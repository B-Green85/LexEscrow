// @vitest-environment jsdom
/**
 * Escrow Monitor render + interaction tests (spec §12 Screen 6).
 *
 * jsdom rather than `react-dom/server` here, unlike the other screen suites:
 * the behaviours that matter on this screen are gates — the settlement button
 * refusing to activate, the manual confirmation refusing to arm until the
 * officer types CONFIRM — and a gate can only be tested by trying to open it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EscrowMonitorView, type EscrowMonitorViewProps } from "./EscrowMonitor";
import { evaluateSummary, type Condition, type ConditionStatus } from "../lib/conditions";
import { ExecutionPath } from "../lexguard/types";
import { ASSET_CLASS_LIST, type AssetClass } from "../lib/assetClasses";

afterEach(cleanup);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-07-18T12:00:00Z");

function cond(
  type: Condition["type"],
  status: ConditionStatus,
  extra: Partial<Condition> = {},
): Condition {
  return {
    id: `c-${type}-${status}`,
    type,
    label: `${type} condition`,
    description: `${type} description`,
    status,
    assetClass: "legal",
    ...extra,
  };
}

function props(extra: Partial<EscrowMonitorViewProps> = {}): EscrowMonitorViewProps {
  const conditions = extra.conditions ?? [cond("document", "met"), cond("esign", "pending")];
  return {
    assetClass: "legal",
    conditions,
    conditionSummary: extra.conditionSummary ?? evaluateSummary(conditions),
    fundsDeposited: false,
    depositTxHash: null,
    escrowBalance: 1_850_000n,
    conditionPolling: false,
    conditionsUpdatedAt: "2026-07-18T12:00:00Z",
    executionPath: ExecutionPath.DirectSettlement,
    arbitrationState: null,
    busy: false,
    error: null,
    cannaVerifyConditions: null,
    cannaVerifyRunning: false,
    eventLog: null,
    now: NOW,
    onConfirmDeposit: vi.fn(),
    onRefresh: vi.fn(),
    onWaiveCondition: vi.fn(),
    onMarkConditionMet: vi.fn(),
    onRunCannaVerify: vi.fn(),
    onProceedToSettlement: vi.fn(),
    onSignArbitration: vi.fn(),
    ...extra,
  };
}

const settleButton = () =>
  screen.getByRole("button", {
    name: /Proceed to Settlement|View Milestone Progress|Lock Escrow into Arbitration/,
  });

// ── Rendering ────────────────────────────────────────────────────────────────

describe("EscrowMonitor — fund custody", () => {
  it("renders the deposit input while funds are not deposited", () => {
    render(<EscrowMonitorView {...props({ fundsDeposited: false })} />);
    expect(screen.getByLabelText("Deposit Transaction Hash")).toBeDefined();
    expect(screen.getByText("Awaiting fund deposit")).toBeDefined();
  });

  it("renders the balance card once funds are deposited", () => {
    render(
      <EscrowMonitorView
        {...props({
          fundsDeposited: true,
          depositTxHash: "0xdeposit-1234",
          escrowBalance: 1_850_000n,
        })}
      />,
    );
    expect(screen.getByText(/\$18,500\.00 USDC/)).toBeDefined();
    expect(screen.getByText(/Funds locked/)).toBeDefined();
    expect(screen.queryByLabelText("Deposit Transaction Hash")).toBeNull();
  });

  it("keeps Confirm Deposit disabled until a hash is entered", () => {
    render(<EscrowMonitorView {...props()} />);
    const button = screen.getByRole("button", { name: "Confirm Deposit" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Deposit Transaction Hash"), {
      target: { value: "0xabc" },
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("hands the trimmed hash to confirmFundsDeposited", () => {
    const onConfirmDeposit = vi.fn();
    render(<EscrowMonitorView {...props({ onConfirmDeposit })} />);
    fireEvent.change(screen.getByLabelText("Deposit Transaction Hash"), {
      target: { value: "  0xdeposit-9  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm Deposit" }));
    expect(onConfirmDeposit).toHaveBeenCalledWith("0xdeposit-9");
  });

  it("hides the settlement section entirely until the escrow is funded", () => {
    render(<EscrowMonitorView {...props({ fundsDeposited: false })} />);
    expect(screen.queryByRole("button", { name: /Proceed to Settlement/ })).toBeNull();
  });
});

describe("EscrowMonitor — condition checklist", () => {
  it("renders one card per condition", () => {
    const conditions = [
      cond("document", "met"),
      cond("esign", "in_progress"),
      cond("bar_verify", "pending"),
      cond("time", "failed"),
    ];
    render(<EscrowMonitorView {...props({ conditions })} />);
    for (const c of conditions) {
      expect(screen.getByText(c.label), `${c.type} card should render`).toBeDefined();
    }
  });

  it("shows a status indicator for every condition state", () => {
    const conditions: Condition[] = [
      cond("document", "met"),
      cond("esign", "in_progress"),
      cond("bar_verify", "pending"),
      cond("time", "failed"),
      cond("manual", "waived"),
    ];
    render(<EscrowMonitorView {...props({ conditions })} />);
    for (const text of ["✅ Met", "🔄 In Progress", "⏳ Pending", "❌ Failed", "〜 Waived"]) {
      expect(screen.getByText(text), `${text} indicator`).toBeDefined();
    }
  });

  it("reports the met/total tally and progress", () => {
    const conditions = [cond("document", "met"), cond("esign", "pending")];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.getByText(/1 of 2 conditions met/)).toBeDefined();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  });

  it("counts a waived condition toward progress but not toward met", () => {
    const conditions = [cond("document", "met"), cond("esign", "waived")];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.getByText(/1 of 2 conditions met/)).toBeDefined();
    expect(screen.getByText(/1 waived/)).toBeDefined();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("renders per-signer status on an esign condition", () => {
    const conditions = [
      cond("esign", "in_progress", {
        signers: ["Jane Anderson", "Marcus Webb"],
        signerStatuses: { "Jane Anderson": "completed", "Marcus Webb": "delivered" },
      }),
    ];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.getByText("✅ Signed")).toBeDefined();
    expect(screen.getByText("📬 Delivered")).toBeDefined();
    expect(screen.getByText(/1 of 2 signed/)).toBeDefined();
  });

  it("shows days remaining on a future time condition", () => {
    const conditions = [cond("time", "pending", { releaseDate: "2026-08-17" })];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.getByText(/30 days remaining/)).toBeDefined();
  });

  it("shows a live countdown inside the final week", () => {
    const conditions = [cond("time", "pending", { releaseDate: "2026-07-20T12:00:00Z" })];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.getByText(/2d .* remaining/)).toBeDefined();
  });

  it("reports a reached release date", () => {
    const conditions = [cond("time", "met", { releaseDate: "2026-07-01" })];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.getByText("✅ Date reached")).toBeDefined();
  });

  it("renders an empty-checklist notice rather than pretending all is well", () => {
    render(<EscrowMonitorView {...props({ conditions: [] })} />);
    expect(screen.getByText(/No conditions have been defined/)).toBeDefined();
  });
});

// ── Gates ────────────────────────────────────────────────────────────────────

describe("EscrowMonitor — settlement gate", () => {
  it("disables Proceed to Settlement while conditions are unmet", () => {
    render(
      <EscrowMonitorView
        {...props({
          fundsDeposited: true,
          conditions: [cond("document", "met"), cond("esign", "pending")],
        })}
      />,
    );
    expect((settleButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/1 condition still pending/)).toBeDefined();
  });

  it("names the blocking conditions on the disabled button", () => {
    render(
      <EscrowMonitorView
        {...props({ fundsDeposited: true, conditions: [cond("esign", "pending")] })}
      />,
    );
    expect(settleButton().getAttribute("title")).toContain("esign condition");
  });

  it("enables Proceed to Settlement once every condition is met", () => {
    render(
      <EscrowMonitorView
        {...props({
          fundsDeposited: true,
          conditions: [cond("document", "met"), cond("esign", "met")],
        })}
      />,
    );
    expect((settleButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/All conditions met — ready to settle/)).toBeDefined();
  });

  it("enables settlement when the remainder is waived rather than met", () => {
    render(
      <EscrowMonitorView
        {...props({
          fundsDeposited: true,
          conditions: [cond("document", "met"), cond("esign", "waived")],
        })}
      />,
    );
    expect((settleButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("still refuses to settle on a failed condition", () => {
    render(
      <EscrowMonitorView
        {...props({ fundsDeposited: true, conditions: [cond("cannaverify", "failed")] })}
      />,
    );
    expect((settleButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("fires proceedToSettlement when the gate is open", () => {
    const onProceedToSettlement = vi.fn();
    render(
      <EscrowMonitorView
        {...props({
          fundsDeposited: true,
          conditions: [cond("document", "met")],
          onProceedToSettlement,
        })}
      />,
    );
    fireEvent.click(settleButton());
    expect(onProceedToSettlement).toHaveBeenCalled();
  });
});

describe("EscrowMonitor — manual confirmation", () => {
  const manualProps = (extra: Partial<EscrowMonitorViewProps> = {}) =>
    props({ conditions: [cond("manual", "pending", { id: "m-1" })], ...extra });

  it("keeps Mark as Met disabled until CONFIRM is typed", () => {
    render(<EscrowMonitorView {...manualProps()} />);
    const button = screen.getByRole("button", { name: "Mark as Met" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // Anything short of the word leaves the gate shut.
    fireEvent.change(screen.getByLabelText(/Type CONFIRM/), { target: { value: "CONFIR" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Type CONFIRM/), { target: { value: "CONFIRM" } });
    expect(button.disabled).toBe(false);
  });

  it("reports the condition id to markConditionMet", () => {
    const onMarkConditionMet = vi.fn();
    render(<EscrowMonitorView {...manualProps({ onMarkConditionMet })} />);
    fireEvent.change(screen.getByLabelText(/Type CONFIRM/), { target: { value: "CONFIRM" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark as Met" }));
    expect(onMarkConditionMet).toHaveBeenCalledWith("m-1");
  });

  it("shows the confirmation instead of the input once met", () => {
    render(
      <EscrowMonitorView
        {...props({ conditions: [cond("manual", "met", { metAt: "2026-07-18T12:00:00Z" })] })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Mark as Met" })).toBeNull();
    expect(screen.getByText(/Confirmed by the escrow officer/)).toBeDefined();
  });
});

describe("EscrowMonitor — waivers", () => {
  it("offers a Waive button on every unmet condition", () => {
    const conditions = [
      cond("document", "pending", { id: "w-pending" }),
      cond("esign", "in_progress", { id: "w-progress" }),
      cond("time", "failed", { id: "w-failed" }),
    ];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.getAllByRole("button", { name: /^Waive/ })).toHaveLength(3);
  });

  it("offers no Waive button on a met or already-waived condition", () => {
    const conditions = [cond("document", "met"), cond("esign", "waived")];
    render(<EscrowMonitorView {...props({ conditions })} />);
    expect(screen.queryByRole("button", { name: /^Waive/ })).toBeNull();
  });

  it("requires a reason before a waiver can be confirmed", () => {
    const onWaiveCondition = vi.fn();
    render(
      <EscrowMonitorView
        {...props({ conditions: [cond("esign", "pending", { id: "w-1" })], onWaiveCondition })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Waive/ }));

    const confirm = screen.getByRole("button", { name: "Confirm Waiver" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Reason for waiving/), {
      target: { value: "Counterparty signed out of band" },
    });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(onWaiveCondition).toHaveBeenCalledWith("w-1", "Counterparty signed out of band");
  });

  it("strikes through a waived condition rather than showing it as met", () => {
    render(
      <EscrowMonitorView
        {...props({
          conditions: [cond("esign", "waived", { failureReason: "signed out of band" })],
        })}
      />,
    );
    expect(screen.getByText("〜 Waived")).toBeDefined();
    expect(screen.getByText(/Waived — signed out of band/)).toBeDefined();
    expect(screen.queryByText("✅ Met")).toBeNull();
  });
});

// ── Release paths + chrome ───────────────────────────────────────────────────

describe("EscrowMonitor — release paths", () => {
  it("shows the arbitration signing panel instead of a settle button on Path B", () => {
    render(
      <EscrowMonitorView
        {...props({
          fundsDeposited: true,
          executionPath: ExecutionPath.ArbitrationEscrow,
          arbitrationState: {
            locked: true,
            party1Signed: true,
            party2Signed: false,
            arbiterSigned: false,
            threshold: 2,
          },
        })}
      />,
    );
    expect(screen.getByText(/Multi-signature resolution/)).toBeDefined();
    expect(screen.getByText("1/2 required signatures")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Proceed to Settlement/ })).toBeNull();
  });

  it("labels the Path C button as milestone progress", () => {
    render(
      <EscrowMonitorView
        {...props({
          fundsDeposited: true,
          executionPath: ExecutionPath.StagedRelease,
          conditions: [cond("document", "met")],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "View Milestone Progress" })).toBeDefined();
  });
});

describe("EscrowMonitor — chrome", () => {
  it("renders for every asset class", () => {
    for (const cls of ASSET_CLASS_LIST as AssetClass[]) {
      const { unmount } = render(<EscrowMonitorView {...props({ assetClass: cls })} />);
      expect(screen.getByRole("heading", { name: /Escrow Monitor/ })).toBeDefined();
      unmount();
    }
  });

  it("shows the auto-refresh badge only while polling", () => {
    const { unmount } = render(<EscrowMonitorView {...props({ conditionPolling: false })} />);
    expect(screen.queryByText(/Auto-refresh/)).toBeNull();
    unmount();

    render(<EscrowMonitorView {...props({ conditionPolling: true })} />);
    expect(screen.getByText(/Auto-refresh/)).toBeDefined();
  });

  it("fires a manual refresh", () => {
    const onRefresh = vi.fn();
    render(<EscrowMonitorView {...props({ onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("surfaces an error banner", () => {
    render(<EscrowMonitorView {...props({ error: "Record the escrow deposit before settling." })} />);
    expect(screen.getByText("Record the escrow deposit before settling.")).toBeDefined();
  });

  it("renders the supplied event log node", () => {
    render(
      <EscrowMonitorView {...props({ eventLog: <div data-testid="event-log">events</div> })} />,
    );
    expect(within(screen.getByTestId("event-log")).getByText("events")).toBeDefined();
  });
});
