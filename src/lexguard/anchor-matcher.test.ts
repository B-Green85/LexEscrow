import { describe, it, expect } from "vitest";
import { matchClientName, matchBarNumber, normalizeName, isDurationNumeric } from "./anchor-matcher";

describe("matchClientName", () => {
  it("is case-insensitive and whitespace-normalized", () => {
    expect(matchClientName("Jane  Anderson", "jane anderson")).toBe(true);
    expect(matchClientName("  JANE\tANDERSON ", "Jane Anderson")).toBe(true);
  });

  it("rejects a different name", () => {
    expect(matchClientName("John Anderson", "Jane Anderson")).toBe(false);
  });

  it("normalizeName collapses whitespace", () => {
    expect(normalizeName("  Foo   Bar\n Baz ")).toBe("foo bar baz");
  });
});

describe("matchBarNumber", () => {
  it("passes when user and Chainlink agree and the doc has no bar number", () => {
    expect(matchBarNumber(null, "123456", "123456")).toBe(true);
  });

  it("passes when all three agree", () => {
    expect(matchBarNumber("123456", "123456", "123456")).toBe(true);
  });

  it("fails when the document bar number diverges", () => {
    expect(matchBarNumber("999999", "123456", "123456")).toBe(false);
  });

  it("fails when user and Chainlink disagree, regardless of the doc", () => {
    expect(matchBarNumber(null, "123456", "654321")).toBe(false);
    expect(matchBarNumber("123456", "123456", "654321")).toBe(false);
  });
});

describe("isDurationNumeric", () => {
  // Helper: place tokenEnd just past the numeric token in a realistic clause.
  const after = (clause: string, token: string) =>
    isDurationNumeric(clause, clause.indexOf(token) + token.length);

  it("excludes a number immediately followed by a duration unit", () => {
    expect(after("return all unearned fees within fourteen (14) days", "14")).toBe(true);
    expect(after("a due diligence period of 30 days", "30")).toBe(true);
    expect(after("terminate upon 2 weeks notice", "2")).toBe(true);
    expect(after("survives for 18 months", "18")).toBe(true);
    expect(after("a term of 5 years", "5")).toBe(true);
    expect(after("cured within 14 business days", "14")).toBe(true);
  });

  it("keeps genuine dollar amounts", () => {
    expect(after("deposit of ($18,500.00) upon execution", "18,500.00")).toBe(false);
    expect(after("balance is ($12,300.00).", "12,300.00")).toBe(false);
    expect(after("Partner rate $650.00 per hour", "650.00")).toBe(false);
    // A duration unit that is not immediately after the number is not excluded.
    expect(after("$5,000 payable per month thereafter", "5,000")).toBe(false);
  });
});
