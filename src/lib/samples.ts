// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Sample documents for demoing the workflow without a real PDF.
 *
 * Legal: `clean` validates and flows through to execution; `inconsistent` has a
 * billing reconciliation that does not add up, so LexGuard escalates.
 *
 * The other six asset classes each ship one minimal placeholder sample (spec
 * §4). Every sample carries an escrow ledger the deterministic parser can read
 * ("Total Held" + "Unearned Balance", earned defaulting to zero — the full
 * amount is still held in escrow), so it reconciles through the one LexGuard
 * arithmetic check and lands Ready on the batch dashboard.
 */

import type { AssetClass } from "./assetClasses";
import { ASSET_CLASS_LIST } from "./assetClasses";

export const SAMPLE_CLEAN = `RETAINER TERMINATION AGREEMENT

Client Full Legal Name: Jane Anderson
Client ID: C-10482
Attorney Bar No. 123456
Client Wallet: 0x1111111111111111111111111111111111111111
Law Firm Wallet: 0x2222222222222222222222222222222222222222
Signature Status: Verified

BILLING RECONCILIATION
Total Retainer Held: $5,000.00
Earned Fees: $800.00
Unearned Balance: $4,200.00

DISPUTED MATTERS
Disputed Hours: 0.0
There are no disputed amounts in this matter.

The parties acknowledge the above reconciliation as complete and accurate.
`;

export const SAMPLE_INCONSISTENT = `RETAINER TERMINATION AGREEMENT

Client Full Legal Name: Marcus Webb
Client ID: C-20931
Attorney Bar No. 654321
Client Wallet: 0x3333333333333333333333333333333333333333
Law Firm Wallet: 0x4444444444444444444444444444444444444444
Signature Status: Verified

BILLING RECONCILIATION
Total Retainer Held: $5,000.00
Earned Fees: $800.00
Unearned Balance: $3,200.00

DISPUTED MATTERS
Disputed Hours: 0.0
`;

// ── Placeholder samples for the other six asset classes (spec §4) ────────────

const SAMPLE_REAL_ESTATE = `Residential real estate purchase escrow for parcel APN 123-456-789 in Los Angeles County, California, releasing to the seller on clear title and inspection-contingency waiver.
Total Held: $450,000.00
Unearned Balance: $450,000.00
`;

const SAMPLE_BUSINESS = `Business acquisition escrow for the purchase of Beta LLC by Acme Corp (EIN 12-3456789), releasing on completion of due diligence and receipt of regulatory approval.
Total Held: $2,100,000.00
Unearned Balance: $2,100,000.00
`;

const SAMPLE_IP = `Intellectual property escrow for assignment of USPTO patent application 12/345,678 from the inventor to Nimbus Labs, releasing once the transfer is recorded.
Total Held: $340,000.00
Unearned Balance: $340,000.00
`;

const SAMPLE_ART = `Fine art escrow for the sale of an oil-on-canvas work with certificate of authenticity and full provenance chain, releasing on physical delivery and condition-report acceptance.
Total Held: $85,000.00
Unearned Balance: $85,000.00
`;

const SAMPLE_NATURAL_RESOURCES = `Natural resource escrow for the transfer of adjudicated water rights across 640 acres in Kern County, releasing on state agency approval and completed survey.
Total Held: $1,200,000.00
Unearned Balance: $1,200,000.00
`;

const SAMPLE_CANNABIS = `Cannabis dispensary acquisition escrow for California license C10-0000123-LIC (Metrc facility CDPH-10001234), releasing once the license verifies active in Metrc with no open compliance holds.
Total Held: $250,000.00
Unearned Balance: $250,000.00
`;

export interface Sample {
  key: string;
  label: string;
  filename: string;
  text: string;
  assetClass: AssetClass;
}

export const SAMPLES: Sample[] = [
  { key: "clean", label: "Clean retainer", filename: "retainer_anderson.txt", text: SAMPLE_CLEAN, assetClass: "legal" },
  { key: "inconsistent", label: "Discrepancy", filename: "retainer_webb.txt", text: SAMPLE_INCONSISTENT, assetClass: "legal" },
  { key: "real_estate", label: "Real estate", filename: "real_estate_purchase_smith.txt", text: SAMPLE_REAL_ESTATE, assetClass: "real_estate" },
  { key: "business", label: "Business", filename: "business_acquisition_acme.txt", text: SAMPLE_BUSINESS, assetClass: "business" },
  { key: "ip", label: "IP", filename: "ip_patent_assignment_nimbus.txt", text: SAMPLE_IP, assetClass: "ip" },
  { key: "art", label: "Art", filename: "art_provenance_gallery.txt", text: SAMPLE_ART, assetClass: "art" },
  { key: "natural_resources", label: "Natural resources", filename: "natural_resources_water_rights.txt", text: SAMPLE_NATURAL_RESOURCES, assetClass: "natural_resources" },
  { key: "cannabis_ind", label: "Cannabis IND", filename: "cannabis_license_greenleaf.txt", text: SAMPLE_CANNABIS, assetClass: "cannabis_ind" },
];

export function sampleToFile(sample: Sample): File {
  return new File([sample.text], sample.filename, { type: "text/plain" });
}

/** The samples for a single asset class (Legal has two; the rest have one). */
export function samplesForClass(assetClass: AssetClass): Sample[] {
  return SAMPLES.filter((s) => s.assetClass === assetClass);
}

/** One representative sample per asset class (7 total), in canonical order. */
export function oneSamplePerClass(): Sample[] {
  return ASSET_CLASS_LIST.map((cls) => SAMPLES.find((s) => s.assetClass === cls)).filter(
    (s): s is Sample => Boolean(s),
  );
}
