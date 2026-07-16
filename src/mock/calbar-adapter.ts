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
 */
import { createServer } from "node:http";

const PORT = 3001;

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

  // eslint-disable-next-line no-console
  console.log(`[calbar-mock] ${new Date().toISOString()} 404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ active: false, error: "not found" }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[calbar-mock] listening on http://localhost:${PORT}/calbar/:barNumber`);
});
