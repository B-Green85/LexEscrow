import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import type {
  AiPublic,
  BlockchainPublic,
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
import { InfoTooltip, type InfoTooltipProps } from "../components/InfoTooltip";
import {
  BLOCKCHAIN_TOOLTIPS,
  PrivateKeyWarning,
  WalletSetupGuide,
} from "../components/blockchainHelp";

export const PROVIDER_SUGGESTIONS = ["Claude", "GPT-4o", "Gemini", "Custom"];

export function SecretInput({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
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
        className="btn btn-ghost btn-sm absolute right-2 top-1/2 -translate-y-1/2 text-xs"
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
    <div className="card p-6">
      <div className="mb-4">
        <div className="text-base font-semibold text-text-primary">{title}</div>
        <div className="mt-1 text-sm text-text-muted">{subtitle}</div>
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
            <p className="text-sm text-text-muted">No AI provider configured — the local heuristic parser is used.</p>
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
            <p className="text-sm text-text-muted">No SMTP configured — email falls back to environment / skipped.</p>
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
            <p className="text-sm text-text-muted">No Twilio configured — SMS is skipped.</p>
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

export const DEFAULT_BASE_URI = "https://demo.docusign.net";

/** Multi-line variant of SecretInput — an RSA PEM is ~1,700 characters. */
export function SecretTextarea({
  value,
  onChange,
  placeholder,
  id,
  onFocus,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
  /** Used by the blockchain step to escalate the private key warning. */
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <textarea
        id={id}
        // Masking a textarea needs a font substitution — `password` is not a
        // valid textarea type. Hidden state keeps the PEM unreadable over a
        // shoulder while preserving the newlines the parser depends on.
        className={`input min-h-28 font-mono text-xs ${show ? "" : "text-transparent [text-shadow:0_0_7px_rgba(226,232,240,0.85)] selection:bg-transparent"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="btn btn-ghost btn-sm absolute right-2 top-2 bg-app-card text-xs"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function DocuSignCard({
  data,
  refresh,
}: {
  data: DocuSignPublic | null;
  refresh: () => void;
}) {
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
  /** Something is in the vault — not necessarily enough to authenticate with. */
  const stored =
    configured ||
    !!data?.accountId ||
    !!data?.userId ||
    !!data?.hasIntegrationKey ||
    !!data?.hasJwtPrivateKey;

  const openEdit = () => {
    // Addressing round-trips from the public shape — it is what the operator
    // typed, and starting blank meant a save that only rotated a key wrote the
    // blanks back over the stored account. The two secrets start empty and,
    // left empty, keep whatever is stored (see `setDocuSign`).
    setIntegrationKey("");
    setUserId(data?.userId ?? "");
    setAccountId(data?.accountId ?? "");
    setBaseUri(data?.baseUri || (data?.environment === "production" ? "" : DEFAULT_BASE_URI));
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
      // Nothing keeps a PEM in component state past the write that consumed it.
      setIntegrationKey("");
      setJwtPrivateKey("");
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
          {stored ? (
            <dl className="space-y-1.5 text-sm">
              <Row
                k="Environment"
                v={data?.environment === "production" ? "Production" : "Sandbox"}
              />
              <Row k="User ID" v={data?.userId || "not set"} mono />
              {/* Masked here, in full only in the edit form — the summary is
                  for recognising the account, not for reading it off. */}
              <Row k="Account ID" v={data?.accountId ? `…${data.accountIdHint}` : "not set"} mono />
              <Row k="Base URI" v={data?.baseUri || "not set"} mono />
              <Row
                k="Integration key"
                v={data?.hasIntegrationKey ? "•••••••• stored" : "not set"}
              />
              <Row
                k="JWT private key"
                v={data?.hasJwtPrivateKey ? "•••••••• stored" : "not set"}
              />
            </dl>
          ) : (
            <p className="text-sm text-text-muted">
              No DocuSign credentials — Send for Signature runs against the demo provider.
            </p>
          )}
          {stored && !configured && (
            <div className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
              Stored, but incomplete — the integration key, JWT private key and account ID are all
              required to authenticate. Send for Signature still runs against the demo provider.
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-secondary" onClick={openEdit}>
              {stored ? "Edit" : "Add"}
            </button>
            <button className="btn btn-secondary" onClick={test}>
              Test Connection
            </button>
            {stored && (
              <button className="btn btn-secondary text-red-600" onClick={del}>
                Delete
              </button>
            )}
          </div>
          {testResult && (
            <div className="mt-2 rounded-md bg-app-input px-2.5 py-1.5 text-xs text-text-primary">
              {testResult}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="ds-integration-key">
              Integration key
            </label>
            <SecretInput
              id="ds-integration-key"
              value={integrationKey}
              onChange={setIntegrationKey}
              placeholder={
                data?.hasIntegrationKey
                  ? "leave blank to keep existing"
                  : "00000000-0000-0000-0000-000000000000"
              }
            />
          </div>
          <div>
            <label className="label" htmlFor="ds-user-id">
              User ID
            </label>
            <input
              id="ds-user-id"
              className="input"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="impersonation subject GUID"
            />
          </div>
          <div>
            <label className="label" htmlFor="ds-account-id">
              Account ID
            </label>
            <input
              id="ds-account-id"
              className="input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="DocuSign account GUID"
            />
          </div>
          <div>
            <label className="label" htmlFor="ds-base-uri">
              Base URI
            </label>
            <input
              id="ds-base-uri"
              className="input"
              value={baseUri}
              onChange={(e) => setBaseUri(e.target.value)}
              placeholder={DEFAULT_BASE_URI}
            />
          </div>
          <div>
            <label className="label" htmlFor="ds-jwt-key">
              JWT private key (RSA PEM)
            </label>
            <SecretTextarea
              id="ds-jwt-key"
              value={jwtPrivateKey}
              onChange={setJwtPrivateKey}
              placeholder={
                data?.hasJwtPrivateKey
                  ? "leave blank to keep existing"
                  : "-----BEGIN RSA PRIVATE KEY-----"
              }
            />
          </div>
          <div>
            <label className="label" htmlFor="ds-environment">
              Environment
            </label>
            <select
              id="ds-environment"
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
            <p className="text-sm text-text-muted">
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
            <div className="mt-2 rounded-md bg-app-input px-2.5 py-1.5 text-xs text-text-primary">
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
            <div className="rounded-md bg-app-input px-2.5 py-1.5 text-xs text-text-primary">
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

// ── Blockchain settlement config ─────────────────────────────────────────────

/**
 * Ethereum Sepolia testnet defaults.
 *
 * These are the addresses this build was developed and deployed against, and
 * they used to live in `contracts/.env` and `cre/config.json`. They are public
 * on-chain identifiers, so they are safe to ship in the bundle — unlike the two
 * values conspicuously absent from this object. The RPC URL is a placeholder
 * because a real one embeds a billable API key; the private key has no entry at
 * all, because there is no version of "a default private key" that is not a
 * catastrophe waiting for someone to click Save.
 */
export const SEPOLIA_DEFAULTS = {
  networkName: "Ethereum Sepolia",
  chainId: 11155111,
  rpcUrl: "https://eth-sepolia.g.alchemy.com/v2/",
  contractAddress: "0x6f532f0eefc61a5792ad211850a8b48fbc388674",
  deployerAddress: "0x0b370090317443afFa8124Af45b7C2FeB5a01810",
  usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  forwarderAddress: "0x15fC6ae953E024d975e77382eEeC56A9101f9F88",
} as const;

/**
 * A `.label` with an optional ⓘ beside it.
 *
 * The button is a sibling of the `<label>`, not a child — see `Field` in
 * SetupWizard for the reasoning, which applies identically here.
 */
function TipLabel({
  htmlFor,
  tooltip,
  children,
}: {
  htmlFor: string;
  tooltip?: InfoTooltipProps;
  children: string;
}) {
  return (
    <div className="mb-1.5 flex items-center">
      <label className="block text-sm font-medium text-text-muted" htmlFor={htmlFor}>
        {children}
      </label>
      {tooltip && <InfoTooltip {...tooltip} />}
    </div>
  );
}

export function BlockchainCard({
  data,
  refresh,
}: {
  data: BlockchainPublic | null;
  refresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [networkName, setNetworkName] = useState<string>(SEPOLIA_DEFAULTS.networkName);
  const [chainId, setChainId] = useState<number>(SEPOLIA_DEFAULTS.chainId);
  const [rpcUrl, setRpcUrl] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [deployerAddress, setDeployerAddress] = useState("");
  const [deployerPrivateKey, setDeployerPrivateKey] = useState("");
  const [usdcAddress, setUsdcAddress] = useState("");
  const [forwarderAddress, setForwarderAddress] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Drives the escalated private key warning — see `PrivateKeyWarning`. */
  const [keyFocused, setKeyFocused] = useState(false);

  const configured = !!data?.hasConfig;

  const openEdit = () => {
    // Addresses round-trip from the public shape — they are public on-chain
    // identifiers, so re-showing them costs nothing and saves re-typing. The
    // two secrets start blank and, left blank, keep whatever is stored.
    setNetworkName(data?.networkName || SEPOLIA_DEFAULTS.networkName);
    setChainId(data?.chainId || SEPOLIA_DEFAULTS.chainId);
    setRpcUrl("");
    setContractAddress(data?.contractAddress ?? "");
    setDeployerAddress(data?.deployerAddress ?? "");
    setDeployerPrivateKey("");
    setUsdcAddress(data?.usdcAddress ?? "");
    setForwarderAddress(data?.forwarderAddress ?? "");
    setPassword("");
    setErr(null);
    setEditing(true);
  };

  /** Fill every non-secret field with the Sepolia testnet values. */
  const prefillDefaults = () => {
    setNetworkName(SEPOLIA_DEFAULTS.networkName);
    setChainId(SEPOLIA_DEFAULTS.chainId);
    setRpcUrl(SEPOLIA_DEFAULTS.rpcUrl);
    setContractAddress(SEPOLIA_DEFAULTS.contractAddress);
    setDeployerAddress(SEPOLIA_DEFAULTS.deployerAddress);
    setUsdcAddress(SEPOLIA_DEFAULTS.usdcAddress);
    setForwarderAddress(SEPOLIA_DEFAULTS.forwarderAddress);
    // deployerPrivateKey is deliberately untouched — see SEPOLIA_DEFAULTS.
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await backend.setBlockchain(password, {
        networkName,
        chainId,
        rpcUrl,
        contractAddress,
        deployerAddress,
        deployerPrivateKey,
        usdcAddress,
        forwarderAddress,
      });
      setDeployerPrivateKey("");
      setRpcUrl("");
      setPassword("");
      setEditing(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const del = async () => {
    await backend.vaultDelete("blockchain");
    refresh();
  };

  return (
    <CardShell title="Blockchain" subtitle="On-chain settlement — network, contracts, deployer key">
      {/* Always visible, in both the summary and the edit view. An operator who
          is about to paste a key needs the warning; an operator reviewing what
          is already stored needs to know what they are custodian of. It
          escalates to the full rules panel once the key field is live. */}
      <div className="mb-3">
        <PrivateKeyWarning expanded={editing && (keyFocused || !!deployerPrivateKey)} />
      </div>

      {!editing ? (
        <div>
          {configured ? (
            <dl className="space-y-1.5 text-sm">
              <Row k="Network" v={data?.networkName || "—"} />
              <Row k="Chain ID" v={String(data?.chainId ?? 0)} />
              <Row k="RPC endpoint" v={data?.rpcUrlHint || "not set"} mono />
              <Row k="Contract" v={data?.contractAddress || "not set"} mono />
              <Row k="Deployer" v={data?.deployerAddress || "not set"} mono />
              <Row k="USDC" v={data?.usdcAddress || "not set"} mono />
              <Row k="Forwarder" v={data?.forwarderAddress || "not set"} mono />
              <Row k="Private key" v={data?.hasPrivateKey ? "•••••••• stored" : "not set"} />
            </dl>
          ) : (
            <p className="text-sm text-text-muted">
              No blockchain configured — settlement is disabled. Parsing, LexGuard and the condition
              engine are unaffected.
            </p>
          )}
          {configured && !data?.hasPrivateKey && (
            <div className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
              Network settings are stored but no deployer key is — this install can read the chain
              but cannot submit a settlement.
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button className="btn btn-secondary" onClick={openEdit}>
              {configured ? "Edit" : "Add"}
            </button>
            {configured && (
              <button className="btn btn-secondary text-red-600" onClick={del}>
                Delete
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <WalletSetupGuide />

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <TipLabel htmlFor="bc-network-name" tooltip={BLOCKCHAIN_TOOLTIPS.networkName}>
                Network name
              </TipLabel>
              <input
                id="bc-network-name"
                className="input"
                value={networkName}
                onChange={(e) => setNetworkName(e.target.value)}
                placeholder="Ethereum Sepolia"
              />
            </div>
            <div>
              <TipLabel htmlFor="bc-chain-id" tooltip={BLOCKCHAIN_TOOLTIPS.chainId}>
                Chain ID
              </TipLabel>
              <input
                id="bc-chain-id"
                className="input"
                type="number"
                value={chainId}
                onChange={(e) => setChainId(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>
          <div>
            <TipLabel htmlFor="bc-rpc-url" tooltip={BLOCKCHAIN_TOOLTIPS.rpcUrl}>
              RPC URL
            </TipLabel>
            <SecretInput
              id="bc-rpc-url"
              value={rpcUrl}
              onChange={setRpcUrl}
              placeholder={
                data?.rpcUrlHint ? "leave blank to keep existing" : "https://eth-sepolia.g.alchemy.com/v2/…"
              }
            />
            <p className="mt-1 text-[11px] text-text-muted">
              Treated as a secret — provider API keys ride in the URL path.
            </p>
          </div>
          <div>
            <TipLabel htmlFor="bc-contract-address" tooltip={BLOCKCHAIN_TOOLTIPS.contractAddress}>
              Contract address (EscrowSettlement)
            </TipLabel>
            <input
              id="bc-contract-address"
              className="input font-mono text-xs"
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
              placeholder="0x…"
            />
          </div>
          <div>
            <TipLabel htmlFor="bc-deployer-address" tooltip={BLOCKCHAIN_TOOLTIPS.deployerAddress}>
              Deployer address
            </TipLabel>
            <input
              id="bc-deployer-address"
              className="input font-mono text-xs"
              value={deployerAddress}
              onChange={(e) => setDeployerAddress(e.target.value)}
              placeholder="0x…"
            />
          </div>
          <div>
            <TipLabel htmlFor="bc-deployer-key" tooltip={BLOCKCHAIN_TOOLTIPS.deployerPrivateKey}>
              Deployer private key
            </TipLabel>
            <SecretTextarea
              id="bc-deployer-key"
              value={deployerPrivateKey}
              onChange={setDeployerPrivateKey}
              onFocus={() => setKeyFocused(true)}
              onBlur={() => setKeyFocused(false)}
              placeholder={data?.hasPrivateKey ? "leave blank to keep existing" : "0x…"}
            />
          </div>
          <div>
            <TipLabel htmlFor="bc-usdc-address" tooltip={BLOCKCHAIN_TOOLTIPS.usdcAddress}>
              USDC address
            </TipLabel>
            <input
              id="bc-usdc-address"
              className="input font-mono text-xs"
              value={usdcAddress}
              onChange={(e) => setUsdcAddress(e.target.value)}
              placeholder="0x…"
            />
          </div>
          <div>
            <TipLabel htmlFor="bc-forwarder-address" tooltip={BLOCKCHAIN_TOOLTIPS.forwarderAddress}>
              Forwarder address (CRE)
            </TipLabel>
            <input
              id="bc-forwarder-address"
              className="input font-mono text-xs"
              value={forwarderAddress}
              onChange={(e) => setForwarderAddress(e.target.value)}
              placeholder="0x…"
            />
          </div>
          <div>
            <label className="label" htmlFor="bc-vault-password">Vault password</label>
            <SecretInput
              id="bc-vault-password"
              value={password}
              onChange={setPassword}
              placeholder="confirm to save"
            />
            <p className="mt-1 text-[11px] text-text-muted">
              Re-entered because this is the one credential here that cannot be revoked after it
              leaks.
            </p>
          </div>
          <Err msg={err} />
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={busy || !password || !contractAddress}
              onClick={save}
            >
              Save
            </button>
            <button className="btn btn-secondary" onClick={prefillDefaults}>
              Pre-fill Sepolia defaults
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

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-text-muted">{k}</dt>
      <dd className={`truncate text-text-primary ${mono ? "font-mono text-xs" : ""}`} title={v}>
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
  const openWizard = useSession((s) => s.openWizard);
  const lockVault = useSession((s) => s.lockVault);
  const unlockVault = useSession((s) => s.unlockVault);
  const [exists, setExists] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [pub, setPub] = useState<VaultPublic | null>(null);
  const [docusign, setDocusign] = useState<DocuSignPublic | null>(null);
  const [clio, setClio] = useState<ClioPublic | null>(null);
  const [practicePanther, setPracticePanther] = useState<PracticePantherPublic | null>(null);
  const [blockchain, setBlockchain] = useState<BlockchainPublic | null>(null);
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
      const [vaultPub, dsPub, clioPub, ppPub, chainPub] = await Promise.all([
        backend.vaultGetPublic(),
        backend.getDocuSignPublic(),
        backend.getClioPublic(),
        backend.getPracticePantherPublic(),
        backend.getBlockchainPublic(),
      ]);
      setPub(vaultPub);
      setDocusign(dsPub);
      setClio(clioPub);
      setPracticePanther(ppPub);
      setBlockchain(chainPub);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onUnlock = async () => {
    setBusy(true);
    setError(null);
    try {
      // Same entry point the launch gate uses, so an unlock from here has the
      // identical side effects — gate down, settlement config re-read.
      const r = await unlockVault(password);
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
    // Through the store, not `backend.vaultLock` directly: locking has to raise
    // the same gate the app launches behind, or this button would leave the
    // operator in a running UI whose credentials have all just gone away.
    await lockVault();
    setUnlocked(false);
    setPub(null);
    setDocusign(null);
    setClio(null);
    setPracticePanther(null);
    setBlockchain(null);
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight text-text-primary">Configuration</h1>
        <button className="btn btn-secondary" onClick={() => closeConfig()}>
          Done
        </button>
      </div>
      <p className="mt-1 text-sm text-text-muted">
        Credentials are held in an AES-256-GCM encrypted vault. Secrets never leave the backend — this
        screen only ever shows public metadata.
      </p>

      {!unlocked ? (
        <div className="card mx-auto mt-8 max-w-md p-6">
          <div className="text-base font-semibold text-text-primary">
            {exists ? "Unlock the vault" : "Create a vault"}
          </div>
          <p className="mt-1 text-sm text-text-muted">
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
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Settlement
            </div>
            <p className="mt-1 text-sm text-text-muted">
              Where funds actually move. Held in the vault rather than in `contracts/.env` — the
              deployer key never reaches this screen, and never crosses IPC.
            </p>
          </div>
          <BlockchainCard data={blockchain} refresh={refresh} />

          <div className="pt-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Integrations
            </div>
            <p className="mt-1 text-sm text-text-muted">
              Escrow lifecycle events are forwarded to your practice-management system. Delivery is
              best-effort — a failed webhook never blocks a settlement.
            </p>
          </div>
          <ClioCard data={clio} refresh={refresh} />
          <PracticePantherCard data={practicePanther} refresh={refresh} />

          <ChangePassword />
        </div>
      )}

      {/* Outside the unlocked branch on purpose: the wizard creates the vault
          itself, so it has to be reachable from the locked screen too — which
          is exactly where an operator who abandoned onboarding ends up. */}
      <div className="mt-10 border-t border-app-border pt-4 text-center">
        <button
          className="text-xs text-text-muted underline underline-offset-2 hover:text-text-primary"
          onClick={() => openWizard()}
        >
          Re-run setup wizard
        </button>
      </div>
    </div>
  );
}
