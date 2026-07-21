import { describe, it, expect } from "vitest";
import { extractJson, parseWithTransport, validateAndConvert } from "./providers";
import { systemPromptFor } from "./assetSchemas";
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

describe("parseWithTransport (document text + per-class prompt wiring)", () => {
  const validJson = JSON.stringify(validCents);

  it("passes the non-empty document text to the transport as the user message", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const transport = async (system: string, user: string) => {
      calls.push({ system, user });
      return validJson;
    };

    const docText = "RETAINER TERMINATION AGREEMENT — total held $5,000.00 ...";
    const payload = await parseWithTransport(transport, docText, "legal");

    expect(calls).toHaveLength(1);
    expect(calls[0].user).toBe(docText);
    expect(calls[0].user.length).toBeGreaterThan(0);
    expect(payload.totalHeld).toBe(5000);
  });

  it("selects the system prompt for the given asset class", async () => {
    let seenSystem = "";
    const transport = async (system: string, _user: string) => {
      seenSystem = system;
      return validJson;
    };

    await parseWithTransport(transport, "PURCHASE AGREEMENT for parcel ...", "real_estate");
    expect(seenSystem).toBe(systemPromptFor("real_estate"));
    expect(seenSystem).toContain("parcelNumber");
  });

  it("throws before calling the transport when the document text is empty", async () => {
    let called = false;
    const transport = async () => {
      called = true;
      return validJson;
    };

    await expect(parseWithTransport(transport, "", "legal")).rejects.toThrow(/nothing for the AI to parse/i);
    await expect(parseWithTransport(transport, "   \n\t ", "legal")).rejects.toThrow();
    expect(called).toBe(false);
  });
});
