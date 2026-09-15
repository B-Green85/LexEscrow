// @vitest-environment jsdom
/**
 * Embedded signing tests (spec §22).
 *
 * The panel is the one place in the eSign layer with real lifecycle — an async
 * URL fetch, a WebView it owns, and a Tauri subscription it must tear down — so
 * unlike the other screen tests these mount into a DOM rather than rendering to
 * a string. The Tauri surface (`listen`, `WebviewWindow`) and the provider are
 * mocked; everything between them is the real component.
 *
 * The assertions that matter most are the ones about *not* completing: a
 * cancelled ceremony, a declined one, and an event belonging to a different
 * envelope must all leave the signature uncollected, because `onComplete` is
 * what runs the certificate pipeline and fulfills the condition.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createElement, StrictMode } from "react";
import type { EmbeddedSigningResult, eSignProvider } from "../lib/esign";

// Hoisted so the `vi.mock` factories below — which are lifted above the
// imports — can reach the same objects the tests assert against.
const tauri = vi.hoisted(() => ({
  handler: null as ((event: { payload: EmbeddedSigningResult }) => void) | null,
  unlisten: null as ReturnType<typeof vi.fn> | null,
  windows: [] as Array<{
    label: string;
    options: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
    /** Fires the window's close-requested handler, as the red X would. */
    requestClose: () => void;
    closeUnlisten: ReturnType<typeof vi.fn>;
  }>,
}));

const esign = vi.hoisted(() => ({
  provider: null as Partial<eSignProvider> | null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: EmbeddedSigningResult }) => void) => {
    tauri.handler = cb;
    tauri.unlisten = vi.fn();
    return tauri.unlisten;
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    close = vi.fn(async () => {});
    private closeHandler: (() => void) | null = null;
    onCloseRequested = vi.fn(async (handler: () => void) => {
      this.closeHandler = handler;
      return this.closeUnlisten;
    });
    closeUnlisten = vi.fn();
    constructor(label: string, options: Record<string, unknown>) {
      tauri.windows.push({
        label,
        options,
        close: this.close,
        closeUnlisten: this.closeUnlisten,
        requestClose: () => this.closeHandler?.(),
      });
    }
  },
}));

vi.mock("../lib/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/backend")>()),
  isTauri: () => true,
}));

vi.mock("../lib/esign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/esign")>()),
  resolveESignProvider: async () => esign.provider,
}));

import {
  CLOSE_GRACE_MS,
  EmbeddedSigningPanel,
  isSigningComplete,
  outcomeFromUrl,
} from "./EmbeddedSigningPanel";
import {
  ConditionDefinitionView,
  deriveSigners,
  syntheticSignerEmail,
  type ConditionDefinitionViewProps,
} from "../screens/ConditionDefinition";
import { anchorsToTrustAnchors, ASSET_CLASSES, emptyAnchorsFor, type AssetClass } from "../lib/assetClasses";

const SIGNING_URL = "https://demo.docusign.net/Signing/StartInSession?t=abc123";
const ENVELOPE_ID = "DEMO-ENV-1700000000";
const SIGNER = {
  email: "officer@lawfirm.example",
  name: "Dana Whitfield",
  clientUserId: "paralegal@lawfirm.example-officer@lawfirm.example",
};

type GetUrl = NonNullable<eSignProvider["getEmbeddedSigningUrl"]>;

let getEmbeddedSigningUrl: Mock<GetUrl>;
let onComplete: Mock<(event: string) => void>;
let onCancel: Mock<() => void>;

beforeEach(() => {
  tauri.handler = null;
  tauri.unlisten = null;
  tauri.windows = [];

  getEmbeddedSigningUrl = vi.fn<GetUrl>(async () => SIGNING_URL);
  onComplete = vi.fn<(event: string) => void>();
  onCancel = vi.fn<() => void>();

  esign.provider = { providerName: () => "DocuSign", getEmbeddedSigningUrl };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  return render(
    <EmbeddedSigningPanel
      envelopeId={ENVELOPE_ID}
      signerEmail={SIGNER.email}
      signerName={SIGNER.name}
      clientUserId={SIGNER.clientUserId}
      onComplete={onComplete}
      onCancel={onCancel}
    />,
  );
}

/** Mount and wait until the ceremony is open and listening. */
async function mountAndOpen() {
  const result = mount();
  await screen.findByText(/Signing in progress/);
  return result;
}

/** Deliver a callback event as the loopback listener would. */
async function emit(event: string, envelopeId: string = ENVELOPE_ID) {
  await act(async () => {
    tauri.handler?.({ payload: { envelopeId, event } });
  });
}

// ── Mount and URL acquisition ────────────────────────────────────────────────

describe("EmbeddedSigningPanel — opening the ceremony", () => {
  it("shows a loading state on mount", () => {
    mount();
    // Synchronous assertion: the URL fetch has not resolved yet.
    expect(screen.getByText(/Preparing signing session/)).toBeTruthy();
  });

  it("calls getEmbeddedSigningUrl on mount with the signer's identity", async () => {
    mount();
    await waitFor(() => expect(getEmbeddedSigningUrl).toHaveBeenCalledOnce());
    expect(getEmbeddedSigningUrl).toHaveBeenCalledWith(
      ENVELOPE_ID,
      SIGNER.email,
      SIGNER.name,
      SIGNER.clientUserId,
    );
  });

  it("shows the waiting state while the signing panel is open", async () => {
    await mountAndOpen();
    expect(screen.getByText(/complete the signature in the DocuSign window/)).toBeTruthy();
    expect(screen.getByText(ENVELOPE_ID)).toBeTruthy();
  });

  it("opens a WebviewWindow at the signing URL", async () => {
    await mountAndOpen();

    expect(tauri.windows).toHaveLength(1);
    expect(tauri.windows[0].label).toBe("esign-panel");
    expect(tauri.windows[0].options.url).toBe(SIGNING_URL);
    expect(tauri.windows[0].options.title).toBe("Sign Document — LexEscrow");
    expect(tauri.windows[0].options.width).toBe(900);
    expect(tauri.windows[0].options.height).toBe(700);
  });

  it("subscribes to the completion event before opening the window", async () => {
    // A demo ceremony completes on redirect, which can beat a subscription
    // registered afterwards — the panel would then wait on an event already
    // fired.
    await mountAndOpen();
    expect(tauri.handler).not.toBeNull();
  });

  it("surfaces an error when the provider cannot host an in-app ceremony", async () => {
    esign.provider = { providerName: () => "HelloSign" };
    mount();

    await screen.findByText(/In-app signing unavailable/);
    expect(screen.getByText(/does not support in-app signing/)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("surfaces an error when minting the signing URL fails", async () => {
    esign.provider = {
      providerName: () => "DocuSign",
      getEmbeddedSigningUrl: vi.fn<GetUrl>(async () => {
        throw new Error("DocuSign refused the embedded signing view (HTTP 400)");
      }),
    };
    mount();

    await screen.findByText(/In-app signing unavailable/);
    expect(screen.getByText(/HTTP 400/)).toBeTruthy();
  });
});

// ── Outcomes ─────────────────────────────────────────────────────────────────

describe("EmbeddedSigningPanel — outcomes", () => {
  it("calls onComplete when signing_complete is received", async () => {
    await mountAndOpen();
    await emit("signing_complete");

    expect(onComplete).toHaveBeenCalledWith("signing_complete");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when a cancel event is received", async () => {
    await mountAndOpen();
    await emit("cancel");

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("calls onCancel when the signer declines", async () => {
    await mountAndOpen();
    await emit("decline");

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each(["session_timeout", "ttl_expired", "viewing_complete"])(
    "treats %s as no signature collected",
    async (event) => {
      await mountAndOpen();
      await emit(event);

      expect(onComplete).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledOnce();
    },
  );

  it("closes the signing window once the ceremony resolves", async () => {
    await mountAndOpen();
    const webview = tauri.windows[0];
    await emit("signing_complete");

    expect(webview.close).toHaveBeenCalled();
    expect(tauri.unlisten).toHaveBeenCalled();
  });

  it("ignores an event belonging to a different envelope", async () => {
    await mountAndOpen();
    await emit("signing_complete", "SOME-OTHER-ENVELOPE");

    expect(onComplete).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // Still waiting on its own envelope.
    expect(screen.getByText(/Signing in progress/)).toBeTruthy();
  });

  it("resolves only once when the same outcome arrives twice", async () => {
    // A duplicate would re-run the certificate pipeline against an envelope
    // already registered on-chain.
    await mountAndOpen();
    await emit("signing_complete");
    await emit("signing_complete");

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("cancels the ceremony from the main window's Cancel button", async () => {
    await mountAndOpen();
    const webview = tauri.windows[0];

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(webview.close).toHaveBeenCalled();
  });

  it("treats a signing window closed by hand as an abandoned ceremony", async () => {
    // No redirect happens when the officer closes the window, so no
    // `esign:embedded_complete` is ever emitted — without the close listener
    // the panel would wait on an event that is not coming.
    await mountAndOpen();

    await act(async () => {
      tauri.windows[0].requestClose();
    });
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce(), {
      timeout: CLOSE_GRACE_MS + 2000,
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("lets a completion already in flight win over the window closing", async () => {
    // The signer finishes and then closes the window themselves: the redirect
    // has fired, so a signature exists. Reading the close as a cancellation
    // would leave that signature uncollected until the next 30-second poll.
    await mountAndOpen();

    await act(async () => {
      tauri.windows[0].requestClose();
    });
    await emit("signing_complete");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS + 50));
    });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("drops the close subscription once the ceremony resolves", async () => {
    await mountAndOpen();
    const webview = tauri.windows[0];
    await emit("signing_complete");

    // `close()` raises close-requested in Tauri; a live subscription would fire
    // the grace timer against an envelope already handed to the pipeline.
    expect(webview.closeUnlisten).toHaveBeenCalled();
  });

  it("unsubscribes on unmount so a later event cannot resolve a dead panel", async () => {
    const { unmount } = await mountAndOpen();
    unmount();

    expect(tauri.unlisten).toHaveBeenCalled();
    expect(tauri.windows[0].closeUnlisten).toHaveBeenCalled();
    expect(tauri.windows[0].close).toHaveBeenCalled();
  });
});

// ── StrictMode ───────────────────────────────────────────────────────────────

/**
 * The regression these guard (the "Preparing signing session…" hang).
 *
 * StrictMode double-invokes an effect on mount: setup → teardown → setup. The
 * teardown cancels the *first* run's closure, so if the second run declines to
 * start — which is what a `useRef` "have we started?" guard makes it do, since
 * a ref survives the simulated remount — nobody is left to open the ceremony.
 * The first run then resolves into a cancelled closure and returns silently,
 * and the panel sits on its loading state for good. An error does the same,
 * which is what made the hang indistinguishable from a backend that never
 * answered.
 *
 * Every assertion below is really the same one: under StrictMode the panel must
 * reach a *terminal* phase — waiting or error — and never stay at loading.
 */
function mountStrict() {
  return render(
    <StrictMode>
      <EmbeddedSigningPanel
        envelopeId={ENVELOPE_ID}
        signerEmail={SIGNER.email}
        signerName={SIGNER.name}
        clientUserId={SIGNER.clientUserId}
        onComplete={onComplete}
        onCancel={onCancel}
      />
    </StrictMode>,
  );
}

describe("EmbeddedSigningPanel — StrictMode double-invoked effect", () => {
  it("reaches the waiting state instead of staying at loading", async () => {
    mountStrict();

    await screen.findByText(/complete the signature in the DocuSign window/);
    expect(screen.queryByText(/Preparing signing session/)).toBeNull();
  });

  it("opens exactly one signing window", async () => {
    mountStrict();

    await screen.findByText(/complete the signature in the DocuSign window/);
    // The superseded run drops the URL it minted rather than opening a second
    // ceremony with it — recipient views are single-use, so it cannot be
    // handed to the surviving run and is simply spent.
    expect(tauri.windows).toHaveLength(1);
    expect(tauri.windows[0].options.url).toBe(SIGNING_URL);
  });

  it("does not report a cancellation when the first run is superseded", async () => {
    mountStrict();

    await screen.findByText(/complete the signature in the DocuSign window/);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("surfaces a minting failure instead of staying at loading", async () => {
    esign.provider = {
      providerName: () => "DocuSign",
      getEmbeddedSigningUrl: vi.fn<GetUrl>(async () => {
        throw new Error("DocuSign refused the embedded signing view (HTTP 400)");
      }),
    };
    mountStrict();

    await screen.findByText(/In-app signing unavailable/);
    expect(screen.getByText(/HTTP 400/)).toBeTruthy();
    expect(screen.queryByText(/Preparing signing session/)).toBeNull();
  });

  it("surfaces a provider that cannot host an in-app ceremony", async () => {
    esign.provider = { providerName: () => "HelloSign" };
    mountStrict();

    await screen.findByText(/In-app signing unavailable/);
    expect(screen.queryByText(/Preparing signing session/)).toBeNull();
  });

  it("opens the ceremony from a Sign Here click", async () => {
    const props: ConditionDefinitionViewProps = {
      // The envelope must already exist and the signer's turn must have come —
      // "Sign Here" is inert otherwise, which is the point of the gating.
      ...sentProps("legal", "in_app", 2),
      onSignInApp: async (signer) => ({
        envelopeId: ENVELOPE_ID,
        clientUserId: SIGNER.clientUserId,
        signer: { ...signer, clientUserId: SIGNER.clientUserId },
      }),
    };
    render(
      <StrictMode>
        <ConditionDefinitionView {...props} />
      </StrictMode>,
    );

    fireEvent.click(screen.getAllByText("Sign Here")[0]);

    await screen.findByText(/complete the signature in the DocuSign window/);
    expect(screen.queryByText(/Preparing signing session/)).toBeNull();
  });
});

// ── Teardown mid-request ─────────────────────────────────────────────────────

describe("EmbeddedSigningPanel — torn down before the URL arrives", () => {
  it("reports an abandoned ceremony rather than returning silently", async () => {
    let release: (url: string) => void = () => {};
    getEmbeddedSigningUrl.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const { unmount } = mount();
    await waitFor(() => expect(getEmbeddedSigningUrl).toHaveBeenCalledOnce());
    unmount();

    // The URL lands on a panel that is already gone. No successor run exists,
    // so the envelope was raised and never opened — a cancellation, not a
    // no-op.
    await act(async () => {
      release(SIGNING_URL);
    });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(tauri.windows).toHaveLength(0);
  });

  it("reports an abandoned ceremony when the request fails after teardown", async () => {
    let reject: (e: Error) => void = () => {};
    getEmbeddedSigningUrl.mockImplementation(
      () =>
        new Promise<string>((_, r) => {
          reject = r;
        }),
    );

    const { unmount } = mount();
    await waitFor(() => expect(getEmbeddedSigningUrl).toHaveBeenCalledOnce());
    unmount();

    await act(async () => {
      reject(new Error("DocuSign recipient view request failed: operation timed out"));
    });

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

// ── Outcome classification ───────────────────────────────────────────────────

describe("isSigningComplete", () => {
  it("accepts only signing_complete", () => {
    expect(isSigningComplete("signing_complete")).toBe(true);
    for (const e of ["cancel", "decline", "session_timeout", "ttl_expired", "viewing_complete"]) {
      expect(isSigningComplete(e)).toBe(false);
    }
  });

  it("rejects an unrecognized event rather than defaulting to complete", () => {
    expect(isSigningComplete("")).toBe(false);
    expect(isSigningComplete("some_new_docusign_event")).toBe(false);
  });
});

describe("outcomeFromUrl", () => {
  it("reads the outcome the demo provider encodes in the signing URL", () => {
    expect(
      outcomeFromUrl("http://localhost:55432/esign-complete?event=signing_complete&envelopeId=E-1"),
    ).toEqual({ event: "signing_complete", envelopeId: "E-1" });
  });

  it("returns null for a real ceremony URL that carries no outcome", () => {
    expect(outcomeFromUrl(SIGNING_URL)).toBeNull();
    expect(outcomeFromUrl("http://localhost:55432/esign-complete?event=cancel")).toBeNull();
    expect(outcomeFromUrl("")).toBeNull();
  });
});

// ── Condition Definition — both routes to a signature ────────────────────────

function conditionProps(
  cls: AssetClass = "legal",
  route: "email" | "in_app" = "email",
): ConditionDefinitionViewProps {
  const raw = emptyAnchorsFor(cls);
  for (const field of ASSET_CLASSES[cls].anchorFields) {
    if (raw[field.key]) continue;
    raw[field.key] =
      field.type === "money" ? "100000" : field.type === "state" ? "California" : `${field.label} Value`;
  }
  // Route every signer the same way for the test: an email address (→ DocuSign)
  // or an explicit in-app choice.
  for (const s of ASSET_CLASSES[cls].signers) {
    if (route === "email") raw[s.emailKey] = `${s.emailKey.toLowerCase()}@example.com`;
    else raw[s.modeKey] = "in_app";
  }
  return {
    assetClass: cls,
    anchors: anchorsToTrustAnchors(cls, raw),
    rawAnchors: raw,
    artifact: { filename: "agreement.pdf", hash: "sha256:" + "a".repeat(64), size: 2048 },
    eSignEnvelopes: [],
    eSignPolling: false,
    busy: false,
    error: null,
    barActive: true,
    cannaVerifyConditions: null,
    cannaVerifyRunning: false,
    onSendForSignature: async () => new Map(),
    onRunCannaVerify: () => {},
    onProceed: () => {},
    onSignInApp: async () => null,
  };
}

/**
 * `conditionProps`, advanced to "the envelope has been sent".
 *
 * `activeOrder` is the routing order currently holding the document, which is
 * what decides whether an in-app party may open their ceremony: lower orders
 * read as completed, the active order as `sent`, higher ones as `created` —
 * DocuSign's waiting state.
 */
function sentProps(
  cls: AssetClass,
  route: "email" | "in_app",
  activeOrder: number,
): ConditionDefinitionViewProps {
  const base = conditionProps(cls, route);
  const signers = deriveSigners(cls, base.anchors, base.rawAnchors).map((sg) =>
    sg.mode === "in_app" ? { ...sg, clientUserId: `officer-${sg.email}` } : sg,
  );
  return {
    ...base,
    eSignEnvelopes: [
      {
        envelopeId: ENVELOPE_ID,
        sessionId: "wf-1",
        documentLabel: "agreement.pdf",
        signers,
        status: "sent",
        sentAt: new Date("2026-07-18T12:00:00Z").toISOString(),
      },
    ],
    recipientStatuses: {
      [ENVELOPE_ID]: signers.map((sg) => ({
        email: sg.email,
        routingOrder: sg.routingOrder,
        clientUserId: sg.clientUserId,
        status:
          sg.routingOrder < activeOrder
            ? "completed"
            : sg.routingOrder === activeOrder
              ? "sent"
              : "created",
      })),
    },
  };
}

describe("ConditionDefinition — signer routes (single flow, no toggle)", () => {
  it("shows Sign Here for an in-app signer, enabled once their turn arrives", () => {
    const html = renderToString(
      createElement(ConditionDefinitionView, sentProps("legal", "in_app", 2)),
    );

    expect(html).toContain("Sign Here");
    // Named for the signer it acts on, so two signers cannot share one button.
    expect(html).toContain("Sign in LexEscrow as");
  });

  it("holds Sign Here disabled while an earlier routing order still has the document", () => {
    // Both parties route in-app here, so they share routing order 2 — order 1
    // is the emailed party on a mixed envelope. Nobody at order 2 may sign yet.
    const html = renderToString(
      createElement(ConditionDefinitionView, sentProps("legal", "in_app", 1)),
    );

    expect(html).toContain("Sign Here");
    expect(html).toContain("disabled");
    expect(html).toContain("Available once the other parties have signed.");
  });

  it("gives an email signer a status, not a second way to send", () => {
    const html = renderToString(
      createElement(ConditionDefinitionView, conditionProps("legal", "email")),
    );

    // One dispatch control for the whole envelope — no per-row send.
    expect(html).not.toContain("Send Email");
    expect(html).toContain("Send for Signature");
    expect(html).toContain("Not sent yet");
    expect(html).not.toContain("Sign Here");
  });

  it("sends every signer on one envelope, whatever their route", () => {
    const html = renderToString(
      createElement(ConditionDefinitionView, conditionProps("real_estate", "email")),
    );
    // Buyer + seller, dispatched together rather than one envelope each.
    expect(html).toContain("Send for Signature (2 signers)");
    expect(html).not.toContain("Sign Here");

    const inAppHtml = renderToString(
      createElement(ConditionDefinitionView, sentProps("real_estate", "in_app", 2)),
    );
    expect(inAppHtml.split("Sign Here").length - 1).toBe(2);
  });

  it("reports each email signer's own routing state once sent", () => {
    // Order 1 completed, order 2 current: on a same-order fixture that is
    // every signer completed — the point is the row reads DocuSign's answer
    // for that recipient rather than the envelope's.
    const html = renderToString(
      createElement(ConditionDefinitionView, sentProps("legal", "email", 2)),
    );
    expect(html).toContain("✅ Signed");
    expect(html).not.toContain("Not sent yet");
  });

  it("badges only the in-app party on a completed mixed envelope", () => {
    // The regression this guards: one envelope now carries both routes, so
    // taking every signer on a completed envelope would badge the emailed
    // client as having "signed in app" — the wrong claim about how their
    // signature was collected, on the screen an auditor reads to find out.
    // Genuinely mixed: the client by email, the firm in-app — which is the
    // only shape where the two can be confused for one another.
    const base = conditionProps("legal", "email");
    const rawAnchors: Record<string, string> = {
      ...base.rawAnchors,
      lawFirmEmail: "",
      lawFirmSignMode: "in_app",
    };
    const firmName = rawAnchors.lawFirmName;
    const html = renderToString(
      createElement(ConditionDefinitionView, {
        ...base,
        rawAnchors,
        eSignEnvelopes: [
          {
            envelopeId: ENVELOPE_ID,
            sessionId: "wf-1",
            documentLabel: "agreement.pdf",
            signers: [
              {
                name: "Brandon Green",
                email: "clientemail@example.com",
                role: "Client",
                routingOrder: 1,
              },
              {
                name: firmName,
                email: syntheticSignerEmail(firmName, "Law firm"),
                role: "Law firm",
                routingOrder: 2,
                clientUserId: "officer@firm.test-bg-law",
              },
            ],
            status: "completed",
            sentAt: new Date("2026-07-18T12:00:00Z").toISOString(),
          },
        ],
      }),
    );

    // Exactly one badge — the embedded party's. The emailed client keeps a
    // plain signature status instead.
    expect(html.split("✅ Signed in app").length - 1).toBe(1);
    expect(html).toContain("clientemail@example.com");
  });

  it("replaces the action with a Signed in app badge once the in-app envelope completes", () => {
    const props = conditionProps("legal", "in_app");
    const clientName = props.rawAnchors.clientFullLegalName;
    const html = renderToString(
      createElement(ConditionDefinitionView, {
        ...props,
        eSignEnvelopes: [
          {
            envelopeId: ENVELOPE_ID,
            sessionId: "wf-1",
            documentLabel: "agreement.pdf",
            signers: [
              {
                name: clientName,
                email: syntheticSignerEmail(clientName, "Client"),
                role: "Client",
                routingOrder: 2, // in-app signers route after the email signers
                clientUserId: "officer@firm.test-client",
              },
            ],
            status: "completed",
            sentAt: new Date("2026-07-18T12:00:00Z").toISOString(),
          },
        ],
      }),
    );

    expect(html).toContain("✅ Signed in app");
  });

  it("does not claim in-app signature for an envelope still in flight", () => {
    const props = conditionProps("legal", "in_app");
    const clientName = props.rawAnchors.clientFullLegalName;
    const html = renderToString(
      createElement(ConditionDefinitionView, {
        ...props,
        eSignEnvelopes: [
          {
            envelopeId: ENVELOPE_ID,
            sessionId: "wf-1",
            documentLabel: "agreement.pdf",
            signers: [
              {
                name: clientName,
                email: syntheticSignerEmail(clientName, "Client"),
                role: "Client",
                routingOrder: 2, // in-app signers route after the email signers
                clientUserId: "officer@firm.test-client",
              },
            ],
            status: "sent",
            sentAt: new Date("2026-07-18T12:00:00Z").toISOString(),
          },
        ],
      }),
    );

    expect(html).not.toContain("Signed in app");
    expect(html).toContain("Sign Here");
  });
});
