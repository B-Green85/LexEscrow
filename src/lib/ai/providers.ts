/**
 * Model-agnostic AI parser providers.
 *
 * The app depends only on `AIParserProvider`. The concrete provider is resolved
 * at runtime from the vault's public AI metadata: `connectionType` selects HTTP
 * vs WebSocket, and the endpoint + api_key are pulled from the vault at parse
 * time *inside the backend*, so the secret never reaches this layer. No model or
 * provider is hardcoded here.
 *
 * The model returns **integer cents** (per the system prompt); providers convert
 * cents → dollars into `ParsedRetainerPayload` after Zod validation, so LexGuard
 * and its tests are untouched. On invalid JSON the provider retries once with a
 * correction system prompt, then surfaces a plain-English error.
 */

import {
  AiExtractionSchema,
  ExecutionPath,
  type AiExtraction,
  type ParsedRetainerPayload,
} from "../../lexguard/types";
import { parseRetainerDocument } from "../aiParse";
import * as backend from "../backend";
import { type AssetClass } from "../assetClasses";
import { systemPromptFor } from "./assetSchemas";
import { type ExtractionSchema, type RetainerSchema } from "./schema";

export interface AIParserProvider {
  readonly label: string;
  parse(documentText: string, schema: RetainerSchema): Promise<ParsedRetainerPayload>;
  /** Nudge: re-extract a single numeric field toward the observed sentinel.
   *  Returns the corrected value (dollars), or null if it could not correct. */
  correct(field: string, currentValue: number, sentinelValue: number): Promise<number | null>;
}

/** Raised when a parse is attempted without a usable provider. */
export class ProviderUnavailableError extends Error {
  constructor(
    public readonly code: "VAULT_LOCKED" | "NO_PROVIDER",
    message: string,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * The asset class carried by an extraction schema. `schemaFor(cls)` tags every
 * non-legal schema with `id = cls`; the legal path reuses `RETAINER_SCHEMA`,
 * which has no `id`, so it falls back to `"legal"`. This is how the asset class
 * chosen in the session store reaches the system-prompt selection here without
 * changing the `parse()` signature.
 */
function assetClassOf(schema: RetainerSchema): AssetClass {
  return ((schema as ExtractionSchema).id as AssetClass | undefined) ?? "legal";
}

// ── Response handling ────────────────────────────────────────────────────────

/**
 * Strip a leading ```json / ``` fence and a trailing ``` from a model response.
 * Claude frequently wraps its JSON in a markdown code block despite being told
 * not to; the fence makes JSON.parse fail, so remove it before parsing. A string
 * with no fence is returned unchanged (aside from trimming).
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function tryParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stripMarkdown(s));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pull the JSON object out of a raw model response, tolerating common shapes. */
export function extractJson(raw: string): Record<string, unknown> {
  let obj = tryParse(raw.trim());

  const content = obj?.content;
  if (Array.isArray(content) && typeof (content[0] as { text?: unknown })?.text === "string") {
    obj = tryParse((content[0] as { text: string }).text) ?? obj;
  }
  const choices = obj?.choices;
  if (Array.isArray(choices)) {
    const inner = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    if (typeof inner === "string") obj = tryParse(inner) ?? obj;
  }
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  return obj ?? {};
}

function extractionToPayload(x: AiExtraction): ParsedRetainerPayload {
  return {
    clientId: x.clientId,
    lawFirmWallet: x.lawFirmWallet,
    clientWallet: x.clientWallet,
    totalHeld: x.totalHeld / 100, // cents → dollars
    earnedFees: x.earnedFees / 100,
    unearnedBalance: x.unearnedBalance / 100,
    disputedHours: x.disputedHours,
    disputedAmount: x.disputedAmount / 100,
    signaturesVerified: x.signaturesVerified,
    recommendedPath:
      x.recommendedPath === "ArbitrationEscrow"
        ? ExecutionPath.ArbitrationEscrow
        : ExecutionPath.DirectSettlement,
    anomaliesFlagged: x.anomaliesFlagged,
    anomaliesSuppressed: x.anomaliesSuppressed,
    barNumber: "",
    clientName: undefined,
    extractedBarNumber: null,
  };
}

/** Validate a raw extraction object against the Zod schema and convert to a payload. */
export function validateAndConvert(
  obj: unknown,
): { success: true; payload: ParsedRetainerPayload } | { success: false; error: string } {
  const r = AiExtractionSchema.safeParse(obj);
  if (!r.success) {
    const error = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { success: false, error };
  }
  return { success: true, payload: extractionToPayload(r.data) };
}

/** Parse a single corrected numeric value (integer cents) from a nudge response. */
function parseCorrectedCents(raw: string, field: string): number | null {
  const obj = extractJson(raw);
  const direct = obj[field] ?? Object.values(obj)[0];
  if (direct !== undefined && direct !== null && direct !== "") {
    const n = Number(direct);
    if (Number.isFinite(n)) return n;
  }
  const bare = raw.replace(/[$,]/g, "").match(/-?\d+(?:\.\d+)?/);
  return bare ? Number(bare[0]) : null;
}

type Transport = (system: string, user: string) => Promise<string>;

export async function parseWithTransport(
  transport: Transport,
  documentText: string,
  assetClass: AssetClass,
): Promise<ParsedRetainerPayload> {
  // Guard: an empty document means the extractor produced nothing (unsupported
  // format, failed OCR, a blank file). Sending an empty user message just makes
  // the model invent zeros, so fail here — before the request — with a message
  // that points at the real cause rather than a downstream validation error.
  if (documentText.trim().length === 0) {
    throw new Error(
      "No text was extracted from the document, so there is nothing for the AI to parse. Execution was not started.",
    );
  }

  const systemPrompt = systemPromptFor(assetClass);
  // The document text IS the user message (transport → messages: [{ role: 'user',
  // content: documentText }] in ai.rs / the browser fetch). Without it the model
  // has nothing to read, which is the guard above.
  const first = validateAndConvert(extractJson(await transport(systemPrompt, documentText)));
  if (first.success) return first.payload;

  // Retry once with a correction system prompt.
  const retrySystem = `${systemPrompt}\n\nYour previous response was invalid (${first.error}). Return ONLY the JSON object described above — no preamble, no markdown, no explanation.`;
  const second = validateAndConvert(extractJson(await transport(retrySystem, documentText)));
  if (second.success) return second.payload;

  throw new Error(
    "The AI response could not be parsed into the required format after a retry. Execution was not started.",
  );
}

async function correctWithTransport(
  transport: Transport,
  field: string,
  currentDollars: number,
  sentinelDollars: number,
): Promise<number | null> {
  const currentCents = Math.round(currentDollars * 100);
  const sentinelCents = Math.round(sentinelDollars * 100);
  const system =
    "You are a legal document parser. Return ONLY the corrected JSON value for the requested field — a single number in integer cents. No other text.";
  const user = `Your extraction of ${field} was ${currentCents}. The document contains ${sentinelCents}. Please re-extract only the ${field} field and return ONLY the corrected JSON value.`;
  const cents = parseCorrectedCents(await transport(system, user), field);
  return cents == null ? null : cents / 100;
}

// ── Concrete providers ───────────────────────────────────────────────────────

/** POST the document to the endpoint with the API key header (transport in backend). */
export class HTTPProvider implements AIParserProvider {
  readonly label: string;
  constructor(providerName: string) {
    this.label = `${providerName} (HTTP)`;
  }
  parse(documentText: string, schema: RetainerSchema): Promise<ParsedRetainerPayload> {
    // Path-identification log (Issue #4) — marks that the request originates in
    // the TypeScript provider layer. Paired with the eprintln! in ai.rs, the
    // next test run shows whether the actual HTTP executed in Rust (this line
    // AND the Rust line appear) or in the browser fetch fallback (only this
    // line appears). Left in place for review.
    console.log(
      "[ai] HTTP request initiated from TypeScript provider layer (providers.ts -> backend.aiRequestHttp)",
    );
    return parseWithTransport(backend.aiRequestHttp, documentText, assetClassOf(schema));
  }
  correct(field: string, current: number, sentinel: number): Promise<number | null> {
    return correctWithTransport(backend.aiRequestHttp, field, current, sentinel);
  }
}

/** Open a streaming WebSocket to the endpoint and collect the full response. */
export class WebSocketProvider implements AIParserProvider {
  readonly label: string;
  constructor(providerName: string) {
    this.label = `${providerName} (WebSocket)`;
  }
  parse(documentText: string, schema: RetainerSchema): Promise<ParsedRetainerPayload> {
    return parseWithTransport(backend.aiRequestWs, documentText, assetClassOf(schema));
  }
  correct(field: string, current: number, sentinel: number): Promise<number | null> {
    return correctWithTransport(backend.aiRequestWs, field, current, sentinel);
  }
}

/** Offline reference parser (deterministic). Not used by resolveProvider. */
export class LocalHeuristicProvider implements AIParserProvider {
  readonly label = "Local heuristic";
  async parse(documentText: string, _schema: RetainerSchema): Promise<ParsedRetainerPayload> {
    return parseRetainerDocument(documentText);
  }
  async correct(_field: string, _current: number, sentinel: number): Promise<number | null> {
    return sentinel; // adopt the observed value
  }
}

/**
 * Resolve the active provider from the vault. Throws `ProviderUnavailableError`
 * when the vault is locked or no provider is configured — the caller surfaces
 * the appropriate action (unlock / open Configuration).
 */
export async function resolveProvider(): Promise<AIParserProvider> {
  const status = await backend.vaultStatus();
  if (!status.unlocked) {
    throw new ProviderUnavailableError(
      "VAULT_LOCKED",
      "The credential vault is locked. Unlock it in Configuration to parse documents.",
    );
  }
  const { ai } = await backend.vaultGetPublic();
  if (!ai || !ai.hasApiKey) {
    throw new ProviderUnavailableError(
      "NO_PROVIDER",
      "No AI provider is configured. Add one in Configuration to parse documents.",
    );
  }
  return ai.connectionType === "websocket"
    ? new WebSocketProvider(ai.providerName)
    : new HTTPProvider(ai.providerName);
}

/**
 * Provider resolution for batch processing. Uses the same vault provider as the
 * single-document flow, but falls back to the deterministic local heuristic
 * when the vault is locked / unconfigured so a batch can still be triaged.
 */
export async function resolveProviderForBatch(): Promise<AIParserProvider> {
  try {
    return await resolveProvider();
  } catch {
    return new LocalHeuristicProvider();
  }
}
