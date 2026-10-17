import { describe, expect, it } from "vitest";
import { emptyAnchorsFor } from "./assetClasses";
import { mergeSuggestions, suggestAnchors, suggestionsToFields } from "./suggest-anchors";

const LEGAL_DOC = `RETAINER TERMINATION AGREEMENT

Client: Jane Anderson
Attorney: Marcus Webb
Attorney Bar No. 123456

BILLING RECONCILIATION
Total Retainer Held: $5,000.00
Earned Fees: $800.00
Unearned Balance: $4,200.00
`;

const REAL_ESTATE_DOC = `RESIDENTIAL PURCHASE AGREEMENT

APN 123-456-789
Property located in Los Angeles County, California.

Buyer: Sarah Chen
Seller: Robert Diaz
Purchase Price: $450,000.00
`;

const CANNABIS_DOC = `CANNABIS LICENSE TRANSFER

State License: C10-0001234-LIC
Metrc Facility ID: MTRC-CA-00042
License Type: Dispensary
Total Held: $250,000.00
`;

describe("suggestAnchors — legal", () => {
  it("extracts the bar number behind a Bar No. label", () => {
    expect(suggestAnchors(LEGAL_DOC, "legal").barNumber).toBe("123456");
  });

  it("accepts the full 5–8 digit bar number range", () => {
    expect(suggestAnchors("State Bar No. 87654321", "legal").barNumber).toBe("87654321");
    expect(suggestAnchors("Bar Number 12345", "legal").barNumber).toBe("12345");
  });

  it("extracts the client name after a Client: label", () => {
    expect(suggestAnchors(LEGAL_DOC, "legal").clientName).toBe("Jane Anderson");
  });

  it("skips a qualifier between the label and the colon", () => {
    // The app's own clean sample writes the label this way; a loose match reads
    // "Full Legal Name" as the client.
    const s = suggestAnchors("Client Full Legal Name: Jane Anderson\n", "legal");
    expect(s.clientName).toBe("Jane Anderson");
  });

  it("extracts the attorney as the counterparty", () => {
    expect(suggestAnchors(LEGAL_DOC, "legal").secondaryPartyName).toBe("Marcus Webb");
  });

  it("takes the largest dollar figure as the amount, in cents", () => {
    expect(suggestAnchors(LEGAL_DOC, "legal").amountCents).toBe(500_000);
  });

  it("returns nothing for fields the document does not contain", () => {
    const s = suggestAnchors(LEGAL_DOC, "legal");
    expect(s.parcelNumber).toBeUndefined();
    expect(s.ein).toBeUndefined();
  });

  it("does not read a bare six-digit number as a bar number", () => {
    const s = suggestAnchors("Invoice number 445566 was issued on the 3rd.", "legal");
    expect(s.barNumber).toBeUndefined();
  });

  it("does not read a label echo as the client name", () => {
    expect(suggestAnchors("Client Name Of Record\n", "legal").clientName).toBeUndefined();
  });
});

/** Shaped like the Bergener Mirejovsky retainer, as poppler extracts it. */
const RETAINER_WITH_PARTIES = `BERGENER MIREJOVSKY
Attorneys at Law
800 Newport Center Drive, Suite 700 | Newport Beach, California 92660

ATTORNEY-CLIENT RETAINER AGREEMENT
Matter No. BM-DEMO-2026

PARTIES
This Attorney-Client Retainer Agreement ("Agreement") is entered into as of October 15, 2026:
Attorney: James Michael Bergener, Esq., California State Bar No. 226570, Newport Beach, California.
Client (FICTIONAL): ProvenyxRD LLC, a Delaware limited liability company ("Client"), with its principal place of
business at 4215 Technology Drive, Oakland, California 94609.

SCOPE OF REPRESENTATION
The Firm agrees to represent the Client in connection with general corporate counsel services.
`;

describe("suggestAnchors — legal party definitions", () => {
  it("never reads a document title as the client name", () => {
    expect(suggestAnchors("ATTORNEY-CLIENT RETAINER AGREEMENT\n", "legal").clientName).toBeUndefined();
    expect(suggestAnchors("CLIENT RETAINER AGREEMENT\n", "legal").clientName).toBeUndefined();
    expect(suggestAnchors("CLIENT ENGAGEMENT LETTER\n", "legal").clientName).toBeUndefined();
  });

  it("rejects an all-caps multi-word label match", () => {
    expect(suggestAnchors("Client: JANE ANDERSON\n", "legal").clientName).toBeUndefined();
  });

  it("takes the client from its formal definition, skipping the descriptor clause", () => {
    expect(suggestAnchors(RETAINER_WITH_PARTIES, "legal").clientName).toBe("ProvenyxRD LLC");
  });

  it("reads the common definition forms", () => {
    const client = (t: string) => suggestAnchors(t, "legal").clientName;
    expect(client(`This Agreement is between Jane Doe ("Client") and the Firm.`)).toBe("Jane Doe");
    expect(client(`by and between Jane Q. Doe (the "Client")`)).toBe("Jane Q. Doe");
    expect(client(`Jane Doe (hereinafter referred to as the “Client”)`)).toBe("Jane Doe");
  });

  it("prefers the formal definition over an earlier labelled mention", () => {
    const t = `Client: Johnny Smithe\nThis Agreement is between John Smith ("Client") and the Firm.`;
    expect(suggestAnchors(t, "legal").clientName).toBe("John Smith");
  });

  it("takes the law firm from the letterhead above an Attorneys at Law line", () => {
    expect(suggestAnchors(RETAINER_WITH_PARTIES, "legal").lawFirmName).toBe("BERGENER MIREJOVSKY");
  });

  it("takes the law firm from its formal definition when there is one", () => {
    const t = `between Jane Doe ("Client") and Smith & Lee, LLP (the "Firm").`;
    expect(suggestAnchors(t, "legal").lawFirmName).toBe("Smith & Lee, LLP");
  });

  it("suggests no law firm when the document neither defines nor letterheads one", () => {
    expect(suggestAnchors(LEGAL_DOC, "legal").lawFirmName).toBeUndefined();
  });

  it("fills clientFullLegalName and lawFirmName on the Legal anchor record", () => {
    const empty = emptyAnchorsFor("legal");
    const { next, filled } = mergeSuggestions(
      "legal",
      empty,
      empty,
      suggestAnchors(RETAINER_WITH_PARTIES, "legal"),
      new Set(),
    );
    expect(next.clientFullLegalName).toBe("ProvenyxRD LLC");
    expect(next.lawFirmName).toBe("BERGENER MIREJOVSKY");
    expect(next.attorneyBarNumber).toBe("226570");
    expect(filled).toEqual(expect.arrayContaining(["clientFullLegalName", "lawFirmName"]));
  });
});

describe("suggestAnchors — real estate", () => {
  it("extracts an APN in XXX-XXX-XXX form", () => {
    expect(suggestAnchors(REAL_ESTATE_DOC, "real_estate").parcelNumber).toBe("123-456-789");
  });

  it("extracts the county name preceding County", () => {
    expect(suggestAnchors(REAL_ESTATE_DOC, "real_estate").county).toBe("Los Angeles");
  });

  it("extracts the state by full name", () => {
    expect(suggestAnchors(REAL_ESTATE_DOC, "real_estate").state).toBe("California");
  });

  it("returns the state in registry casing so it matches the select", () => {
    expect(suggestAnchors("Recorded in new york on the 4th.", "real_estate").state).toBe("New York");
  });

  it("prefers the longer state name when one contains another", () => {
    expect(suggestAnchors("Situated in West Virginia.", "real_estate").state).toBe("West Virginia");
  });

  it("extracts the buyer after a Buyer: label", () => {
    expect(suggestAnchors(REAL_ESTATE_DOC, "real_estate").primaryPartyName).toBe("Sarah Chen");
  });

  it("extracts the seller after a Seller: label", () => {
    expect(suggestAnchors(REAL_ESTATE_DOC, "real_estate").secondaryPartyName).toBe("Robert Diaz");
  });
});

describe("suggestAnchors — cannabis IND", () => {
  it("extracts a CA DCC format license", () => {
    expect(suggestAnchors(CANNABIS_DOC, "cannabis_ind").stateLicenseNumber).toBe("C10-0001234-LIC");
  });

  it("extracts a Metrc facility ID", () => {
    expect(suggestAnchors(CANNABIS_DOC, "cannabis_ind").metrcFacilityId).toBe("MTRC-CA-00042");
  });

  it("extracts the CDPH facility form the platform samples use", () => {
    const s = suggestAnchors("Metrc facility CDPH-10001234 is active.", "cannabis_ind");
    expect(s.metrcFacilityId).toBe("CDPH-10001234");
  });

  it("extracts the license type", () => {
    expect(suggestAnchors(CANNABIS_DOC, "cannabis_ind").licenseType).toBe("dispensary");
    expect(suggestAnchors("Licensed cultivator premises.", "cannabis_ind").licenseType).toBe("cultivator");
  });

  it("normalises retailer to dispensary", () => {
    expect(suggestAnchors("Storefront retailer license.", "cannabis_ind").licenseType).toBe("dispensary");
  });

  it("returns nothing when the license is not in CA DCC format", () => {
    const s = suggestAnchors("State License: ABC-123\nLicense Type: Distributor", "cannabis_ind");
    expect(s.stateLicenseNumber).toBeUndefined();
    expect(s.licenseType).toBe("distributor");
  });
});

describe("suggestAnchors — remaining classes", () => {
  it("extracts business entities and EIN", () => {
    const s = suggestAnchors(
      "Buyer: Acme Corp\nSeller: Beta Holdings LLC\nEIN: 12-3456789\n",
      "business",
    );
    expect(s.buyerEntity).toBe("Acme Corp");
    expect(s.sellerEntity).toBe("Beta Holdings LLC");
    expect(s.ein).toBe("12-3456789");
  });

  it("extracts a patent number written with a period", () => {
    expect(suggestAnchors("Patent No. 8,123,456 assigned herein.", "ip").usptoNumber).toBe("8,123,456");
  });

  it("extracts licensee, licensor and royalty rate", () => {
    const s = suggestAnchors(
      "Licensee: Nimbus Labs\nLicensor: Ada Reyes\nRoyalty: 5% of net revenue\n",
      "ip",
    );
    expect(s.primaryPartyName).toBe("Nimbus Labs");
    expect(s.secondaryPartyName).toBe("Ada Reyes");
    expect(s.royaltyRate).toBe("5%");
  });

  it("extracts artist and work title", () => {
    const s = suggestAnchors("Artist: Elena Moreau\nTitle: Blue Horizon\n", "art");
    expect(s.artistName).toBe("Elena Moreau");
    expect(s.workTitle).toBe("Blue Horizon");
  });

  it("extracts rights type and acreage", () => {
    const s = suggestAnchors(
      "Transfer of adjudicated water rights across 640 acres in Kern County.",
      "natural_resources",
    );
    expect(s.rightsType).toBe("water rights");
    expect(s.acreage).toBe("640");
    expect(s.county).toBe("Kern");
  });

  it("keeps class-specific fields out of other classes", () => {
    // The cannabis document names a license, but a Legal load must not read it.
    expect(suggestAnchors(CANNABIS_DOC, "legal").stateLicenseNumber).toBeUndefined();
  });
});

describe("suggestAnchors — general", () => {
  it("returns the largest dollar amount, not the smallest or the first", () => {
    expect(suggestAnchors("Fee $100.00, price $9,500.00, deposit $250.00", "legal").amountCents)
      .toBe(950_000);
  });

  it("scales amounts written without cents correctly", () => {
    // Concatenating digits would read this as $4,500.
    expect(suggestAnchors("Purchase price $450,000", "legal").amountCents).toBe(45_000_000);
  });

  it("returns nothing for an amount of zero", () => {
    expect(suggestAnchors("Balance $0.00 outstanding", "legal").amountCents).toBeUndefined();
  });

  it("returns everything empty for an empty document", () => {
    expect(suggestAnchors("", "legal")).toEqual({});
    expect(suggestAnchors("   \n  ", "real_estate")).toEqual({});
  });

  it("trims and collapses whitespace in every match", () => {
    const s = suggestAnchors("Client:    Jane   Anderson  \nAttorney:   Marcus  Webb\n", "legal");
    expect(s.clientName).toBe("Jane Anderson");
    expect(s.secondaryPartyName).toBe("Marcus Webb");
  });
});

describe("suggestionsToFields", () => {
  it("maps onto the anchor field keys the class renders", () => {
    const fields = suggestionsToFields("real_estate", suggestAnchors(REAL_ESTATE_DOC, "real_estate"));
    expect(fields).toMatchObject({
      parcelNumber: "123-456-789",
      county: "Los Angeles",
      state: "California",
      buyerName: "Sarah Chen",
      sellerName: "Robert Diaz",
    });
  });

  it("formats the amount as a dollar string for money fields", () => {
    const fields = suggestionsToFields("real_estate", suggestAnchors(REAL_ESTATE_DOC, "real_estate"));
    expect(fields.purchasePrice).toBe("450000.00");
  });

  it("normalises select-backed fields to their exact option", () => {
    const cannabis = suggestionsToFields("cannabis_ind", suggestAnchors(CANNABIS_DOC, "cannabis_ind"));
    expect(cannabis.licenseType).toBe("Dispensary");

    const nr = suggestionsToFields(
      "natural_resources",
      suggestAnchors("Mineral rights over 320 acres in Kern County.", "natural_resources"),
    );
    expect(nr.rightsType).toBe("Mineral");
    expect(nr.jurisdiction).toBe("Kern County");
  });

  it("drops a select suggestion that is not one of the options", () => {
    const s = suggestAnchors("Conveyance of surface rights across 80 acres.", "natural_resources");
    expect(s.rightsType).toBe("surface rights");
    expect(suggestionsToFields("natural_resources", s).rightsType).toBeUndefined();
  });
});

describe("mergeSuggestions", () => {
  const defaults = emptyAnchorsFor("legal");
  const suggestions = suggestAnchors(LEGAL_DOC, "legal");

  it("fills empty fields and reports which it filled", () => {
    const { next, filled } = mergeSuggestions("legal", defaults, defaults, suggestions, new Set());
    expect(next.attorneyBarNumber).toBe("123456");
    expect(next.clientFullLegalName).toBe("Jane Anderson");
    expect(filled).toEqual(expect.arrayContaining(["attorneyBarNumber", "clientFullLegalName"]));
  });

  it("does not overwrite values the officer already entered", () => {
    const current = { ...defaults, attorneyBarNumber: "999999", clientFullLegalName: "Someone Else" };
    const { next, filled } = mergeSuggestions("legal", current, defaults, suggestions, new Set());
    expect(next.attorneyBarNumber).toBe("999999");
    expect(next.clientFullLegalName).toBe("Someone Else");
    expect(filled).toHaveLength(0);
  });

  it("does not refill a field the officer cleared after touching it", () => {
    const { next, filled } = mergeSuggestions(
      "legal",
      defaults,
      defaults,
      suggestions,
      new Set(["attorneyBarNumber"]),
    );
    expect(next.attorneyBarNumber).toBe("");
    expect(filled).not.toContain("attorneyBarNumber");
  });

  it("fills a select still sitting on its class default", () => {
    // `emptyAnchorsFor` pre-sets selects to their first option, so "untouched"
    // has to mean "still the default", not "empty".
    const cannabisDefaults = emptyAnchorsFor("cannabis_ind");
    expect(cannabisDefaults.licenseType).toBe("Dispensary");
    const { next, filled } = mergeSuggestions(
      "cannabis_ind",
      cannabisDefaults,
      cannabisDefaults,
      suggestAnchors("Licensed cultivator, C10-0001234-LIC.", "cannabis_ind"),
      new Set(),
    );
    expect(next.licenseType).toBe("Cultivator");
    expect(filled).toContain("licenseType");
  });

  it("leaves fields with no match untouched and unreported", () => {
    const { next, filled } = mergeSuggestions("legal", defaults, defaults, suggestions, new Set());
    expect(next.clientEmail).toBe("");
    expect(next.clientPhone).toBe("");
    expect(filled).not.toContain("clientEmail");
    expect(filled).not.toContain("clientPhone");
  });
});
