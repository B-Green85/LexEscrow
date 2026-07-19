/**
 * Mock CA State Bar verification adapter — for local CRE simulation only.
 *
 * Stands in for the real endpoint the CRE workflow's Chainlink Functions call
 * hits during attorney verification. It returns HTTP 200 with an "active"
 * attorney for any bar number, which is all `verifyBar` in `cre/main.ts` checks
 * (it reads the status code, not the body).
 *
 * In production this is replaced by the actual Chainlink Functions HTTP call to
 * the California State Bar licensee portal.
 *
 *   Run:  bun src/mock/calbar-adapter.ts   (or: npx tsx src/mock/calbar-adapter.ts)
 *   GET   http://localhost:3001/calbar/:barNumber
 *         → 200 { active: true, name: "Test Attorney", barNumber }
 *   GET   http://localhost:3001/verify/:barNumber
 *         → 200 BarVerifyResult (see src/lib/adapters/bar-verify.ts)
 *
 * ── Demo data policy ────────────────────────────────────────────────────────
 * Every name, firm and bar number below is invented for this mock. No real
 * attorney, firm, or California bar number appears anywhere in this file, and
 * none may be added — a demo fixture that names a real licensee makes a claim
 * about a real person's standing that this server is in no position to make.
 */
import { createServer } from "node:http";

const PORT = 3001;

/**
 * The `/verify` fixture — a wholly fictional attorney.
 *
 * "Alex J. Mercer" of "Mercer Legal Group LLP" does not exist; the name and
 * firm were invented for this adapter.
 */
const DEMO_ATTORNEY = {
  attorneyName: "Alex J. Mercer",
  admissionDate: "2014-06-01",
  firmName: "Mercer Legal Group LLP",
} as const;

/**
 * What the mock registry treats as a licensee on file.
 *
 * Six digits is the California format. Anything else is answered `inactive`
 * with a "not found in records" detail, which is what the real registry
 * returns for a number it has never issued.
 */
function isKnownBarNumber(barNumber: string): boolean {
  return /^\d{6}$/.test(barNumber);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/calbar\/([^/]+)\/?$/);

  if (req.method === "GET" && match) {
    const barNumber = decodeURIComponent(match[1]);
    // eslint-disable-next-line no-console
    console.log(`[calbar-mock] ${new Date().toISOString()} verify barNumber=${barNumber} → active`);
    const body = JSON.stringify({ active: true, name: "Test Attorney", barNumber });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }

  // ── GET /verify/:barNumber — BarVerifyResult shape ────────────────────────
  // What `verifyBarForState_CA` in src/lib/adapters/bar-verify.ts calls. Unlike
  // /calbar above (status-code only), this carries a structured body: the
  // condition builder records the attorney name, admission date and firm in the
  // bar_verify condition's metadata.
  const verifyMatch = url.pathname.match(/^\/verify\/([^/]+)\/?$/);
  if (req.method === "GET" && verifyMatch) {
    const barNumber = decodeURIComponent(verifyMatch[1]);
    const known = isKnownBarNumber(barNumber);
    const body = known
      ? {
          barNumber,
          status: "active",
          ...DEMO_ATTORNEY,
          detail: "Active member in good standing — California State Bar",
        }
      : {
          barNumber,
          status: "inactive",
          detail: "Bar number not found in California State Bar records",
        };

    // eslint-disable-next-line no-console
    console.log(
      `[calbar-mock] ${new Date().toISOString()} verify barNumber=${barNumber} → ${body.status}`,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[calbar-mock] ${new Date().toISOString()} 404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ active: false, error: "not found" }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[calbar-mock] listening on http://localhost:${PORT}/calbar/:barNumber`);
  // eslint-disable-next-line no-console
  console.log(`[calbar-mock] listening on http://localhost:${PORT}/verify/:barNumber`);
});
