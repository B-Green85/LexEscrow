// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

// @vitest-environment jsdom
/**
 * Per-asset-class working state at Document Load.
 *
 * Each asset class keeps its own uploaded file, its own anchor values, and its
 * own suggestion marks. Switching class swaps which slot is shown without
 * disturbing the others, and returning to a class restores exactly what was
 * there — no re-extraction, no bleed between classes. These are the properties
 * that only exist once the screen holds every class in parallel, so they are
 * tested through the real screen and the real sample documents.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DocumentLoad } from "./DocumentLoad";
import { useSession } from "../store/session";

beforeEach(() => {
  useSession.setState({
    assetClass: "legal",
    file: null,
    anchors: {
      attorneyBarNumber: "",
      state: "California",
      clientFullLegalName: "",
      clientEmail: "",
      clientPhone: "",
    },
  });
});

afterEach(cleanup);

// ── Helpers ──────────────────────────────────────────────────────────────────

function field(label: string | RegExp): HTMLInputElement {
  const el = screen.getByText(label).parentElement?.querySelector("input");
  if (!el) throw new Error(`no input beside "${label}"`);
  return el as HTMLInputElement;
}

function dot(label: string | RegExp): HTMLElement | null {
  return within(screen.getByText(label)).queryByTitle(/Suggested from document/);
}

/** Click a class-selector card by its display name. */
function selectClass(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Load a sample chip and wait for its suggestions to settle. */
async function load(name: string | RegExp, until: () => void) {
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(until);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DocumentLoad — per-class file and anchor slots", () => {
  it("keeps each class's file and fields when switching between them", async () => {
    render(<DocumentLoad />);

    // Legal: load a retainer.
    await load("Clean retainer", () => expect(field("Attorney bar number").value).toBe("123456"));
    expect(screen.getByText("retainer_anderson.txt")).toBeTruthy();

    // Real estate: load a purchase agreement into its own slot.
    selectClass("Real Estate");
    expect(field("Parcel number").value).toBe(""); // fresh, untouched by Legal
    await load(/Real estate/, () => expect(field("Parcel number").value).toBe("123-456-789"));
    expect(field("Purchase price").value).toBe("450000.00");
    expect(screen.getByText("real_estate_purchase_smith.txt")).toBeTruthy();

    // Back to Legal: its file and fields are exactly as they were left.
    selectClass("Legal");
    expect(field("Attorney bar number").value).toBe("123456");
    expect(field("Client full legal name").value).toBe("Jane Anderson");
    expect(dot("Attorney bar number")).not.toBeNull();
    expect(screen.getByText("retainer_anderson.txt")).toBeTruthy();

    // And Real Estate is still populated when we return — no re-extraction.
    selectClass("Real Estate");
    expect(field("Parcel number").value).toBe("123-456-789");
    expect(field("County").value).toBe("Los Angeles");
    expect(screen.getByText("real_estate_purchase_smith.txt")).toBeTruthy();
  });

  it("shows an empty upload zone for a class that has no file yet", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () => expect(screen.getByText("retainer_anderson.txt")).toBeTruthy());

    selectClass("Business");

    // The Legal file is not shown under Business; the empty prompt is.
    expect(screen.queryByText("retainer_anderson.txt")).toBeNull();
    expect(screen.getByText(/Drag documents here/)).toBeTruthy();
  });

  it("does not let a load on one class disturb another class's anchors", async () => {
    render(<DocumentLoad />);

    // Type into Legal before touching anything else.
    fireEvent.change(field("Attorney bar number"), { target: { value: "778899" } });

    selectClass("Real Estate");
    await load(/Real estate/, () => expect(field("Parcel number").value).toBe("123-456-789"));

    selectClass("Legal");
    expect(field("Attorney bar number").value).toBe("778899");
  });

  it("preserves an officer edit made before switching away and back", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () => expect(dot("Attorney bar number")).not.toBeNull());

    fireEvent.change(field("Attorney bar number"), { target: { value: "654321" } });
    expect(dot("Attorney bar number")).toBeNull();

    selectClass("Real Estate");
    selectClass("Legal");

    expect(field("Attorney bar number").value).toBe("654321");
    expect(dot("Attorney bar number")).toBeNull(); // edited fields never regain the dot
  });

  it("syncs the active class through to the session store on switch", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () =>
      expect(useSession.getState().anchors.attorneyBarNumber).toBe("123456"),
    );

    selectClass("Real Estate");
    await load(/Real estate/, () => expect(field("Parcel number").value).toBe("123-456-789"));

    // The store now mirrors Real Estate (parcel → identifier), not Legal.
    expect(useSession.getState().anchors.attorneyBarNumber).toBe("123-456-789");
    expect(useSession.getState().file?.name).toBe("real_estate_purchase_smith.txt");

    selectClass("Legal");
    expect(useSession.getState().anchors.attorneyBarNumber).toBe("123456");
    expect(useSession.getState().file?.name).toBe("retainer_anderson.txt");
  });

  it("names the suggested value in the amber-dot tooltip", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () => expect(dot("Attorney bar number")).not.toBeNull());

    // The tooltip is driven by the stored per-class AnchorSuggestions.
    expect(dot("Attorney bar number")?.getAttribute("title")).toContain("123456");
    expect(dot("Client full legal name")?.getAttribute("title")).toContain("Jane Anderson");
  });
});
