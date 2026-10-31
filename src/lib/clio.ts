// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Clio Manage intake — the frontend half.
 *
 * Three things live here and nothing else: the payload shapes that cross IPC
 * from `clio.rs`, the deterministic identifier that stands in for a document
 * hash on this path, and the system prompt that tells the AI it is reading
 * structured matter data rather than a document.
 *
 * **Nothing here persists.** Clio's ToS §10(e) forbids holding matter data
 * beyond session scope, so the payload lives in the session store for the
 * length of one escrow transaction and is never handed to `backend.saveP*`,
 * `createSession`'s payload fields, or the audit trail. What *is* recorded is
 * LexEscrow's own derived data — the intake identifier, the asset class, the
 * total in cents — which is not Clio's to restrict.
 */

import type { AssetClass } from "./assetClasses";

// ── Payload shapes (mirror the Rust structs in clio.rs) ──────────────────────

export interface ClioParty {
  name: string;
  email: string | null;
  phone: string | null;
  isClient: boolean;
  isBillRecipient: boolean;
}

export interface ClioBill {
  number: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  state: string;
  issuedAt: string | null;
  dueAt: string | null;
  memo: string | null;
}

export interface ClioMatterPayload {
  matterId: number;
  displayNumber: string;
  description: string;
  status: string;
  billingMethod: string;
  openDate: string | null;
  closeDate: string | null;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  parties: ClioParty[];
  bills: ClioBill[];
  /** Integer cents. Null when the firm has no trust accounting on the matter —
   *  which is not the same as a zero balance, and is why this is nullable. */
  trustBalanceCents: number | null;
  fetchedAt: string;
}

export interface ClioMatterSummary {
  id: number;
  displayNumber: string;
  description: string;
}

/**
 * The loopback address the OAuth callback listener binds, and the value the
 * Clio Developer Portal must have registered.
 *
 * Mirrors `CLIO_DEFAULT_REDIRECT_URI` in `vault.rs`. Clio matches it exactly,
 * so the two spellings have to agree — the Configuration screen shows this one
 * read-only, and the backend binds the port in it.
 */
export const CLIO_DEFAULT_REDIRECT_URI = "http://127.0.0.1:8080/callback";

/** Which intake path produced the session. */
export type IntakeSource = "artifact" | "clio";

// ── The intake identifier ────────────────────────────────────────────────────

/** ASCII Unit Separator — the same delimiter the audit chain hashes with. */
const FIELD_SEP = "\u001f";

/**
 * The stand-in for a document hash on the Clio path.
 *
 * There is no artifact to fingerprint — the input is a JSON record pulled from
 * an API, not a file an officer can hand to anyone — so there is nothing for
 * SHA-256 over bytes to mean here. What the audit trail actually needs from
 * that column is a stable identifier for *which intake produced this session*,
 * and this derives one from the three values that pin it down: the matter, the
 * moment it was read, and the OAuth client it was read through.
 *
 * Deterministic, so the same fetch always names the same session, and prefixed
 * `clio:` rather than `sha256:` because it is emphatically **not** a document
 * fingerprint. Anything downstream that treats a `sha256:` value as evidence of
 * a document's contents would be wrong to do so here, and the prefix is what
 * stops it silently trying.
 */
export async function clioIntakeIdentifier(
  matterId: number,
  fetchedAt: string,
  clientId: string,
): Promise<string> {
  // U+001F between fields, exactly as the audit chain delimits its own — it
  // cannot occur in a matter id, a timestamp or an OAuth client id, so no two
  // different fetches can collide by concatenating to the same string.
  const material = [String(matterId), fetchedAt, clientId].join(FIELD_SEP);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `clio:${hex}`;
}

// ── The AI prompt ────────────────────────────────────────────────────────────

/**
 * The system prompt for the Clio intake path.
 *
 * Composed on top of the asset class's existing prompt rather than replacing
 * it: the fields the model must return, and the JSON shape it must return them
 * in, are identical on both paths — LexGuard validates the output the same way
 * regardless of where the input came from. All this adds is what changed, which
 * is the *input*: structured records instead of prose.
 *
 * The trust-balance rule is the one substantive instruction. Clio's protected
 * funds are the firm's own accounting of what is actually held in trust, which
 * is a stronger source than anything inferable from an invoice, so when it is
 * present it wins.
 */
export function clioSystemPrompt(basePrompt: string): string {
  return `${basePrompt}

── INPUT FORMAT (Clio Manage intake) ──
The user message is NOT a document. It is a JSON record pulled read-only from
the firm's Clio Manage account, describing one matter: its metadata, its client,
its contacts, its recent bills, and its trust-account balance.

Extract exactly the same fields you would from a retainer document, using these
sources:
  - totalHeld       — trustBalanceCents when present; otherwise the most recent
                      bill's totalCents.
  - earnedFees      — the sum of paidCents across the listed bills.
  - unearnedBalance — trustBalanceCents when present; otherwise totalHeld minus
                      earnedFees.
  - clientId        — displayNumber (Clio's matter reference).
  - clientName      — clientName.

Rules:
  - trustBalanceCents, when present, is AUTHORITATIVE for the escrow amount.
    It is the firm's own trust accounting; prefer it over any figure derived
    from bills.
  - trustBalanceCents may be null. That means the firm has no trust accounting
    on this matter — it does NOT mean the balance is zero.
  - Every *Cents field in the input is already integer cents. Do not multiply.
  - Clio carries no wallet addresses. Return the zero address for both wallet
    fields; the officer supplies them downstream.
  - Report anomalies you can see in the record — a disputed or overdue bill, a
    closed matter with an outstanding balance — in anomaliesFlagged.`;
}

/**
 * The user message: the payload as JSON.
 *
 * Pretty-printed at two spaces because the model reads it better that way, and
 * the token cost of the whitespace is trivial next to a matter's bill list.
 */
export function clioUserMessage(payload: ClioMatterPayload): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * A dollar-denominated plain-text projection of the matter, for the VDB.
 *
 * Deliberately *not* the JSON the AI reads, and the difference matters. The VDB
 * exists so LexGuard can ask "does the payload's $30,000.00 actually appear in
 * the source it came from" — it scans for dollar figures and the field labels
 * around them. Handing it the raw JSON would feed it `3000000` next to
 * `trustBalanceCents` and make every co-validation compare dollars against
 * cents, so every Clio session would escalate on a discrepancy that is purely
 * an encoding difference.
 *
 * What the source *asserts* is thirty thousand dollars held in trust; the cents
 * integer is a transport detail. This renders the assertion in the form the VDB
 * was built to read, which keeps LexGuard doing real work on this path — it can
 * still catch an AI that invents a total the matter never contained.
 */
export function clioVdbText(payload: ClioMatterPayload): string {
  const dollars = (cents: number) =>
    `$${(cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const lines = [
    `Clio Matter ${payload.displayNumber}`,
    `Description: ${payload.description}`,
    `Status: ${payload.status}`,
    `Billing method: ${payload.billingMethod}`,
    `Client full legal name: ${payload.clientName}`,
  ];
  if (payload.clientEmail) lines.push(`Client email: ${payload.clientEmail}`);
  if (payload.clientPhone) lines.push(`Client phone: ${payload.clientPhone}`);
  if (payload.openDate) lines.push(`Retainer start date: ${payload.openDate}`);
  if (payload.closeDate) lines.push(`Retainer end date: ${payload.closeDate}`);

  if (payload.trustBalanceCents !== null) {
    lines.push(`Total retainer held: ${dollars(payload.trustBalanceCents)}`);
    lines.push(`Unearned balance: ${dollars(payload.trustBalanceCents)}`);
  } else {
    lines.push(`Total retainer held: ${dollars(billedTotalCents(payload))}`);
  }
  lines.push(`Earned fees: ${dollars(paidTotalCents(payload))}`);

  for (const b of payload.bills) {
    lines.push(
      `Bill ${b.number}: total ${dollars(b.totalCents)}, paid ${dollars(b.paidCents)}, ` +
        `balance ${dollars(b.balanceCents)}, state ${b.state}`,
    );
  }
  for (const p of payload.parties) {
    lines.push(`Party: ${p.name}${p.email ? ` <${p.email}>` : ""}`);
  }
  return lines.join("\n");
}

// ── Downstream hand-offs ─────────────────────────────────────────────────────

/**
 * The parties an escrow needs to notify or collect signatures from.
 *
 * Contacts with no email are dropped: both consumers — the DocuSign envelope
 * and the SMTP notifier — address people by email, and a party without one
 * cannot be reached by either. They stay visible in the intake summary, so the
 * officer can see the matter has a contact LexEscrow cannot act on.
 */
export function contactableParties(payload: ClioMatterPayload): ClioParty[] {
  return payload.parties.filter((p) => Boolean(p.email));
}

/** Total of every listed bill, in integer cents. */
export function billedTotalCents(payload: ClioMatterPayload): number {
  return payload.bills.reduce((sum, b) => sum + b.totalCents, 0);
}

/** Total paid across every listed bill, in integer cents — the earned fees. */
export function paidTotalCents(payload: ClioMatterPayload): number {
  return payload.bills.reduce((sum, b) => sum + b.paidCents, 0);
}

/**
 * The escrow amount this intake asserts, in integer cents.
 *
 * Mirrors the prompt's rule so the officer's summary card and the AI are
 * reading the same number: trust balance when the firm keeps one, the billed
 * total otherwise.
 */
export function escrowAmountCents(payload: ClioMatterPayload): number {
  return payload.trustBalanceCents ?? billedTotalCents(payload);
}

/**
 * Clio intake is a Legal-asset-class path.
 *
 * Clio is practice-management software for law firms; a matter is a legal
 * engagement by construction. The toggle is therefore only offered on the Legal
 * class, and this is the predicate the Document Load screen asks.
 */
export function supportsClioIntake(assetClass: AssetClass): boolean {
  return assetClass === "legal";
}
