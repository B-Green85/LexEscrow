// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Asset class abstraction — the single barrel for LexEscrow's seven asset
 * classes (platform spec §4). The underlying escrow engine (ArtifactGuard, the
 * LexGuard pipeline, CRE settlement) is identical across every class; only the
 * metadata schema, the trust anchors collected at Document Load, and the
 * display chrome differ.
 *
 * `legal` is one value of `AssetClass` — nothing here is hardwired to it. The
 * existing `TrustAnchors` / `ParsedRetainerPayload` types (in lexguard/types.ts,
 * which is never modified) are the Legal implementation; every class projects
 * its extraction onto that same `ParsedRetainerPayload` so the one LexGuard
 * pipeline validates all of them.
 */

import { ExecutionPath, type ParsedRetainerPayload, type TrustAnchors } from "../lexguard/types";

export { ExecutionPath };
export type { ParsedRetainerPayload, TrustAnchors };

// ── Asset class identity ─────────────────────────────────────────────────────

export type AssetClass =
  | "legal"
  | "real_estate"
  | "business"
  | "ip"
  | "art"
  | "natural_resources"
  | "cannabis_ind";

export const ASSET_CLASS_LIST: AssetClass[] = [
  "legal",
  "real_estate",
  "business",
  "ip",
  "art",
  "natural_resources",
  "cannabis_ind",
];

// ── Trust-anchor field definitions (Document Load) ───────────────────────────

export type AnchorFieldType = "text" | "email" | "money" | "state" | "select";

export interface AnchorFieldDef {
  key: string;
  label: string;
  type: AnchorFieldType;
  required?: boolean;
  placeholder?: string;
  options?: string[]; // for select / state
  full?: boolean; // span both grid columns
}

/**
 * One required signer for a class's escrow release. Every class has exactly two
 * (its two parties). The email and the in-app choice are entered manually on
 * Document Load and stored in the raw anchor record under `emailKey` / `modeKey`
 * — **never populated by AI parsing**. A signer routes to a DocuSign email when a
 * valid email is entered; the officer may instead mark `modeKey` as `"in_app"`,
 * and that party signs in-app with no email. One of the two must be chosen for
 * every signer before processing can begin.
 */
export interface SignerDef {
  role: string; // display label, e.g. "Buyer", "Client", "Law firm"
  nameKey: string; // raw anchor key holding the party's name
  emailKey: string; // raw anchor key holding the party's (optional) email
  modeKey: string; // raw anchor key; "in_app" when the party signs in-app
}

/** Maps a class's anchor field keys onto the pipeline's `TrustAnchors` shape so
 *  AnchorMatcher / notification / bar-verify code is class-agnostic. */
export interface TrustAnchorMap {
  identifier?: string; // → attorneyBarNumber (primary verifiable identifier)
  state?: string; // → state
  primaryParty?: string; // → clientFullLegalName (party notified / anchored)
  primaryEmail?: string; // → clientEmail
  phone?: string; // → clientPhone
}

export interface AssetClassDescriptor {
  id: AssetClass;
  displayName: string; // "Cannabis IND"
  abbrev: string; // "CAN-IND"
  icon: string; // emoji
  uploadLabel: string; // Document Load upload prompt
  /** Which extracted fields name the two primary parties (dashboard Parties col). */
  partyLabels: [string, string];
  anchorFields: AnchorFieldDef[];
  trustAnchorMap: TrustAnchorMap;
  /** The two required signers for this class's escrow release (spec §23). */
  signers: SignerDef[];
  /** AI-extracted metadata field names (spec §4 "Key metadata"). */
  metadataFields: string[];
  /** Release conditions applicable to this class (spec §4). */
  releaseConditions: string[];
}

// ── US states (non-legal classes) ────────────────────────────────────────────

export const US_STATES: string[] = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
  "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
  "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
  "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
  "Wisconsin", "Wyoming",
];

const text = (key: string, label: string, required = true, placeholder?: string): AnchorFieldDef => ({
  key,
  label,
  type: "text",
  required,
  placeholder,
});
const money = (key: string, label: string, required = true): AnchorFieldDef => ({
  key,
  label,
  type: "money",
  required,
});

/** A signer definition, deriving `modeKey` from the email key's party prefix
 *  (e.g. `buyerEmail` → `buyerSignMode`). */
const signer = (role: string, nameKey: string, emailKey: string): SignerDef => ({
  role,
  nameKey,
  emailKey,
  modeKey: `${emailKey.replace(/Email$/i, "")}SignMode`,
});

// ── The registry ─────────────────────────────────────────────────────────────

export const ASSET_CLASSES: Record<AssetClass, AssetClassDescriptor> = {
  legal: {
    id: "legal",
    displayName: "Legal",
    abbrev: "LAW",
    icon: "⚖️",
    uploadLabel: "Retainer termination document",
    partyLabels: ["Client", "Law firm"],
    anchorFields: [
      text("attorneyBarNumber", "Attorney bar number", true, "123456"),
      // Legal is California-only for now (V2 roadmap: 50-state BarVerify).
      { key: "state", label: "State", type: "select", required: true, options: ["California"] },
      { key: "clientFullLegalName", label: "Client full legal name", type: "text", required: true, placeholder: "Jane Anderson", full: true },
      text("lawFirmName", "Law firm name", true, "Hargrove & Weston LLP"),
      { key: "clientPhone", label: "Client phone", type: "text", required: false, placeholder: "+1 555 010 0000" },
    ],
    trustAnchorMap: {
      identifier: "attorneyBarNumber",
      state: "state",
      primaryParty: "clientFullLegalName",
      primaryEmail: "clientEmail",
      phone: "clientPhone",
    },
    signers: [
      signer("Client", "clientFullLegalName", "clientEmail"),
      signer("Law firm", "lawFirmName", "lawFirmEmail"),
    ],
    metadataFields: [
      "attorney bar number", "client ID", "total retainer held", "earned fees",
      "unearned balance", "disputed hours", "termination date",
    ],
    releaseConditions: [
      "Billing reconciled", "Signatures verified", "Disputed hours resolved", "Appeal period expired",
    ],
  },

  real_estate: {
    id: "real_estate",
    displayName: "Real Estate",
    abbrev: "RE",
    icon: "🏠",
    uploadLabel: "Purchase agreement, deed & title documents",
    partyLabels: ["Buyer", "Seller"],
    anchorFields: [
      text("parcelNumber", "Parcel number", true, "APN 123-456-789"),
      text("county", "County", true, "Los Angeles"),
      { key: "state", label: "State", type: "state", required: true },
      text("buyerName", "Buyer name", true, "Smith"),
      text("sellerName", "Seller name", true, "Jones"),
      money("purchasePrice", "Purchase price"),
    ],
    trustAnchorMap: {
      identifier: "parcelNumber",
      state: "state",
      primaryParty: "buyerName",
      primaryEmail: "buyerEmail",
    },
    signers: [
      signer("Buyer", "buyerName", "buyerEmail"),
      signer("Seller", "sellerName", "sellerEmail"),
    ],
    metadataFields: [
      "parcel number", "legal description", "county", "state", "purchase price",
      "earnest money amount", "closing date", "contingencies",
    ],
    releaseConditions: [
      "Title clear", "Inspection contingency waived", "Financing confirmed",
      "Closing documents executed by all parties",
    ],
  },

  business: {
    id: "business",
    displayName: "Business",
    abbrev: "BIZ",
    icon: "💼",
    uploadLabel: "Purchase agreement & due diligence documents",
    partyLabels: ["Buyer entity", "Seller entity"],
    anchorFields: [
      text("buyerEntityName", "Buyer entity name", true, "Acme Corp"),
      text("sellerEntityName", "Seller entity name", true, "Beta LLC"),
      text("ein", "EIN", true, "12-3456789"),
      money("purchasePrice", "Purchase price"),
    ],
    trustAnchorMap: {
      identifier: "ein",
      primaryParty: "buyerEntityName",
      primaryEmail: "buyerEmail",
    },
    signers: [
      signer("Buyer entity", "buyerEntityName", "buyerEmail"),
      signer("Seller entity", "sellerEntityName", "sellerEmail"),
    ],
    metadataFields: [
      "entity names", "EIN", "purchase price", "earnest deposit",
      "closing conditions", "rep and warranty expiration",
    ],
    releaseConditions: [
      "Due diligence complete", "Regulatory approval received",
      "Milestone deliverable accepted", "Rep and warranty period expired",
    ],
  },

  ip: {
    id: "ip",
    displayName: "Intellectual Property",
    abbrev: "IP",
    icon: "📋",
    uploadLabel: "Patent assignment & license documents",
    partyLabels: ["Licensee", "Licensor"],
    anchorFields: [
      text("usptoFilingNumber", "USPTO filing number", true, "US 12/345,678"),
      text("licenseeName", "Licensee name", true, "Inventor"),
      text("licensorName", "Licensor name", true, "Licensee Co"),
      text("royaltyRate", "Royalty rate", true, "5%"),
    ],
    trustAnchorMap: {
      identifier: "usptoFilingNumber",
      primaryParty: "licenseeName",
      primaryEmail: "licenseeEmail",
    },
    signers: [
      signer("Licensee", "licenseeName", "licenseeEmail"),
      signer("Licensor", "licensorName", "licensorEmail"),
    ],
    metadataFields: [
      "USPTO filing number", "patent number", "licensee", "licensor",
      "royalty rate", "royalty period", "territory",
    ],
    releaseConditions: [
      "USPTO transfer confirmed", "Royalty audit complete",
      "Settlement agreement executed", "License effective date reached",
    ],
  },

  art: {
    id: "art",
    displayName: "Art & Collectibles",
    abbrev: "ART",
    icon: "🎨",
    uploadLabel: "Certificate of authenticity & provenance",
    partyLabels: ["Buyer", "Seller"],
    anchorFields: [
      text("artistName", "Artist name", true, "Gallery"),
      text("title", "Title", true, "Untitled #4"),
      text("medium", "Medium", true, "Oil on canvas"),
      money("appraisedValue", "Appraised value"),
      text("buyerName", "Buyer name", true, "Collector"),
      text("sellerName", "Seller name", true, "Gallery"),
    ],
    trustAnchorMap: {
      identifier: "title",
      primaryParty: "buyerName",
      primaryEmail: "buyerEmail",
    },
    signers: [
      signer("Buyer", "buyerName", "buyerEmail"),
      signer("Seller", "sellerName", "sellerEmail"),
    ],
    metadataFields: [
      "artist", "title", "medium", "dimensions", "creation date",
      "current location", "appraised value", "provenance chain",
    ],
    releaseConditions: [
      "Physical delivery confirmed", "Condition report accepted",
      "Provenance chain verified", "Authenticity certificate issued",
    ],
  },

  natural_resources: {
    id: "natural_resources",
    displayName: "Natural Resources",
    abbrev: "NR",
    icon: "💧",
    uploadLabel: "Rights certificate, deed & agency approval",
    partyLabels: ["Buyer", "Seller"],
    anchorFields: [
      {
        key: "rightsType",
        label: "Rights type",
        type: "select",
        required: true,
        options: ["Water", "Mineral", "Timber"],
      },
      text("jurisdiction", "Jurisdiction", true, "Kern County"),
      { key: "acreage", label: "Acreage", type: "text", required: true, placeholder: "640" },
      text("buyerName", "Buyer name", true, "Farm"),
      text("sellerName", "Seller name", true, "County"),
    ],
    trustAnchorMap: {
      identifier: "jurisdiction",
      primaryParty: "buyerName",
      primaryEmail: "buyerEmail",
    },
    signers: [
      signer("Buyer", "buyerName", "buyerEmail"),
      signer("Seller", "sellerName", "sellerEmail"),
    ],
    metadataFields: [
      "rights type", "jurisdiction", "acreage", "resource type",
      "extraction limits", "royalty rate", "expiration date",
    ],
    releaseConditions: [
      "Agency transfer confirmed", "Survey complete",
      "Extraction license issued", "Royalty period verified",
    ],
  },

  cannabis_ind: {
    id: "cannabis_ind",
    displayName: "Cannabis IND",
    abbrev: "CAN-IND",
    icon: "🌿",
    uploadLabel: "State license, Metrc registration & transfer manifest",
    partyLabels: ["Buyer", "Seller"],
    anchorFields: [
      text("stateLicenseNumber", "State license number", true, "C10-0000123-LIC"),
      text("metrcFacilityId", "Metrc facility ID", true, "CDPH-10001234"),
      {
        key: "licenseType",
        label: "License type",
        type: "select",
        required: true,
        options: ["Dispensary", "Cultivator", "Manufacturer", "Distributor"],
      },
      text("entityName", "Entity name", true, "GreenLeaf Co"),
      text("buyerName", "Buyer name", true, "GreenLeaf"),
      text("sellerName", "Seller name", true, "Emerald Co"),
    ],
    trustAnchorMap: {
      identifier: "stateLicenseNumber",
      primaryParty: "buyerName",
      primaryEmail: "buyerEmail",
    },
    signers: [
      signer("Buyer", "buyerName", "buyerEmail"),
      signer("Seller", "sellerName", "sellerEmail"),
    ],
    metadataFields: [
      "state license number", "Metrc facility ID", "license type", "license status",
      "compliance hold status", "inventory batch numbers", "entity name", "EIN",
      "state of licensure",
    ],
    releaseConditions: [
      "State license verified active in Metrc", "No open compliance holds",
      "Inventory count confirmed", "Transfer manifest confirmed",
      "Lab test results meet specifications", "Entity in good standing",
      "All parties signed",
    ],
  },
};

export function descriptorFor(assetClass: AssetClass): AssetClassDescriptor {
  return ASSET_CLASSES[assetClass];
}

// ── Anchor helpers ───────────────────────────────────────────────────────────

/** Empty anchor record for a class — every field key present, state defaulted,
 *  plus each signer's email and sign-mode key seeded blank. */
export function emptyAnchorsFor(assetClass: AssetClass): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ASSET_CLASSES[assetClass].anchorFields) {
    out[f.key] = f.type === "state" ? "" : f.options?.[0] ?? "";
  }
  for (const s of ASSET_CLASSES[assetClass].signers) {
    out[s.emailKey] = "";
    out[s.modeKey] = "";
  }
  return out;
}

/** Project a class's anchor record onto the pipeline's `TrustAnchors` shape.
 *  For `legal` this is the identity mapping, so the Legal flow is unchanged.
 *  `email` mirrors the primary party's manually-entered address (blank → in-app);
 *  it is never populated by AI. */
export function anchorsToTrustAnchors(
  assetClass: AssetClass,
  raw: Record<string, string>,
): TrustAnchors {
  const map = ASSET_CLASSES[assetClass].trustAnchorMap;
  const primaryEmail = ((map.primaryEmail && raw[map.primaryEmail]) || "").trim();
  return {
    attorneyBarNumber: (map.identifier && raw[map.identifier]) || "",
    state: (map.state && raw[map.state]) || "",
    clientFullLegalName: (map.primaryParty && raw[map.primaryParty]) || "",
    clientEmail: primaryEmail,
    clientPhone: map.phone ? raw[map.phone] : undefined,
    ...(primaryEmail && { email: primaryEmail }),
  };
}

// ── Signer routing (email vs in-app) ─────────────────────────────────────────

export const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** The two required signers for a class. */
export function signersFor(assetClass: AssetClass): SignerDef[] {
  return ASSET_CLASSES[assetClass].signers;
}

/**
 * A signer routes to a DocuSign email — a valid email was entered and the
 * officer has not overridden the party to in-app signing. Email absent or the
 * in-app override set means the party signs in-app instead.
 */
export function signerHasEmail(signer: SignerDef, raw: Record<string, string>): boolean {
  if ((raw[signer.modeKey] ?? "") === "in_app") return false;
  return EMAIL_RE.test((raw[signer.emailKey] ?? "").trim());
}

/**
 * The officer has resolved this signer's route: either a valid email is entered,
 * or the party is explicitly marked to sign in-app. An undecided signer (no
 * email and no in-app choice) is not complete — the choice is forced.
 */
export function signerRouteComplete(signer: SignerDef, raw: Record<string, string>): boolean {
  if ((raw[signer.modeKey] ?? "") === "in_app") return true;
  return EMAIL_RE.test((raw[signer.emailKey] ?? "").trim());
}

/** Every required signer has a resolved route (email or in-app). */
export function signersComplete(assetClass: AssetClass, raw: Record<string, string>): boolean {
  return ASSET_CLASSES[assetClass].signers.every((s) => signerRouteComplete(s, raw));
}

/**
 * Required anchor fields are all filled, and every required signer's route
 * (email or in-app) has been decided.
 */
export function anchorsComplete(assetClass: AssetClass, raw: Record<string, string>): boolean {
  const fieldsOk = ASSET_CLASSES[assetClass].anchorFields.every((f) => {
    if (!f.required) return true;
    return (raw[f.key] ?? "").trim().length > 0;
  });
  return fieldsOk && signersComplete(assetClass, raw);
}

// ── Folder / filename → asset class detection (batch Load Folder) ────────────

const DETECT: Array<[RegExp, AssetClass]> = [
  [/cannabis|metrc|dispensary|cultivat|marijuana|can[-_]?ind/i, "cannabis_ind"],
  [/real[-_ ]?estate|deed|escrow_re|parcel|title|closing/i, "real_estate"],
  [/business|acquisition|m&a|merger|loi|entity/i, "business"],
  [/\bip\b|patent|trademark|uspto|licens/i, "ip"],
  [/\bart\b|provenance|painting|collectible|gallery/i, "art"],
  [/natural[-_ ]?resource|water[-_ ]?rights|mineral|timber/i, "natural_resources"],
  [/legal|retainer|attorney|law/i, "legal"],
];

/** Detect an asset class from a folder or filename. Null if ambiguous. */
export function detectAssetClassFromName(name: string): AssetClass | null {
  for (const [re, cls] of DETECT) if (re.test(name)) return cls;
  return null;
}

// ── Display extraction (dashboard Parties / Amount, non-legal projection) ────

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function firstDollarAmount(text: string): number {
  const m = text.match(/\$?\s*([\d]{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function labelledValue(text: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*([A-Z][A-Za-z0-9.,'&/ -]{1,60})`, "i");
    const m = text.match(re);
    if (m) return m[1].trim().replace(/\s{2,}/g, " ");
  }
  return "";
}

export interface AssetDisplayInfo {
  primaryParty: string;
  secondaryParty: string;
  amountDollars: number;
  identifier: string;
}

/** Deterministic, display-only extraction from document text — party names,
 *  escrow amount, and primary identifier — for the dashboard and the non-legal
 *  ParsedRetainerPayload projection. This is NOT LexGuard validation. */
export function extractAssetInfo(assetClass: AssetClass, text: string): AssetDisplayInfo {
  const [p1Label, p2Label] = ASSET_CLASSES[assetClass].partyLabels;
  const primaryParty = labelledValue(text, [p1Label, "Buyer", "Client", "Licensee", "Artist", "Party"]);
  const secondaryParty = labelledValue(text, [p2Label, "Seller", "Law firm", "Licensor", "Counterparty"]);
  const amountLine = text.match(/(?:price|amount|value|escrow|total)[^\n]*/i)?.[0] ?? text;
  return {
    primaryParty,
    secondaryParty,
    amountDollars: firstDollarAmount(amountLine),
    identifier: labelledValue(text, ["License", "Parcel", "EIN", "USPTO", "Facility", "Jurisdiction"]),
  };
}

/**
 * Project a non-legal document into the pipeline's `ParsedRetainerPayload`.
 * Escrow amount → `totalHeld`; `earnedFees` = 0 and `unearnedBalance` = total so
 * the payload-diff arithmetic check holds; primary party → `clientName`. The
 * SAME LexGuard pipeline then validates it. (Legal never calls this — it keeps
 * its own retainer parser.)
 */
export function projectToRetainerPayload(assetClass: AssetClass, text: string): ParsedRetainerPayload {
  const info = extractAssetInfo(assetClass, text);
  const total = info.amountDollars;
  const disputed = /disput|contest|hold|escrow pending/i.test(text);
  return {
    clientId: info.identifier || "—",
    lawFirmWallet: ZERO_ADDR,
    clientWallet: ZERO_ADDR,
    totalHeld: total,
    earnedFees: 0,
    unearnedBalance: total,
    disputedHours: 0,
    disputedAmount: 0,
    signaturesVerified: /sign|executed|verified/i.test(text),
    recommendedPath: disputed ? ExecutionPath.ArbitrationEscrow : ExecutionPath.DirectSettlement,
    anomaliesFlagged: [],
    anomaliesSuppressed: false,
    barNumber: info.identifier,
    clientName: info.primaryParty || undefined,
    extractedBarNumber: info.identifier || null,
  };
}
