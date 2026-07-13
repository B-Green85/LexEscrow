/**
 * Model-agnostic AI parser providers.
 *
 * The rest of the app depends only on `AIParserProvider`. The concrete provider
 * is resolved at runtime from the vault's public AI metadata: `connectionType`
 * selects HTTP vs WebSocket, and the endpoint + api_key are pulled from the
 * vault at parse time (inside the backend, so the secret never reaches here).
 * When no provider is configured (or the vault is locked), a deterministic
 * local heuristic stands in. LexGuard validates the output regardless of which
 * provider produced it.
 */

import { ExecutionPath, type ParsedRetainerPayload } from "../../lexguard/types";
import { parseRetainerDocument } from "../aiParse";
import * as backend from "../backend";
import { type RetainerSchema } from "./schema";

export interface AIParserProvider {
  readonly label: string;
  parse(documentText: string, schema: RetainerSchema): Promise<ParsedRetainerPayload>;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function tryParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pull the retainer JSON out of a raw model response, tolerating common shapes. */
export function extractJson(raw: string): Record<string, unknown> {
  let obj = tryParse(raw.trim());

  // Anthropic Messages: { content: [{ text }] }
  const content = obj?.content;
  if (Array.isArray(content) && typeof (content[0] as { text?: unknown })?.text === "string") {
    obj = tryParse((content[0] as { text: string }).text) ?? obj;
  }
  // OpenAI Chat: { choices: [{ message: { content } }] }
  const choices = obj?.choices;
  if (Array.isArray(choices)) {
    const inner = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    if (typeof inner === "string") obj = tryParse(inner) ?? obj;
  }
  // Last resort: first {...} block in the text.
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  return obj ?? {};
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function toStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Coerce arbitrary model JSON into a well-typed ParsedRetainerPayload. */
export function coercePayload(obj: Record<string, unknown>): ParsedRetainerPayload {
  const recommendedPath =
    obj.recommendedPath === "ArbitrationEscrow"
      ? ExecutionPath.ArbitrationEscrow
      : ExecutionPath.DirectSettlement;

  return {
    clientId: toStr(obj.clientId) ?? "C-UNKNOWN",
    lawFirmWallet: toStr(obj.lawFirmWallet) ?? ZERO,
    clientWallet: toStr(obj.clientWallet) ?? ZERO,
    totalHeld: toNum(obj.totalHeld),
    earnedFees: toNum(obj.earnedFees),
    unearnedBalance: toNum(obj.unearnedBalance),
    disputedHours: toNum(obj.disputedHours),
    disputedAmount: toNum(obj.disputedAmount),
    signaturesVerified: Boolean(obj.signaturesVerified),
    recommendedPath,
    anomaliesFlagged: Array.isArray(obj.anomaliesFlagged) ? obj.anomaliesFlagged.map(String) : [],
    anomaliesSuppressed: Boolean(obj.anomaliesSuppressed),
    barNumber: "",
    clientName: toStr(obj.clientName),
    extractedBarNumber: toStr(obj.barNumberInDocument) ?? null,
  };
}

/** POST to the configured endpoint with the API key header (transport in backend). */
export class HTTPProvider implements AIParserProvider {
  readonly label: string;
  constructor(providerName: string) {
    this.label = `${providerName} (HTTP)`;
  }
  async parse(documentText: string, schema: RetainerSchema): Promise<ParsedRetainerPayload> {
    const raw = await backend.aiParseHttp(documentText, JSON.stringify(schema));
    return coercePayload(extractJson(raw));
  }
}

/** Streaming WebSocket connection; collects the full payload, then coerces. */
export class WebSocketProvider implements AIParserProvider {
  readonly label: string;
  constructor(providerName: string) {
    this.label = `${providerName} (WebSocket)`;
  }
  async parse(documentText: string, schema: RetainerSchema): Promise<ParsedRetainerPayload> {
    const raw = await backend.aiParseWs(documentText, JSON.stringify(schema));
    return coercePayload(extractJson(raw));
  }
}

/** Deterministic local extraction — used when no AI provider is configured. */
export class LocalHeuristicProvider implements AIParserProvider {
  readonly label = "Local heuristic";
  async parse(documentText: string, _schema: RetainerSchema): Promise<ParsedRetainerPayload> {
    return parseRetainerDocument(documentText);
  }
}

/**
 * Resolve the active provider from the vault's public AI metadata. Falls back
 * to the local heuristic when the vault is locked or no provider is configured.
 */
export async function resolveProvider(): Promise<AIParserProvider> {
  try {
    const { ai } = await backend.vaultGetPublic();
    if (ai && ai.hasApiKey) {
      return ai.connectionType === "websocket"
        ? new WebSocketProvider(ai.providerName)
        : new HTTPProvider(ai.providerName);
    }
  } catch {
    // vault locked / unavailable → local heuristic
  }
  return new LocalHeuristicProvider();
}
