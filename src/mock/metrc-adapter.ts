/**
 * Mock Metrc + state regulatory adapter — for local CRE simulation only.
 *
 * Stands in for the real endpoints the CannaVerify adapter suite's Chainlink
 * Functions calls hit during cannabis condition verification (spec §5). Same
 * pattern as `calbar-adapter.ts`: a zero-dependency `node:http` server that
 * answers with fixed demo data, so the whole cannabis workflow runs offline.
 *
 * In production these are replaced by actual Chainlink Functions HTTP calls to
 * Metrc's per-state API and the relevant Secretary of State endpoint.
 *
 *   Run:  npx tsx src/mock/metrc-adapter.ts   (or via demo/mock-adapters)
 *   GET   http://localhost:3002/v2/licenses/:licenseNumber
 *   GET   http://localhost:3002/v2/packages
 *   POST  http://localhost:3002/v2/transfers
 *   GET   http://localhost:3002/v2/entity/:licenseNumber
 */
import { createServer, type Server } from "node:http";

/** The one license number the demo treats as active and hold-free. */
export const DEMO_LICENSE = "C10-0001234-LIC";
export const DEMO_FACILITY_ID = "MTRC-CA-00042";

const DEFAULT_PORT = 3002;

const JSON_HEADERS = { "content-type": "application/json" } as const;

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[metrc-mock] ${new Date().toISOString()} ${message}`);
}

/**
 * Start the mock Metrc adapter. Returns the server so callers can close it
 * (tests, or a demo runner shutting both adapters down together).
 */
export function startMetrcAdapter(port: number = DEFAULT_PORT): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = req.method ?? "GET";

    const send = (status: number, body: unknown) => {
      res.writeHead(status, JSON_HEADERS);
      res.end(JSON.stringify(body));
    };

    // ── GET /v2/licenses/:licenseNumber — license status + compliance holds ──
    const licenseMatch = url.pathname.match(/^\/v2\/licenses\/([^/]+)\/?$/);
    if (method === "GET" && licenseMatch) {
      const licenseNumber = decodeURIComponent(licenseMatch[1]);
      const active = licenseNumber === DEMO_LICENSE;
      log(`licenses ${licenseNumber} → ${active ? "Active" : "Inactive"}`);
      return send(200, {
        licenseNumber,
        licenseType: "Cannabis Retailer",
        status: active ? "Active" : "Inactive",
        expirationDate: "2027-12-31",
        facilityId: DEMO_FACILITY_ID,
        complianceHolds: active ? 0 : 1,
      });
    }

    // ── GET /v2/packages — inventory batches ────────────────────────────────
    if (method === "GET" && /^\/v2\/packages\/?$/.test(url.pathname)) {
      log("packages → 2 active");
      return send(200, {
        packages: [
          { label: "DEMO-BATCH-001", quantity: 50, unit: "Each", status: "Active" },
          { label: "DEMO-BATCH-002", quantity: 25, unit: "Each", status: "Active" },
        ],
      });
    }

    // ── POST /v2/transfers — transfer manifest ──────────────────────────────
    if (method === "POST" && /^\/v2\/transfers\/?$/.test(url.pathname)) {
      log("transfers → Accepted");
      // Drain the request body; the mock does not inspect it.
      req.resume();
      return send(200, {
        manifestNumber: "DEMO-MANIFEST-2026-001",
        status: "Accepted",
        estimatedDepartureDateTime: "2026-10-20T09:00:00Z",
      });
    }

    // ── GET /v2/entity/:licenseNumber — Secretary of State standing ─────────
    const entityMatch = url.pathname.match(/^\/v2\/entity\/([^/]+)\/?$/);
    if (method === "GET" && entityMatch) {
      const licenseNumber = decodeURIComponent(entityMatch[1]);
      const active = licenseNumber === DEMO_LICENSE;
      log(`entity ${licenseNumber} → ${active ? "Active" : "Inactive"}`);
      return send(200, {
        entityName: "GreenLeaf Dispensary LLC",
        status: active ? "Active" : "Inactive",
        state: "CA",
        entityType: "LLC",
      });
    }

    log(`404 ${method} ${url.pathname}`);
    send(404, { error: "not found" });
  });

  server.listen(port, () => {
    log(`listening on http://localhost:${port}`);
  });

  return server;
}

// Run directly (`npx tsx src/mock/metrc-adapter.ts`) — mirrors calbar-adapter.
if (process.argv[1] && process.argv[1].endsWith("metrc-adapter.ts")) {
  startMetrcAdapter(DEFAULT_PORT);
}
