// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

// @vitest-environment jsdom
/**
 * Clio intake — the screens.
 *
 * Three surfaces, and they fail for different reasons:
 *
 *   1. **The picker.** Debounces before it reaches Clio, refuses to search at
 *      all when the account is not connected, and recovers from a failed fetch.
 *   2. **Screen 7.** Renders the connected firm, and treats an install still
 *      holding the pre-OAuth placeholder shape as "not configured" rather than
 *      crashing on the missing fields.
 *   3. **Document Load.** The toggle swaps intake paths and clears the other
 *      path's input, so nothing stale reaches `beginProcessing`.
 *
 * The debounce assertions are the ones worth having. An un-debounced search
 * sends a request per keystroke to a third party's rate-limited API, and it
 * fails silently — by working, slowly, until a firm's account is throttled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClioIntakePanel } from "./ClioIntakePanel";
import { ClioCard } from "../screens/Configuration";
import { DocumentLoad } from "../screens/DocumentLoad";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import type { ClioMatterPayload } from "../lib/clio";
import type { ClioPublic } from "../lib/vaultTypes";

const MATTER: ClioMatterPayload = {
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
  ],
  bills: [
    {
      number: "INV-001",
      totalCents: 1_250_000,
      paidCents: 500_000,
      balanceCents: 750_000,
      state: "awaiting_payment",
      issuedAt: "2026-08-01",
      dueAt: null,
      memo: null,
    },
  ],
  trustBalanceCents: 3_000_000,
  fetchedAt: "2026-09-05T12:00:00Z",
};

function clioPublic(over: Partial<ClioPublic> = {}): ClioPublic {
  return {
    appId: "app-1234",
    clientId: "client-abc",
    redirectUri: "http://127.0.0.1:8080/callback",
    hasClientSecret: true,
    hasCredentials: true,
    connected: true,
    tokenExpiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    ...over,
  };
}

const connected = (yes = true) =>
  vi.spyOn(backend, "clioCheckConnection").mockResolvedValue({
    connected: yes,
    expiresAt: yes ? new Date(Date.now() + 45 * 60_000).toISOString() : null,
    firmName: yes ? "Hargrove & Weston LLP" : null,
  });

beforeEach(() => {
  useSession.setState({ clioMatter: null, intakeSource: "artifact", assetClass: "legal" });
  vi.spyOn(backend, "onClioOAuthCallback").mockResolvedValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── 1. The matter picker ─────────────────────────────────────────────────────

describe("the matter picker", () => {
  it("prompts for a connection instead of a search when Clio is not connected", async () => {
    connected(false);
    const search = vi.spyOn(backend, "clioSearchMatters");
    render(<ClioIntakePanel />);

    expect(
      await screen.findByText(
        "Connect your Clio account in Settings → Configuration to use this feature.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Search open matters")).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it("debounces the search rather than calling per keystroke", async () => {
    connected();
    const search = vi.spyOn(backend, "clioSearchMatters").mockResolvedValue([]);
    render(<ClioIntakePanel />);
    const field = await screen.findByLabelText("Search open matters");

    vi.useFakeTimers();
    for (const value of ["An", "And", "Ande", "Ander"]) {
      fireEvent.change(field, { target: { value } });
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
    }
    // Still inside the window — four keystrokes, no request yet.
    expect(search).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search).toHaveBeenCalledWith("Ander");
  });

  it("does not search on a one-character query", async () => {
    connected();
    const search = vi.spyOn(backend, "clioSearchMatters").mockResolvedValue([]);
    render(<ClioIntakePanel />);
    const field = await screen.findByLabelText("Search open matters");

    vi.useFakeTimers();
    fireEvent.change(field, { target: { value: "A" } });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    vi.useRealTimers();

    expect(search).not.toHaveBeenCalled();
  });

  it("fetches the matter the officer picked, by id", async () => {
    connected();
    vi.spyOn(backend, "clioSearchMatters").mockResolvedValue([
      { id: 4321, displayNumber: "00123-Anderson", description: "Anderson v. Wexler" },
      { id: 9999, displayNumber: "00999-Other", description: "Someone else" },
    ]);
    const fetchMatter = vi.spyOn(backend, "clioFetchMatter").mockResolvedValue(MATTER);
    render(<ClioIntakePanel />);

    fireEvent.change(await screen.findByLabelText("Search open matters"), {
      target: { value: "Anderson" },
    });
    const row = await screen.findByText("00123-Anderson");
    await act(async () => {
      fireEvent.click(row);
    });

    await waitFor(() => expect(fetchMatter).toHaveBeenCalledWith(4321));
    expect(useSession.getState().clioMatter).toEqual(MATTER);
  });

  it("shows the summary once a matter is held", async () => {
    connected();
    useSession.setState({ clioMatter: MATTER });
    render(<ClioIntakePanel />);

    expect(await screen.findByText("00123-Anderson")).toBeTruthy();
    expect(screen.getByText("Jane Anderson")).toBeTruthy();
    // The trust balance, labelled as such — not the billed total.
    expect(screen.getByText("Trust balance")).toBeTruthy();
    expect(screen.getByText("$30,000.00")).toBeTruthy();
  });

  it("says so when the matter has no trust balance, rather than showing $0.00", async () => {
    connected();
    useSession.setState({ clioMatter: { ...MATTER, trustBalanceCents: null } });
    render(<ClioIntakePanel />);

    expect(await screen.findByText("Billed total")).toBeTruthy();
    expect(screen.getByText("$12,500.00")).toBeTruthy();
    expect(screen.getByText(/no trust balance in Clio/i)).toBeTruthy();
  });

  it("surfaces a fetch failure and offers a retry", async () => {
    connected();
    vi.spyOn(backend, "clioSearchMatters").mockResolvedValue([
      { id: 4321, displayNumber: "00123-Anderson", description: "Anderson v. Wexler" },
    ]);
    const fetchMatter = vi
      .spyOn(backend, "clioFetchMatter")
      .mockRejectedValueOnce(new Error("Clio session expired — reconnect"))
      .mockResolvedValueOnce(MATTER);

    render(<ClioIntakePanel />);
    fireEvent.change(await screen.findByLabelText("Search open matters"), {
      target: { value: "Anderson" },
    });
    const row = await screen.findByText("00123-Anderson");
    await act(async () => {
      fireEvent.click(row);
    });

    expect(await screen.findByText(/Clio session expired/)).toBeTruthy();
    expect(useSession.getState().clioMatter).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("Try again"));
    });
    await waitFor(() => expect(useSession.getState().clioMatter).toEqual(MATTER));
    expect(fetchMatter).toHaveBeenCalledTimes(2);
  });
});

// ── 2. Screen 7 ──────────────────────────────────────────────────────────────

describe("the Configuration card", () => {
  it("renders the firm and the token's remaining life when connected", async () => {
    connected();
    render(<ClioCard data={clioPublic()} refresh={vi.fn()} />);

    expect(await screen.findByText("Hargrove & Weston LLP")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText(/valid for \d+ min/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  it("offers Connect once an app is registered but not authorised", () => {
    render(<ClioCard data={clioPublic({ connected: false })} refresh={vi.fn()} />);

    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect to Clio" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("treats a stale placeholder registration as not configured", () => {
    // An install upgraded from the `{webhookUrl, apiKey}` shape reads through
    // as all-empty. The required behaviour is a prompt to connect — not an
    // error, and not a crash on the missing OAuth fields.
    const stale: ClioPublic = {
      appId: "",
      clientId: "",
      redirectUri: "",
      hasClientSecret: false,
      hasCredentials: false,
      connected: false,
      tokenExpiresAt: "",
    };
    render(<ClioCard data={stale} refresh={vi.fn()} />);

    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Register app" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect to Clio" })).toBeNull();
  });

  it("renders nothing at all for an absent group without crashing", () => {
    render(<ClioCard data={null} refresh={vi.fn()} />);
    expect(screen.getByText("Not configured")).toBeTruthy();
  });

  it("shows the redirect URI read-only, so a Portal mismatch is diagnosable", () => {
    render(<ClioCard data={clioPublic({ connected: false })} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit app" }));

    const field = screen.getByLabelText("Redirect URI") as HTMLInputElement;
    expect(field.value).toBe("http://127.0.0.1:8080/callback");
    expect(field.readOnly).toBe(true);
  });

  it("submits a blank client secret on edit, so the stored one is kept", async () => {
    const save = vi.spyOn(backend, "setClio").mockResolvedValue(undefined);
    render(<ClioCard data={clioPublic({ connected: false })} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit app" }));

    fireEvent.change(screen.getByLabelText("App ID"), { target: { value: "app-corrected" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        appId: "app-corrected",
        clientId: "client-abc",
        clientSecret: undefined,
      }),
    );
  });
});

// ── 3. Document Load ─────────────────────────────────────────────────────────

describe("the intake toggle", () => {
  it("swaps the drop zone for the matter picker", async () => {
    connected(false);
    render(<DocumentLoad />);

    expect(screen.getByText(/Drag documents here/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Pull from Clio" }));
    });

    expect(screen.queryByText(/Drag documents here/)).toBeNull();
    expect(useSession.getState().intakeSource).toBe("clio");
  });

  it("clears the other path's input on every switch", async () => {
    // A stale file behind a Clio selection — or the reverse — is how
    // `beginProcessing` would hash a document the officer thought they replaced.
    connected(false);
    useSession.setState({ clioMatter: MATTER });
    render(<DocumentLoad />);

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Pull from Clio" }));
    });
    expect(useSession.getState().file).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Upload Documents" }));
    });
    expect(useSession.getState().clioMatter).toBeNull();
  });

  it("is not offered outside the Legal asset class", async () => {
    // Clio is practice-management software for law firms; a matter is a legal
    // engagement by construction, so a toggle elsewhere could not be honoured.
    useSession.setState({ assetClass: "art" });
    render(<DocumentLoad />);
    expect(screen.queryByRole("radio", { name: "Pull from Clio" })).toBeNull();
  });

  it("pre-fills the client trust anchors from the fetched matter", async () => {
    // The whole hand-off into DocuSign and the notification flow: the Legal
    // signer descriptor routes to `clientEmail` and `sendClientNotification`
    // reads `clientEmail`/`clientPhone`, so filling these reaches both with no
    // downstream branch at all.
    connected();
    useSession.setState({ intakeSource: "clio" });
    render(<DocumentLoad />);

    await act(async () => {
      useSession.getState().setClioMatter(MATTER);
    });

    await waitFor(() => {
      const anchors = useSession.getState().anchors;
      expect(anchors.clientFullLegalName).toBe("Jane Anderson");
      expect(anchors.clientEmail).toBe("jane@example.test");
      expect(anchors.clientPhone).toBe("+15550100");
    });
  });
});
