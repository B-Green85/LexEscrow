import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import type {
  AiPublic,
  ClioPublic,
  DocuSignPublic,
  PracticePantherPublic,
  SmtpPublic,
  TwilioPublic,
  VaultPublic,
} from "../lib/vaultTypes";
import {
  sendClioWebhook,
  sendPracticePantherWebhook,
  CLIO_TEST_EVENT,
  PRACTICE_PANTHER_TEST_TRIGGER,
} from "../lib/integrations";

const PROVIDER_SUGGESTIONS = ["Claude", "GPT-4o", "Gemini", "Custom"];

function SecretInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        className="input pr-16"
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

function CardShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="mb-3">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        <div className="text-xs text-slate-400">{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <div className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{msg}</div>;
}

// ── AI provider ──────────────────────────────────────────────────────────────

function AiCard({ data, refresh }: { data: AiPublic | null; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [providerName, setProviderName] = useState("Claude");
  const [endpoint, setEndpoint] = useState("");
  const [connectionType, setConnectionType] = useState<"http" | "websocket">("http");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openEdit = () => {
    setProviderName(data?.providerName ?? "Claude");
    setEndpoint(data?.endpoint ?? "");
    setConnectionType(data?.connectionType ?? "http");
    setApiKey("");
    setErr(null);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await backend.vaultSetAi({ providerName, endpoint, connectionType, apiKey: apiKey || undefined });
      setEditing(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const del = async () => {
    await backend.vaultDelete("ai");
    refresh();
  };

  return (
    <CardShell title="AI Provider" subtitle="Resolves the document parser at runtime">
      {!editing ? (
        <div>
          {data ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Provider" v={data.providerName} />
              <Row k="Endpoint" v={data.endpoint} mono />
              <Row k="Connection" v={data.connectionType === "websocket" ? "WebSocket" : "HTTP"} />
              <Row k="API key" v={data.hasApiKey ? "•••••••• stored" : "not set"} />
            </dl>
          ) : (
            <p className="text-sm text-slate-400">No AI provider configured — the local heuristic parser is used.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-secondary" onClick={openEdit}>
              {data ? "Edit" : "Add"}
            </button>
            {data && (
              <button className="btn btn-secondary text-red-600" onClick={del}>
                Delete
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Provider name</label>
            <input
              className="input"
              list="ai-providers"
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
              placeholder="Claude"
            />
            <datalist id="ai-providers">
              {PROVIDER_SUGGESTIONS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="label">Endpoint</label>
            <input
              className="input"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={connectionType === "websocket" ? "wss://…" : "https://…"}
            />
          </div>
          <div>
            <label className="label">Connection type</label>
            <div className="flex gap-4 text-sm">
              {(["http", "websocket"] as const).map((ct) => (
                <label key={ct} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={connectionType === ct}
                    onChange={() => setConnectionType(ct)}
                  />
                  {ct === "http" ? "HTTP" : "WebSocket"}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="label">API key</label>
            <SecretInput value={apiKey} onChange={setApiKey} placeholder={data?.hasApiKey ? "leave blank to keep existing" : "sk-…"} />
          </div>
          <Err msg={err} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !endpoint} onClick={save}>
              Save
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

function SmtpCard({ data, refresh }: { data: SmtpPublic | null; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openEdit = () => {
    setHost(data?.host ?? "");
    setPort(data?.port ?? 587);
    setUsername(data?.username ?? "");
    setPassword("");
    setErr(null);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await backend.vaultSetSmtp({ host, port, username, password: password || undefined });
      setEditing(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const del = async () => {
    await backend.vaultDelete("smtp");
    refresh();
  };

  return (
    <CardShell title="SMTP" subtitle="Outbound mail for client notifications">
      {!editing ? (
        <div>
          {data ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Host" v={data.host} mono />
              <Row k="Port" v={String(data.port)} />
              <Row k="Username" v={data.username} />
              <Row k="Password" v={data.hasPassword ? "•••••••• stored" : "not set"} />
            </dl>
          ) : (
            <p className="text-sm text-slate-400">No SMTP configured — email falls back to environment / skipped.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-secondary" onClick={openEdit}>
              {data ? "Edit" : "Add"}
            </button>
            {data && (
              <button className="btn btn-secondary text-red-600" onClick={del}>
                Delete
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="label">Host</label>
              <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div>
              <label className="label">Port</label>
              <input
                className="input"
                type="number"
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>
          <div>
            <label className="label">Username</label>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <SecretInput value={password} onChange={setPassword} placeholder={data?.hasPassword ? "leave blank to keep existing" : ""} />
          </div>
          <Err msg={err} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !host} onClick={save}>
              Save
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ── Twilio ─────────────────────────────────────────────────────────────────

function TwilioCard({ data, refresh }: { data: TwilioPublic | null; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [accountSid, setAccountSid] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openEdit = () => {
    setAccountSid(data?.accountSid ?? "");
    setFromNumber(data?.fromNumber ?? "");
    setAuthToken("");
    setErr(null);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await backend.vaultSetTwilio({ accountSid, fromNumber, authToken: authToken || undefined });
      setEditing(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const del = async () => {
    await backend.vaultDelete("twilio");
    refresh();
  };

  return (
    <CardShell title="Twilio (optional)" subtitle="SMS for client notifications">
      {!editing ? (
        <div>
          {data ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Account SID" v={data.accountSid} mono />
              <Row k="From number" v={data.fromNumber} />
              <Row k="Auth token" v={data.hasAuthToken ? "•••••••• stored" : "not set"} />
            </dl>
          ) : (
            <p className="text-sm text-slate-400">No Twilio configured — SMS is skipped.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-secondary" onClick={openEdit}>
              {data ? "Edit" : "Add"}
            </button>
            {data && (
              <button className="btn btn-secondary text-red-600" onClick={del}>
                Delete
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Account SID</label>
            <input className="input" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="AC…" />
          </div>
          <div>
            <label className="label">From number</label>
            <input className="input" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} placeholder="+15550000000" />
          </div>
          <div>
            <label className="label">Auth token</label>
            <SecretInput value={authToken} onChange={setAuthToken} placeholder={data?.hasAuthToken ? "leave blank to keep existing" : ""} />
          </div>
          <Err msg={err} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !accountSid} onClick={save}>
              Save
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ── DocuSign (spec §24) ──────────────────────────────────────────────────────

const DEFAULT_BASE_URI = "https://demo.docusign.net";

/** Multi-line variant of SecretInput — an RSA PEM is ~1,700 characters. */
function SecretTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <textarea
        // Masking a textarea needs a font substitution — `password` is not a
        // valid textarea type. Hidden state keeps the PEM unreadable over a
        // shoulder while preserving the newlines the parser depends on.
        className={`input min-h-28 font-mono text-xs ${show ? "" : "text-transparent [text-shadow:0_0_7px_rgba(226,232,240,0.85)] selection:bg-transparent"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-2 rounded bg-[#111827] px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

function DocuSignCard({ data, refresh }: { data: DocuSignPublic | null; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [integrationKey, setIntegrationKey] = useState("");
  const [userId, setUserId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [baseUri, setBaseUri] = useState(DEFAULT_BASE_URI);
  const [jwtPrivateKey, setJwtPrivateKey] = useState("");
  const [environment, setEnvironment] = useState("sandbox");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const configured = !!data?.hasCredentials;

  const openEdit = () => {
    // The public shape carries no key, user ID or full account ID by design, so
    // an edit starts from the environment default rather than echoing secrets.
    setIntegrationKey("");
    setUserId("");
    setAccountId("");
    setBaseUri(data?.environment === "production" ? "" : DEFAULT_BASE_URI);
    setJwtPrivateKey("");
    setEnvironment(data?.environment || "sandbox");
    setErr(null);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await backend.setDocuSign({
        integrationKey,
        userId,
        accountId,
        baseUri,
        jwtPrivateKey,
        environment,
      });
      setEditing(false);
      setTestResult(null);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const test = async () => {
    setTestResult(null);
    try {
      const ok = await backend.hasDocuSign();
      setTestResult(ok ? "✅ Connected" : "❌ Not configured");
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const del = async () => {
    await backend.vaultDelete("docusign");
    setTestResult(null);
    refresh();
  };

  return (
    <CardShell title="DocuSign" subtitle="eSignature envelopes — JWT Grant, server-to-server">
      {!editing ? (
        <div>
          {configured ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Credentials" v="•••••••• stored" />
              <Row
                k="Environment"
                v={data?.environment === "production" ? "Production" : "Sandbox"}
              />
              <Row k="Account ID" v={`…${data?.accountIdHint ?? ""}`} mono />
            </dl>
          ) : (
            <p className="text-sm text-slate-400">
              No DocuSign credentials — Send for Signature runs against the demo provider.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-secondary" onClick={openEdit}>
              {configured ? "Edit" : "Add"}
            </button>
            <button className="btn btn-secondary" onClick={test}>
              Test Connection
            </button>
            {configured && (
              <button className="btn btn-secondary text-red-600" onClick={del}>
                Delete
              </button>
            )}
          </div>
          {testResult && (
            <div className="mt-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
              {testResult}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Integration key</label>
            <SecretInput
              value={integrationKey}
              onChange={setIntegrationKey}
              placeholder={configured ? "leave blank to keep existing" : "00000000-0000-0000-0000-000000000000"}
            />
          </div>
          <div>
            <label className="label">User ID</label>
            <input
              className="input"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="impersonation subject GUID"
            />
          </div>
          <div>
            <label className="label">Account ID</label>
            <input
              className="input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="DocuSign account GUID"
            />
          </div>
          <div>
            <label className="label">Base URI</label>
            <input
              className="input"
              value={baseUri}
              onChange={(e) => setBaseUri(e.target.value)}
              placeholder={DEFAULT_BASE_URI}
            />
          </div>
          <div>
            <label className="label">JWT private key (RSA PEM)</label>
            <SecretTextarea
              value={jwtPrivateKey}
              onChange={setJwtPrivateKey}
              placeholder={
                configured
                  ? "leave blank to keep existing"
                  : "-----BEGIN RSA PRIVATE KEY-----"
              }
            />
          </div>
          <div>
            <label className="label">Environment</label>
            <select
              className="input"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          </div>
          <Err msg={err} />
          <div className="flex gap-2">
            <button
              className="btn btn-primary"
              disabled={busy || !userId || !accountId || !baseUri}
              onClick={save}
            >
              Save
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ── Practice-management integrations (spec §14 V1) ───────────────────────────

/**
 * Shared card for the two webhook integrations.
 *
 * Clio and PracticePanther differ only in their event vocabulary — which is a
 * property of the *payload*, not of the configuration — so a second near-
 * identical card would be duplication with no compensating clarity. The vendor
 * differences that matter to the operator (the test event name, the URL
 * placeholder) are passed in.
 */
function WebhookCard({
  title,
  subtitle,
  data,
  urlPlaceholder,
  testLabel,
  onSave,
  onTest,
  refresh,
}: {
  title: string;
  subtitle: string;
  data: ClioPublic | PracticePantherPublic | null;
  urlPlaceholder: string;
  testLabel: string;
  onSave: (input: { webhookUrl: string; matterId?: string; apiKey?: string }) => Promise<void>;
  onTest: (input: { webhookUrl: string; matterId?: string; apiKey?: string }) => Promise<string>;
  refresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [matterId, setMatterId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const configured = !!data?.webhookUrl;

  const openEdit = () => {
    setWebhookUrl(data?.webhookUrl ?? "");
    setMatterId(data?.matterId ?? "");
    setApiKey("");
    setErr(null);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        webhookUrl,
        matterId: matterId || undefined,
        apiKey: apiKey || undefined,
      });
      setEditing(false);
      setTestResult(null);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  /**
   * Fire a test webhook.
   *
   * Tests the values currently on screen rather than what is stored, so an
   * operator can validate a URL and key *before* committing them — and, more
   * importantly, so the stored API key never has to be read back out of the
   * vault to be exercised.
   */
  const test = async () => {
    setTestResult("Sending…");
    try {
      setTestResult(
        await onTest({
          webhookUrl: editing ? webhookUrl : (data?.webhookUrl ?? ""),
          matterId: (editing ? matterId : data?.matterId) || undefined,
          apiKey: apiKey || undefined,
        }),
      );
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const disable = async () => {
    // A blank URL clears the entry in both vault implementations, so the token
    // does not linger after the integration is switched off.
    await onSave({ webhookUrl: "" });
    setTestResult(null);
    refresh();
  };

  return (
    <CardShell title={title} subtitle={subtitle}>
      {!editing ? (
        <div>
          {configured ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Webhook URL" v={data?.webhookUrl ?? ""} mono />
              <Row k="Matter ID" v={data?.matterId || "not set"} />
              <Row k="API key" v={data?.hasApiKey ? "•••••••• stored" : "not set"} />
            </dl>
          ) : (
            <p className="text-sm text-slate-400">
              No webhook configured — escrow events are not forwarded.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-secondary" onClick={openEdit}>
              {configured ? "Edit" : "Add"}
            </button>
            <button className="btn btn-secondary" disabled={!configured} onClick={test}>
              Test
            </button>
            {configured && (
              <button className="btn btn-secondary text-red-600" onClick={disable}>
                Delete
              </button>
            )}
          </div>
          {testResult && (
            <div className="mt-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
              {testResult}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Webhook URL</label>
            <input
              className="input"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={urlPlaceholder}
            />
          </div>
          <div>
            <label className="label">Matter ID (optional)</label>
            <input
              className="input"
              value={matterId}
              onChange={(e) => setMatterId(e.target.value)}
              placeholder="associates events with an existing matter"
            />
          </div>
          <div>
            <label className="label">API key</label>
            <SecretInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={data?.hasApiKey ? "leave blank to keep existing" : "bearer token"}
            />
          </div>
          <Err msg={err} />
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy || !webhookUrl} onClick={save}>
              Save
            </button>
            <button className="btn btn-secondary" disabled={!webhookUrl} onClick={test}>
              Test — {testLabel}
            </button>
            <button className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {testResult && (
            <div className="rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
              {testResult}
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
}

/** Human-readable outcome of a test webhook. */
function describeTest(result: { success: boolean; statusCode?: number; error?: string }): string {
  if (result.success) return `✅ Delivered — HTTP ${result.statusCode ?? 200}`;
  return `❌ ${result.error ?? `HTTP ${result.statusCode ?? "error"}`}`;
}

function ClioCard({ data, refresh }: { data: ClioPublic | null; refresh: () => void }) {
  return (
    <WebhookCard
      title="Clio"
      subtitle="Matter updates posted as escrow events occur"
      data={data}
      urlPlaceholder="https://app.clio.com/webhooks/…"
      testLabel={CLIO_TEST_EVENT}
      refresh={refresh}
      onSave={(input) => backend.setClio(input)}
      onTest={async (input) =>
        describeTest(
          await sendClioWebhook(input, {
            event: CLIO_TEST_EVENT,
            sessionId: "test",
            assetClass: "legal",
            timestamp: new Date().toISOString(),
            data: { source: "LexEscrow configuration test" },
          }),
        )
      }
    />
  );
}

function PracticePantherCard({
  data,
  refresh,
}: {
  data: PracticePantherPublic | null;
  refresh: () => void;
}) {
  return (
    <WebhookCard
      title="PracticePanther"
      subtitle="Matter triggers fired as escrow events occur"
      data={data}
      urlPlaceholder="https://api.practicepanther.com/webhooks/…"
      testLabel={PRACTICE_PANTHER_TEST_TRIGGER}
      refresh={refresh}
      onSave={(input) => backend.setPracticePanther(input)}
      onTest={async (input) =>
        describeTest(
          await sendPracticePantherWebhook(input, {
            trigger: PRACTICE_PANTHER_TEST_TRIGGER,
            source: "lexescrow",
            session_id: "test",
            occurred_at: new Date().toISOString(),
            metadata: { source: "LexEscrow configuration test" },
          }),
        )
      }
    />
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-500">{k}</dt>
      <dd className={`truncate text-slate-800 ${mono ? "font-mono text-xs" : ""}`} title={v}>
        {v}
      </dd>
    </div>
  );
}

// ── Change password ──────────────────────────────────────────────────────────

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await backend.vaultChangePassword(current, next);
      setCurrent("");
      setNext("");
      setOpen(false);
      setMsg("Vault password changed.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <CardShell title="Vault password" subtitle="Re-keys and re-encrypts the vault">
      {msg && <div className="mb-2 rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700">{msg}</div>}
      {!open ? (
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>
          Change password
        </button>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Current password</label>
            <SecretInput value={current} onChange={setCurrent} />
          </div>
          <div>
            <label className="label">New password</label>
            <SecretInput value={next} onChange={setNext} />
          </div>
          <Err msg={err} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !current || !next} onClick={submit}>
              Update
            </button>
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export function Configuration() {
  const closeConfig = useSession((s) => s.closeConfig);
  const [exists, setExists] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [pub, setPub] = useState<VaultPublic | null>(null);
  const [docusign, setDocusign] = useState<DocuSignPublic | null>(null);
  const [clio, setClio] = useState<ClioPublic | null>(null);
  const [practicePanther, setPracticePanther] = useState<PracticePantherPublic | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const status = await backend.vaultStatus();
    setExists(status.exists);
    setUnlocked(status.unlocked);
    if (status.unlocked) {
      // DocuSign and the two webhook integrations live outside VaultPublic —
      // each has its own deliberately narrower public shape.
      const [vaultPub, dsPub, clioPub, ppPub] = await Promise.all([
        backend.vaultGetPublic(),
        backend.getDocuSignPublic(),
        backend.getClioPublic(),
        backend.getPracticePantherPublic(),
      ]);
      setPub(vaultPub);
      setDocusign(dsPub);
      setClio(clioPub);
      setPracticePanther(ppPub);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onUnlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await backend.vaultUnlock(password);
      if (!r.ok) {
        setError(r.message ?? "Unlock failed.");
        setBusy(false);
        return;
      }
      setPassword("");
      setExists(true);
      setUnlocked(true);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const onLock = async () => {
    await backend.vaultLock();
    setUnlocked(false);
    setPub(null);
    setDocusign(null);
    setClio(null);
    setPracticePanther(null);
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">Configuration</h1>
        <button className="btn btn-secondary" onClick={() => closeConfig()}>
          Done
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Credentials are held in an AES-256-GCM encrypted vault. Secrets never leave the backend — this
        screen only ever shows public metadata.
      </p>

      {!unlocked ? (
        <div className="card mx-auto mt-8 max-w-md p-6">
          <div className="text-sm font-semibold text-slate-800">
            {exists ? "Unlock the vault" : "Create a vault"}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {exists
              ? "Enter your vault password to manage credentials."
              : "Set a password. It derives the encryption key — there is no recovery if lost."}
          </p>
          <div className="mt-4">
            <SecretInput value={password} onChange={setPassword} placeholder="Vault password" />
          </div>
          {error && <div className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error}</div>}
          <button
            className="btn btn-primary mt-4 w-full"
            disabled={busy || !password}
            onClick={onUnlock}
          >
            {exists ? "Unlock" : "Create vault"}
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-4 py-2">
            <span className="text-sm font-medium text-emerald-800">Vault unlocked</span>
            <button className="text-xs font-medium text-emerald-700 underline" onClick={onLock}>
              Lock
            </button>
          </div>
          <AiCard data={pub?.ai ?? null} refresh={refresh} />
          <SmtpCard data={pub?.smtp ?? null} refresh={refresh} />
          <TwilioCard data={pub?.twilio ?? null} refresh={refresh} />
          <DocuSignCard data={docusign} refresh={refresh} />

          <div className="pt-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Integrations
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Escrow lifecycle events are forwarded to your practice-management system. Delivery is
              best-effort — a failed webhook never blocks a settlement.
            </p>
          </div>
          <ClioCard data={clio} refresh={refresh} />
          <PracticePantherCard data={practicePanther} refresh={refresh} />

          <ChangePassword />
        </div>
      )}
    </div>
  );
}
