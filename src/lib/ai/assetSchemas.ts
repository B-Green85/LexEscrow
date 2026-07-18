/**
 * AI extraction schemas for all seven asset classes (platform spec §4),
 * following the same pattern as RETAINER_SCHEMA. Every schema carries the
 * escrow-core fields (so the AI response coerces to a `ParsedRetainerPayload`
 * and runs through the one LexGuard pipeline) plus the asset-specific metadata.
 * Monetary fields are integer cents.
 *
 * Legal reuses RETAINER_SCHEMA unchanged.
 */

import { RETAINER_SCHEMA, type ExtractionSchema, type SchemaField } from "./schema";
import type { AssetClass } from "../assetClasses";

/** Escrow-core fields present in every schema. `totalHeld` is the escrow amount;
 *  `earnedFees` + `unearnedBalance` must sum to it (payload-diff arithmetic). */
const ESCROW_CORE: SchemaField[] = [
  { name: "clientName", type: "string", description: "Primary party (buyer / client / licensee) full legal name as written" },
  { name: "counterpartyName", type: "string", description: "Secondary party (seller / firm / licensor) name as written" },
  { name: "totalHeld", type: "money", description: "Total escrow amount held, in US dollars" },
  { name: "earnedFees", type: "money", description: "Portion already earned / retained (0 if none)" },
  { name: "unearnedBalance", type: "money", description: "Remaining escrow balance; earnedFees + unearnedBalance must equal totalHeld" },
  { name: "disputedHours", type: "number", description: "Disputed hours, if any (0 otherwise)" },
  { name: "disputedAmount", type: "money", description: "Disputed amount in US dollars (0 if none)" },
  { name: "signaturesVerified", type: "boolean", description: "Whether all party signatures are present/verified" },
  {
    name: "recommendedPath",
    type: "enum",
    enum: ["DirectSettlement", "ArbitrationEscrow"],
    description: "DirectSettlement when undisputed; ArbitrationEscrow when disputes/holds are present",
  },
  { name: "anomaliesFlagged", type: "string[]", description: "Short descriptions of anomalies observed" },
  { name: "anomaliesSuppressed", type: "boolean", description: "Whether flagged anomalies were suppressed (should be false)" },
];

const schema = (id: AssetClass, fields: SchemaField[]): ExtractionSchema => ({
  id,
  fields: [...ESCROW_CORE, ...fields],
});

const REAL_ESTATE_SCHEMA = schema("real_estate", [
  { name: "parcelNumber", type: "string", description: "Assessor parcel number (APN)" },
  { name: "legalDescription", type: "string", description: "Legal description of the property" },
  { name: "county", type: "string", description: "County" },
  { name: "state", type: "string", description: "State" },
  { name: "earnestMoneyAmount", type: "money", description: "Earnest money deposit amount, US dollars" },
  { name: "closingDate", type: "string", description: "Closing date (YYYY-MM-DD)" },
  { name: "contingencies", type: "string[]", description: "Outstanding contingencies" },
]);

const BUSINESS_SCHEMA = schema("business", [
  { name: "buyerEntityName", type: "string", description: "Buyer entity legal name" },
  { name: "sellerEntityName", type: "string", description: "Seller entity legal name" },
  { name: "ein", type: "string", description: "Employer Identification Number" },
  { name: "earnestDeposit", type: "money", description: "Earnest deposit amount, US dollars" },
  { name: "closingConditions", type: "string[]", description: "Closing conditions" },
  { name: "repWarrantyExpiration", type: "string", description: "Rep and warranty expiration date" },
]);

const IP_SCHEMA = schema("ip", [
  { name: "usptoFilingNumber", type: "string", description: "USPTO filing / application number" },
  { name: "patentNumber", type: "string", description: "Granted patent number, if any" },
  { name: "licensee", type: "string", description: "Licensee name" },
  { name: "licensor", type: "string", description: "Licensor name" },
  { name: "royaltyRate", type: "string", description: "Royalty rate (e.g. 5%)" },
  { name: "royaltyPeriod", type: "string", description: "Royalty period" },
  { name: "territory", type: "string", description: "Licensed territory" },
]);

const ART_SCHEMA = schema("art", [
  { name: "artist", type: "string", description: "Artist name" },
  { name: "title", type: "string", description: "Work title" },
  { name: "medium", type: "string", description: "Medium" },
  { name: "dimensions", type: "string", description: "Dimensions" },
  { name: "creationDate", type: "string", description: "Creation date" },
  { name: "appraisedValue", type: "money", description: "Appraised value, US dollars" },
  { name: "provenanceChain", type: "string[]", description: "Provenance chain entries" },
]);

const NATURAL_RESOURCES_SCHEMA = schema("natural_resources", [
  { name: "rightsType", type: "enum", enum: ["Water", "Mineral", "Timber"], description: "Type of resource rights" },
  { name: "jurisdiction", type: "string", description: "Jurisdiction / agency" },
  { name: "acreage", type: "number", description: "Acreage" },
  { name: "extractionLimits", type: "string", description: "Extraction limits" },
  { name: "royaltyRate", type: "string", description: "Royalty rate" },
  { name: "expirationDate", type: "string", description: "Rights expiration date" },
]);

/**
 * Cannabis IND schema — exact fields required by the task, plus escrow core.
 */
const CANNABIS_IND_SCHEMA = schema("cannabis_ind", [
  { name: "state_license_number", type: "string", description: "State cannabis license number" },
  { name: "metrc_facility_id", type: "string", description: "Metrc facility identifier" },
  {
    name: "license_type",
    type: "enum",
    enum: ["dispensary", "cultivator", "manufacturer", "distributor"],
    description: "License type",
  },
  { name: "inventory_batch_numbers", type: "string[]", description: "Metrc inventory batch numbers in the transfer" },
  { name: "purchase_price", type: "money", description: "Purchase price, US dollars (integer cents)" },
  { name: "entity_name", type: "string", description: "Business entity legal name" },
  { name: "ein", type: "string", description: "Employer Identification Number" },
]);

export const ASSET_SCHEMAS: Record<AssetClass, ExtractionSchema> = {
  legal: RETAINER_SCHEMA,
  real_estate: REAL_ESTATE_SCHEMA,
  business: BUSINESS_SCHEMA,
  ip: IP_SCHEMA,
  art: ART_SCHEMA,
  natural_resources: NATURAL_RESOURCES_SCHEMA,
  cannabis_ind: CANNABIS_IND_SCHEMA,
};

/** The AI extraction schema for an asset class. `schemaFor('legal')` is exactly
 *  `RETAINER_SCHEMA` (reference identity), so the Legal path is unchanged. */
export function schemaFor(assetClass: AssetClass): ExtractionSchema {
  return ASSET_SCHEMAS[assetClass];
}
