// @vitest-environment jsdom
/**
 * DocuSign credentials — Configuration card + the vault round-trip.
 *
 * The bug this file pins down: the edit form used to open with every field
 * blank, because `DocuSignPublic` carried nothing but a presence flag, the
 * environment and four characters of the account ID. Saving from that form —
 * even just to rotate the PEM — wrote the blanks back over the stored user ID,
 * account ID and base URI. So the assertions come in two halves:
 *
 *   1. Opening an edit pre-populates from what is stored, and the two secrets
 *      stay blank with a "keep existing" prompt — ordinary UI.
 *   2. Edit-then-save without retyping anything loses nothing, and the public
 *      shape still carries no key material. Those run against the real browser
 *      vault, not a mock of it, because a mocked `getDocuSignPublic` would
 *      return whatever shape this file expected and prove nothing about the
 *      boundary it is supposed to be guarding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_BASE_URI, DocuSignCard } from "./Configuration";
import type { DocuSignPublic } from "../lib/vaultTypes";
import * as backend from "../lib/backend";
import * as browserVault from "../lib/browserVault";

afterEach(cleanup);

const ACCOUNT_ID = "acct-000-987654";
const USER_ID = "user-abc-123";
const INTEGRATION_KEY = "ik-must-never-leave-the-vault";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n-----END RSA PRIVATE KEY-----";

/** A fully configured public shape, as the vault would return it. */
function configured(extra: Partial<DocuSignPublic> = {}): DocuSignPublic {
  return {
    hasCredentials: true,
    environment: "production",
    accountIdHint: "7654",
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    baseUri: "https://na4.docusign.net",
    hasIntegrationKey: true,
    hasJwtPrivateKey: true,
    ...extra,
  };
}

const value = (label: RegExp | string) =>
  (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;
const placeholder = (label: RegExp | string) =>
  (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).placeholder;

// ── The card ─────────────────────────────────────────────────────────────────

describe("DocuSignCard", () => {
  it("renders an unconfigured state that names the fallback", () => {
    render(<DocuSignCard data={null} refresh={vi.fn()} />);

    expect(screen.getByText(/Send for Signature runs against the demo provider/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("shows the configured summary with the account ID masked", () => {
    render(<DocuSignCard data={configured()} refresh={vi.fn()} />);

    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByText(USER_ID)).toBeTruthy();
    expect(screen.getByText("https://na4.docusign.net")).toBeTruthy();
    // Last four only — the summary is for recognising the account.
    expect(screen.getByText("…7654")).toBeTruthy();
    expect(screen.queryByText(ACCOUNT_ID)).toBeNull();
    expect(screen.getAllByText("•••••••• stored")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("pre-populates every stored field on edit and leaves the secrets blank", () => {
    render(<DocuSignCard data={configured()} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // The regression: these three were blank, and saving wrote the blanks back.
    expect(value(/^User ID$/)).toBe(USER_ID);
    expect(value(/^Account ID$/)).toBe(ACCOUNT_ID);
    expect(value(/^Base URI$/)).toBe("https://na4.docusign.net");
    expect(value(/^Environment$/)).toBe("production");

    // The two credentials are never echoed — blank, with the house rule stated.
    expect(value(/^Integration key$/)).toBe("");
    expect(value(/JWT private key/)).toBe("");
    expect(placeholder(/^Integration key$/)).toMatch(/leave blank to keep existing/i);
    expect(placeholder(/JWT private key/)).toMatch(/leave blank to keep existing/i);
  });

  it("offers the sandbox default base URI only when nothing is stored", () => {
    render(<DocuSignCard data={null} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(value(/^Base URI$/)).toBe(DEFAULT_BASE_URI);

    cleanup();
    render(<DocuSignCard data={configured({ baseUri: "https://na4.docusign.net" })} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(value(/^Base URI$/)).toBe("https://na4.docusign.net");
  });

  it("treats a stored-but-incomplete entry as editable rather than absent", () => {
    // Metadata saved, PEM never supplied. Reporting this as "no credentials"
    // is how a half-written entry looks like a wiped one.
    render(
      <DocuSignCard
        data={configured({ hasCredentials: false, hasJwtPrivateKey: false })}
        refresh={vi.fn()}
      />,
    );

    expect(screen.getByText(/Stored, but incomplete/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();

    // And the edit still starts from what survived.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(value(/^Account ID$/)).toBe(ACCOUNT_ID);
    expect(placeholder(/JWT private key/)).toMatch(/BEGIN RSA PRIVATE KEY/);
  });
});

// ── The vault round-trip ─────────────────────────────────────────────────────

describe("DocuSign credentials — edit against the real vault", () => {
  beforeEach(async () => {
    // No storage reset: this jsdom lacks `localStorage.clear`, and the browser
    // vault falls back to an in-memory cell when storage is unavailable.
    // Unlocking with a stable password is enough — vitest gives each test file
    // its own module registry, so the cell starts empty here.
    browserVault.lock();
    await backend.vaultUnlock("test-password");
    await backend.setDocuSign({
      integrationKey: INTEGRATION_KEY,
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      baseUri: "https://na4.docusign.net",
      jwtPrivateKey: PEM,
      environment: "production",
    });
  });

  afterEach(() => {
    browserVault.lock();
  });

  it("never returns key material, in any field", async () => {
    const pub = await backend.getDocuSignPublic();

    // Not by name, and not smuggled into some other field either — the whole
    // serialized shape is checked, which is the only version of this assertion
    // that survives someone adding a field later.
    const json = JSON.stringify(pub);
    expect(json).not.toContain(INTEGRATION_KEY);
    expect(json).not.toContain("BEGIN RSA PRIVATE KEY");

    expect(pub.hasIntegrationKey).toBe(true);
    expect(pub.hasJwtPrivateKey).toBe(true);
    expect(pub.accountIdHint).toBe("7654");
  });

  it("keeps every field when an edit is opened and saved untouched", async () => {
    const before = await backend.getDocuSignPublic();
    render(<DocuSignCard data={before} refresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // Save is reachable without retyping anything — with the form starting
    // blank it was disabled until the operator re-entered the whole account.
    const saveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    await waitFor(async () => {
      expect(await backend.getDocuSignPublic()).toEqual(before);
    });
    // Both secrets survived a save that retyped neither.
    expect(await backend.hasDocuSign()).toBe(true);
  });

  it("changes only the field that was edited", async () => {
    const before = await backend.getDocuSignPublic();
    render(<DocuSignCard data={before} refresh={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText(/^Environment$/), { target: { value: "sandbox" } });
    fireEvent.change(screen.getByLabelText(/^Base URI$/), {
      target: { value: DEFAULT_BASE_URI },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const after = await backend.getDocuSignPublic();
      expect(after.environment).toBe("sandbox");
      expect(after.baseUri).toBe(DEFAULT_BASE_URI);
      // The point of the exercise: flipping to sandbox did not cost the
      // account it authenticates as.
      expect(after.userId).toBe(USER_ID);
      expect(after.accountId).toBe(ACCOUNT_ID);
      expect(after.hasIntegrationKey).toBe(true);
      expect(after.hasJwtPrivateKey).toBe(true);
    });
  });
});
