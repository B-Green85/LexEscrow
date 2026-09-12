/**
 * Mock DocuSign eSignature API — for local demo and CRE simulation only.
 *
 * Stands in for the four DocuSign REST endpoints `docusign.rs` calls (spec §17),
 * so the whole signature lifecycle runs offline with no developer account, no
 * RSA keypair and no consent grant. Same pattern as `metrc-adapter.ts`: a
 * zero-dependency `node:http` server answering with fixed demo data.
 *
 * Envelopes advance on a compressed clock — the same schedule as
 * `MockDocuSignProvider`, so the two mocks agree:
 *
 *   < 10s   sent
 *   10–30s  delivered
 *   > 30s   completed
 *
 *   Run:  npx tsx src/mock/docusign-adapter.ts   (or via demo/mock-adapters)
 *   POST  http://localhost:3003/v2.1/accounts/:accountId/envelopes
 *   GET   http://localhost:3003/v2.1/accounts/:accountId/envelopes/:envelopeId
 *   GET   http://localhost:3003/v2.1/accounts/:accountId/envelopes/:envelopeId/documents/certificate
 *   POST  http://localhost:3003/v2.1/accounts/:accountId/oauth/token
 *   POST  http://localhost:3003/reset
 */
import { createServer, type Server, type ServerResponse } from "node:http";

const DEFAULT_PORT = 3003;

export const DEMO_ENVELOPE_PREFIX = "DEMO-ENV-";
export const DEMO_ACCESS_TOKEN = "DEMO-ACCESS-TOKEN";
export const DEMO_CERTIFICATE_TEXT = "DEMO-CERTIFICATE-PDF";

const DELIVERED_AFTER_MS = 10_000;
const COMPLETED_AFTER_MS = 30_000;

const JSON_HEADERS = { "content-type": "application/json" } as const;
const PDF_HEADERS = { "content-type": "application/pdf" } as const;

interface StoredEnvelope {
  envelopeId: string;
  accountId: string;
  createdAt: number;
  emailSubject: string;
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[docusign-mock] ${new Date().toISOString()} ${message}`);
}

/**
 * Let the Vite dev server / demo webview call this mock from another origin.
 * Set via `setHeader` so the values survive each `writeHead(status, headers)`
 * below (Node merges the two header sets). Wildcard origin is fine — this
 * server only returns local demo fixtures.
 */
function applyCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Age-derived status — the mock's whole lifecycle model. */
function statusFor(createdAt: number, now: number): string {
  const age = now - createdAt;
  if (age >= COMPLETED_AFTER_MS) return "completed";
  if (age >= DELIVERED_AFTER_MS) return "delivered";
  return "sent";
}

export function startDocuSignAdapter(port: number = DEFAULT_PORT): Server {
  const envelopes = new Map<string, StoredEnvelope>();
  let seq = 0;

  const server = createServer((req, res) => {
    applyCors(res);
    if (req.method === "OPTIONS") {
      // CORS preflight — no body, headers already applied above.
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const method = req.method ?? "GET";

    const send = (status: number, body: unknown) => {
      res.writeHead(status, JSON_HEADERS);
      res.end(JSON.stringify(body));
    };

    // ── POST /v2.1/accounts/:accountId/oauth/token ──────────────────────────
    if (method === "POST" && /\/oauth\/token\/?$/.test(url.pathname)) {
      req.resume();
      log("oauth/token → DEMO-ACCESS-TOKEN");
      return send(200, {
        access_token: DEMO_ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    // ── POST /reset — clear state for the demo reset script ─────────────────
    if (method === "POST" && /^\/reset\/?$/.test(url.pathname)) {
      req.resume();
      const cleared = envelopes.size;
      envelopes.clear();
      seq = 0;
      log(`reset → cleared ${cleared} envelope(s)`);
      return send(200, { ok: true, cleared });
    }

    // ── GET .../envelopes/:envelopeId/documents/certificate ─────────────────
    const certMatch = url.pathname.match(
      /^\/v2\.1\/accounts\/([^/]+)\/envelopes\/([^/]+)\/documents\/certificate\/?$/,
    );
    if (method === "GET" && certMatch) {
      const envelopeId = decodeURIComponent(certMatch[2]);
      if (!envelopes.has(envelopeId)) {
        log(`certificate ${envelopeId} → 404`);
        return send(404, { errorCode: "ENVELOPE_DOES_NOT_EXIST" });
      }
      log(`certificate ${envelopeId} → ${DEMO_CERTIFICATE_TEXT}`);
      res.writeHead(200, PDF_HEADERS);
      return res.end(Buffer.from(DEMO_CERTIFICATE_TEXT, "utf8"));
    }

    // ── POST .../envelopes/:envelopeId/views/recipient ───────────────────────
    // Embedded signing (spec §22). The real API returns a short-lived DocuSign
    // ceremony URL; the mock returns the return-URL itself carrying
    // `signing_complete`, so opening it drives the same loopback listener →
    // `esign:embedded_complete` → certificate pipeline that production does.
    const viewMatch = url.pathname.match(
      /^\/v2\.1\/accounts\/([^/]+)\/envelopes\/([^/]+)\/views\/recipient\/?$/,
    );
    if (method === "POST" && viewMatch) {
      const envelopeId = decodeURIComponent(viewMatch[2]);
      req.resume();
      if (!envelopes.has(envelopeId)) {
        log(`views/recipient ${envelopeId} → 404`);
        return send(404, { errorCode: "ENVELOPE_DOES_NOT_EXIST" });
      }
      const signingUrl = `http://127.0.0.1:55432/esign-complete?event=signing_complete&envelopeId=${encodeURIComponent(
        envelopeId,
      )}`;
      log(`views/recipient ${envelopeId} → ${signingUrl}`);
      return send(201, { signingUrl });
    }

    // ── GET /v2.1/accounts/:accountId/envelopes/:envelopeId ─────────────────
    const statusMatch = url.pathname.match(
      /^\/v2\.1\/accounts\/([^/]+)\/envelopes\/([^/]+)\/?$/,
    );
    if (method === "GET" && statusMatch) {
      const envelopeId = decodeURIComponent(statusMatch[2]);
      const stored = envelopes.get(envelopeId);
      if (!stored) {
        log(`status ${envelopeId} → 404`);
        return send(404, { errorCode: "ENVELOPE_DOES_NOT_EXIST" });
      }
      const status = statusFor(stored.createdAt, Date.now());
      log(`status ${envelopeId} → ${status}`);
      return send(200, {
        envelopeId,
        status,
        statusDateTime: new Date().toISOString(),
      });
    }

    // ── POST /v2.1/accounts/:accountId/envelopes ────────────────────────────
    const createMatch = url.pathname.match(/^\/v2\.1\/accounts\/([^/]+)\/envelopes\/?$/);
    if (method === "POST" && createMatch) {
      const accountId = decodeURIComponent(createMatch[1]);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let emailSubject = "";
        try {
          emailSubject = (JSON.parse(body || "{}") as { emailSubject?: string }).emailSubject ?? "";
        } catch {
          // A malformed body is not worth rejecting in a mock.
        }
        const now = Date.now();
        // The sequence suffix keeps IDs unique within a millisecond.
        const envelopeId = `${DEMO_ENVELOPE_PREFIX}${now}${seq === 0 ? "" : `-${seq}`}`;
        seq += 1;
        envelopes.set(envelopeId, { envelopeId, accountId, createdAt: now, emailSubject });
        log(`envelopes → created ${envelopeId}`);
        send(201, {
          envelopeId,
          status: "sent",
          statusDateTime: new Date(now).toISOString(),
          uri: `/envelopes/${envelopeId}`,
        });
      });
      return;
    }

    log(`404 ${method} ${url.pathname}`);
    send(404, { error: "not found" });
  });

  server.listen(port, () => {
    log(`listening on http://localhost:${port}`);
  });

  return server;
}

// Run directly (`npx tsx src/mock/docusign-adapter.ts`) — mirrors metrc-adapter.
if (process.argv[1] && process.argv[1].endsWith("docusign-adapter.ts")) {
  startDocuSignAdapter(DEFAULT_PORT);
}
