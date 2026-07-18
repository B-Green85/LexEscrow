/**
 * Demo mock-adapter runner.
 *
 * Starts every external endpoint the CRE workflow, the CannaVerify adapter suite
 * and the DocuSign eSign integration call during a local demo, so the full
 * seven-asset-class flow runs offline:
 *
 *   3001 — CA State Bar   (attorney verification, legal asset class)
 *   3002 — Metrc + SoS    (CannaVerify, Cannabis IND asset class)
 *   3003 — DocuSign       (eSign envelopes, spec Part II)
 *
 *   Run:  npx tsx demo/mock-adapters/index.ts
 *
 * The CA Bar adapter stays at src/mock/calbar-adapter.ts because the existing
 * CRE workflow references it there. It binds port 3001 on import, so importing
 * the module *is* starting it.
 */
import "../../src/mock/calbar-adapter";
import { startMetrcAdapter } from "../../src/mock/metrc-adapter";
import { startDocuSignAdapter } from "../../src/mock/docusign-adapter";

const CALBAR_PORT = 3001;
const METRC_PORT = 3002;
const DOCUSIGN_PORT = 3003;

startMetrcAdapter(METRC_PORT);
startDocuSignAdapter(DOCUSIGN_PORT);

// eslint-disable-next-line no-console
console.log(
  [
    "",
    "  LexEscrow mock adapters running",
    `    · CA State Bar   http://localhost:${CALBAR_PORT}/calbar/:barNumber`,
    `    · Metrc / SoS    http://localhost:${METRC_PORT}/v2/...`,
    `    · DocuSign       http://localhost:${DOCUSIGN_PORT}/v2.1/accounts/:accountId/envelopes`,
    "",
    "  Ctrl-C to stop all three.",
    "",
  ].join("\n"),
);
