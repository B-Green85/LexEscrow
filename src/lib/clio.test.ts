/**
 * Clio intake — the pure half.
 *
 * The identifier that stands in for a document hash, the two renderings of a
 * matter (JSON for the model, dollars for the VDB), and the derived totals the
 * summary card and the prompt must agree on.
 *
 * The dollar/cents split is the one worth staring at. Clio hands LexEscrow
 * integer cents; the VDB scans for dollar figures. Getting that boundary wrong
 * does not throw — it silently escalates every Clio session on a discrepancy
 * that is purely an encoding difference.
 */

import { describe, expect, it } from "vitest";
import { ASSET_CLASS_LIST } from "./assetClasses";
import {
  billedTotalCents,
  clioIntakeIdentifier,
  clioSystemPrompt,
  clioUserMessage,
  clioVdbText,
  contactableParties,
  escrowAmountCents,
  paidTotalCents,
  supportsClioIntake,
  type ClioMatterPayload,
} from "./clio";

function matter(over: Partial<ClioMatterPayload> = {}): ClioMatterPayload {
  return {
    matterId: 4321,
    displayNumber: "00123-Anderson",
    description: "Anderson v. Wexler",
    status: "open",
    billingMethod: "hourly",
    openDate: "2026-01-15",
    closeDate: null,
    clientName: "Jane Anderson",
    clientEmail: "jane@example.test",
    clientPhone: "+15550100",
    parties: [
      {
        name: "Jane Anderson",
        email: "jane@example.test",
        phone: "+15550100",
        isClient: true,
        isBillRecipient: true,
      },
      {
        name: "Marcus Wexler",
        email: "marcus@example.test",
        phone: null,
        isClient: false,
        isBillRecipient: false,
      },
      { name: "No Contact Co", email: null, phone: null, isClient: false, isBillRecipient: false },
    ],
    bills: [
      {
        number: "INV-001",
        totalCents: 1_250_000,
        paidCents: 500_000,
        balanceCents: 750_000,
        state: "awaiting_payment",
        issuedAt: "2026-08-01",
        dueAt: "2026-09-01",
        memo: "August fees",
      },
      {
        number: "INV-002",
        totalCents: 30_050,
        paidCents: 30_050,
        balanceCents: 0,
        state: "paid",
        issuedAt: "2026-07-01",
        dueAt: null,
        memo: null,
      },
    ],
    trustBalanceCents: 3_000_000,
    fetchedAt: "2026-09-05T12:00:00Z",
    ...over,
  };
}

// ── The intake identifier ────────────────────────────────────────────────────

describe("clioIntakeIdentifier", () => {
  it("is deterministic for the same fetch", async () => {
    const a = await clioIntakeIdentifier(4321, "2026-09-05T12:00:00Z", "client-abc");
    const b = await clioIntakeIdentifier(4321, "2026-09-05T12:00:00Z", "client-abc");
    expect(a).toBe(b);
  });

  it("changes when any of the three inputs changes", async () => {
    const base = await clioIntakeIdentifier(4321, "2026-09-05T12:00:00Z", "client-abc");
    for (const other of [
      await clioIntakeIdentifier(9999, "2026-09-05T12:00:00Z", "client-abc"),
      await clioIntakeIdentifier(4321, "2026-09-05T13:00:00Z", "client-abc"),
      await clioIntakeIdentifier(4321, "2026-09-05T12:00:00Z", "another-client"),
    ]) {
      expect(other).not.toBe(base);
    }
  });

  it("cannot collide by concatenation", async () => {
    // Without a field separator, (12, "3…") and (123, "…") would hash the same.
    const a = await clioIntakeIdentifier(12, "3-2026", "c");
    const b = await clioIntakeIdentifier(123, "-2026", "c");
    expect(a).not.toBe(b);
  });

  it("is prefixed clio: so nothing mistakes it for a document fingerprint", async () => {
    // The prefix is load-bearing: this identifier says which *intake* produced
    // a session, and asserts nothing about any document's contents.
    const id = await clioIntakeIdentifier(1, "2026-09-05T12:00:00Z", "c");
    expect(id.startsWith("clio:")).toBe(true);
    expect(id.startsWith("sha256:")).toBe(false);
    expect(id).toHaveLength("clio:".length + 64);
  });
});

// ── Derived totals ───────────────────────────────────────────────────────────

describe("derived totals", () => {
  it("sums bills in integer cents", () => {
    expect(billedTotalCents(matter())).toBe(1_280_050);
    expect(paidTotalCents(matter())).toBe(530_050);
  });

  it("prefers the trust balance as the escrow amount", () => {
    // Clio's protected funds are the firm's own trust accounting — a stronger
    // source than anything inferable from an invoice.
    expect(escrowAmountCents(matter())).toBe(3_000_000);
  });

  it("falls back to the billed total when there is no trust accounting", () => {
    expect(escrowAmountCents(matter({ trustBalanceCents: null }))).toBe(1_280_050);
  });

  it("treats a zero trust balance as a real zero, not as absent", () => {
    // The distinction the whole nullable type exists for: a matter holding
    // nothing in trust is not a matter whose trust balance is unknown.
    expect(escrowAmountCents(matter({ trustBalanceCents: 0 }))).toBe(0);
  });
});

// ── The two renderings ───────────────────────────────────────────────────────

describe("clioUserMessage", () => {
  it("is the payload as JSON, in cents", () => {
    const parsed = JSON.parse(clioUserMessage(matter()));
    expect(parsed.trustBalanceCents).toBe(3_000_000);
    expect(parsed.displayNumber).toBe("00123-Anderson");
  });
});

describe("clioVdbText", () => {
  const text = clioVdbText(matter());

  it("renders money in dollars, not cents", () => {
    // The VDB scans for dollar figures. Feeding it `3000000` beside
    // `trustBalanceCents` would make every LexGuard co-validation compare
    // dollars against cents and escalate on an encoding difference.
    expect(text).toContain("$30,000.00");
    expect(text).not.toContain("3000000");
  });

  it("labels the amounts with the field names LexGuard looks for", () => {
    expect(text).toContain("Total retainer held: $30,000.00");
    expect(text).toContain("Unearned balance: $30,000.00");
    expect(text).toContain("Earned fees: $5,300.50");
  });

  it("carries the client and the parties", () => {
    expect(text).toContain("Client full legal name: Jane Anderson");
    expect(text).toContain("Party: Marcus Wexler <marcus@example.test>");
  });

  it("uses the billed total when the matter has no trust balance", () => {
    const t = clioVdbText(matter({ trustBalanceCents: null }));
    expect(t).toContain("Total retainer held: $12,800.50");
    // …and makes no unearned-balance claim it cannot support.
    expect(t).not.toContain("Unearned balance");
  });

  it("agrees with the summary card on the escrow amount", () => {
    // The card, the prompt and the VDB all have to name the same number, or the
    // officer approves one figure and LexGuard validates another.
    for (const m of [matter(), matter({ trustBalanceCents: null })]) {
      const dollars = `$${(escrowAmountCents(m) / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
      expect(clioVdbText(m)).toContain(`Total retainer held: ${dollars}`);
    }
  });
});

// ── The prompt ───────────────────────────────────────────────────────────────

describe("clioSystemPrompt", () => {
  const prompt = clioSystemPrompt("BASE PROMPT FOR LEGAL");

  it("composes on top of the asset class prompt rather than replacing it", () => {
    // One definition of the output contract, not two that can drift.
    expect(prompt.startsWith("BASE PROMPT FOR LEGAL")).toBe(true);
  });

  it("tells the model the input is a record, not a document", () => {
    expect(prompt).toContain("NOT a document");
    expect(prompt).toContain("Clio Manage");
  });

  it("states the trust-balance and cents rules", () => {
    expect(prompt).toContain("AUTHORITATIVE");
    expect(prompt).toMatch(/already integer cents/i);
    expect(prompt).toMatch(/does NOT mean the balance is zero/i);
  });
});

// ── Hand-offs ────────────────────────────────────────────────────────────────

describe("contactableParties", () => {
  it("drops parties with no email", () => {
    // DocuSign and the SMTP notifier both address people by email; a party
    // without one cannot be reached by either.
    const names = contactableParties(matter()).map((p) => p.name);
    expect(names).toEqual(["Jane Anderson", "Marcus Wexler"]);
  });
});

describe("supportsClioIntake", () => {
  it("is offered on Legal only", () => {
    // Clio is practice-management software for law firms — a matter is a legal
    // engagement by construction.
    expect(supportsClioIntake("legal")).toBe(true);
    for (const cls of ASSET_CLASS_LIST.filter((c) => c !== "legal")) {
      expect(supportsClioIntake(cls)).toBe(false);
    }
  });
});
