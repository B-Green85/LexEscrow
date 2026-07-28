import { describe, it, expect } from "vitest";
import { primeVDB, queryVDB, setNumericAnchor, validateVDBIntegrity, inferFieldContext } from "./vdb";
import type { VDBStore } from "./vdb";

const SAMPLE = [
  "RETAINER TERMINATION AGREEMENT",
  "",
  "Client: Jane Anderson",
  "Attorney Bar No. 123456",
  "",
  "BILLING RECONCILIATION",
  "Total Retainer Held: $5,000.00",
  "Earned Fees: $800.00",
  "Unearned Balance: $4,200.00",
  "",
  "DISPUTED MATTERS",
  "Disputed Hours: 0.0",
  "No disputed amounts are present in this matter.",
].join("\n");

describe("primeVDB", () => {
  it("extracts numerics with inferred field context", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    const unearned = queryVDB(vdb, "numeric", "unearnedBalance").map((e) => e.value);
    const total = queryVDB(vdb, "numeric", "totalHeld").map((e) => e.value);
    const earned = queryVDB(vdb, "numeric", "earnedFees").map((e) => e.value);
    expect(unearned).toContain(4200);
    expect(total).toContain(5000);
    expect(earned).toContain(800);
  });

  it("extracts proper nouns", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    const names = queryVDB(vdb, "proper_noun").map((e) => e.value);
    expect(names).toContain("Jane Anderson");
  });

  it("extracts identifiers and dispute flags", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    expect(queryVDB(vdb, "identifier").length).toBeGreaterThan(0);
    const flags = queryVDB(vdb, "flag").map((e) => e.value);
    expect(flags).toContain("disputed");
  });

  it("binds entries to the artifact hash and session", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    expect(vdb.artifactHash).toBe("sha256:abc");
    expect(vdb.sessionId).toBe("s1");
    expect(vdb.entries.length).toBeGreaterThan(0);
  });
});

describe("inferFieldContext", () => {
  it("prefers unearnedBalance over earnedFees", () => {
    const text = "Unearned Balance: $4,200.00";
    const idx = text.indexOf("$4,200.00");
    expect(inferFieldContext(text, idx)).toBe("unearnedBalance");
  });
});

describe("validateVDBIntegrity", () => {
  it("is valid while the artifact hash matches", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    expect(validateVDBIntegrity(vdb, "sha256:abc")).toBe(true);
  });

  it("invalidates on hash mismatch (caller must re-prime)", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    expect(validateVDBIntegrity(vdb, "sha256:CHANGED")).toBe(false);
  });
});

describe("primeVDB — time/duration exclusion (poison fix)", () => {
  const DOC = [
    "TERMINATION",
    "The Firm shall return all unearned fees within fourteen (14) days.",
    "The unearned retainer balance is ($12,300.00).",
  ].join("\n");

  it("does not anchor a time/duration figure as a dollar amount", async () => {
    const vdb = await primeVDB(DOC, "sha256:x", "s1");
    const unearned = queryVDB(vdb, "numeric", "unearnedBalance").map((e) => Number(e.value));
    // The real balance is anchored; the "(14) days" figure is not.
    expect(unearned).toContain(12300);
    expect(unearned).not.toContain(14);
  });
});

describe("setNumericAnchor", () => {
  it("replaces a field's numeric anchors with the human-confirmed value", async () => {
    const vdb = await primeVDB(SAMPLE, "sha256:abc", "s1");
    const updated = setNumericAnchor(vdb, "unearnedBalance", 4200);

    expect(queryVDB(updated, "numeric", "unearnedBalance").map((e) => Number(e.value))).toEqual([4200]);
    // Anchors for other fields are untouched.
    expect(queryVDB(updated, "numeric", "totalHeld").map((e) => Number(e.value))).toContain(5000);
    // The input store is not mutated.
    expect(updated).not.toBe(vdb);
  });

  it("adds an anchor when the field had none", () => {
    const empty: VDBStore = { sessionId: "s", artifactHash: "h", entries: [], primedAt: "t" };
    const updated = setNumericAnchor(empty, "unearnedBalance", 999);
    expect(queryVDB(updated, "numeric", "unearnedBalance").map((e) => Number(e.value))).toEqual([999]);
  });
});
