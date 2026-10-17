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

  it("carries the AI's clientName and lawFirmName onto the payload", () => {
    const r = validateAndConvert({ ...validCents, clientName: "ProvenyxRD LLC", lawFirmName: "Bergener Mirejovsky" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.payload.clientName).toBe("ProvenyxRD LLC");
      expect(r.payload.lawFirmName).toBe("Bergener Mirejovsky");
    }
  });

  it("treats a null party name as not found, not a validation failure", () => {
    const r = validateAndConvert({ ...validCents, clientName: null, lawFirmName: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.payload.clientName).toBeUndefined();
      expect(r.payload.lawFirmName).toBeUndefined();
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

  it("coerces null string fields (model 'not found') to their schema defaults", () => {
    const r = validateAndConvert({
      ...validCents,
      clientId: null,
      lawFirmWallet: null,
      clientWallet: null,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.payload.clientId).toBe("C-UNKNOWN"); // schema default
      expect(typeof r.payload.lawFirmWallet).toBe("string");
      expect(r.payload.lawFirmWallet.length).toBeGreaterThan(0); // ZERO_ADDRESS default
      expect(typeof r.payload.clientWallet).toBe("string");
      expect(r.payload.clientWallet.length).toBeGreaterThan(0);
    }
  });

  // Regression for the PDF-extraction fix: the real retainer that Claude
  // returns has null wallet fields (no on-chain addresses in the document).
  // This is the exact extraction object observed in the ai.rs debug logs.
  it("validates the real retainer extraction with null wallets", () => {
    const extracted = {
      clientId: "HW-2026-0847",
      lawFirmWallet: null,
      clientWallet: null,
      totalHeld: 1850000,
      earnedFees: 620000,
      unearnedBalance: 1230000,
      disputedHours: 0,
      disputedAmount: 0,
      signaturesVerified: false,
      recommendedPath: "DirectSettlement",
      anomaliesFlagged: ["No law firm wallet address found in document"],
      anomaliesSuppressed: false,
    };
    const r = validateAndConvert(extracted);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.payload.clientId).toBe("HW-2026-0847");
      expect(r.payload.totalHeld).toBe(18500);
      expect(r.payload.earnedFees).toBe(6200);
      expect(r.payload.unearnedBalance).toBe(12300);
      expect(r.payload.recommendedPath).toBe(ExecutionPath.DirectSettlement);
    }
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
