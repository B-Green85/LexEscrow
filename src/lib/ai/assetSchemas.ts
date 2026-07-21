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

// ── AI system prompts (per asset class) ──────────────────────────────────────
//
// `systemPromptFor(assetClass)` is the top-level `system` string handed to the
// model for a document of that class (providers.ts → backend transport →
// ai.rs / browser fetch). Each prompt names the document type, lists every
// field with its type and description, and states the value to emit when a
// field is absent.
//
// Every prompt asks for the escrow-settlement core (SETTLEMENT_FIELDS +
// TAIL_FIELDS) in addition to the class-specific metadata, because the LexGuard
// validator (lexguard/types.ts `AiExtractionSchema`) *requires* the money and
// routing fields for all seven classes — `totalHeld` is the amount actually
// held in escrow, whatever the class calls its headline figure. Unknown keys in
// the response are stripped by that validator, so the class-specific metadata is
// safe to request even though the current payload only consumes the core.

/**
 * One field the model must return, plus the exact value to emit when the
 * document does not contain it. `notFound` is rendered verbatim so the model
 * returns a value the Zod validator accepts: strings/enums → null, money/number
 * → 0, boolean → false, list → [] (and `recommendedPath` → a valid enum member,
 * since it has no schema default).
 */
interface PromptField {
  name: string;
  type: string;
  description: string;
  notFound: string;
}

/**
 * Escrow-settlement fields every class must return regardless of its metadata —
 * the values the LexGuard pipeline and payload arithmetic consume. Held
 * identical across classes so settlement behaves the same everywhere.
 */
const SETTLEMENT_FIELDS: PromptField[] = [
  { name: "totalHeld", type: "integer cents", description: "Total amount held in escrow for this transaction (the escrow balance).", notFound: "0" },
  { name: "earnedFees", type: "integer cents", description: "Portion of the escrow already earned or released.", notFound: "0" },
  { name: "unearnedBalance", type: "integer cents", description: "Remaining escrow balance still held; earnedFees + unearnedBalance must equal totalHeld.", notFound: "0" },
  { name: "disputedHours", type: "number", description: "Disputed hours, if any.", notFound: "0" },
  { name: "disputedAmount", type: "integer cents", description: "Disputed amount in escrow.", notFound: "0" },
  { name: "signaturesVerified", type: "boolean", description: "Whether all required party signatures are present and verified.", notFound: "false" },
];

/** Routing + anomaly fields, returned last by every class. */
const TAIL_FIELDS: PromptField[] = [
  { name: "recommendedPath", type: "DirectSettlement | ArbitrationEscrow | StagedRelease", description: "DirectSettlement when undisputed; ArbitrationEscrow when disputes or compliance holds are present; StagedRelease for milestone-based release.", notFound: "DirectSettlement" },
  { name: "anomaliesFlagged", type: "string[]", description: "Short descriptions of any inconsistencies, missing signatures, or suspicious values observed.", notFound: "[]" },
  { name: "anomaliesSuppressed", type: "boolean", description: "Whether flagged anomalies were suppressed. Always return false.", notFound: "false" },
];

const LEGAL_FIELDS: PromptField[] = [
  { name: "clientId", type: "string", description: "Client identifier or matter number.", notFound: "null" },
  { name: "lawFirmWallet", type: "string", description: "Law firm wallet address (0x followed by 40 hex characters).", notFound: "null" },
  { name: "clientWallet", type: "string", description: "Client wallet address (0x followed by 40 hex characters).", notFound: "null" },
  ...SETTLEMENT_FIELDS,
  ...TAIL_FIELDS,
];

const REAL_ESTATE_FIELDS: PromptField[] = [
  { name: "parcelNumber", type: "string", description: "Assessor parcel number (APN).", notFound: "null" },
  { name: "county", type: "string", description: "County where the property is located.", notFound: "null" },
  { name: "state", type: "string", description: "State where the property is located.", notFound: "null" },
  { name: "buyerName", type: "string", description: "Buyer full legal name.", notFound: "null" },
  { name: "sellerName", type: "string", description: "Seller full legal name.", notFound: "null" },
  { name: "buyerEmail", type: "string", description: "Buyer email address.", notFound: "null" },
  { name: "sellerEmail", type: "string", description: "Seller email address.", notFound: "null" },
  { name: "purchasePrice", type: "integer cents", description: "Total purchase price of the property.", notFound: "0" },
  { name: "earnestMoney", type: "integer cents", description: "Earnest money deposit amount.", notFound: "0" },
  { name: "closingDate", type: "string (ISO 8601 date, YYYY-MM-DD)", description: "Scheduled closing date.", notFound: "null" },
  { name: "contingencies", type: "string[]", description: "Outstanding contingencies (inspection, financing, appraisal, etc.).", notFound: "[]" },
  { name: "titleClear", type: "boolean", description: "Whether title is clear of liens and encumbrances.", notFound: "false" },
  ...SETTLEMENT_FIELDS,
  ...TAIL_FIELDS,
];

const BUSINESS_FIELDS: PromptField[] = [
  { name: "buyerEntity", type: "string", description: "Buyer entity legal name.", notFound: "null" },
  { name: "sellerEntity", type: "string", description: "Seller entity legal name.", notFound: "null" },
  { name: "ein", type: "string", description: "Employer Identification Number of the target / seller entity.", notFound: "null" },
  { name: "buyerEmail", type: "string", description: "Buyer contact email address.", notFound: "null" },
  { name: "sellerEmail", type: "string", description: "Seller contact email address.", notFound: "null" },
  { name: "purchasePrice", type: "integer cents", description: "Total purchase price for the business.", notFound: "0" },
  { name: "earnestDeposit", type: "integer cents", description: "Earnest deposit amount.", notFound: "0" },
  { name: "dueDiligencePeriodDays", type: "number", description: "Length of the due diligence period, in days.", notFound: "0" },
  { name: "closingDate", type: "string", description: "Scheduled closing date.", notFound: "null" },
  { name: "representationsAndWarrantiesPeriodMonths", type: "number", description: "Survival period of representations and warranties, in months.", notFound: "0" },
  ...SETTLEMENT_FIELDS,
  ...TAIL_FIELDS,
];

const IP_FIELDS: PromptField[] = [
  { name: "usptoFilingNumber", type: "string", description: "USPTO filing or application number.", notFound: "null" },
  { name: "patentNumber", type: "string", description: "Granted patent number, if issued.", notFound: "null" },
  { name: "licenseeName", type: "string", description: "Licensee (or assignee) name.", notFound: "null" },
  { name: "licensorName", type: "string", description: "Licensor (or assignor) name.", notFound: "null" },
  { name: "licenseeEmail", type: "string", description: "Licensee email address.", notFound: "null" },
  { name: "licensorEmail", type: "string", description: "Licensor email address.", notFound: "null" },
  { name: "assignmentPrice", type: "integer cents", description: "One-time assignment or purchase price.", notFound: "0" },
  { name: "royaltyRate", type: "string", description: 'Royalty rate exactly as written (e.g. "5%").', notFound: "null" },
  { name: "royaltyCapCents", type: "integer cents", description: "Maximum total royalties payable (royalty cap).", notFound: "0" },
  { name: "effectiveDate", type: "string", description: "Effective date of the assignment / license.", notFound: "null" },
  { name: "urecordationRequired", type: "boolean", description: "Whether USPTO recordation of the assignment is required.", notFound: "false" },
  ...SETTLEMENT_FIELDS,
  ...TAIL_FIELDS,
];

const ART_FIELDS: PromptField[] = [
  { name: "artistName", type: "string", description: "Artist name.", notFound: "null" },
  { name: "workTitle", type: "string", description: "Title of the work.", notFound: "null" },
  { name: "medium", type: "string", description: "Medium (e.g. oil on canvas).", notFound: "null" },
  { name: "dimensions", type: "string", description: "Dimensions of the work.", notFound: "null" },
  { name: "yearCreated", type: "string", description: "Year the work was created.", notFound: "null" },
  { name: "appraisedValue", type: "integer cents", description: "Appraised value of the work.", notFound: "0" },
  { name: "salePrice", type: "integer cents", description: "Agreed sale price.", notFound: "0" },
  { name: "buyerName", type: "string", description: "Buyer full legal name.", notFound: "null" },
  { name: "sellerName", type: "string", description: "Seller full legal name.", notFound: "null" },
  { name: "buyerEmail", type: "string", description: "Buyer email address.", notFound: "null" },
  { name: "sellerEmail", type: "string", description: "Seller email address.", notFound: "null" },
  { name: "provenanceChain", type: "string[]", description: "Ordered provenance chain entries (prior owners / transfers).", notFound: "[]" },
  { name: "authenticityVerified", type: "boolean", description: "Whether authenticity is verified / a certificate of authenticity is present.", notFound: "false" },
  ...SETTLEMENT_FIELDS,
  ...TAIL_FIELDS,
];

const NATURAL_RESOURCES_FIELDS: PromptField[] = [
  { name: "rightsType", type: "water | mineral | timber | surface | oil_gas", description: "Type of resource rights being transferred.", notFound: "null" },
  { name: "jurisdiction", type: "string", description: "Jurisdiction or governing agency.", notFound: "null" },
  { name: "acreage", type: "number", description: "Acreage covered by the rights.", notFound: "0" },
  { name: "certificateNumber", type: "string", description: "Rights certificate number.", notFound: "null" },
  { name: "priorityDate", type: "string", description: "Priority date of the rights.", notFound: "null" },
  { name: "buyerName", type: "string", description: "Buyer full legal name.", notFound: "null" },
  { name: "sellerName", type: "string", description: "Seller full legal name.", notFound: "null" },
  { name: "buyerEmail", type: "string", description: "Buyer email address.", notFound: "null" },
  { name: "sellerEmail", type: "string", description: "Seller email address.", notFound: "null" },
  { name: "purchasePrice", type: "integer cents", description: "Total purchase price for the rights.", notFound: "0" },
  { name: "agencyApprovalRequired", type: "boolean", description: "Whether a government agency must approve the transfer.", notFound: "false" },
  ...SETTLEMENT_FIELDS,
  ...TAIL_FIELDS,
];

const CANNABIS_IND_FIELDS: PromptField[] = [
  { name: "stateLicenseNumber", type: "string", description: "State cannabis license number.", notFound: "null" },
  { name: "metrcFacilityId", type: "string", description: "Metrc facility identifier.", notFound: "null" },
  { name: "licenseType", type: "dispensary | cultivator | manufacturer | distributor", description: "Type of cannabis license.", notFound: "null" },
  { name: "entityName", type: "string", description: "Licensed business entity legal name.", notFound: "null" },
  { name: "buyerName", type: "string", description: "Buyer full legal name.", notFound: "null" },
  { name: "sellerName", type: "string", description: "Seller full legal name.", notFound: "null" },
  { name: "buyerEmail", type: "string", description: "Buyer email address.", notFound: "null" },
  { name: "sellerEmail", type: "string", description: "Seller email address.", notFound: "null" },
  { name: "purchasePrice", type: "integer cents", description: "Total purchase price for the license / inventory.", notFound: "0" },
  { name: "inventoryBatchNumbers", type: "string[]", description: "Metrc inventory batch numbers included in the transfer.", notFound: "[]" },
  { name: "licenseExpirationDate", type: "string", description: "Expiration date of the state license.", notFound: "null" },
  ...SETTLEMENT_FIELDS,
  ...TAIL_FIELDS,
];

const DOC_TYPES: Record<AssetClass, string> = {
  legal: "law-firm retainer termination and client trust-account release agreement",
  real_estate: "real estate purchase agreement, with its deed and title documents",
  business: "business acquisition and purchase agreement (M&A)",
  ip: "intellectual-property assignment and patent license agreement",
  art: "art or collectible sale agreement, with certificate of authenticity and provenance records",
  natural_resources: "natural-resources rights transfer agreement (water, mineral, timber, surface, or oil & gas rights)",
  cannabis_ind: "cannabis-industry license transfer, with its state license, Metrc registration, and transfer manifest",
};

const PROMPT_FIELDS: Record<AssetClass, PromptField[]> = {
  legal: LEGAL_FIELDS,
  real_estate: REAL_ESTATE_FIELDS,
  business: BUSINESS_FIELDS,
  ip: IP_FIELDS,
  art: ART_FIELDS,
  natural_resources: NATURAL_RESOURCES_FIELDS,
  cannabis_ind: CANNABIS_IND_FIELDS,
};

function renderPrompt(assetClass: AssetClass): string {
  const fields = PROMPT_FIELDS[assetClass]
    .map((f) => `- ${f.name} (${f.type}): ${f.description} Return ${f.notFound} if not found.`)
    .join("\n");

  return `You are an AI extraction agent. You are reading a ${DOC_TYPES[assetClass]}. Extract the fields listed below from the document text and return them as a single raw JSON object.

Fields to extract:
${fields}

Rules:
- Return ONLY the raw JSON object described above. No markdown, no code fences, no preamble, no explanation.
- Every monetary value MUST be an integer number of cents (for example $1,234.56 becomes 123456). Never use dollars, decimal points, thousands separators, or currency symbols.
- earnedFees + unearnedBalance must equal totalHeld.
- If a field is not present in the document, return exactly the "not found" value listed for that field above.
- anomaliesSuppressed must always be false.`;
}

/**
 * The top-level `system` prompt for an asset class. `systemPromptFor('legal')`
 * asks for exactly the retainer field set; every other class names its own
 * document type and metadata while still returning the escrow-settlement core.
 */
export function systemPromptFor(assetClass: AssetClass): string {
  return renderPrompt(assetClass);
}
