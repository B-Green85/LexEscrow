// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/** The retainer field schema handed to an AI provider to shape its output. */

export interface SchemaField {
  name: string;
  type: "money" | "number" | "string" | "boolean" | "enum" | "string[]";
  description: string;
  enum?: string[];
}

export interface RetainerSchema {
  fields: SchemaField[];
}

/**
 * An asset-class extraction schema: the retainer field set (or an asset-class
 * projection of it) tagged with the asset class `id`. Structurally a superset of
 * `RetainerSchema`, so an `ExtractionSchema` is accepted anywhere a
 * `RetainerSchema` is expected — e.g. `provider.parse()`. `schemaFor('legal')`
 * returns the reference `RETAINER_SCHEMA`, keeping the Legal path unchanged.
 */
export interface ExtractionSchema extends RetainerSchema {
  id?: string;
}

export const RETAINER_SCHEMA: RetainerSchema = {
  fields: [
    { name: "clientId", type: "string", description: "Client identifier / matter number" },
    { name: "clientName", type: "string", description: "Client full legal name exactly as written in the document" },
    { name: "clientWallet", type: "string", description: "Client wallet address (0x…40 hex)" },
    { name: "lawFirmWallet", type: "string", description: "Law firm wallet address (0x…40 hex)" },
    { name: "totalHeld", type: "money", description: "Total retainer held, in US dollars" },
    { name: "earnedFees", type: "money", description: "Earned fees retained by the firm, in US dollars" },
    { name: "unearnedBalance", type: "money", description: "Unearned balance refundable to the client, in US dollars" },
    { name: "disputedHours", type: "number", description: "Disputed hours, if any" },
    { name: "disputedAmount", type: "money", description: "Disputed amount, in US dollars" },
    { name: "signaturesVerified", type: "boolean", description: "Whether the release document signatures are present/verified" },
    {
      name: "recommendedPath",
      type: "enum",
      enum: ["DirectSettlement", "ArbitrationEscrow"],
      description: "DirectSettlement when undisputed; ArbitrationEscrow when disputes are present",
    },
    { name: "anomaliesFlagged", type: "string[]", description: "Short descriptions of any anomalies observed" },
    { name: "anomaliesSuppressed", type: "boolean", description: "Whether flagged anomalies were suppressed (should be false)" },
    { name: "barNumberInDocument", type: "string", description: "Attorney bar number as written in the document, or null if absent" },
  ],
};
