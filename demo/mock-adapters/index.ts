/**
 * Demo mock-adapter runner.
 *
 * Starts every external endpoint the CannaVerify adapter suite and the DocuSign
 * eSign integration call during a local demo, so the full seven-asset-class flow
 * runs offline:
 *
 *   3002 — Metrc + SoS    (CannaVerify, Cannabis IND asset class)
 *   3003 — DocuSign       (eSign envelopes, spec Part II)
 *
 *   Run:  npx tsx demo/mock-adapters/index.ts
 *
 * Attorney bar verification has no mock: it goes through the Rust backend to a
 * real registry, and an unconfigured Apify token reports itself as unconfigured
 * rather than failing, so the demo runs offline without one.
 */
import { startMetrcAdapter } from "../../src/mock/metrc-adapter";
import { startDocuSignAdapter } from "../../src/mock/docusign-adapter";

const METRC_PORT = 3002;
const DOCUSIGN_PORT = 3003;

startMetrcAdapter(METRC_PORT);
startDocuSignAdapter(DOCUSIGN_PORT);

// eslint-disable-next-line no-console
console.log(
  [
    "",
    "  LexEscrow mock adapters running",
    `    · Metrc / SoS    http://localhost:${METRC_PORT}/v2/...`,
    `    · DocuSign       http://localhost:${DOCUSIGN_PORT}/v2.1/accounts/:accountId/envelopes`,
    "",
    "  Ctrl-C to stop both.",
    "",
  ].join("\n"),
);
