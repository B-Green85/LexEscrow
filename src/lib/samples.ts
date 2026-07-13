/**
 * Sample retainer termination documents for demoing the workflow without a real
 * PDF. `clean` validates and flows through to execution; `inconsistent` has a
 * billing reconciliation that does not add up, so LexGuard escalates.
 */

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

export interface Sample {
  key: string;
  label: string;
  filename: string;
  text: string;
}

export const SAMPLES: Sample[] = [
  { key: "clean", label: "Clean retainer", filename: "retainer_anderson.txt", text: SAMPLE_CLEAN },
  { key: "inconsistent", label: "Discrepancy", filename: "retainer_webb.txt", text: SAMPLE_INCONSISTENT },
];

export function sampleToFile(sample: Sample): File {
  return new File([sample.text], sample.filename, { type: "text/plain" });
}
