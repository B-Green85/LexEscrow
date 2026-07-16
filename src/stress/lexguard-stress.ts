/**
 * LexGuard Stress Test — adversarial harness.
 *
 * Runs a battery of hostile inputs against the LexGuard suite (VDB cross-
 * reference, payload-diff arithmetic, anchor-matcher, anomaly-watcher,
 * scope-guard, ArtifactGuard normalization + hashing) plus the co-validation
 * pipeline and its nudge loop, and reports pass/fail per scenario.
 *
 *   Run:  npm run stress:lexguard
 *
 * A scenario "passes" when LexGuard behaves as it must — either clearing a
 * legitimate payload or catching an adversarial one. Non-zero exit on any fail.
 */

import * as backend from "../lib/backend";
import { runLexGuardPipeline } from "../lexguard/pipeline";
import {
  diffNumericsWithVDB,
  formatUsd,
  toCents,
  validateArithmetic,
} from "../lexguard/payload-diff";
import { matchBarNumber, matchClientName } from "../lexguard/anchor-matcher";
import { detectAnomalySuppression } from "../lexguard/anomaly-watcher";
import { AUTHORIZED_FIELDS, detectScopeViolation } from "../lexguard/scope-guard";
import { primeVDB } from "../lexguard/vdb";
import { AI_ACCESSED_FIELDS } from "../lib/aiParse";
import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "../lexguard/types";
import type { AIParserProvider } from "../lib/ai/providers";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ANCHORS: TrustAnchors = {
  attorneyBarNumber: "123456",
  state: "California",
  clientFullLegalName: "Jane Anderson",
  clientEmail: "client@example.com",
};

/** A clean, arithmetically-consistent payload ($5,000 = $800 + $4,200). */
function payload(over: Partial<ParsedRetainerPayload> = {}): ParsedRetainerPayload {
  return {
    clientId: "C-10482",
    lawFirmWallet: "0x2222222222222222222222222222222222222222",
    clientWallet: "0x1111111111111111111111111111111111111111",
    totalHeld: 5000,
    earnedFees: 800,
    unearnedBalance: 4200,
    disputedHours: 0,
    disputedAmount: 0,
    signaturesVerified: true,
    recommendedPath: ExecutionPath.DirectSettlement,
    anomaliesFlagged: [],
    anomaliesSuppressed: false,
    barNumber: "123456",
    clientName: "Jane Anderson",
    extractedBarNumber: "123456",
    ...over,
  };
}

const DOC_MATCHES_4200 = [
  "BILLING RECONCILIATION",
  "Total Retainer Held: $5,000.00",
  "Earned Fees: $800.00",
  "Unearned Balance: $4,200.00",
].join("\n");

const DOC_MATCHES_3200 = DOC_MATCHES_4200.replace("$4,200.00", "$3,200.00");

/** Stub AI provider whose correct() returns whatever `corrector` yields. */
function stub(corrector: (field: string, current: number, sentinel: number) => number | null): AIParserProvider {
  return {
    label: "stress-stub",
    parse: async () => payload(),
    correct: async (field, current, sentinel) => corrector(field, current, sentinel),
  };
}

// Hidden / zero-width / bidi codepoints — checked directly to avoid any
// escaping ambiguity in source.
const HIDDEN_CODES = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e, 0x200e, 0x200f, 0x2066, 0x2067, 0x2068, 0x2069,
]);
const hasHidden = (s: string): boolean =>
  Array.from(s).some((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return HIDDEN_CODES.has(cp) || (cp >= 0x202a && cp <= 0x202e);
  });

// ── Scenario type ────────────────────────────────────────────────────────────

interface Result {
  passed: boolean;
  verb: string; // e.g. "passed", "caught", "halted"
  detail: string;
}
interface Scenario {
  name: string;
  run: () => Promise<Result>;
}

const ok = (verb: string, detail = ""): Result => ({ passed: true, verb, detail });
const fail = (detail: string): Result => ({ passed: false, verb: "FAILED", detail });

// ── Scenarios ────────────────────────────────────────────────────────────────

const scenarios: Scenario[] = [
  {
    name: "CLEAN",
    run: async () => {
      const vdb = await primeVDB(DOC_MATCHES_4200, "sha256:clean", "s-clean");
      const r = await runLexGuardPipeline({
        payload: payload(),
        vdb,
        anchors: ANCHORS,
        chainlinkVerifiedBar: "123456",
        provider: stub((_f, _c, s) => s),
      });
      return r.escalation === null
        ? ok("passed", "no escalation, no corrections")
        : fail(`unexpected escalation: ${r.escalation.fieldLabel}`);
    },
  },

  {
    name: "ARITHMETIC DRIFT",
    run: async () => {
      // unearned matches the doc (3200) so only the sum is wrong: 800 + 3200 ≠ 5000.
      const vdb = await primeVDB(DOC_MATCHES_3200, "sha256:a", "s-arith");
      const r = await runLexGuardPipeline({
        payload: payload({ unearnedBalance: 3200 }),
        vdb,
        anchors: ANCHORS,
        chainlinkVerifiedBar: "123456",
        provider: stub((_f, _c, s) => s),
      });
      return r.escalation && r.escalation.module === "payload-diff" && r.escalation.field === "arithmetic"
        ? ok("caught", "payload-diff arithmetic escalation")
        : fail(`expected arithmetic escalation, got ${r.escalation?.module ?? "none"}`);
    },
  },

  {
    name: "HIDDEN CHARACTER INJECTION",
    run: async () => {
      // Zero-width space, BOM, and a bidi override embedded in name + amount.
      const ZWSP = String.fromCharCode(0x200b);
      const BOM = String.fromCharCode(0xfeff);
      const RLO = String.fromCharCode(0x202e);
      const PDF = String.fromCharCode(0x202c);
      const rawName = "Ja" + ZWSP + "ne" + BOM + " Anderson";
      const rawAmount = "$4," + ZWSP + "200.00";
      const rawBidi = RLO + "Stolen" + PDF + " Amount";

      const cleanName = backend.normalizeTextJs(rawName);
      const cleanAmount = backend.normalizeTextJs(rawAmount);
      const cleanBidi = backend.normalizeTextJs(rawBidi);

      const stripped = !hasHidden(cleanName) && !hasHidden(cleanAmount) && !hasHidden(cleanBidi);
      // Normalization is load-bearing: raw fails the anchor, normalized passes it.
      const rawFails = !matchClientName(rawName, "Jane Anderson");
      const normPasses = matchClientName(cleanName, "Jane Anderson");
      const amountClean = cleanAmount === "$4,200.00";

      return stripped && rawFails && normPasses && amountClean
        ? ok("caught", `normalized "${cleanName}" / "${cleanAmount}" before LexGuard`)
        : fail(
            `stripped=${stripped} rawFails=${rawFails} normPasses=${normPasses} amount="${cleanAmount}"`,
          );
    },
  },

  {
    name: "ANOMALY SUPPRESSION",
    run: async () => {
      const vdb = await primeVDB(DOC_MATCHES_4200, "sha256:an", "s-anom");
      const p = payload({ anomaliesFlagged: ["ledger gap"], anomaliesSuppressed: true, recommendedPath: ExecutionPath.ArbitrationEscrow });
      const moduleFires = detectAnomalySuppression(p.anomaliesFlagged, p.anomaliesSuppressed, p.recommendedPath);
      const r = await runLexGuardPipeline({ payload: p, vdb, anchors: ANCHORS, chainlinkVerifiedBar: "123456", provider: stub((_f, _c, s) => s) });
      return moduleFires && r.escalation?.module === "anomaly-watcher"
        ? ok("caught", "AnomalyWatcher escalation")
        : fail(`moduleFires=${moduleFires} escalation=${r.escalation?.module ?? "none"}`);
    },
  },

  {
    name: "SCOPE VIOLATION",
    run: async () => {
      const accessed = [...AI_ACCESSED_FIELDS, "ssn", "routingNumber"];
      const violations = detectScopeViolation(accessed);
      return violations.includes("ssn") && violations.includes("routingNumber")
        ? ok("caught", `ScopeGuard flagged ${violations.join(", ")} (${AUTHORIZED_FIELDS.size} authorized)`)
        : fail(`expected ssn/routingNumber flagged, got [${violations.join(", ")}]`);
    },
  },

  {
    name: "NUDGE EXHAUSTION",
    run: async () => {
      // AI never corrects: correct() always returns the same wrong value.
      const vdb = await primeVDB(DOC_MATCHES_4200, "sha256:n", "s-nudge");
      let nudges = 0;
      const r = await runLexGuardPipeline({
        payload: payload({ unearnedBalance: 3200 }),
        vdb,
        anchors: ANCHORS,
        chainlinkVerifiedBar: "123456",
        provider: stub(() => {
          nudges++;
          return 3200; // never matches the sentinel (4200)
        }),
      });
      // Exactly 3 nudge attempts, then escalation.
      return nudges === 3 && r.corrections.length === 3 && r.escalation !== null
        ? ok("caught", `escalated at exactly nudge 3 (${nudges} attempts)`)
        : fail(`nudges=${nudges} corrections=${r.corrections.length} escalation=${!!r.escalation}`);
    },
  },

  {
    name: "HASH TAMPERING",
    run: async () => {
      const name = `stress-${Date.now()}.txt`;
      const original = new TextEncoder().encode("Unearned Balance: $4,200.00");
      const tampered = new TextEncoder().encode("Unearned Balance: $9,200.00");
      await backend.loadArtifact(name, original); // registers the baseline hash
      // Intermediate check should pass on the original, then the tampered bytes
      // must halt the final blocking re-verify.
      try {
        await backend.finalVerifyBeforeExecution(name, original); // ok
      } catch {
        return fail("final verify wrongly rejected the original bytes");
      }
      try {
        await backend.finalVerifyBeforeExecution(name, tampered);
        return fail("tampered artifact was NOT halted");
      } catch (e) {
        const reason = typeof e === "object" && e && "reason" in e ? String((e as { reason: unknown }).reason) : String(e);
        return reason.includes("modified after parsing")
          ? ok("halted", "ArtifactGuard blocked the tampered artifact")
          : fail(`halted, but unexpected reason: ${reason}`);
      }
    },
  },

  {
    name: "CASCADE (all 5 modules)",
    run: async () => {
      const vdb = await primeVDB(DOC_MATCHES_4200, "sha256:c", "s-cascade");
      const p = payload({
        totalHeld: 5000,
        earnedFees: 800,
        unearnedBalance: 3200, // arithmetic broken + VDB mismatch (doc says 4200)
        clientName: "Wrong Person", // anchor mismatch
        extractedBarNumber: "999999", // anchor bar mismatch
        anomaliesFlagged: ["ledger gap"],
        anomaliesSuppressed: true, // anomaly suppression
      });
      const fired = {
        arithmetic: !validateArithmetic(p),
        anchorName: !matchClientName(p.clientName ?? "", ANCHORS.clientFullLegalName),
        anchorBar: !matchBarNumber(p.extractedBarNumber ?? null, ANCHORS.attorneyBarNumber, "123456"),
        anomaly: detectAnomalySuppression(p.anomaliesFlagged, p.anomaliesSuppressed, p.recommendedPath),
        scope: detectScopeViolation([...AI_ACCESSED_FIELDS, "ssn"]).length > 0,
        vdb: diffNumericsWithVDB(p, vdb).some((d) => d.field === "unearnedBalance"),
      };
      const allFired = Object.values(fired).every(Boolean);
      const r = await runLexGuardPipeline({ payload: p, vdb, anchors: ANCHORS, chainlinkVerifiedBar: "123456", provider: stub(() => null) });
      // A cascade cannot proceed — in batch this surfaces as a non-clean (flagged) item.
      return allFired && r.escalation !== null
        ? ok("caught", `all modules fired (${Object.keys(fired).filter((k) => (fired as Record<string, boolean>)[k]).join(", ")}); pipeline escalated → item not clean`)
        : fail(`fired=${JSON.stringify(fired)} escalation=${!!r.escalation}`);
    },
  },

  {
    name: "CONCURRENT STRESS (10 sessions)",
    run: async () => {
      const N = 10;
      const specs = Array.from({ length: N }, (_, i) => ({
        sessionId: `stress-conc-${Date.now()}-${i}`,
        adversarial: i % 2 === 1,
      }));

      const results = await Promise.all(
        specs.map(async (spec) => {
          await backend.createSession({
            sessionId: spec.sessionId,
            clientId: "c",
            attorneyBarNumber: "123456",
            documentHash: "sha256:x",
          });
          await backend.logEvent(spec.sessionId, "document_loaded", "operator", JSON.stringify({ adversarial: spec.adversarial }));
          const vdb = await primeVDB(DOC_MATCHES_4200, "sha256:x", spec.sessionId);
          // Adversarial: non-nudgeable arithmetic drift (900 + 4200 ≠ 5000).
          const p = spec.adversarial ? payload({ earnedFees: 900 }) : payload();
          const r = await runLexGuardPipeline({ payload: p, vdb, anchors: ANCHORS, chainlinkVerifiedBar: "123456", provider: stub((_f, _c, s) => s) });
          await backend.logEvent(spec.sessionId, "parse", "operator", JSON.stringify({ escalation: !!r.escalation }));
          return { spec, escalation: !!r.escalation };
        }),
      );

      // Each session's result must match its input.
      const wrong = results.filter((r) => r.escalation !== r.spec.adversarial);
      // The global hash chain must remain intact under concurrent appends.
      const chain = await backend.verifyAuditChain();
      // Each session's audit trail must be attributed only to that session.
      let misattributed = 0;
      for (const spec of specs) {
        const trail = await backend.getAuditTrail(spec.sessionId);
        if (trail.length < 2 || trail.some((e) => e.sessionId !== spec.sessionId)) misattributed++;
      }

      return wrong.length === 0 && chain.valid && misattributed === 0
        ? ok("passed", `${N} independent sessions, chain intact (${chain.entries} entries), per-session attribution correct`)
        : fail(`wrongResults=${wrong.length} chainValid=${chain.valid} misattributed=${misattributed}`);
    },
  },

  {
    name: "FLOATING POINT TRAP",
    run: async () => {
      // The classic float trap and a granular ledger case, via integer cents.
      const trap = validateArithmetic(payload({ earnedFees: 0.1, unearnedBalance: 0.2, totalHeld: 0.3 }));
      const granular = validateArithmetic(payload({ earnedFees: 1234.56, unearnedBalance: 8765.44, totalHeld: 10000 }));
      const floatIsBroken = 0.1 + 0.2 !== 0.3; // sanity: naive float really is wrong
      const centsExact = toCents(0.1) === 10n && toCents(0.2) === 20n && toCents(0.3) === 30n;
      return trap && granular && floatIsBroken && centsExact
        ? ok("passed", `toCents exact; ${formatUsd(toCents(0.1) + toCents(0.2))} == ${formatUsd(toCents(0.3))} (no drift)`)
        : fail(`trap=${trap} granular=${granular} floatBroken=${floatIsBroken} centsExact=${centsExact}`);
    },
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nLexGuard Stress Test\n────────────────────");
  const results: { name: string; res: Result }[] = [];
  for (const s of scenarios) {
    try {
      results.push({ name: s.name, res: await s.run() });
    } catch (e) {
      results.push({ name: s.name, res: fail(`threw: ${e instanceof Error ? e.message : String(e)}`) });
    }
  }

  for (const { name, res } of results) {
    const icon = res.passed ? "✅" : "❌";
    const tail = res.passed ? res.verb + (res.detail ? ` — ${res.detail}` : "") : `FAILED — ${res.detail}`;
    console.log(`${icon} ${name} — ${tail}`);
  }

  const failed = results.filter((r) => !r.res.passed).length;
  console.log("────────────────────");
  console.log(`${results.length - failed}/${results.length} scenarios passed${failed ? ` — ${failed} FAILED` : " — all green"}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
