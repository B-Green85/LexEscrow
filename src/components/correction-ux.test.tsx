// @vitest-environment jsdom
/**
 * Session 4 — LexGuard Correction UX (spec §28–§31).
 *
 * These components gate a liability transfer: the confirm and override buttons
 * are the moment a human takes ownership of a value that moves money. Rendering
 * assertions alone would not prove the gates hold, so this suite drives real
 * clicks and keystrokes through jsdom rather than server-rendering to a string.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CorrectedField } from "./CorrectedField";
import { OverrideDialog } from "./OverrideDialog";
import { SourceDocumentViewer } from "./SourceDocumentViewer";
import { LexGuardEscalationView } from "../screens/LexGuardEscalation";
import { ParsedOutputReview } from "../screens/ParsedOutputReview";
import { useSession } from "../store/session";
import { ExecutionPath, type ParsedRetainerPayload } from "../lexguard/types";
import type { Escalation, LexGuardCorrection } from "../lexguard/pipeline";

afterEach(cleanup);

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

// ── CorrectedField (spec §28) ───────────────────────────────────────────────

function correctedField(overrides: Partial<Parameters<typeof CorrectedField>[0]> = {}) {
  const onOverride = vi.fn();
  render(
    <CorrectedField
      fieldName="totalHeld"
      label="Total retainer held"
      correctedValue={18500}
      originalAiValue={18050}
      module="payload-diff"
      constraint="earned_fees + unearned_balance must equal total_held"
      onOverride={onOverride}
      {...overrides}
    />,
  );
  return { onOverride };
}

describe("CorrectedField", () => {
  it("renders the original AI value struck through and the corrected value in amber", () => {
    correctedField();

    const original = screen.getByTestId("original-value");
    expect(original.textContent).toBe("$18,050.00");
    expect(original.className).toContain("line-through");

    const corrected = screen.getByTestId("corrected-value");
    expect(corrected.textContent).toBe("$18,500.00");
    expect(corrected.className).toContain("text-amber-700");
  });

  it("attributes the correction to its module and constraint", () => {
    correctedField();
    expect(
      screen.getByText(/LexGuard corrected — payload-diff: earned_fees \+ unearned_balance/),
    ).toBeTruthy();
  });

  it("renders non-money fields as raw values rather than currency", () => {
    correctedField({
      fieldName: "clientName",
      label: "Client",
      correctedValue: "Jane Anderson",
      originalAiValue: "Jane Andersen",
      constraint: "must match the trust anchor",
    });

    expect(screen.getByTestId("corrected-value").textContent).toBe("Jane Anderson");
    expect(screen.getByTestId("original-value").textContent).toBe("Jane Andersen");
  });

  it("keeps the override dialog closed until the Override button is clicked", () => {
    correctedField();
    expect(screen.queryByTestId("override-dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(screen.getByTestId("override-dialog")).toBeTruthy();
  });

  it("triggers onOverride with the officer's value and reason", () => {
    const { onOverride } = correctedField();

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    type(screen.getByLabelText("Your override value"), "18525.00");
    type(screen.getByLabelText("Reason (required)"), "Per wire confirmation addendum");
    fireEvent.click(screen.getByRole("button", { name: "Apply Override" }));

    expect(onOverride).toHaveBeenCalledTimes(1);
    expect(onOverride).toHaveBeenCalledWith("18525.00", "Per wire confirmation addendum");
  });

  it("closes the dialog once an override is applied", () => {
    correctedField();

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    type(screen.getByLabelText("Your override value"), "1");
    type(screen.getByLabelText("Reason (required)"), "because");
    fireEvent.click(screen.getByRole("button", { name: "Apply Override" }));

    expect(screen.queryByTestId("override-dialog")).toBeNull();
  });
});

// ── OverrideDialog (spec §30) ───────────────────────────────────────────────

function overrideDialog() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <OverrideDialog
      fieldName="totalHeld"
      lexGuardValue={18500}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  const apply = screen.getByRole("button", { name: "Apply Override" }) as HTMLButtonElement;
  return { onConfirm, onCancel, apply };
}

describe("OverrideDialog", () => {
  it("shows the LexGuard value the officer is departing from", () => {
    overrideDialog();
    expect(screen.getByText("$18,500.00")).toBeTruthy();
    expect(screen.getByText("Override LexGuard Correction")).toBeTruthy();
  });

  it("disables Apply Override before anything is entered", () => {
    const { apply } = overrideDialog();
    expect(apply.disabled).toBe(true);
  });

  it("keeps Apply Override disabled when the reason is empty", () => {
    const { apply } = overrideDialog();
    type(screen.getByLabelText("Your override value"), "18525.00");
    expect(apply.disabled).toBe(true);
  });

  it("keeps Apply Override disabled when the reason is only whitespace", () => {
    const { apply } = overrideDialog();
    type(screen.getByLabelText("Your override value"), "18525.00");
    type(screen.getByLabelText("Reason (required)"), "    ");
    expect(apply.disabled).toBe(true);
  });

  it("keeps Apply Override disabled when the value is empty", () => {
    const { apply } = overrideDialog();
    type(screen.getByLabelText("Reason (required)"), "a stated reason");
    expect(apply.disabled).toBe(true);
  });

  it("enables Apply Override once both value and reason are filled", () => {
    const { apply } = overrideDialog();
    type(screen.getByLabelText("Your override value"), "18525.00");
    type(screen.getByLabelText("Reason (required)"), "a stated reason");
    expect(apply.disabled).toBe(false);
  });

  it("calls onConfirm with the trimmed value and reason", () => {
    const { onConfirm, apply } = overrideDialog();
    type(screen.getByLabelText("Your override value"), "  18525.00  ");
    type(screen.getByLabelText("Reason (required)"), "  wire confirmation  ");
    fireEvent.click(apply);

    expect(onConfirm).toHaveBeenCalledWith("18525.00", "wire confirmation");
  });

  it("calls onCancel and never onConfirm when the officer keeps the LexGuard value", () => {
    const { onConfirm, onCancel } = overrideDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel — Keep LexGuard Value" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ── SourceDocumentViewer (spec §29) ─────────────────────────────────────────

const SOURCE_TEXT = [
  "RETAINER AGREEMENT",
  "Total Retainer Held: $18,500.00",
  "Earned Fees: $6,200.00",
  "Client: Jane Anderson",
].join("\n");

describe("SourceDocumentViewer", () => {
  it("renders the normalized document text", () => {
    render(<SourceDocumentViewer text={SOURCE_TEXT} onClose={vi.fn()} />);

    const viewer = screen.getByTestId("source-document-viewer");
    expect(viewer.textContent).toContain("RETAINER AGREEMENT");
    expect(viewer.textContent).toContain("Client: Jane Anderson");
  });

  it("highlights every dollar amount so the officer can find the disputed figure", () => {
    const { container } = render(<SourceDocumentViewer text={SOURCE_TEXT} onClose={vi.fn()} />);

    const marks = Array.from(container.querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["$18,500.00", "$6,200.00"]);
    expect(container.querySelector("mark")?.className).toContain("amber");
  });

  it("leaves text without amounts unhighlighted", () => {
    const { container } = render(<SourceDocumentViewer text="No figures here." onClose={vi.fn()} />);

    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(screen.getByTestId("source-document-viewer").textContent).toContain("No figures here.");
  });

  it("calls onClose from the close button", () => {
    const onClose = vi.fn();
    render(<SourceDocumentViewer text={SOURCE_TEXT} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText("Close source document"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── LexGuardEscalation dialog (spec §29, §31) ───────────────────────────────

const singleField: Escalation = {
  module: "payload-diff",
  field: "totalHeld",
  fieldLabel: "Total Retainer Held",
  aiValue: "$18,050.00",
  observedValue: "$18,500.00",
  recommendation: "Review the billing reconciliation section.",
  documentExtractedValue: 18500,
  correctionField: "totalHeld",
  aiAttempt1: 18050,
  aiAttempt2: 18200,
  aiAttempt3: 18050,
  additionalDiscrepancies: [],
};

const twoFields: Escalation = {
  ...singleField,
  additionalDiscrepancies: [
    {
      field: "barNumber",
      module: "anchor-matcher",
      aiValue: "187456",
      observedValue: "187654",
      correctionField: "extractedBarNumber",
    },
  ],
};

function escalation(esc: Escalation, normalizedText: string | null = SOURCE_TEXT) {
  const onConfirm = vi.fn();
  const onReviewDocument = vi.fn();
  render(
    <LexGuardEscalationView
      escalation={esc}
      normalizedText={normalizedText}
      busy={false}
      onConfirm={onConfirm}
      onReviewDocument={onReviewDocument}
    />,
  );
  const confirm = () =>
    screen.getByRole("button", { name: /^Confirm All/ }) as HTMLButtonElement;
  return { onConfirm, onReviewDocument, confirm };
}

describe("LexGuardEscalation — single field", () => {
  it("shows the document value and all three AI attempts", () => {
    escalation(singleField);

    expect(screen.getByTestId("document-says-0").textContent).toBe("$18,500.00");
    expect(screen.getByText("AI parsed (nudge 1)")).toBeTruthy();
    expect(screen.getByText("AI parsed (nudge 2)")).toBeTruthy();
    expect(screen.getByText("AI parsed (nudge 3)")).toBeTruthy();

    const field = screen.getByTestId("escalation-field-0");
    expect(within(field).getByText("$18,200.00")).toBeTruthy();
    expect(within(field).getAllByText("$18,050.00")).toHaveLength(2);
  });

  it("labels the field with its position and owning module", () => {
    escalation(singleField);
    expect(screen.getByText(/Field 1 of 1/)).toBeTruthy();
    expect(screen.getByText("payload-diff")).toBeTruthy();
  });

  it("pre-fills the correct-value input from the document extraction", () => {
    escalation(singleField);
    const input = screen.getByLabelText("Correct value") as HTMLInputElement;
    expect(input.value).toBe("18500.00");
  });

  it("renders attempts that never landed as an em dash", () => {
    escalation({ ...singleField, aiAttempt2: undefined, aiAttempt3: undefined });

    const field = screen.getByTestId("escalation-field-0");
    expect(within(field).getAllByText("—")).toHaveLength(2);
  });

  it("blocks Confirm All until the attestation is checked", () => {
    const { confirm } = escalation(singleField);
    // Value is pre-filled, so attestation is the only thing still missing.
    expect(confirm().disabled).toBe(true);
    expect(confirm().textContent).toContain("0 remaining");

    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm().disabled).toBe(false);
  });

  it("blocks Confirm All when a field is cleared, and counts it as remaining", () => {
    const { confirm } = escalation(singleField);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(confirm().disabled).toBe(false);

    type(screen.getByLabelText("Correct value"), "");
    expect(confirm().disabled).toBe(true);
    expect(confirm().textContent).toContain("1 remaining");
  });

  it("refuses a money value that cannot be parsed as a number", () => {
    const { confirm } = escalation(singleField);
    fireEvent.click(screen.getByRole("checkbox"));
    type(screen.getByLabelText("Correct value"), "eighteen thousand");

    expect(confirm().disabled).toBe(true);
  });

  it("emits the officer's value in payload-native dollars on confirm", () => {
    const { onConfirm, confirm } = escalation(singleField);
    type(screen.getByLabelText("Correct value"), "18500.00");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith([{ field: "totalHeld", value: 18500 }]);
  });

  it("carries an officer-entered value that differs from the default", () => {
    const { onConfirm, confirm } = escalation(singleField);
    type(screen.getByLabelText("Correct value"), "18525.50");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith([{ field: "totalHeld", value: 18525.5 }]);
  });

  it("routes Review Document to its own handler without confirming", () => {
    const { onConfirm, onReviewDocument } = escalation(singleField);
    fireEvent.click(screen.getByRole("button", { name: "Review Document" }));

    expect(onReviewDocument).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("LexGuardEscalation — multi-field cascade", () => {
  it("numbers each field as 'Field n of 2'", () => {
    escalation(twoFields);
    expect(screen.getByText(/Field 1 of 2/)).toBeTruthy();
    expect(screen.getByText(/Field 2 of 2/)).toBeTruthy();
  });

  it("shows each field's own module attribution", () => {
    escalation(twoFields);
    expect(screen.getByText("payload-diff")).toBeTruthy();
    expect(screen.getByText("anchor-matcher")).toBeTruthy();
  });

  it("treats a non-money field as a raw string value", () => {
    escalation(twoFields);
    expect(screen.getByTestId("document-says-1").textContent).toBe("187654");
    const inputs = screen.getAllByLabelText("Correct value") as HTMLInputElement[];
    expect(inputs[1].value).toBe("187654");
  });

  it("confirms every field in one submission", () => {
    const { onConfirm, confirm } = escalation(twoFields);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirm());

    expect(onConfirm).toHaveBeenCalledWith([
      { field: "totalHeld", value: 18500 },
      { field: "barNumber", value: "187654" },
    ]);
  });

  it("counts only the unanswered fields as remaining", () => {
    const { confirm } = escalation(twoFields);
    const inputs = screen.getAllByLabelText("Correct value");
    type(inputs[0], "");
    type(inputs[1], "");
    expect(confirm().textContent).toContain("2 remaining");

    type(inputs[0], "18500");
    expect(confirm().textContent).toContain("1 remaining");
  });

  it("will not confirm while any field is unanswered, even with attestation", () => {
    const { onConfirm, confirm } = escalation(twoFields);
    fireEvent.click(screen.getByRole("checkbox"));
    type(screen.getAllByLabelText("Correct value")[1], "");

    expect(confirm().disabled).toBe(true);
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("marks answered fields with a checkmark and unanswered ones without", () => {
    escalation(twoFields);
    expect(screen.getByTestId("field-check-0").textContent).toBe("✓");

    type(screen.getAllByLabelText("Correct value")[1], "");
    expect(screen.getByTestId("field-check-1").textContent).toBe("");
  });
});

describe("LexGuardEscalation — a second escalation resets the gate", () => {
  /** Re-render the same mounted instance with a different escalation object. */
  function rerenderWith(first: Escalation, second: Escalation) {
    const onConfirm = vi.fn();
    const view = (esc: Escalation) => (
      <LexGuardEscalationView
        escalation={esc}
        normalizedText={SOURCE_TEXT}
        busy={false}
        onConfirm={onConfirm}
        onReviewDocument={vi.fn()}
      />
    );
    const { rerender } = render(view(first));
    return { onConfirm, next: () => rerender(view(second)) };
  }

  const secondEscalation: Escalation = {
    ...singleField,
    field: "earnedFees",
    correctionField: "earnedFees",
    documentExtractedValue: 800,
    aiAttempt1: 900,
    aiAttempt2: 900,
    aiAttempt3: 900,
  };

  it("clears the attestation when a correction surfaces a new discrepancy", () => {
    const { next } = rerenderWith(singleField, secondEscalation);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);

    next();

    // Attestation is per-escalation — carrying it over would let the officer
    // confirm findings they never looked at.
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: /^Confirm All/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("re-seeds the inputs from the new escalation rather than keeping stale values", () => {
    const { next } = rerenderWith(singleField, secondEscalation);
    type(screen.getByLabelText("Correct value"), "99999");

    next();

    expect((screen.getByLabelText("Correct value") as HTMLInputElement).value).toBe("800.00");
  });

  it("confirms the new escalation's field, not the previous one", () => {
    const { onConfirm, next } = rerenderWith(singleField, secondEscalation);
    next();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Confirm All/ }));

    expect(onConfirm).toHaveBeenCalledWith([{ field: "earnedFees", value: 800 }]);
  });
});

describe("LexGuardEscalation — source document", () => {
  it("opens the viewer over the dialog and keeps the dialog mounted", () => {
    escalation(singleField);
    expect(screen.queryByTestId("source-document-viewer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View Source Document" }));
    expect(screen.getByTestId("source-document-viewer")).toBeTruthy();
    // The officer must not lose their place while consulting the document.
    expect(screen.getByLabelText("Correct value")).toBeTruthy();
  });

  it("preserves in-progress corrections across opening and closing the viewer", () => {
    escalation(singleField);
    type(screen.getByLabelText("Correct value"), "18525.50");

    fireEvent.click(screen.getByRole("button", { name: "View Source Document" }));
    fireEvent.click(screen.getByLabelText("Close source document"));

    expect((screen.getByLabelText("Correct value") as HTMLInputElement).value).toBe("18525.50");
    expect(screen.queryByTestId("source-document-viewer")).toBeNull();
  });

  it("disables the viewer when no artifact text is available", () => {
    escalation(singleField, null);
    const button = screen.getByRole("button", { name: "View Source Document" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

// ── Stage 4 wiring: ParsedOutputReview (spec §28, §30) ──────────────────────

const reviewPayload: ParsedRetainerPayload = {
  clientId: "C-1",
  lawFirmWallet: "0xFirm",
  clientWallet: "0xClient",
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
  extractedBarNumber: null,
};

const resolvedCorrection: LexGuardCorrection = {
  module: "payload-diff",
  field: "unearnedBalance",
  aiValue: 3200,
  observedValue: 4200,
  nudgeCount: 1,
  resolved: true,
  timestamp: new Date("2026-07-18T12:00:00Z").toISOString(),
};

function renderReview(corrections: LexGuardCorrection[]) {
  useSession.setState({
    sessionId: "wf-review-test",
    payload: reviewPayload,
    corrections,
    escalation: null,
    screen: "review",
    providerLabel: "stub",
    assetClass: "legal",
    scrollCompleted: false,
    acknowledged: false,
    busy: false,
    error: null,
    vdb: null,
  });
  return render(<ParsedOutputReview />);
}

describe("ParsedOutputReview — corrected field wiring", () => {
  it("renders a CorrectedField for the field LexGuard corrected", () => {
    renderReview([resolvedCorrection]);

    const field = screen.getByTestId("corrected-unearnedBalance");
    expect(within(field).getByTestId("original-value").textContent).toBe("$3,200.00");
    expect(within(field).getByTestId("corrected-value").textContent).toBe("$4,200.00");
  });

  it("leaves uncorrected money fields as plain rows", () => {
    renderReview([resolvedCorrection]);

    expect(screen.queryByTestId("corrected-totalHeld")).toBeNull();
    expect(screen.queryByTestId("corrected-earnedFees")).toBeNull();
  });

  it("summarises the corrections in an amber banner", () => {
    renderReview([resolvedCorrection]);

    const banner = screen.getByTestId("corrections-banner");
    expect(banner.textContent).toContain("1 LexGuard correction applied");
    expect(banner.textContent).toContain("review highlighted fields below");
    expect(banner.className).toContain("amber");
  });

  it("shows no banner when nothing was corrected", () => {
    renderReview([]);
    expect(screen.queryByTestId("corrections-banner")).toBeNull();
  });

  it("ignores unresolved nudge attempts — they were never applied", () => {
    renderReview([{ ...resolvedCorrection, resolved: false }]);

    expect(screen.queryByTestId("corrected-unearnedBalance")).toBeNull();
    expect(screen.queryByTestId("corrections-banner")).toBeNull();
  });

  it("opens the override dialog inline from the corrected field", () => {
    renderReview([resolvedCorrection]);
    expect(screen.queryByTestId("override-dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    expect(screen.getByTestId("override-dialog")).toBeTruthy();
  });

  it("applies an override, notifies the officer, and drops the field's highlight", () => {
    renderReview([resolvedCorrection]);

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    type(screen.getByLabelText("Your override value"), "4150.00");
    type(screen.getByLabelText("Reason (required)"), "Per wire confirmation addendum");
    fireEvent.click(screen.getByRole("button", { name: "Apply Override" }));

    expect(screen.getByTestId("override-notice").textContent).toContain(
      "Override applied — please re-review the full payload",
    );
    // The field is now the officer's value, not LexGuard's — the amber
    // "LexGuard corrected" highlight would be a false claim.
    expect(screen.queryByTestId("corrected-unearnedBalance")).toBeNull();
    expect(screen.queryByTestId("corrections-banner")).toBeNull();
  });

  it("keeps an open override dialog mounted across an unrelated store update", () => {
    renderReview([resolvedCorrection]);
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    type(screen.getByLabelText("Reason (required)"), "half-typed reason");

    // Any store write re-renders this screen — `useSession()` subscribes to the
    // whole store. The dialog and its in-progress text must survive it.
    // `act` is what forces the re-render to actually flush; without it the
    // assertion would pass against a component that remounts on every render.
    act(() => {
      useSession.setState({ busy: true });
    });

    expect(screen.getByTestId("override-dialog")).toBeTruthy();
    expect((screen.getByLabelText("Reason (required)") as HTMLTextAreaElement).value).toBe(
      "half-typed reason",
    );
  });

  it("writes the overridden value into the payload in dollars", () => {
    renderReview([resolvedCorrection]);

    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    type(screen.getByLabelText("Your override value"), "4150.00");
    type(screen.getByLabelText("Reason (required)"), "wire confirmation");
    fireEvent.click(screen.getByRole("button", { name: "Apply Override" }));

    expect(useSession.getState().payload?.unearnedBalance).toBe(4150);
  });
});
