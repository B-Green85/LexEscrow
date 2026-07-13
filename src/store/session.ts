/**
 * LexEscrow session store (Zustand).
 *
 * Owns the whole workflow: trust anchors → hashing → attorney verification →
 * AI parse → LexGuard co-validation (nudge / correct / escalate) → forced
 * review acknowledgment → final blocking re-verify → CRE execution → client
 * notification. Every consequential step is written to the append-only,
 * hash-chained audit trail.
 */

import { create } from "zustand";
import * as backend from "../lib/backend";
import { AI_ACCESSED_FIELDS, parseRetainerDocument } from "../lib/aiParse";
import {
  ExecutionPath,
  type ParsedRetainerPayload,
  type TrustAnchors,
} from "../lexguard/types";
import { primeVDB, queryVDB, type VDBStore } from "../lexguard/vdb";
import {
  diffNumericsWithVDB,
  formatUsd,
  toCents,
  toPayloadCents,
  validateArithmetic,
} from "../lexguard/payload-diff";
import { matchBarNumber, matchClientName } from "../lexguard/anchor-matcher";
import { detectAnomalySuppression } from "../lexguard/anomaly-watcher";
import { detectScopeViolation } from "../lexguard/scope-guard";

export type Screen = "load" | "processing" | "review" | "execution" | "escalation";
export type StepStatus = "pending" | "active" | "done" | "error";

export interface ProcessingStep {
  key: string;
  label: string;
  status: StepStatus;
}

export interface LexGuardCorrection {
  module: string;
  field: string;
  aiValue: string | number;
  observedValue: string | number;
  nudgeCount: number;
  resolved: boolean;
  timestamp: string;
}

export interface Escalation {
  module: string;
  field: string;
  fieldLabel: string;
  aiValue: string;
  observedValue: string;
  recommendation: string;
}

export interface NotificationStatus {
  channel: "email" | "sms";
  target: string;
  status: "sent" | "delivered" | "skipped" | "failed";
}

export interface ExecutionState {
  phase: "idle" | "verifying" | "converting" | "settling" | "notifying" | "done" | "error";
  path: ExecutionPath | null;
  txHash: string | null;
  clientCents: bigint;
  firmCents: bigint;
  notifications: NotificationStatus[];
}

const OPERATOR_DEFAULT = "paralegal@lawfirm.com";

const emptyAnchors: TrustAnchors = {
  attorneyBarNumber: "",
  state: "California",
  clientFullLegalName: "",
  clientEmail: "",
  clientPhone: "",
};

function initialSteps(): ProcessingStep[] {
  return [
    { key: "hash", label: "Hashing artifacts", status: "pending" },
    { key: "bar", label: "Verifying attorney", status: "pending" },
    { key: "ai", label: "AI parsing", status: "pending" },
    { key: "lexguard", label: "LexGuard validating", status: "pending" },
  ];
}

const formatDollars = (n: number): string => formatUsd(toCents(n));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A deterministic UUID-ish id without Math.random dependence at module load.
function newId(prefix: string): string {
  const rand = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${performance.now()}`;
  return `${prefix}-${rand}`;
}

interface SessionState {
  screen: Screen;
  operator: string;
  anchors: TrustAnchors;
  sessionId: string | null;
  file: File | null;
  artifact: backend.LoadedArtifact | null;
  vdb: VDBStore | null;
  payload: ParsedRetainerPayload | null;
  corrections: LexGuardCorrection[];
  escalation: Escalation | null;
  barActive: boolean | null;
  steps: ProcessingStep[];
  execution: ExecutionState;
  error: string | null;
  reviewOpenedAt: number | null;
  scrollCompleted: boolean;
  acknowledged: boolean;
  busy: boolean;

  // actions
  setAnchor: (patch: Partial<TrustAnchors>) => void;
  setFile: (file: File | null) => void;
  reset: () => void;
  beginProcessing: () => Promise<void>;
  markScrollCompleted: () => void;
  setAcknowledged: (v: boolean) => Promise<void>;
  proceedToExecution: () => Promise<void>;
  resolveEscalation: (choice: "review" | "ai" | "lexguard") => Promise<void>;
  buildAuditReport: () => Promise<string>;
}

function stepStatus(steps: ProcessingStep[], key: string, status: StepStatus): ProcessingStep[] {
  return steps.map((s) => (s.key === key ? { ...s, status } : s));
}

export const useSession = create<SessionState>((set, get) => {
  // Sequential audit logger — preserves hash-chain order.
  const log = async (event: string, payload: Record<string, unknown>) => {
    const { sessionId, operator } = get();
    if (!sessionId) return;
    try {
      await backend.logEvent(sessionId, event, operator, JSON.stringify(payload));
    } catch (e) {
      console.error("audit log failed", event, e);
    }
  };

  const setStep = (key: string, status: StepStatus) =>
    set((s) => ({ steps: stepStatus(s.steps, key, status) }));

  return {
    screen: "load",
    operator: OPERATOR_DEFAULT,
    anchors: emptyAnchors,
    sessionId: null,
    file: null,
    artifact: null,
    vdb: null,
    payload: null,
    corrections: [],
    escalation: null,
    barActive: null,
    steps: initialSteps(),
    execution: {
      phase: "idle",
      path: null,
      txHash: null,
      clientCents: 0n,
      firmCents: 0n,
      notifications: [],
    },
    error: null,
    reviewOpenedAt: null,
    scrollCompleted: false,
    acknowledged: false,
    busy: false,

    setAnchor: (patch) => set((s) => ({ anchors: { ...s.anchors, ...patch } })),
    setFile: (file) => set({ file }),

    reset: () =>
      set({
        screen: "load",
        anchors: emptyAnchors,
        sessionId: null,
        file: null,
        artifact: null,
        vdb: null,
        payload: null,
        corrections: [],
        escalation: null,
        barActive: null,
        steps: initialSteps(),
        execution: { phase: "idle", path: null, txHash: null, clientCents: 0n, firmCents: 0n, notifications: [] },
        error: null,
        reviewOpenedAt: null,
        scrollCompleted: false,
        acknowledged: false,
        busy: false,
      }),

    beginProcessing: async () => {
      const { file, anchors } = get();
      if (!file) {
        set({ error: "Please add a retainer document before continuing." });
        return;
      }
      const sessionId = newId("wf");
      set({
        sessionId,
        screen: "processing",
        steps: initialSteps(),
        error: null,
        busy: true,
      });

      try {
        // 1) Hash + normalize in the backend.
        setStep("hash", "active");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const artifact = await backend.loadArtifact(file.name, bytes);
        set({ artifact });
        await backend.createSession({
          sessionId,
          clientId: "pending",
          attorneyBarNumber: anchors.attorneyBarNumber,
          documentHash: artifact.hash,
        });
        await log("document_loaded", {
          filename: artifact.filename,
          hash: artifact.hash,
          size: artifact.size,
        });
        await log("trust_anchors_provided", {
          bar_last4: anchors.attorneyBarNumber.slice(-4),
          state: anchors.state,
          client_name: anchors.clientFullLegalName,
        });
        setStep("hash", "done");

        // 2) Verify attorney (simulated CA State Bar check).
        setStep("bar", "active");
        const active = /^\d{5,8}$/.test(anchors.attorneyBarNumber.trim()) && anchors.state === "California";
        set({ barActive: active });
        await log("bar_verification_result", {
          active,
          source: "ca-state-bar (simulated)",
          bar_last4: anchors.attorneyBarNumber.slice(-4),
        });
        if (!active) {
          setStep("bar", "error");
          set({
            error:
              "Attorney bar number could not be verified as active with the California State Bar. Processing halted.",
            busy: false,
          });
          await backend.updateSessionState(sessionId, "FAILED");
          return;
        }
        setStep("bar", "done");

        // 3) AI parse + VDB prime.
        setStep("ai", "active");
        await backend.updateSessionState(sessionId, "PARSING");
        const vdb = await primeVDB(artifact.normalizedText, artifact.hash, sessionId);
        const { payload, extractedClientName, extractedBarNumber } = parseRetainerDocument(
          artifact.normalizedText,
          anchors,
        );
        set({ vdb, payload });
        setStep("ai", "done");

        // 4) LexGuard co-validation.
        setStep("lexguard", "active");
        const result = runLexGuard({
          payload,
          vdb,
          anchors,
          chainlinkVerifiedBar: anchors.attorneyBarNumber,
          extractedClientName,
          extractedBarNumber,
        });
        set({ payload: result.payload, corrections: result.corrections, escalation: result.escalation });

        for (const c of result.corrections) {
          await log("lexguard_correction", {
            module: c.module,
            field: c.field,
            aiValue: c.aiValue,
            observedValue: c.observedValue,
            nudgeCount: c.nudgeCount,
            resolved: c.resolved,
          });
        }

        const cents = toPayloadCents(result.payload);
        await backend.savePayload({
          payloadId: newId("pl"),
          sessionId,
          totalHeldCents: Number(cents.totalHeldCents),
          earnedFeesCents: Number(cents.earnedFeesCents),
          unearnedBalanceCents: Number(cents.unearnedBalanceCents),
          disputedHours: cents.disputedHours,
          disputedAmountCents: Number(cents.disputedAmountCents),
        });
        setStep("lexguard", "done");

        // 5) Route to escalation or review.
        if (result.escalation) {
          await backend.updateSessionState(sessionId, "ESCALATED");
          set({ screen: "escalation", busy: false });
        } else {
          set({ screen: "review", reviewOpenedAt: Date.now(), scrollCompleted: false, acknowledged: false, busy: false });
          await log("review_screen_opened", {});
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ error: `Processing failed: ${message}`, busy: false });
        setStep("lexguard", "error");
      }
    },

    markScrollCompleted: () => {
      if (get().scrollCompleted) return;
      set({ scrollCompleted: true });
      void log("review_scroll_completed", {});
    },

    setAcknowledged: async (v) => {
      set({ acknowledged: v });
      if (v) {
        await log("acknowledgment_checked", { user: get().operator });
      }
    },

    proceedToExecution: async () => {
      const { file, artifact, payload, sessionId, reviewOpenedAt, anchors } = get();
      if (!file || !artifact || !payload || !sessionId) return;
      set({ busy: true, error: null });

      // Final blocking re-verify — the race-condition fix.
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await backend.finalVerifyBeforeExecution(artifact.filename, bytes);
      } catch (e) {
        const reason =
          typeof e === "object" && e && "reason" in e ? String((e as { reason: unknown }).reason) : String(e);
        set({
          error: `${reason}. The document changed since it was reviewed — reload and re-acknowledge before proceeding.`,
          busy: false,
          acknowledged: false,
        });
        return;
      }

      if (reviewOpenedAt) {
        await log("review_time_on_screen", { duration_ms: Date.now() - reviewOpenedAt, scroll_completed: true });
      }

      const path = payload.recommendedPath;
      await backend.setExecutionPath(sessionId, path);
      await backend.updateSessionState(sessionId, "APPROVED");
      set({ screen: "execution", execution: { ...get().execution, phase: "verifying", path } });
      await log("cre_execution_started", { workflow_id: sessionId, execution_path: path });
      await sleep(700);

      // CRE execution (simulated end-to-end for a self-contained build).
      const cents = toPayloadCents(payload);
      const clientCents = path === ExecutionPath.DirectSettlement ? cents.unearnedBalanceCents : cents.totalHeldCents;
      const firmCents = path === ExecutionPath.DirectSettlement ? cents.earnedFeesCents : 0n;
      const txHash = ("0x" + artifact.hash.replace("sha256:", "").slice(0, 64)) as string;

      set({ execution: { ...get().execution, phase: "converting", clientCents, firmCents, txHash, path } });
      await sleep(700);
      set({ execution: { ...get().execution, phase: "settling", clientCents, firmCents, txHash, path } });
      await sleep(900);

      await backend.updateSessionState(sessionId, "EXECUTED");
      await log("cre_execution_completed", {
        workflow_id: sessionId,
        execution_path: path,
        client_amount_usdc: Number(clientCents) / 100,
        firm_amount_usdc: Number(firmCents) / 100,
        tx_hash: txHash,
        client_wallet: payload.clientWallet,
        firm_wallet: payload.lawFirmWallet,
      });
      await log("settlement_on_chain", { document_hash: artifact.hash, tx_hash: txHash });

      // Client notification (post-settlement only).
      set({ execution: { ...get().execution, phase: "notifying", clientCents, firmCents, txHash, path } });
      const notifications = await sendNotifications(anchors, clientCents, txHash, log);

      set({ execution: { phase: "done", path, txHash, clientCents, firmCents, notifications } });
      set({ busy: false });
    },

    resolveEscalation: async (choice) => {
      const { escalation, payload, sessionId } = get();
      if (!escalation || !payload || !sessionId) return;
      await log("lexguard_escalation", {
        module: escalation.module,
        field: escalation.field,
        aiValue: escalation.aiValue,
        observedValue: escalation.observedValue,
        user_decision: choice,
        user: get().operator,
      });

      if (choice === "review") {
        set({ screen: "load" });
        return;
      }

      // Adopt the chosen value for a numeric escalation, then proceed to review.
      const next = { ...payload };
      if (escalation.field === "unearnedBalance") {
        const raw = choice === "lexguard" ? escalation.observedValue : escalation.aiValue;
        const parsed = parseFloat(String(raw).replace(/[$,\s]/g, ""));
        if (Number.isFinite(parsed)) next.unearnedBalance = parsed;
      }
      set({ payload: next, escalation: null, screen: "review", reviewOpenedAt: Date.now(), scrollCompleted: false, acknowledged: false });
      await backend.updateSessionState(sessionId, "PARSING");
      await log("review_screen_opened", { after_escalation: true });
    },

    buildAuditReport: async () => {
      const { sessionId, anchors, artifact, payload } = get();
      if (!sessionId) return "{}";
      const trail = await backend.getAuditTrail(sessionId);
      const chain = await backend.verifyAuditChain();
      return JSON.stringify(
        {
          session_id: sessionId,
          generated_at: new Date().toISOString(),
          client: anchors.clientFullLegalName,
          attorney_bar_number: anchors.attorneyBarNumber,
          document_hash: artifact?.hash ?? null,
          recommended_path: payload?.recommendedPath ?? null,
          chain_verification: chain,
          audit_trail: trail,
        },
        null,
        2,
      );
    },
  };
});

// ── LexGuard orchestration ──────────────────────────────────────────────────

interface LexGuardInput {
  payload: ParsedRetainerPayload;
  vdb: VDBStore;
  anchors: TrustAnchors;
  chainlinkVerifiedBar: string;
  extractedClientName: string | null;
  extractedBarNumber: string | null;
}

interface LexGuardResult {
  payload: ParsedRetainerPayload;
  corrections: LexGuardCorrection[];
  escalation: Escalation | null;
}

function runLexGuard(input: LexGuardInput): LexGuardResult {
  const corrections: LexGuardCorrection[] = [];
  const payload = { ...input.payload };
  const now = () => new Date().toISOString();

  // 1) VDB-assisted numeric diff. If AI's unearned balance disagrees with a
  // single confident VDB observation, nudge once and adopt it (logged).
  let diffs = diffNumericsWithVDB(payload, input.vdb);
  const uniqueUnearned = [...new Set(queryVDB(input.vdb, "numeric", "unearnedBalance").map((e) => Number(e.value)))];
  if (diffs.some((d) => d.field === "unearnedBalance") && uniqueUnearned.length === 1) {
    const observed = uniqueUnearned[0];
    corrections.push({
      module: "payload-diff",
      field: "unearnedBalance",
      aiValue: payload.unearnedBalance,
      observedValue: observed,
      nudgeCount: 1,
      resolved: true,
      timestamp: now(),
    });
    payload.unearnedBalance = observed;
    diffs = diffNumericsWithVDB(payload, input.vdb);
  }

  const arithmeticBroken = !validateArithmetic(payload);
  const barOk = matchBarNumber(input.extractedBarNumber, input.anchors.attorneyBarNumber, input.chainlinkVerifiedBar);
  const clientNameOk = input.extractedClientName
    ? matchClientName(input.extractedClientName, input.anchors.clientFullLegalName)
    : true;
  const suppressed = detectAnomalySuppression(payload.anomaliesFlagged, payload.anomaliesSuppressed, payload.recommendedPath);
  const scopeViolations = detectScopeViolation(AI_ACCESSED_FIELDS);

  // First unresolved discrepancy becomes the escalation.
  let escalation: Escalation | null = null;
  const unearnedDiff = diffs.find((d) => d.field === "unearnedBalance");
  if (unearnedDiff) {
    escalation = {
      module: "payload-diff",
      field: "unearnedBalance",
      fieldLabel: "Unearned Balance",
      aiValue: formatDollars(Number(unearnedDiff.aiValue)),
      observedValue: formatDollars(Number(unearnedDiff.observedValue)),
      recommendation: "Review the billing records section of the retainer agreement before proceeding.",
    };
  } else if (arithmeticBroken) {
    escalation = {
      module: "payload-diff",
      field: "arithmetic",
      fieldLabel: "Retainer Arithmetic",
      aiValue: `${formatDollars(payload.earnedFees)} + ${formatDollars(payload.unearnedBalance)} = ${formatDollars(
        payload.earnedFees + payload.unearnedBalance,
      )}`,
      observedValue: `${formatDollars(payload.totalHeld)} total held`,
      recommendation:
        "Earned fees plus unearned balance do not equal the total retainer held. Review the billing reconciliation section before proceeding.",
    };
  } else if (!barOk) {
    escalation = {
      module: "anchor-matcher",
      field: "barNumber",
      fieldLabel: "Attorney Bar Number",
      aiValue: input.extractedBarNumber ?? "—",
      observedValue: input.anchors.attorneyBarNumber,
      recommendation: "The bar number found in the document does not match the verified attorney identity.",
    };
  } else if (!clientNameOk) {
    escalation = {
      module: "anchor-matcher",
      field: "clientName",
      fieldLabel: "Client Name",
      aiValue: input.extractedClientName ?? "—",
      observedValue: input.anchors.clientFullLegalName,
      recommendation: "The client name in the document does not match the name entered at document load.",
    };
  } else if (suppressed) {
    escalation = {
      module: "anomaly-watcher",
      field: "anomaliesSuppressed",
      fieldLabel: "Flagged Anomalies",
      aiValue: "Routed to direct settlement",
      observedValue: `${payload.anomaliesFlagged.length} anomaly(ies) flagged`,
      recommendation:
        "Anomalies were flagged during parsing but the workflow would proceed to direct settlement. Route to arbitration or resolve the anomalies.",
    };
  } else if (scopeViolations.length > 0) {
    escalation = {
      module: "scope-guard",
      field: scopeViolations[0],
      fieldLabel: "Field Access",
      aiValue: scopeViolations.join(", "),
      observedValue: "authorized fields only",
      recommendation: "AI accessed one or more fields outside the authorized set for a retainer release.",
    };
  }

  return { payload, corrections, escalation };
}

// ── Notifications (Phase 7 wires the Rust SMTP/Twilio backend) ───────────────

async function sendNotifications(
  anchors: TrustAnchors,
  clientCents: bigint,
  txHash: string,
  log: (event: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<NotificationStatus[]> {
  const out: NotificationStatus[] = [];

  const email = await backend.sendClientNotification({
    channel: "email",
    to: anchors.clientEmail,
    clientName: anchors.clientFullLegalName,
    amountCents: Number(clientCents),
    reference: txHash,
  });
  out.push(email);
  await log("client_notification_sent", {
    channel: "email",
    delivery_status: email.status,
    amount_usdc: Number(clientCents) / 100,
    ref: txHash,
  });

  if (anchors.clientPhone && anchors.clientPhone.trim()) {
    const sms = await backend.sendClientNotification({
      channel: "sms",
      to: anchors.clientPhone,
      clientName: anchors.clientFullLegalName,
      amountCents: Number(clientCents),
      reference: txHash,
    });
    out.push(sms);
    await log("client_notification_sent", {
      channel: "sms",
      delivery_status: sms.status,
      amount_usdc: Number(clientCents) / 100,
      ref: txHash,
    });
  }

  return out;
}
