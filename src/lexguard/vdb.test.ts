import { describe, it, expect } from "vitest";
import { primeVDB, queryVDB, validateVDBIntegrity, inferFieldContext } from "./vdb";

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
