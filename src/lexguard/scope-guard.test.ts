import { describe, it, expect } from "vitest";
import { AUTHORIZED_FIELDS, detectScopeViolation } from "./scope-guard";

describe("detectScopeViolation", () => {
  it("permits the authorized field set", () => {
    expect(
      detectScopeViolation(["clientId", "totalHeld", "earnedFees", "unearnedBalance", "recommendedPath"]),
    ).toEqual([]);
  });

  it("flags fields outside the whitelist", () => {
    expect(detectScopeViolation(["clientId", "ssn", "routingNumber"])).toEqual([
      "ssn",
      "routingNumber",
    ]);
  });

  it("authorizes exactly the twelve retainer fields", () => {
    expect(AUTHORIZED_FIELDS.size).toBe(12);
  });
});
