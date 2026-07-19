/**
 * Practice-management integration tests.
 *
 * The load-bearing assertions are the negative ones. A webhook posts to a
 * server LexEscrow does not control, so two properties matter more than any
 * happy path: nothing sensitive may appear in an outbound payload, and no
 * delivery outcome may ever propagate as a failure — the escrow event being
 * reported has already happened and is already on the audit chain.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendClioWebhook,
  buildClioPayload,
  CLIO_EVENTS,
  type ClioConfig,
} from "./clio-webhook";
import {
  sendPracticePantherWebhook,
  buildPracticePantherPayload,
  PRACTICE_PANTHER_TRIGGERS,
  type PracticePantherConfig,
} from "./practice-panther";
import {
  fireIntegrationWebhooks,
  clioEventName,
  practicePantherTriggerName,
  INTEGRATION_EVENTS,
} from "./index";
import { ExecutionPath } from "../../lexguard/types";
import type { SessionState } from "../../store/session";

const CLIO: ClioConfig = {
  webhookUrl: "https://clio.example.test/hooks",
  matterId: "MATTER-0042",
  apiKey: "clio-secret-token",
};

const PP: PracticePantherConfig = {
  webhookUrl: "https://pp.example.test/hooks",
  apiKey: "pp-secret-token",
};

const WALLET = "0xC0FFEE0000000000000000000000000000001234";
const FIRM_WALLET = "0xBEEF000000000000000000000000000000005678";
const BAR_NUMBER = "447823";
const LICENSE_NUMBER = "C10-0001234-LIC";

/** A fully-populated session — every sensitive field present, so exclusion is
 *  actually being exercised rather than passing by absence. */
function sessionState(over: Record<string, unknown> = {}): SessionState {
  return {
    sessionId: "wf-1234",
    assetClass: "legal",
    operator: "paralegal@lawfirm.example.com",
    anchors: {
      attorneyBarNumber: BAR_NUMBER,
      state: "California",
      clientFullLegalName: "Meridian Consulting Group LLC",
      clientEmail: "client@example.com",
      clientPhone: "",
    },
    rawAnchors: {
      stateLicenseNumber: LICENSE_NUMBER,
      attorneyBarNumber: BAR_NUMBER,
      metrcFacilityId: "MTRC-CA-00042",
    },
    payload: {
      clientId: "C-1",
      lawFirmWallet: FIRM_WALLET,
      clientWallet: WALLET,
      totalHeld: 18500,
      earnedFees: 6200,
      unearnedBalance: 12300,
      disputedHours: 0,
      disputedAmount: 0,
      signaturesVerified: true,
      recommendedPath: ExecutionPath.DirectSettlement,
      anomaliesFlagged: [],
      anomaliesSuppressed: false,
      barNumber: BAR_NUMBER,
      clientName: "Meridian Consulting Group LLC",
      extractedBarNumber: BAR_NUMBER,
    },
    artifact: { hash: "sha256:deadbeef", filename: "retainer.txt", size: 10, normalizedText: "" },
    anchorReceipt: null,
    execution: {
      phase: "done",
      path: ExecutionPath.DirectSettlement,
      txHash: "0xsettlement",
      clientCents: 0n,
      firmCents: 0n,
      notifications: [],
    },
    conditionSummary: { total: 3, met: 3, pending: 0, failed: 0, allMet: true },
    ...over,
  } as unknown as SessionState;
}

/** The parts of a captured `fetch` init the assertions below care about. */
interface CapturedInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Stub `fetch` with a fixed status. Returns the spy for request assertions. */
function stubFetch(status = 200) {
  // Params are declared so `mock.calls` is typed as a two-element tuple — a
  // zero-arg spy types every call as `[]` and defeats the assertions below.
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
  }));
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

type FetchSpy = ReturnType<typeof stubFetch>;

function initOf(spy: FetchSpy, call = 0): CapturedInit {
  return spy.mock.calls[call][1] as unknown as CapturedInit;
}

function bodyOf(spy: FetchSpy, call = 0): Record<string, unknown> {
  return JSON.parse(initOf(spy, call).body);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sendClioWebhook", () => {
  const payload = {
    event: CLIO_EVENTS.settlementComplete,
    sessionId: "wf-1234",
    assetClass: "legal",
    timestamp: "2026-07-18T12:00:00.000Z",
    data: {},
  };

  it("reports success on a 2xx", async () => {
    stubFetch(200);
    expect(await sendClioWebhook(CLIO, payload)).toEqual({ success: true, statusCode: 200 });
  });

  it("reports failure on a non-2xx without throwing", async () => {
    stubFetch(500);
    const result = await sendClioWebhook(CLIO, payload);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toBe("HTTP 500");
  });

  it("reports failure on a network error without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    const result = await sendClioWebhook(CLIO, payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.statusCode).toBeUndefined();
  });

  it("sends the bearer token and JSON content type", async () => {
    const spy = stubFetch();
    await sendClioWebhook(CLIO, payload);
    const init = initOf(spy);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer clio-secret-token");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const spy = stubFetch();
    await sendClioWebhook({ webhookUrl: CLIO.webhookUrl }, payload);
    expect(initOf(spy).headers.authorization).toBeUndefined();
  });

  it("fills the matter ID in from the config", async () => {
    const spy = stubFetch();
    await sendClioWebhook(CLIO, payload);
    expect(bodyOf(spy).matterId).toBe("MATTER-0042");
  });

  it("fails without attempting a request when no URL is configured", async () => {
    const spy = stubFetch();
    const result = await sendClioWebhook({ webhookUrl: "" }, payload);
    expect(result.success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("sendPracticePantherWebhook", () => {
  const payload = {
    trigger: PRACTICE_PANTHER_TRIGGERS.settlementComplete,
    source: "lexescrow" as const,
    session_id: "wf-1234",
    occurred_at: "2026-07-18T12:00:00.000Z",
    metadata: {},
  };

  it("reports success on a 2xx", async () => {
    stubFetch(202);
    expect(await sendPracticePantherWebhook(PP, payload)).toEqual({ success: true, statusCode: 202 });
  });

  it("reports failure on a non-2xx without throwing", async () => {
    stubFetch(403);
    const result = await sendPracticePantherWebhook(PP, payload);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("reports failure on a network error without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
    );
    const result = await sendPracticePantherWebhook(PP, payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain("socket hang up");
  });
});

describe("payload construction", () => {
  it("buildClioPayload excludes wallet addresses", () => {
    const serialized = JSON.stringify(buildClioPayload(CLIO_EVENTS.settlementComplete, sessionState()));
    expect(serialized).not.toContain(WALLET);
    expect(serialized).not.toContain(FIRM_WALLET);
    expect(serialized).not.toContain("clientWallet");
    expect(serialized).not.toContain("lawFirmWallet");
  });

  it("buildClioPayload excludes bar and license numbers", () => {
    const serialized = JSON.stringify(buildClioPayload(CLIO_EVENTS.settlementComplete, sessionState()));
    expect(serialized).not.toContain(BAR_NUMBER);
    expect(serialized).not.toContain(LICENSE_NUMBER);
    expect(serialized).not.toContain("barNumber");
  });

  it("buildPracticePantherPayload excludes the same sensitive fields", () => {
    const serialized = JSON.stringify(
      buildPracticePantherPayload(PRACTICE_PANTHER_TRIGGERS.settlementComplete, sessionState()),
    );
    expect(serialized).not.toContain(WALLET);
    expect(serialized).not.toContain(FIRM_WALLET);
    expect(serialized).not.toContain(BAR_NUMBER);
    expect(serialized).not.toContain(LICENSE_NUMBER);
  });

  it("buildClioPayload carries the useful non-sensitive facts", () => {
    const payload = buildClioPayload(CLIO_EVENTS.settlementComplete, sessionState());
    expect(payload.event).toBe("lexescrow.settlement.complete");
    expect(payload.sessionId).toBe("wf-1234");
    expect(payload.assetClass).toBe("legal");
    expect(payload.data.operator).toBe("paralegal@lawfirm.example.com");
    expect(payload.data.escrowAmountUsd).toBe(18500);
    expect(payload.data.executionPath).toBe(ExecutionPath.DirectSettlement);
    expect(payload.data.settlementTxHash).toBe("0xsettlement");
    expect(Date.parse(payload.timestamp)).not.toBeNaN();
  });

  it("buildPracticePantherPayload uses 'trigger', not 'event'", () => {
    const payload = buildPracticePantherPayload(
      PRACTICE_PANTHER_TRIGGERS.settlementComplete,
      sessionState(),
    );
    expect(payload.trigger).toBe("escrow_settlement_complete");
    expect(payload).not.toHaveProperty("event");
    // …and the rest of the snake_case envelope Clio does not use.
    expect(payload.source).toBe("lexescrow");
    expect(payload.session_id).toBe("wf-1234");
    expect(payload.metadata.escrowAmountUsd).toBe(18500);
    expect(payload).not.toHaveProperty("data");
  });

  it("tolerates a session with nothing parsed yet", () => {
    const empty = sessionState({
      payload: null,
      artifact: null,
      execution: { phase: "idle", path: null, txHash: null, clientCents: 0n, firmCents: 0n, notifications: [] },
      conditionSummary: { total: 0, met: 0, pending: 0, failed: 0, allMet: false },
    });
    const payload = buildClioPayload(CLIO_EVENTS.sessionCreated, empty);
    expect(payload.data.escrowAmountUsd).toBe(0);
    expect(payload.data.settlementTxHash).toBeUndefined();
    expect(payload.data.conditions).toBeUndefined();
  });
});

describe("event naming", () => {
  it("derives each vendor's name for all six canonical events", () => {
    // Pins the derivation against the vendor-facing constants, so the two
    // cannot drift apart without a failure here.
    expect(INTEGRATION_EVENTS.map(clioEventName)).toEqual([
      CLIO_EVENTS.sessionCreated,
      CLIO_EVENTS.reviewApproved,
      CLIO_EVENTS.fundsDeposited,
      CLIO_EVENTS.conditionsMet,
      CLIO_EVENTS.settlementComplete,
      CLIO_EVENTS.receiptIssued,
    ]);
    expect(INTEGRATION_EVENTS.map(practicePantherTriggerName)).toEqual([
      PRACTICE_PANTHER_TRIGGERS.sessionCreated,
      PRACTICE_PANTHER_TRIGGERS.reviewApproved,
      PRACTICE_PANTHER_TRIGGERS.fundsDeposited,
      PRACTICE_PANTHER_TRIGGERS.conditionsMet,
      PRACTICE_PANTHER_TRIGGERS.settlementComplete,
      PRACTICE_PANTHER_TRIGGERS.receiptIssued,
    ]);
  });
});

describe("fireIntegrationWebhooks", () => {
  it("fires both vendors concurrently", async () => {
    let resolveClio: () => void = () => {};
    const started: string[] = [];
    const spy = vi.fn(async (url: string) => {
      started.push(url);
      // Clio hangs until released; PracticePanther must still get away.
      if (url === CLIO.webhookUrl) await new Promise<void>((r) => (resolveClio = r));
      return { ok: true, status: 200 };
    });
    vi.stubGlobal("fetch", spy as unknown as typeof fetch);

    const pending = fireIntegrationWebhooks("settlement.complete", sessionState(), {
      clio: CLIO,
      practicePanther: PP,
    });

    // Both requests are in flight before either has resolved.
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toContain(CLIO.webhookUrl);
    expect(started).toContain(PP.webhookUrl);

    resolveClio();
    await expect(pending).resolves.toBeUndefined();
  });

  it("sends each vendor its own event vocabulary", async () => {
    const spy = stubFetch();
    await fireIntegrationWebhooks("funds.deposited", sessionState(), {
      clio: CLIO,
      practicePanther: PP,
    });

    const bodies = spy.mock.calls.map((_, i) => bodyOf(spy, i));
    const clioBody = bodies.find((b) => "event" in b)!;
    const ppBody = bodies.find((b) => "trigger" in b)!;
    expect(clioBody.event).toBe("lexescrow.funds.deposited");
    expect(ppBody.trigger).toBe("escrow_funds_deposited");
  });

  it("resolves even when one vendor fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === CLIO.webhookUrl) throw new Error("Clio is down");
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch,
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      fireIntegrationWebhooks("settlement.complete", sessionState(), {
        clio: CLIO,
        practicePanther: PP,
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves when both vendors fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      fireIntegrationWebhooks("settlement.complete", sessionState(), {
        clio: CLIO,
        practicePanther: PP,
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when no configs are provided", async () => {
    const spy = stubFetch();
    await fireIntegrationWebhooks("settlement.complete", sessionState(), {});
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops for a vendor configured without a URL", async () => {
    const spy = stubFetch();
    await fireIntegrationWebhooks("settlement.complete", sessionState(), {
      clio: { webhookUrl: "" },
      practicePanther: { webhookUrl: "" },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("routes through the transport override instead of posting directly", async () => {
    // The Tauri path: configs arrive without an API key and delivery is
    // delegated to the backend, so no fetch may leave the WebView.
    const spy = stubFetch();
    const transport = vi.fn(async () => ({ success: true, statusCode: 200 }));

    await fireIntegrationWebhooks("receipt.issued", sessionState(), {
      clio: { webhookUrl: CLIO.webhookUrl, matterId: "MATTER-0042" },
      practicePanther: { webhookUrl: PP.webhookUrl },
      transport,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
    const [[clioVendor, clioBody], [ppVendor, ppBody]] = transport.mock.calls as unknown as [
      [string, Record<string, unknown>],
      [string, Record<string, unknown>],
    ];
    expect(clioVendor).toBe("clio");
    expect(clioBody.event).toBe("lexescrow.receipt.issued");
    expect(clioBody.matterId).toBe("MATTER-0042");
    expect(ppVendor).toBe("practicePanther");
    expect(ppBody.trigger).toBe("escrow_receipt_issued");
  });
});
