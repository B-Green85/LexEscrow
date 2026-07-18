/**
 * Demo mock-adapter runner.
 *
 * Starts every external endpoint the CRE workflow and CannaVerify adapter suite
 * call during a local demo, so the full seven-asset-class flow runs offline:
 *
 *   3001 — CA State Bar   (attorney verification, legal asset class)
 *   3002 — Metrc + SoS    (CannaVerify, Cannabis IND asset class)
 *
 *   Run:  npx tsx demo/mock-adapters/index.ts
 *
 * The CA Bar adapter stays at src/mock/calbar-adapter.ts because the existing
 * CRE workflow references it there. It binds port 3001 on import, so importing
 * the module *is* starting it.
 */
import "../../src/mock/calbar-adapter";
import { startMetrcAdapter } from "../../src/mock/metrc-adapter";

const CALBAR_PORT = 3001;
const METRC_PORT = 3002;

startMetrcAdapter(METRC_PORT);

// eslint-disable-next-line no-console
console.log(
  [
    "",
    "  LexEscrow mock adapters running",
    `    · CA State Bar   http://localhost:${CALBAR_PORT}/calbar/:barNumber`,
    `    · Metrc / SoS    http://localhost:${METRC_PORT}/v2/...`,
    "",
    "  Ctrl-C to stop both.",
    "",
  ].join("\n"),
);
