// @vitest-environment jsdom
/**
 * LexTrace — the debug console, from the icon to the terminal.
 *
 * Four things are under test, and they are deliberately separated because they
 * fail for different reasons:
 *
 *   1. **The gate.** An unconfigured install refuses with a specific message
 *      rather than opening an empty panel; a configured one asks for the
 *      password once and never again that session.
 *   2. **The cycle.** Closed → bottom → right → closed, from the icon and from
 *      the keyboard, with the *same* transition table behind both.
 *   3. **The panel.** Read-only, ANSI-preserving, polling on a 3s interval and
 *      — the part that actually leaks if it regresses — not polling once it is
 *      closed.
 *   4. **The layout.** Neither open position may disturb the closed one.
 *
 * xterm is mocked rather than driven. Its rendering is not this app's code and
 * needs a real layout engine to do anything; what belongs here is the contract
 * LexEscrow holds it to — stdin disabled, output written verbatim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import App from "../App";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import { useToasts } from "./Toast";

// ── xterm ────────────────────────────────────────────────────────────────────

const writeln = vi.fn();
const clear = vi.fn();
const dispose = vi.fn();
const fit = vi.fn();
const terminalOptions: Record<string, unknown>[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      terminalOptions.push(options);
    }
    loadAddon = vi.fn();
    open = vi.fn();
    writeln = writeln;
    clear = clear;
    dispose = dispose;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = fit;
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// jsdom has no ResizeObserver, and the panel observes its own host to refit.
class StubResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal("ResizeObserver", StubResizeObserver);

// The 2.5s launch animation is not what any of this is about, and RTL's
// `waitFor` polls on real timers, so faking them here would deadlock instead.
vi.mock("./Splash", async () => {
  return {
    Splash: ({ onFinish }: { onFinish: () => void }) => {
      useEffect(() => onFinish(), [onFinish]);
      return null;
    },
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PASSWORD = "lextrace-operator-pw";
const OPERATOR = "ops-jordan";

/** An install whose console is configured and whose vault is readable. */
function configured() {
  vi.spyOn(backend, "hasDebugConsole").mockResolvedValue(true);
  vi.spyOn(backend, "getDebugConsolePublic").mockResolvedValue({
    configured: true,
    operatorId: OPERATOR,
  });
  vi.spyOn(backend, "authenticateDebugConsole").mockImplementation(
    async (password: string) => password === PASSWORD,
  );
}

/** Skip the gate entirely — for cases about the cycle, not the gate. */
function alreadyIn() {
  configured();
  useSession.setState({ debugAuthenticated: true, debugOperatorId: OPERATOR });
}

const debugIcon = () => screen.getByLabelText("LexTrace Debug Console");
const panel = () => screen.queryByLabelText("LexTrace debug console");

beforeEach(() => {
  terminalOptions.length = 0;
  writeln.mockClear();
  clear.mockClear();
  dispose.mockClear();
  fit.mockClear();
  useSession.setState({
    debugPanel: 0,
    debugAuthenticated: false,
    debugPromptOpen: false,
    debugOperatorId: "",
    showWizard: false,
    wizardComplete: true,
    vaultLocked: false,
    credentialPromptOpen: false,
    storeBackend: "app_vault",
    storeBackendChecked: true,
  });
  useToasts.setState({ toasts: [] });
  // The vault is open in every case here; the debug gate is what is under test,
  // not the credential gate in front of it.
  vi.spyOn(backend, "vaultStatus").mockResolvedValue({ exists: true, unlocked: true });
  vi.spyOn(backend, "runCreDebug").mockResolvedValue("");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── 1. The gate ──────────────────────────────────────────────────────────────

describe("the password gate", () => {
  it("refuses an unconfigured install with the IT-setup message", async () => {
    vi.spyOn(backend, "hasDebugConsole").mockResolvedValue(false);
    render(<App />);

    await act(async () => {
      fireEvent.click(debugIcon());
    });

    expect(
      await screen.findByText("Debug console requires IT setup. Configure in Settings."),
    ).toBeTruthy();
    // Refused, not opened empty: an empty terminal reads as a broken tool.
    expect(panel()).toBeNull();
    expect(useSession.getState().debugPanel).toBe(0);
  });

  it("leaves the icon visible on an unconfigured install", () => {
    // Hiding it would make "not configured" indistinguishable from "this build
    // has no debug console", which is the question the operator is asking.
    vi.spyOn(backend, "hasDebugConsole").mockResolvedValue(false);
    render(<App />);
    expect(debugIcon()).toBeTruthy();
  });

  it("asks for a password on the first open", async () => {
    configured();
    render(<App />);

    await act(async () => {
      fireEvent.click(debugIcon());
    });

    expect(await screen.findByText("LexTrace Debug Console", { selector: "h2" })).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it("rejects a wrong password without opening the panel", async () => {
    configured();
    render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });

    const field = await screen.findByPlaceholderText("Debug console password");
    fireEvent.change(field, { target: { value: "not-the-password" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Open console"));
    });

    expect(await screen.findByText("Incorrect debug console password.")).toBeTruthy();
    expect(panel()).toBeNull();
    expect(useSession.getState().debugAuthenticated).toBe(false);
  });

  it("opens the panel on the correct password and shows the operator", async () => {
    configured();
    render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });

    const field = await screen.findByPlaceholderText("Debug console password");
    fireEvent.change(field, { target: { value: PASSWORD } });
    await act(async () => {
      fireEvent.click(screen.getByText("Open console"));
    });

    await waitFor(() => expect(panel()).not.toBeNull());
    expect(useSession.getState().debugPanel).toBe(1);
    expect(screen.getByText(`Operator: ${OPERATOR}`)).toBeTruthy();
  });

  it("does not ask again for the rest of the session", async () => {
    configured();
    render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    const field = await screen.findByPlaceholderText("Debug console password");
    fireEvent.change(field, { target: { value: PASSWORD } });
    await act(async () => {
      fireEvent.click(screen.getByText("Open console"));
    });
    await waitFor(() => expect(panel()).not.toBeNull());

    // Cycle all the way round to closed, then open again.
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    expect(useSession.getState().debugPanel).toBe(0);

    await act(async () => {
      fireEvent.click(debugIcon());
    });

    await waitFor(() => expect(useSession.getState().debugPanel).toBe(1));
    expect(screen.queryByPlaceholderText("Debug console password")).toBeNull();
  });

  it("closes the console when the vault is sealed", async () => {
    // The credentials the panel polls with live in the vault. An authenticated
    // panel surviving a lock would poll a store it can no longer read.
    alreadyIn();
    vi.spyOn(backend, "vaultLock").mockResolvedValue(undefined);
    render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    await waitFor(() => expect(panel()).not.toBeNull());

    await act(async () => {
      await useSession.getState().lockVault();
    });

    expect(panel()).toBeNull();
    expect(useSession.getState().debugAuthenticated).toBe(false);
  });
});

// ── 2. The cycle ─────────────────────────────────────────────────────────────

describe("the three-position cycle", () => {
  it("advances closed → bottom → right → closed on each click", async () => {
    alreadyIn();
    render(<App />);

    await act(async () => {
      fireEvent.click(debugIcon());
    });
    await waitFor(() => expect(useSession.getState().debugPanel).toBe(1));
    expect(panel()?.className).toContain("h-[280px]");

    await act(async () => {
      fireEvent.click(debugIcon());
    });
    expect(useSession.getState().debugPanel).toBe(2);
    expect(panel()?.className).toContain("w-[420px]");

    await act(async () => {
      fireEvent.click(debugIcon());
    });
    expect(useSession.getState().debugPanel).toBe(0);
    expect(panel()).toBeNull();
  });

  it("runs the same cycle from Cmd/Ctrl+Shift+D", async () => {
    alreadyIn();
    render(<App />);

    const press = async (mod: "metaKey" | "ctrlKey") => {
      await act(async () => {
        fireEvent.keyDown(window, { code: "KeyD", key: "D", shiftKey: true, [mod]: true });
      });
    };

    await press("metaKey");
    await waitFor(() => expect(useSession.getState().debugPanel).toBe(1));
    await press("ctrlKey");
    expect(useSession.getState().debugPanel).toBe(2);
    await press("metaKey");
    expect(useSession.getState().debugPanel).toBe(0);
  });

  it("ignores the shortcut without both modifiers", async () => {
    alreadyIn();
    render(<App />);

    for (const event of [
      { code: "KeyD", shiftKey: true }, // no Cmd/Ctrl
      { code: "KeyD", metaKey: true }, // no Shift
      { code: "KeyE", metaKey: true, shiftKey: true }, // wrong key
      { code: "KeyD", metaKey: true, shiftKey: true, altKey: true }, // extra modifier
    ]) {
      await act(async () => {
        fireEvent.keyDown(window, event);
      });
    }
    expect(useSession.getState().debugPanel).toBe(0);
  });

  it("closes from the panel's own X button", async () => {
    alreadyIn();
    render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    await waitFor(() => expect(panel()).not.toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close debug console"));
    });

    expect(panel()).toBeNull();
    expect(useSession.getState().debugPanel).toBe(0);
  });
});

// ── 3. The panel ─────────────────────────────────────────────────────────────

describe("the terminal", () => {
  const openPanel = async () => {
    alreadyIn();
    render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    // Ready means "the terminal exists", not "something has been written to
    // it". The panel opens clean — nothing is printed until the first poll
    // returns output — so waiting on `writeln` would hang for every case whose
    // CRE response is empty.
    await waitFor(() => expect(terminalOptions.length).toBe(1));
  };

  it("builds a read-only terminal", async () => {
    await openPanel();
    // The whole read-only claim on the frontend side. `disableStdin` is what
    // makes the terminal reject keystrokes rather than merely ignore them.
    expect(terminalOptions[0].disableStdin).toBe(true);
    expect(terminalOptions[0].cursorBlink).toBe(false);
  });

  it("writes CRE output verbatim, ANSI escapes intact", async () => {
    const blue = "\x1b[34mchainlink\x1b[0m execution 4 of 4";
    vi.spyOn(backend, "runCreDebug").mockResolvedValue(blue);
    await openPanel();

    await waitFor(() => expect(writeln.mock.calls.flat()).toContain(blue));
  });

  it("replaces the previous result rather than appending to it", async () => {
    // The panel shows the current state of the workflow, not a transcript of
    // how it got there — so every result clears before it writes.
    //
    // The delay matters: a result that resolves before xterm has finished
    // importing takes the buffered path, which writes into a terminal that is
    // new and has nothing to clear. Landing it *after* the terminal exists is
    // what exercises the replace.
    vi.spyOn(backend, "runCreDebug").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("some output"), 50)),
    );
    await openPanel();

    await waitFor(() => expect(clear).toHaveBeenCalled());
    // …and the clear precedes the write, or the result would be wiped out by
    // the very call that was supposed to display it.
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(
      writeln.mock.invocationCallOrder[writeln.mock.invocationCallOrder.length - 1],
    );
    expect(writeln.mock.calls.flat()).toContain("some output");
  });

  it("leaves the last result on screen for an empty response", async () => {
    // Empty means the backend already had a run in flight. Nothing happened, so
    // nothing is redrawn — clearing here would blank the last real result and
    // leave the operator with an empty panel until the next poll lands.
    vi.spyOn(backend, "runCreDebug").mockResolvedValue("");
    await openPanel();

    await waitFor(() => expect(backend.runCreDebug).toHaveBeenCalled());
    expect(clear).not.toHaveBeenCalled();
    expect(writeln).not.toHaveBeenCalled();
  });

  it("surfaces a backend failure once rather than every three seconds", async () => {
    vi.spyOn(backend, "runCreDebug").mockRejectedValue(
      new Error("CRE CLI not found. Ensure cre is installed and in PATH."),
    );
    await openPanel();

    await waitFor(() =>
      expect(
        writeln.mock.calls.flat().filter((l) => String(l).includes("CRE CLI not found")).length,
      ).toBe(1),
    );
  });

  it("stops polling once the panel closes", async () => {
    // The one regression that would keep a subprocess running behind a closed
    // panel — and keep writing to the audit trail — indefinitely.
    vi.spyOn(backend, "runCreDebug").mockResolvedValue("out");
    await openPanel();
    await waitFor(() => expect(backend.runCreDebug).toHaveBeenCalled());

    // Cycle right, then closed.
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    expect(panel()).toBeNull();

    const callsAtClose = vi.mocked(backend.runCreDebug).mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3_200));
    });
    expect(vi.mocked(backend.runCreDebug).mock.calls.length).toBe(callsAtClose);
  }, 10_000);

  it("keeps its scrollback when the panel is repositioned", async () => {
    // Moving the panel is not a reason to lose the output the operator moved it
    // in order to read — so the terminal must not be rebuilt.
    await openPanel();
    expect(terminalOptions.length).toBe(1);

    await act(async () => {
      fireEvent.click(debugIcon());
    });
    expect(useSession.getState().debugPanel).toBe(2);
    expect(terminalOptions.length).toBe(1);
    expect(dispose).not.toHaveBeenCalled();
  });
});

// ── 4. The layout ────────────────────────────────────────────────────────────

describe("layout", () => {
  it("leaves the closed layout exactly as it was", async () => {
    alreadyIn();
    const { container } = render(<App />);
    const shell = container.firstElementChild as HTMLElement;

    // The page scrolls as a whole when nothing is docked, which is what all
    // eleven screens were laid out against.
    expect(shell.classList.contains("min-h-screen")).toBe(true);
    expect(shell.classList.contains("h-screen")).toBe(false);
    expect(container.querySelector("main")?.className).not.toContain("overflow-y-auto");
  });

  it("bounds the shell to the viewport while a panel is docked", async () => {
    alreadyIn();
    const { container } = render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    await waitFor(() => expect(panel()).not.toBeNull());

    const shell = container.firstElementChild as HTMLElement;
    expect(shell.classList.contains("h-screen")).toBe(true);
    expect(shell.classList.contains("min-h-screen")).toBe(false);
    // …and the main column scrolls inside it, rather than sliding the docked
    // panel off the bottom of a growing page.
    expect(container.querySelector("main")?.className).toContain("overflow-y-auto");
  });

  it("keeps every screen reachable with the panel open", async () => {
    alreadyIn();
    render(<App />);
    await act(async () => {
      fireEvent.click(debugIcon());
    });
    await waitFor(() => expect(panel()).not.toBeNull());

    // The header is the app's only navigation, and it sits above the row the
    // panel joins — so it has to survive both positions.
    for (const label of ["Recent Workflows", "Batch Processing", "Configuration"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    await act(async () => {
      fireEvent.click(debugIcon()); // → right split
    });
    expect(screen.getByLabelText("Configuration")).toBeTruthy();
  });
});
