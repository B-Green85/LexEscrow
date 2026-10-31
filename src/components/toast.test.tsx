// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

// @vitest-environment jsdom
/**
 * Toast feedback on the two settlement-screen downloads.
 *
 * The bug is one of absence: both buttons wrote a file and left the screen
 * perfectly still, so a working button and a broken one looked identical. What
 * matters here is therefore *when* the message appears — synchronously, on the
 * click, before the download handler has done anything — and that the handler
 * still runs. Timers are faked so the 2.5s life is asserted rather than waited
 * out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toaster, toast, useToasts } from "./Toast";
import { AnchorReceiptCard } from "./AnchorReceiptCard";
import { AuditCard } from "../screens/ExecutionConfirmation";
import { ASSERTION_TEXT, ASSERTION_TYPE, type AnchorReceipt } from "../lib/anchor-receipt";
import * as backend from "../lib/backend";

beforeEach(() => {
  vi.useFakeTimers();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advance past the visible window and the fade that follows it. */
const runOutTheToast = () => act(() => void vi.advanceTimersByTime(2_500 + 300));

const HASH = "sha256:" + "a".repeat(64);

function receipt(): AnchorReceipt {
  return {
    receiptId: "r-1",
    issuedAt: "2026-07-28T12:00:00.000Z",
    assertionType: ASSERTION_TYPE,
    transactionId: "session-1",
    assetClass: "legal",
    summary: { overallStatus: "verified_all", verifiedCount: 1, totalCount: 1 },
    items: [
      {
        label: "retainer.pdf",
        hmac: "c2VhbA",
        hash: HASH,
        size: 1_024,
        registered: true,
        registeredAt: "2026-07-28T12:00:00.000Z",
        onChainTx: "0x" + "b".repeat(64),
      },
    ],
    assertionText: ASSERTION_TEXT,
    receiptHash: HASH,
  };
}

// ── The primitive ────────────────────────────────────────────────────────────

describe("Toaster", () => {
  it("shows a message, then drops it after 2.5s plus the fade", () => {
    render(<Toaster />);
    expect(screen.queryByText("Downloading receipt…")).toBeNull();

    act(() => toast("Downloading receipt…"));
    expect(screen.getByText("Downloading receipt…")).toBeTruthy();

    // Still up at the end of the visible window — fading, not gone.
    act(() => void vi.advanceTimersByTime(2_500));
    expect(screen.getByText("Downloading receipt…").className).toContain("opacity-0");

    act(() => void vi.advanceTimersByTime(300));
    expect(screen.queryByText("Downloading receipt…")).toBeNull();
  });

  it("gives each toast its own full life rather than cutting the first short", () => {
    render(<Toaster />);

    act(() => toast("first"));
    act(() => void vi.advanceTimersByTime(1_000));
    act(() => toast("second"));

    // 1.5s later the first has expired and the second has 1s left.
    act(() => void vi.advanceTimersByTime(1_800));
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("announces politely, and never eats a click aimed at the UI beneath it", () => {
    render(<Toaster />);
    act(() => toast("Downloading receipt…"));

    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.className).toContain("pointer-events-none");
  });
});

// ── The two buttons ──────────────────────────────────────────────────────────

describe("settlement downloads", () => {
  it("toasts on the receipt download, without disturbing the handler", () => {
    const onDownload = vi.fn();
    render(
      <>
        <AnchorReceiptCard receipt={receipt()} onDownload={onDownload} />
        <Toaster />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download Receipt JSON" }));

    expect(screen.getByText("Downloading receipt…")).toBeTruthy();
    // The download itself is untouched: still called, still exactly once.
    expect(onDownload).toHaveBeenCalledTimes(1);

    runOutTheToast();
    expect(screen.queryByText("Downloading receipt…")).toBeNull();
  });

  it("toasts on the audit report, without disturbing the handler", () => {
    // AuditCard verifies the chain on mount; the toast is not waiting on it.
    vi.spyOn(backend, "verifyAuditChain").mockResolvedValue({
      valid: true,
      entries: 3,
      brokenAt: null,
    } as Awaited<ReturnType<typeof backend.verifyAuditChain>>);

    const onPrintReport = vi.fn();
    render(
      <>
        <AuditCard onDownload={vi.fn()} onPrintReport={onPrintReport} />
        <Toaster />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download Audit Report (PDF)" }));

    expect(screen.getByText("Downloading audit report…")).toBeTruthy();
    expect(onPrintReport).toHaveBeenCalledTimes(1);
  });

  it("fires the toast synchronously, before the download handler runs", () => {
    // Ordering is the whole point: a toast raised after a slow synchronous
    // export would appear when the feedback is no longer needed.
    let toastVisibleWhenHandlerRan = false;
    render(
      <>
        <AnchorReceiptCard
          receipt={receipt()}
          onDownload={() => {
            toastVisibleWhenHandlerRan = useToasts.getState().toasts.length > 0;
          }}
        />
        <Toaster />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download Receipt JSON" }));
    expect(toastVisibleWhenHandlerRan).toBe(true);
  });
});
