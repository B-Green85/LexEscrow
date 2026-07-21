import { describe, it, expect } from "vitest";
import { systemPromptFor } from "./assetSchemas";
import { ASSET_CLASS_LIST } from "../assetClasses";

describe("systemPromptFor", () => {
  it("legal prompt mentions totalHeld and earnedFees", () => {
    const prompt = systemPromptFor("legal");
    expect(prompt).toContain("totalHeld");
    expect(prompt).toContain("earnedFees");
  });

  it("real_estate prompt mentions parcelNumber and purchasePrice", () => {
    const prompt = systemPromptFor("real_estate");
    expect(prompt).toContain("parcelNumber");
    expect(prompt).toContain("purchasePrice");
  });

  it("cannabis_ind prompt mentions stateLicenseNumber and metrcFacilityId", () => {
    const prompt = systemPromptFor("cannabis_ind");
    expect(prompt).toContain("stateLicenseNumber");
    expect(prompt).toContain("metrcFacilityId");
  });

  it("returns a distinct prompt for every asset class", () => {
    const prompts = ASSET_CLASS_LIST.map((cls) => systemPromptFor(cls));
    expect(new Set(prompts).size).toBe(ASSET_CLASS_LIST.length);
  });

  it("names each class's own document type", () => {
    expect(systemPromptFor("real_estate").toLowerCase()).toContain("real estate");
    expect(systemPromptFor("ip").toLowerCase()).toContain("intellectual");
    expect(systemPromptFor("cannabis_ind").toLowerCase()).toContain("cannabis");
  });

  it("every prompt requires raw JSON, integer cents, no markdown, and the escrow core", () => {
    for (const cls of ASSET_CLASS_LIST) {
      const prompt = systemPromptFor(cls);
      const lower = prompt.toLowerCase();
      expect(lower).toContain("json");
      expect(lower).toContain("cents");
      expect(lower).toContain("markdown");
      // Escrow-settlement core the LexGuard validator requires for every class.
      expect(prompt).toContain("totalHeld");
      expect(prompt).toContain("recommendedPath");
      expect(prompt).toContain("anomaliesSuppressed");
    }
  });
});
