import { describe, it, expect } from "vitest";
import { matchClientName, matchBarNumber, normalizeName } from "./anchor-matcher";

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
