/**
 * suggest-anchors — deterministic, best-effort pre-fill of the Document Load
 * trust anchors from the raw text of a dropped artifact.
 *
 * This is a convenience for the escrow officer, NOT validation. Everything it
 * produces is a *suggestion* the officer must confirm before Continue; LexGuard
 * still matches the confirmed anchors against the parsed document downstream
 * (see lexguard/anchor-matcher, which this file deliberately does not touch).
 *
 * The governing rule is "null beats wrong": a pattern that does not match
 * confidently yields nothing at all rather than a plausible guess. A blank
 * field costs the officer a few keystrokes; a wrong field that looks
 * authoritative costs an anchor mismatch nobody notices.
 *
 * Pure — no store access, no I/O, no side effects.
 */

import type { AssetClass } from "./assetClasses";

export interface AnchorSuggestions {
  // Common across classes
  primaryPartyName?: string; // buyer, client, licensee, assignee
  secondaryPartyName?: string; // seller, attorney, licensor, assignor
  amountCents?: number; // largest dollar amount found

  // Legal
  barNumber?: string;
  clientName?: string;
  lawFirmName?: string;

  // Real Estate
  parcelNumber?: string;
  county?: string;
  state?: string;

  // Business
  buyerEntity?: string;
  sellerEntity?: string;
  ein?: string;

  // IP
  usptoNumber?: string;
  royaltyRate?: string;

  // Art
  artistName?: string;
  workTitle?: string;

  // Natural Resources
  rightsType?: string;
  acreage?: string;

  // Cannabis IND
  stateLicenseNumber?: string;
  metrcFacilityId?: string;
  licenseType?: string;
}

// ── Confidence helpers ───────────────────────────────────────────────────────

/** Collapse whitespace runs and trim — every returned value passes through. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Words that, appearing first, mean the capture is a label fragment rather than
 * a name. The label regexes below all carry `/i` (needed so "client:" matches
 * as well as "Client:"), and `/i` also defeats the `[A-Z]` that was supposed to
 * require a proper noun — so "Client Full Legal Name: Jane Anderson" can
 * otherwise capture "Full Legal Name". These two guards restore that intent.
 */
const LABEL_ECHO = new Set([
  "full", "legal", "name", "names", "the", "this", "that", "these", "those",
  "a", "an", "and", "or", "of", "for", "id", "no", "number", "information",
  "details", "agreement", "party", "parties", "shall", "hereby", "dated",
  "date", "address", "email", "phone", "wallet", "status", "signature",
  "total", "amount", "is", "are", "was", "were", "shall",
  // Document-title words: "ATTORNEY-CLIENT RETAINER AGREEMENT" puts the label
  // "Client" directly before "RETAINER AGREEMENT", which is not a name.
  "retainer", "attorney", "attorneys", "client", "engagement", "fee", "fees",
]);

/** Every word that begins with a letter must begin with a capital one. */
function properCased(s: string): boolean {
  return s.split(/\s+/).every((w) => !/^[a-zA-Z]/.test(w) || /^[A-Z]/.test(w));
}

function confidentName(s: string): boolean {
  if (s.length < 2 || s.length > 80) return false;
  if (!properCased(s)) return false;
  const first = s.split(/\s+/)[0].replace(/[^a-zA-Z]/g, "").toLowerCase();
  return !LABEL_ECHO.has(first);
}

/**
 * More than one word, and every letter upper-case — a heading or title line
 * ("RETAINER AGREEMENT"), not a name. The label regexes carry `/i`, so the
 * NAME pattern's `[A-Z]` cannot reject these on its own.
 */
function shouted(s: string): boolean {
  return /\s/.test(s) && /[A-Z]/.test(s) && !/[a-z]/.test(s);
}

/** A name taken from after a label: confident, and not a shouted heading. */
function confidentLabelledName(s: string): boolean {
  return confidentName(s) && !shouted(s);
}

/**
 * First capture group of the first match that clears `validate`. Scanning past
 * a rejected match (rather than giving up on it) is what lets a document whose
 * first "Buyer" mention is prose still resolve from its labelled one.
 */
function firstMatch(
  text: string,
  re: RegExp,
  validate: (v: string) => boolean = () => true,
): string | undefined {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  for (const m of text.matchAll(new RegExp(re.source, flags))) {
    const v = clean(m[1] ?? "");
    if (v && validate(v)) return v;
  }
  return undefined;
}

/**
 * A proper-noun run of 2–4 capitalised words — the shape of a person's name.
 * The separator is spaces and tabs rather than `\s`: these documents put one
 * labelled value per line, and `\s` would let a greedy run swallow the next
 * line's label ("Client: Jane Anderson\nAttorney:" → "Jane Anderson Attorney").
 */
const NAME = String.raw`([A-Z][a-zA-Z'-]+(?:[ \t]+[A-Z][a-zA-Z'-]+){1,3})`;

/**
 * A name sitting after one of `labels`. Tries the colon-anchored form first so
 * a qualifier between label and colon ("Client Full Legal Name: Jane Anderson")
 * is skipped rather than read as the name; falls back to the loose form
 * ("Buyer Jane Anderson").
 */
function labelledName(text: string, labels: string): string | undefined {
  const anchored = new RegExp(`(?:${labels})[A-Za-z ]{0,30}?:\\s*${NAME}`, "i");
  const loose = new RegExp(`(?:${labels})[:\\s]+${NAME}`, "i");
  return (
    firstMatch(text, anchored, confidentLabelledName) ?? firstMatch(text, loose, confidentLabelledName)
  );
}

/** `"client"` → `[Cc][Ll][Ii][Ee][Nn][Tt]` — case-insensitive without `/i`. */
function caseless(word: string): string {
  return word.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
}

/**
 * A party name in a formal definition. Case-SENSITIVE, unlike the label
 * patterns: every word must really begin with a capital, so the capture stops
 * at the lower-case word before the name ("between Jane Doe" → "Jane Doe").
 * Words may carry `&`, periods and inner capitals ("ProvenyxRD", "Smith & Lee"),
 * and an entity suffix may follow a comma ("Smith Lee, LLP").
 */
const DEFINED_NAME = String.raw`((?:[A-Z][\w.'’&-]*|&)(?:[ \t]+(?:[A-Z][\w.'’&-]*|&|of|and)){0,6}?(?:,[ \t]*(?:LLP|LLC|Inc\.?|P\.?C\.?|PLLC|APC|LPA))?)`;

/**
 * The name a document formally defines as `labels` — the way parties are
 * introduced in nearly every agreement:
 *
 *   Jane Doe ("Client")
 *   Smith & Lee LLP (the "Firm")
 *   ProvenyxRD LLC, a Delaware limited liability company ("Client")
 *   Jane Doe (hereinafter referred to as the "Client")
 *
 * The descriptor clause after a comma ("a Delaware limited liability
 * company") is skipped, never captured. This is the strongest signal a
 * document gives about who a party is — it beats any label match, and it is
 * immune to headings like "ATTORNEY-CLIENT RETAINER AGREEMENT", which define
 * nothing.
 */
function definedParty(text: string, labels: string[]): string | undefined {
  const label = labels.map(caseless).join("|");
  const re = new RegExp(
    String.raw`(?<![\w&])${DEFINED_NAME}` +
      // optional descriptor: ", a Delaware limited liability company"
      String.raw`(?:,[ \t]*(?:an?|the)[ \t][^()\n"“”]{0,80}?)?` +
      String.raw`[ \t]*\([ \t]*(?:hereinafter[ \t]+)?(?:referred[ \t]+to[ \t]+as[ \t]+)?(?:${caseless("the")}[ \t]+)?` +
      String.raw`["“'‘](?:${label})["”'’]`,
    "g",
  );
  return firstMatch(text, re, confidentName);
}

/**
 * A firm name set as letterhead: a line on its own, immediately above an
 * "Attorneys at Law" / "Lawyers" / "A Professional Law Corporation" line.
 * Letterheads are routinely set in capitals, so — unlike a labelled name — an
 * all-caps firm name is accepted here: the line below it is the context that
 * says what it is. Returned exactly as written.
 */
function letterheadFirm(text: string): string | undefined {
  const tagline = [
    String.raw`${caseless("attorneys")}?[ \t]+${caseless("at")}[ \t]+${caseless("law")}`,
    String.raw`${caseless("attorney")}[ \t]+${caseless("at")}[ \t]+${caseless("law")}`,
    caseless("lawyers"),
    String.raw`${caseless("a")}[ \t]+${caseless("professional")}[ \t]+(?:${caseless("law")}[ \t]+)?${caseless("corporation")}`,
  ].join("|");
  const re = new RegExp(
    String.raw`^[ \t]*([A-Z][A-Za-z0-9&.,'’ \t-]{1,60}?)[ \t]*\r?\n[ \t]*(?:${tagline})[ \t]*$`,
    "gm",
  );
  return firstMatch(text, re, confidentName);
}

/** Entity names carry a corporate suffix, so they tolerate `&`, commas, periods. */
const ENTITY = String.raw`([A-Z][a-zA-Z \t&,.']+(?:LLC|Inc|Corp|Ltd|LP|LLP|Co)\.?)`;

function labelledEntity(text: string, labels: string): string | undefined {
  return firstMatch(text, new RegExp(`(?:${labels})[:\\s]+${ENTITY}`, "i"), confidentName);
}

// ── Common extractors ────────────────────────────────────────────────────────

/**
 * Largest dollar figure in the document, in cents — the purchase price /
 * retainer total is almost always the biggest number on the page.
 *
 * Parsed as dollars-then-scaled rather than by stripping the decimal point:
 * "$450,000" and "$450,000.00" have to land on the same value, and digit
 * concatenation silently reads the former as $4,500.
 */
function largestAmountCents(text: string): number | undefined {
  const matches = text.match(/\$[\d,]+(?:\.\d{2})?/g);
  if (!matches) return undefined;
  let max = 0;
  for (const m of matches) {
    const n = parseFloat(m.replace(/[$,]/g, ""));
    if (!Number.isFinite(n)) continue;
    const cents = Math.round(n * 100);
    if (cents > max) max = cents;
  }
  return max > 0 ? max : undefined;
}

const US_STATE_NAMES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
  "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
  "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
  "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
  "Wisconsin", "Wyoming",
];

const STATE_RE = new RegExp(`\\b(${US_STATE_NAMES.join("|")})\\b`, "i");
const STATE_CANONICAL = new Map(US_STATE_NAMES.map((s) => [s.toLowerCase(), s]));

/** First state named, in the registry's own casing so it matches the select. */
function stateName(text: string): string | undefined {
  const m = text.match(STATE_RE);
  return m ? STATE_CANONICAL.get(m[1].toLowerCase()) : undefined;
}

/**
 * The county named before the word "County". Deliberately case-SENSITIVE on the
 * capture: `/i` would let `[A-Z][a-z]+` match the lowercase word before the
 * county ("in Kern County" → "in Kern"), and because a rejected match still
 * consumes the text, the real name would never be reached.
 */
const COUNTY_RE = /([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)[ \t]+[Cc]ounty/;

const PRIMARY_LABELS = String.raw`Buyer|Purchaser|Client|Licensee|Assignee`;
const SECONDARY_LABELS = String.raw`Seller|Grantor|Attorney|Counsel|Licensor|Assignor`;

// ── The extractor ────────────────────────────────────────────────────────────

export function suggestAnchors(text: string, assetClass: string): AnchorSuggestions {
  const out: AnchorSuggestions = {};
  if (!text || !text.trim()) return out;

  const put = <K extends keyof AnchorSuggestions>(k: K, v: AnchorSuggestions[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };

  // Common across every class. Emails are intentionally never suggested — a
  // signature address must be entered manually, never inferred from the document.
  put("amountCents", largestAmountCents(text));
  put("primaryPartyName", labelledName(text, PRIMARY_LABELS));
  put("secondaryPartyName", labelledName(text, SECONDARY_LABELS));

  switch (assetClass) {
    case "legal": {
      put("barNumber", firstMatch(
        text,
        /(?:Bar\s*(?:No|Number|#)?\.?\s*|State\s*Bar\s*(?:No|#)?\.?\s*)(\d{5,8})/i,
      ));
      // A formal definition ('ProvenyxRD LLC, a Delaware … ("Client")') first;
      // a "Client: Jane Anderson" label only when the document defines none.
      const client = definedParty(text, ["client", "clients"]) ?? labelledName(text, "Client");
      put("clientName", client);
      put(
        "lawFirmName",
        definedParty(text, ["firm", "law firm", "attorney", "attorneys", "counsel"]) ?? letterheadFirm(text),
      );
      // In Legal the client is the anchored party and the firm is the counterparty.
      put("primaryPartyName", client ?? out.primaryPartyName);
      put("secondaryPartyName", labelledName(text, String.raw`Attorney|Counsel|Law\s*Firm`) ?? out.secondaryPartyName);
      break;
    }

    case "real_estate": {
      put("parcelNumber", firstMatch(
        text,
        /(?:APN|Parcel\s*(?:No|Number|#)?)[:\s#]*([0-9]{3}-[0-9]{3}-[0-9]{3,}|[0-9-]{8,})/i,
      ));
      put("county", firstMatch(text, COUNTY_RE, confidentName));
      put("state", stateName(text));
      put("primaryPartyName", labelledName(text, "Buyer|Purchaser") ?? out.primaryPartyName);
      put("secondaryPartyName", labelledName(text, "Seller|Grantor") ?? out.secondaryPartyName);
      break;
    }

    case "business": {
      put("buyerEntity", labelledEntity(text, "Buyer|Acquirer|Purchaser"));
      put("sellerEntity", labelledEntity(text, "Seller|Target|Company"));
      put("ein", firstMatch(text, /(?:EIN|Tax\s*ID|Federal\s*Tax)[:\s#]*(\d{2}-\d{7})/i));
      break;
    }

    case "ip": {
      // The `\.?` is what lets the near-universal "Patent No. 8,123,456" form
      // through, matching the bar-number pattern. `[0-9,]{7,12}` can also be
      // satisfied by commas alone, so real digits are required too.
      put("usptoNumber", firstMatch(
        text,
        /(?:Patent\s*(?:No|Number|#)?\.?\s*|US\s*)([0-9,]{7,12})/i,
        (v) => v.replace(/\D/g, "").length >= 6,
      ));
      put("primaryPartyName", labelledName(text, "Licensee") ?? out.primaryPartyName);
      put("secondaryPartyName", labelledName(text, "Licensor") ?? out.secondaryPartyName);
      const royalty = firstMatch(text, /(\d+(?:\.\d+)?)\s*%\s*(?:royalt|of\s*(?:net|gross))/i);
      // Re-attached because the anchor field is a rate, not a bare number ("5%").
      put("royaltyRate", royalty ? `${royalty}%` : undefined);
      break;
    }

    case "art": {
      put("artistName", firstMatch(
        text,
        /(?:Artist|Creator|Author)[:\s]+([A-Z][a-zA-Z\s.'-]+?)(?:\n|,|\()/i,
        confidentName,
      ));
      put("workTitle", firstMatch(text, /(?:Title[:\s]+|")([^"\n]{3,60})(?:"|$)/im));
      break;
    }

    case "natural_resources": {
      const rights = firstMatch(
        text,
        /\b(water\s*rights?|mineral\s*rights?|timber\s*rights?|surface\s*rights?|oil\s*(?:and\s*gas\s*)?rights?)\b/i,
      );
      put("rightsType", rights?.toLowerCase());
      put("acreage", firstMatch(text, /(\d+(?:,\d{3})*(?:\.\d+)?)\s*acres?/i));
      put("county", firstMatch(text, COUNTY_RE, confidentName));
      put("state", stateName(text));
      break;
    }

    case "cannabis_ind": {
      put("stateLicenseNumber", firstMatch(text, /([A-Z]\d{2}-\d{7}-[A-Z]{3})/i));
      put("metrcFacilityId",
        firstMatch(text, /(?:Metrc|MTRC)[:\s-]*(?:Facility\s*(?:ID|#)?[:\s]*)?([A-Z]{4}-[A-Z]{2}-\d{5})/i)
        // Californian facilities are issued as CDPH-10001234 rather than the
        // MTRC-CA-00042 shape, and the app's own sample uses that form.
        ?? firstMatch(text, /(?:Metrc|MTRC)[:\s-]*(?:Facility\s*(?:ID|#)?[:\s]*)?([A-Z]{4}-\d{8})/i),
      );
      const license = firstMatch(text, /\b(dispensary|cultivator|manufacturer|distributor|retailer)\b/i);
      // "Retailer" is the storefront licence class the platform files as dispensary.
      put("licenseType", license ? (license.toLowerCase() === "retailer" ? "dispensary" : license.toLowerCase()) : undefined);
      break;
    }
  }

  return out;
}

// ── Projection onto the Document Load anchor fields ──────────────────────────

const SELECT_RIGHTS: Record<string, string> = {
  "water rights": "Water",
  "water right": "Water",
  "mineral rights": "Mineral",
  "mineral right": "Mineral",
  "timber rights": "Timber",
  "timber right": "Timber",
};

const SELECT_LICENSE: Record<string, string> = {
  dispensary: "Dispensary",
  cultivator: "Cultivator",
  manufacturer: "Manufacturer",
  distributor: "Distributor",
};

/**
 * Map suggestions onto the anchor field keys a class actually renders
 * (lib/assetClasses `anchorFields`). Select-backed fields are normalised to the
 * exact option string, or dropped when the suggestion is not one of the
 * options — a select that cannot represent the value must stay untouched.
 */
export function suggestionsToFields(
  assetClass: AssetClass,
  s: AnchorSuggestions,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, v: string | undefined) => {
    if (v) out[key] = v;
  };
  const money = s.amountCents && s.amountCents > 0 ? (s.amountCents / 100).toFixed(2) : undefined;

  switch (assetClass) {
    case "legal":
      put("attorneyBarNumber", s.barNumber);
      put("clientFullLegalName", s.clientName ?? s.primaryPartyName);
      put("lawFirmName", s.lawFirmName);
      break;

    case "real_estate":
      put("parcelNumber", s.parcelNumber);
      put("county", s.county);
      put("state", s.state);
      put("buyerName", s.primaryPartyName);
      put("sellerName", s.secondaryPartyName);
      put("purchasePrice", money);
      break;

    case "business":
      put("buyerEntityName", s.buyerEntity ?? s.primaryPartyName);
      put("sellerEntityName", s.sellerEntity ?? s.secondaryPartyName);
      put("ein", s.ein);
      put("purchasePrice", money);
      break;

    case "ip":
      put("usptoFilingNumber", s.usptoNumber);
      put("licenseeName", s.primaryPartyName);
      put("licensorName", s.secondaryPartyName);
      put("royaltyRate", s.royaltyRate);
      break;

    case "art":
      put("artistName", s.artistName);
      put("title", s.workTitle);
      put("appraisedValue", money);
      put("buyerName", s.primaryPartyName);
      put("sellerName", s.secondaryPartyName);
      break;

    case "natural_resources":
      put("rightsType", s.rightsType ? SELECT_RIGHTS[s.rightsType] : undefined);
      // The field is a jurisdiction ("Kern County"), not a bare county name.
      put("jurisdiction", s.county ? `${s.county} County` : undefined);
      put("acreage", s.acreage);
      put("buyerName", s.primaryPartyName);
      put("sellerName", s.secondaryPartyName);
      break;

    case "cannabis_ind":
      put("stateLicenseNumber", s.stateLicenseNumber);
      put("metrcFacilityId", s.metrcFacilityId);
      put("licenseType", s.licenseType ? SELECT_LICENSE[s.licenseType] : undefined);
      put("buyerName", s.primaryPartyName);
      put("sellerName", s.secondaryPartyName);
      break;
  }

  return out;
}

/**
 * Fold suggestions into the officer's current anchor record.
 *
 * A field is filled only when the officer has not touched it AND it still holds
 * either nothing or the class default — selects arrive pre-set to their first
 * option (`emptyAnchorsFor`), so "still the default" is the only way an
 * untouched select can be recognised as free to fill. Typed input is never
 * overwritten.
 *
 * Returns the next record plus the keys that were filled, which the caller
 * marks as suggested.
 */
export function mergeSuggestions(
  assetClass: AssetClass,
  current: Record<string, string>,
  defaults: Record<string, string>,
  suggestions: AnchorSuggestions,
  touched: ReadonlySet<string>,
): { next: Record<string, string>; filled: string[] } {
  const proposed = suggestionsToFields(assetClass, suggestions);
  const next = { ...current };
  const filled: string[] = [];

  for (const [key, value] of Object.entries(proposed)) {
    if (touched.has(key)) continue;
    if (!(key in current)) continue; // not a field this class renders
    const held = (current[key] ?? "").trim();
    if (held !== "" && held !== (defaults[key] ?? "")) continue;
    if (held === value) continue;
    next[key] = value;
    filled.push(key);
  }

  return { next, filled };
}
