// @vitest-environment jsdom
/**
 * Document field suggestion at Document Load.
 *
 * Driven through the real screen and the real sample documents rather than a
 * stubbed extractor: the unit tests in `lib/suggest-anchors.test.ts` already
 * prove the patterns, and what is worth proving here is the part that only
 * exists once they are wired to a form — that a suggestion lands in the right
 * field, that it is marked as unverified, and above all that it never lands on
 * top of something the officer typed.
 *
 * The amber dot is treated as a correctness property, not decoration. A
 * pre-filled anchor that looks identical to a typed one invites the officer to
 * confirm a value they never actually read, and the anchors are what LexGuard
 * matches the parsed document against downstream.
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

/** The input rendered beside a given anchor label. */
function field(label: string | RegExp): HTMLInputElement {
  const el = screen.getByText(label).parentElement?.querySelector("input");
  if (!el) throw new Error(`no input beside "${label}"`);
  return el as HTMLInputElement;
}

/** The "suggested from document" dot on a given anchor label, if present. */
function dot(label: string | RegExp): HTMLElement | null {
  return within(screen.getByText(label)).queryByTitle(/Suggested from document/);
}

const sample = (name: string | RegExp) => screen.getByRole("button", { name });

/** Load a sample and wait for its suggestions to settle. */
async function load(name: string | RegExp, until: () => void) {
  fireEvent.click(sample(name));
  await waitFor(until);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DocumentLoad — suggestion from the dropped artifact", () => {
  it("pre-fills anchors the document confidently yields", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () => expect(field("Attorney bar number").value).toBe("123456"));
    expect(field("Client full legal name").value).toBe("Jane Anderson");
  });

  it("marks every pre-filled field as suggested", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () => expect(dot("Attorney bar number")).not.toBeNull());
    expect(dot("Client full legal name")).not.toBeNull();
  });

  it("leaves fields with no match empty and unmarked", async () => {
    render(<DocumentLoad />);
    // The clean retainer carries no email or phone number.
    await load("Clean retainer", () => expect(field("Client full legal name").value).toBe("Jane Anderson"));
    expect(field("Client email").value).toBe("");
    expect(dot("Client email")).toBeNull();
    expect(dot(/^Client phone/)).toBeNull();
  });

  it("shows no dots at all before a document is loaded", () => {
    render(<DocumentLoad />);
    expect(dot("Attorney bar number")).toBeNull();
    expect(dot("Client full legal name")).toBeNull();
  });

  it("clears the dot on the field the officer edits, and only that field", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () => expect(dot("Attorney bar number")).not.toBeNull());

    fireEvent.change(field("Attorney bar number"), { target: { value: "654321" } });

    expect(dot("Attorney bar number")).toBeNull();
    expect(dot("Client full legal name")).not.toBeNull();
  });

  it("never overwrites a value the officer has already entered", async () => {
    render(<DocumentLoad />);
    fireEvent.change(field("Attorney bar number"), { target: { value: "999999" } });

    await load("Clean retainer", () => expect(field("Client full legal name").value).toBe("Jane Anderson"));

    expect(field("Attorney bar number").value).toBe("999999");
    expect(dot("Attorney bar number")).toBeNull();
  });

  it("does not re-fill a field the officer touched and then cleared", async () => {
    render(<DocumentLoad />);
    fireEvent.change(field("Attorney bar number"), { target: { value: "9" } });
    fireEvent.change(field("Attorney bar number"), { target: { value: "" } });

    await load("Clean retainer", () => expect(field("Client full legal name").value).toBe("Jane Anderson"));

    expect(field("Attorney bar number").value).toBe("");
  });

  it("pre-fills a money field as a dollar string from the largest amount", async () => {
    render(<DocumentLoad />);
    fireEvent.click(sample(/Real Estate/));
    await load(/Real estate/, () => expect(field("Purchase price").value).toBe("450000.00"));

    expect(field("Parcel number").value).toBe("123-456-789");
    expect(field("County").value).toBe("Los Angeles");
    expect(dot("Purchase price")).not.toBeNull();
  });

  it("drops suggestions when the officer switches asset class", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () => expect(dot("Attorney bar number")).not.toBeNull());

    fireEvent.click(sample(/Real Estate/));

    expect(field("Parcel number").value).toBe("");
    expect(dot("Parcel number")).toBeNull();
  });

  it("writes the suggested anchors through to the session store", async () => {
    render(<DocumentLoad />);
    await load("Clean retainer", () =>
      expect(useSession.getState().anchors.attorneyBarNumber).toBe("123456"),
    );
    expect(useSession.getState().anchors.clientFullLegalName).toBe("Jane Anderson");
  });
});
