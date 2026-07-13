import { describe, it, expect } from "vitest";
import { extractJson, validateAndConvert } from "./providers";
import { ExecutionPath } from "../../lexguard/types";

describe("extractJson", () => {
  it("parses a direct JSON object", () => {
    expect(extractJson('{"totalHeld":5000}').totalHeld).toBe(5000);
  });
  it("unwraps an Anthropic messages response", () => {
    const raw = JSON.stringify({ content: [{ text: '{"totalHeld":42}' }] });
    expect(extractJson(raw).totalHeld).toBe(42);
  });
  it("unwraps an OpenAI chat response", () => {
    const raw = JSON.stringify({ choices: [{ message: { content: '{"totalHeld":7}' } }] });
    expect(extractJson(raw).totalHeld).toBe(7);
  });
  it("finds a JSON block embedded in prose", () => {
    expect(extractJson('Sure! {"totalHeld": 9} — done.').totalHeld).toBe(9);
  });
  it("returns an empty object for junk", () => {
    expect(extractJson("not json at all")).toEqual({});
  });
});

const validCents = {
  clientId: "C-1",
  lawFirmWallet: "0xFirm",
  clientWallet: "0xClient",
  totalHeld: 500000,
  earnedFees: 80000,
  unearnedBalance: 420000,
  disputedHours: 0,
  disputedAmount: 0,
  signaturesVerified: true,
  recommendedPath: "DirectSettlement",
  anomaliesFlagged: [],
  anomaliesSuppressed: false,
};

describe("validateAndConvert (Zod + cents→dollars)", () => {
  it("validates integer cents and converts to dollars", () => {
    const r = validateAndConvert(validCents);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.payload.totalHeld).toBe(5000);
      expect(r.payload.earnedFees).toBe(800);
      expect(r.payload.unearnedBalance).toBe(4200);
      expect(r.payload.recommendedPath).toBe(ExecutionPath.DirectSettlement);
    }
  });

  it("coerces string-number cents", () => {
    const r = validateAndConvert({ ...validCents, totalHeld: "500000" });
    expect(r.success && r.payload.totalHeld).toBe(5000);
  });

  it("applies defaults for optional fields", () => {
    const minimal = { totalHeld: 500000, earnedFees: 80000, unearnedBalance: 420000, recommendedPath: "ArbitrationEscrow" };
    const r = validateAndConvert(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.payload.clientId).toBe("C-UNKNOWN");
      expect(r.payload.disputedAmount).toBe(0);
      expect(r.payload.recommendedPath).toBe(ExecutionPath.ArbitrationEscrow);
    }
  });

  it("fails when required money fields are missing (triggers retry)", () => {
    expect(validateAndConvert({ recommendedPath: "DirectSettlement" }).success).toBe(false);
  });

  it("fails when recommendedPath is missing or invalid", () => {
    const { recommendedPath, ...noPath } = validCents;
    void recommendedPath;
    expect(validateAndConvert(noPath).success).toBe(false);
    expect(validateAndConvert({ ...validCents, recommendedPath: "Whatever" }).success).toBe(false);
  });

  it("fails on a completely empty / junk object", () => {
    expect(validateAndConvert({}).success).toBe(false);
  });
});
