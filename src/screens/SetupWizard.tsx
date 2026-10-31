// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * First-run onboarding (spec §12 Screen 0).
 *
 * The same credential forms as the Configuration screen, presented as a linear
 * flow instead of a settings page. The two are not alternatives — Configuration
 * is where an operator who knows what they are looking for goes to change one
 * thing, and it assumes an unlocked vault before it shows anything. That is
 * exactly the assumption a first launch cannot satisfy: there is no vault yet,
 * so the screen an operator meets first is a password prompt with no
 * explanation of what it protects or why there is no recovery.
 *
 * So this flow inverts the order. It explains, then asks, one decision per
 * screen, and every step after the vault can be skipped — an install that only
 * ever runs Manual Entry against a demo settlement is a legitimate install, and
 * refusing to start until DocuSign is wired up would be a lie about what the
 * product needs.
 *
 * The form primitives and the Sepolia defaults are imported from Configuration
 * rather than restated. A second copy of the "blank secret keeps the stored
 * one" convention, or of a contract address, is a copy that drifts.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import emblem from "../assets/lexescrow-emblem.png";
import { InfoTooltip, type InfoTooltipProps } from "../components/InfoTooltip";
import { BlockchainWriteAuthModal } from "../components/BlockchainWriteAuthModal";
import {
  BLOCKCHAIN_TOOLTIPS,
  PrivateKeyWarning,
  WalletSetupGuide,
} from "../components/blockchainHelp";
import {
  DEFAULT_BASE_URI,
  PROVIDER_SUGGESTIONS,
  SEPOLIA_DEFAULTS,
  SecretInput,
  SecretTextarea,
} from "./Configuration";

export const TOTAL_STEPS = 7;

/** Skip-set members. Steps 1, 2 and 7 cannot be skipped and have no key. */
export type SkippableStep = "ai" | "blockchain" | "docusign" | "notifications";

export type PasswordStrength = "weak" | "fair" | "strong";

/**
 * Vault password strength.
 *
 * Length is weighted over composition on purpose: this password is stretched
 * into an AES-256-GCM key and is the only thing standing between a stolen vault
 * file and a deployer key that moves funds. A 14-character passphrase resists
 * the offline attack that matters here better than "P@ss1!" does, so twelve
 * characters reaches `strong` on length alone, while a shorter password has to
 * earn it with all four character classes.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < 8) return "weak";
  const mixed =
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
  if (password.length >= 12 || mixed) return "strong";
  return "fair";
}

const STRENGTH_UI: Record<PasswordStrength, { label: string; bar: string; text: string; width: string }> = {
  weak: { label: "Weak", bar: "bg-red-500", text: "text-red-400", width: "w-1/3" },
  fair: { label: "Fair", bar: "bg-amber-500", text: "text-amber-400", width: "w-2/3" },
  strong: { label: "Strong", bar: "bg-emerald-500", text: "text-emerald-400", width: "w-full" },
};

// ── Chrome ───────────────────────────────────────────────────────────────────

/**
 * Step progress. Shown from step 3 — the two steps before it are not optional
 * and not navigable, so a position indicator would only tell the operator how
 * much of something they cannot leave is left.
 */
export function StepProgress({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-3" data-testid="wizard-progress">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((n) => {
          const state = n < step ? "done" : n === step ? "current" : "future";
          return (
            <span
              key={n}
              data-testid={`wizard-dot-${n}`}
              data-state={state}
              className={`h-2.5 w-2.5 rounded-full border transition-colors ${
                state === "done"
                  ? "border-gold bg-gold"
                  : state === "current"
                    ? "border-gold bg-white"
                    : "border-app-border bg-app-input"
              }`}
            />
          );
        })}
      </div>
      <span className="text-xs font-medium text-text-muted">
        {step >= TOTAL_STEPS ? "Complete ✅" : `Step ${step} of ${TOTAL_STEPS}`}
      </span>
    </div>
  );
}

function Shell({
  step,
  title,
  subtitle,
  children,
  footer,
}: {
  step: number;
  /** Omitted by the welcome step, which carries its own centred heading. */
  title?: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg"
      role="dialog"
      aria-modal="true"
    >
      <div className="mx-4 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-2xl border border-app-border bg-app-card p-8 shadow-2xl">
        {step >= 3 && <StepProgress step={step} />}
        {title && (
          <h1 className={`text-xl font-semibold text-text-primary ${step >= 3 ? "mt-6" : ""}`}>
            {title}
          </h1>
        )}
        {subtitle && <div className="mt-2 text-sm leading-relaxed text-text-muted">{subtitle}</div>}
        <div className="mt-6 flex-1">{children}</div>
        <div className="mt-8 flex flex-wrap items-center gap-3">{footer}</div>
      </div>
    </div>
  );
}

/** The rationale under a Skip button — why skipping is survivable, and what it costs. */
function SkipNote({ children }: { children: ReactNode }) {
  return <p className="mt-3 w-full text-xs text-text-muted">{children}</p>;
}

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400" role="alert">
      {msg}
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  tooltip,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  tooltip?: InfoTooltipProps;
  children: ReactNode;
}) {
  return (
    <div>
      {/* The ⓘ is a sibling of the `<label>`, not a child of it. Nesting a
          button inside a label makes clicking it focus the field as well, and
          it appends the icon to the field's accessible name — "Chain ID ⓘ" is
          not what a screen reader should announce, nor what a test asking for
          the field by its label should have to match. */}
      <div className="mb-1.5 flex items-center">
        <label className="block text-sm font-medium text-text-muted" htmlFor={id}>
          {label}
        </label>
        {tooltip && <InfoTooltip {...tooltip} />}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}
    </div>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export function SetupWizard() {
  const completeWizard = useSession((s) => s.completeWizard);
  const storeBackend = useSession((s) => s.storeBackend);

  const [step, setStep] = useState(1);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Step 2 — vault.
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [vaultCreated, setVaultCreated] = useState(false);
  /**
   * Does a vault already exist? False on a first run — and true whenever the
   * flow was re-opened from Configuration or the File menu, which turns step 2
   * from "choose a password" into "re-enter yours". The distinction is not
   * cosmetic: telling a returning operator to pick an unrecoverable password
   * would be a lie, and holding them to the strength gate would lock them out
   * of the very steps they came back to fill in.
   */
  const [vaultExists, setVaultExists] = useState(false);

  // Step 3 — AI.
  const [providerName, setProviderName] = useState("Claude");
  const [endpoint, setEndpoint] = useState("");
  const [connectionType, setConnectionType] = useState<"http" | "websocket">("http");
  const [apiKey, setApiKey] = useState("");

  // Step 4 — blockchain.
  const [networkName, setNetworkName] = useState<string>(SEPOLIA_DEFAULTS.networkName);
  const [chainId, setChainId] = useState<number>(SEPOLIA_DEFAULTS.chainId);
  const [rpcUrl, setRpcUrl] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [deployerAddress, setDeployerAddress] = useState("");
  const [deployerPrivateKey, setDeployerPrivateKey] = useState("");
  const [usdcAddress, setUsdcAddress] = useState("");
  const [forwarderAddress, setForwarderAddress] = useState("");
  /** Drives the escalated private key warning — see `PrivateKeyWarning`. */
  const [keyFocused, setKeyFocused] = useState(false);
  // Under the OS keychain there is no vault password to carry from step 2 —
  // the blockchain write is gated by the write authorization modal instead,
  // exactly as it is on the Configuration screen.
  const isKeychain = storeBackend === "os_keychain";
  const [authOpen, setAuthOpen] = useState(false);
  const [authEnrolled, setAuthEnrolled] = useState(false);

  // Step 5 — DocuSign.
  const [integrationKey, setIntegrationKey] = useState("");
  const [userId, setUserId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [baseUri, setBaseUri] = useState(DEFAULT_BASE_URI);
  const [jwtPrivateKey, setJwtPrivateKey] = useState("");
  const [environment, setEnvironment] = useState("sandbox");

  // Step 6 — notifications.
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [skipSms, setSkipSms] = useState(false);
  const [twilioSid, setTwilioSid] = useState("");
  const [twilioFrom, setTwilioFrom] = useState("");
  const [twilioToken, setTwilioToken] = useState("");

  useEffect(() => {
    // A failure here degrades to the create-a-vault copy, which is also what a
    // genuinely fresh install shows. `vaultUnlock` handles both cases either
    // way, so a wrong guess costs wording, never correctness.
    void backend
      .vaultStatus()
      .then((s) => setVaultExists(s.exists))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Decides which shape the write-auth modal takes: enrol a password on the
    // first blockchain save, confirm the existing one on any save after.
    if (!isKeychain) {
      setAuthEnrolled(false);
      return;
    }
    let cancelled = false;
    void backend.hasBlockchainWriteAuth().then((v) => {
      if (!cancelled) setAuthEnrolled(v);
    });
    return () => {
      cancelled = true;
    };
  }, [isKeychain]);

  const strength = passwordStrength(password);
  const matches = password.length > 0 && password === confirm;
  const canCreateVault = vaultExists
    ? password.length > 0
    : matches && strength !== "weak";

  /** Advance, recording that this step was configured rather than skipped. */
  const advance = (key?: SkippableStep) => {
    if (key) {
      setSkipped((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    setErr(null);
    setStep((s) => s + 1);
  };

  const skip = (key: SkippableStep) => {
    setSkipped((prev) => new Set(prev).add(key));
    setErr(null);
    setStep((s) => s + 1);
  };

  const back = () => {
    setErr(null);
    setStep((s) => Math.max(1, s - 1));
  };

  /** Run a save, surfacing its failure in place rather than advancing past it. */
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const createVault = () =>
    guard(async () => {
      // `vaultUnlock` creates the vault on its first call and unlocks it on
      // every call after — the same entry point Configuration uses, so a
      // wizard-created vault is byte-identical to one made from the settings
      // screen, and a re-run of this flow just opens the existing one.
      const result = await backend.vaultUnlock(password);
      if (!result.ok) {
        throw new Error(
          result.message ?? (vaultExists ? "Could not unlock the vault." : "Could not create the vault."),
        );
      }
      setVaultCreated(true);
      setConfirm("");
      advance();
    });

  const saveAi = () =>
    guard(async () => {
      await backend.vaultSetAi({
        providerName,
        endpoint,
        connectionType,
        apiKey: apiKey || undefined,
      });
      setApiKey("");
      advance("ai");
    });

  /**
   * The blockchain write, parameterised on which password confirms it.
   *
   * Returns an error message rather than throwing, because the write-auth
   * modal needs to distinguish "wrong password, stay open and retry" from
   * success — the same contract Configuration's write uses.
   */
  const writeBlockchain = async (confirmPassword: string): Promise<string | null> => {
    setBusy(true);
    setErr(null);
    try {
      await backend.setBlockchain(confirmPassword, {
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
      setAuthOpen(false);
      // A first write enrols the authorization password — a re-opened modal
      // in this same run must ask to confirm, not to set.
      if (isKeychain) setAuthEnrolled(true);
      advance("blockchain");
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      setBusy(false);
    }
  };

  const saveBlockchain = async () => {
    // Under the OS keychain there is no vault password to re-supply — the
    // write authorization modal collects the confirmation instead.
    if (isKeychain) {
      setErr(null);
      setAuthOpen(true);
      return;
    }
    // The vault password is re-supplied from step 2 rather than re-typed.
    // Configuration asks for it again because it is re-authorizing an
    // operator who may have walked away from an unlocked vault; here it was
    // entered ninety seconds ago by the same person, on the same flow.
    const message = await writeBlockchain(password);
    if (message) setErr(message);
  };

  const saveDocuSign = () =>
    guard(async () => {
      await backend.setDocuSign({
        integrationKey,
        userId,
        accountId,
        baseUri,
        jwtPrivateKey,
        environment,
      });
      setIntegrationKey("");
      setJwtPrivateKey("");
      advance("docusign");
    });

  const saveNotifications = () =>
    guard(async () => {
      await backend.vaultSetSmtp({
        host: smtpHost,
        port: smtpPort,
        username: smtpUsername,
        password: smtpPassword || undefined,
      });
      if (!skipSms && twilioSid) {
        await backend.vaultSetTwilio({
          accountSid: twilioSid,
          fromNumber: twilioFrom,
          authToken: twilioToken || undefined,
        });
      }
      setSmtpPassword("");
      setTwilioToken("");
      advance("notifications");
    });

  const prefillSepolia = () => {
    setNetworkName(SEPOLIA_DEFAULTS.networkName);
    setChainId(SEPOLIA_DEFAULTS.chainId);
    setRpcUrl(SEPOLIA_DEFAULTS.rpcUrl);
    setContractAddress(SEPOLIA_DEFAULTS.contractAddress);
    setUsdcAddress(SEPOLIA_DEFAULTS.usdcAddress);
    setForwarderAddress(SEPOLIA_DEFAULTS.forwarderAddress);
    // Deployer address and private key are deliberately untouched — one is the
    // operator's own wallet, and the other has no safe default to ship.
  };

  const backButton = (
    <button className="btn btn-ghost text-sm" onClick={back} disabled={busy}>
      ← Back
    </button>
  );

  // ── Step 1 — Welcome ──────────────────────────────────────────────────────

  if (step === 1) {
    return (
      <Shell
        step={1}
        footer={
          <button className="btn btn-primary btn-lg mx-auto" onClick={() => advance()}>
            Get Started →
          </button>
        }
      >
        <div className="text-center">
          <img
            src={emblem}
            alt="LexEscrow"
            width={200}
            height={200}
            className="mx-auto h-48 w-48 select-none"
            draggable={false}
          />
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-text-primary">
            Welcome to LexEscrow
          </h1>
          <p className="mt-2 text-sm font-medium uppercase tracking-[0.2em] text-gold">
            360° AI-Governed Escrow Platform
          </p>
          <p className="mx-auto mt-6 max-w-lg text-sm leading-relaxed text-text-muted">
            Before you begin, let's set up your secure credential vault. Your vault encrypts all API
            keys, blockchain credentials, and signing certificates with AES-256-GCM encryption.
            Nothing leaves your machine.
          </p>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            { icon: "🔐", title: "Sovereign", body: "All credentials encrypted locally. No cloud." },
            {
              icon: "⚖️",
              title: "AI-Governed",
              body: "Documents parsed, humans authorize, CRE executes.",
            },
            {
              icon: "🔗",
              title: "On-Chain",
              body: "Every document anchored. Every receipt verifiable.",
            },
          ].map((f) => (
            <div key={f.title} className="card p-4 text-center">
              <div className="text-2xl">{f.icon}</div>
              <div className="mt-1.5 text-sm font-semibold text-text-primary">{f.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-text-muted">{f.body}</div>
            </div>
          ))}
        </div>
      </Shell>
    );
  }

  // ── Step 2 — Vault password ───────────────────────────────────────────────

  if (step === 2) {
    // Under the OS keychain there is no vault and no password to choose. The
    // step is kept rather than removed so the numbering stays fixed at seven
    // and Back from step 3 lands somewhere coherent — but asking an operator
    // to invent a vault password moments after they picked "no vault password
    // required" would contradict the choice they just made.
    if (storeBackend === "os_keychain") {
      return (
        <Shell
          step={2}
          title="Credential Storage"
          subtitle="Your credentials go straight into the system keychain. Everything from here is optional."
          footer={
            <button className="btn btn-primary" onClick={() => advance()}>
              Continue →
            </button>
          }
        >
          <div className="card flex items-center gap-3 p-5">
            <span className="text-2xl">🔑</span>
            <div>
              <div className="text-sm font-semibold text-emerald-400">✅ OS Keychain in use</div>
              <div className="text-xs text-text-muted">
                Unlocked by your login session — no vault password to choose or remember.
              </div>
            </div>
          </div>
        </Shell>
      );
    }

    // Reached again by Back from step 3. The vault is open and re-running this
    // step would only ask for a password that has already been accepted, so it
    // reports its own outcome instead of re-offering the form.
    if (vaultCreated) {
      return (
        <Shell
          step={2}
          title={vaultExists ? "Vault Unlocked" : "Vault Created"}
          subtitle="Your credential vault is encrypted and unlocked. Everything from here is optional."
          footer={
            <button className="btn btn-primary" onClick={() => advance()}>
              Continue →
            </button>
          }
        >
          <div className="card flex items-center gap-3 p-5">
            <span className="text-2xl">🔐</span>
            <div>
              <div className="text-sm font-semibold text-emerald-400">
                {vaultExists ? "✅ Vault unlocked" : "✅ Vault created"}
              </div>
              <div className="text-xs text-text-muted">
                AES-256-GCM, keyed from the password you just entered.
              </div>
            </div>
          </div>
        </Shell>
      );
    }

    return (
      <Shell
        step={2}
        title={vaultExists ? "Unlock Your Vault" : "Create Your Vault Password"}
        subtitle={
          vaultExists
            ? "This install already has a vault. Enter its password to continue — the remaining steps write into it."
            : "This password encrypts all your credentials. Choose something strong — it cannot be recovered if lost."
        }
        footer={
          <button
            className="btn btn-gold btn-lg"
            disabled={busy || !canCreateVault}
            onClick={createVault}
          >
            {busy ? "Unlocking…" : vaultExists ? "Unlock Vault →" : "Create Vault →"}
          </button>
        }
      >
        <div className="card space-y-4 p-5">
          <Field id="wz-password" label="Vault password">
            <SecretInput id="wz-password" value={password} onChange={setPassword} />
          </Field>
          <Err msg={err} />

          {/* Strength, confirmation and the no-recovery warning are all about
              *choosing* a password. None of them applies to typing one that
              already exists and already protects real credentials. */}
          {vaultExists ? null : (
            <>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium text-text-muted">Strength</span>
                  <span
                    className={`text-xs font-semibold ${STRENGTH_UI[strength].text}`}
                    data-testid="strength-label"
                  >
                    {STRENGTH_UI[strength].label}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-input">
                  <div
                    data-testid="strength-bar"
                    data-strength={strength}
                    className={`h-full rounded-full transition-all ${STRENGTH_UI[strength].bar} ${STRENGTH_UI[strength].width}`}
                  />
                </div>
              </div>

              <Field id="wz-confirm" label="Confirm password">
                <SecretInput id="wz-confirm" value={confirm} onChange={setConfirm} />
              </Field>
              {confirm.length > 0 && !matches && (
                <p className="text-xs text-red-400">Passwords do not match.</p>
              )}

              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-400">
                ⚠️ Store this password somewhere safe. There is no recovery mechanism. Losing it
                means losing access to all stored credentials.
              </div>
            </>
          )}
        </div>
      </Shell>
    );
  }

  // ── Step 3 — AI provider ──────────────────────────────────────────────────

  if (step === 3) {
    return (
      <Shell
        step={3}
        title="Configure AI Provider"
        subtitle="LexEscrow uses AI to parse documents and extract structured data. Any OpenAI-compatible provider works — Claude, GPT-4o, Gemini, or a local Ollama instance."
        footer={
          <>
            {backButton}
            <button className="btn btn-primary" disabled={busy || !endpoint} onClick={saveAi}>
              Save &amp; Continue →
            </button>
            <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => skip("ai")}>
              Skip — Use Manual Entry →
            </button>
            <SkipNote>
              Without an AI provider, you can still use Manual Entry mode to process documents.
            </SkipNote>
          </>
        }
      >
        <div className="card space-y-4 p-5">
          <Field id="wz-ai-provider" label="Provider name">
            <input
              id="wz-ai-provider"
              list="wz-ai-providers"
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
              placeholder="Claude"
            />
            <datalist id="wz-ai-providers">
              {PROVIDER_SUGGESTIONS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field id="wz-ai-endpoint" label="Endpoint URL">
            <input
              id="wz-ai-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={connectionType === "websocket" ? "wss://…" : "https://…"}
            />
          </Field>
          <div>
            <span className="label">Connection type</span>
            <div className="flex gap-4 text-sm text-text-muted">
              {(["http", "websocket"] as const).map((ct) => (
                <label key={ct} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="wz-connection"
                    checked={connectionType === ct}
                    onChange={() => setConnectionType(ct)}
                  />
                  {ct === "http" ? "HTTP" : "WebSocket"}
                </label>
              ))}
            </div>
          </div>
          <Field id="wz-ai-key" label="API key">
            <SecretInput id="wz-ai-key" value={apiKey} onChange={setApiKey} placeholder="sk-…" />
          </Field>
          <Err msg={err} />
        </div>
      </Shell>
    );
  }

  // ── Step 4 — Blockchain ───────────────────────────────────────────────────

  if (step === 4) {
    return (
      <Shell
        step={4}
        title="Configure Blockchain Settlement"
        subtitle="LexEscrow settles escrow transactions on Ethereum via Chainlink CRE. Configure your Sepolia testnet credentials to enable on-chain settlement and AnchorReceipt registration."
        footer={
          <>
            {backButton}
            <button
              className="btn btn-primary"
              disabled={busy || !contractAddress}
              onClick={saveBlockchain}
            >
              Save &amp; Continue →
            </button>
            <button
              className="btn btn-ghost text-sm"
              disabled={busy}
              onClick={() => skip("blockchain")}
            >
              Use Demo Mode →
            </button>
            <SkipNote>
              In Demo Mode, settlements use mock transactions. Real on-chain settlement requires
              blockchain configuration.
            </SkipNote>
          </>
        }
      >
        <div className="card space-y-4 p-5">
          <PrivateKeyWarning expanded={keyFocused || !!deployerPrivateKey} />

          <WalletSetupGuide />

          <button className="btn btn-secondary btn-sm" onClick={prefillSepolia}>
            Use Sepolia Defaults
          </button>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field
                id="wz-bc-network"
                label="Network name"
                tooltip={BLOCKCHAIN_TOOLTIPS.networkName}
              >
                <input
                  id="wz-bc-network"
                  value={networkName}
                  onChange={(e) => setNetworkName(e.target.value)}
                />
              </Field>
            </div>
            <Field id="wz-bc-chain" label="Chain ID" tooltip={BLOCKCHAIN_TOOLTIPS.chainId}>
              <input
                id="wz-bc-chain"
                type="number"
                value={chainId}
                onChange={(e) => setChainId(parseInt(e.target.value, 10) || 0)}
              />
            </Field>
          </div>
          <Field
            id="wz-bc-rpc"
            label="RPC URL"
            hint="Treated as a secret — provider API keys ride in the URL path."
            tooltip={BLOCKCHAIN_TOOLTIPS.rpcUrl}
          >
            <SecretInput
              id="wz-bc-rpc"
              value={rpcUrl}
              onChange={setRpcUrl}
              placeholder="https://eth-sepolia.g.alchemy.com/v2/…"
            />
          </Field>
          <Field
            id="wz-bc-contract"
            label="Contract address"
            tooltip={BLOCKCHAIN_TOOLTIPS.contractAddress}
          >
            <input
              id="wz-bc-contract"
              className="font-mono text-xs"
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
              placeholder="0x…"
            />
          </Field>
          <Field
            id="wz-bc-deployer"
            label="Deployer wallet address"
            tooltip={BLOCKCHAIN_TOOLTIPS.deployerAddress}
          >
            <input
              id="wz-bc-deployer"
              className="font-mono text-xs"
              value={deployerAddress}
              onChange={(e) => setDeployerAddress(e.target.value)}
              placeholder="0x…"
            />
          </Field>
          <Field
            id="wz-bc-key"
            label="Deployer private key"
            tooltip={BLOCKCHAIN_TOOLTIPS.deployerPrivateKey}
          >
            <SecretTextarea
              id="wz-bc-key"
              value={deployerPrivateKey}
              onChange={setDeployerPrivateKey}
              onFocus={() => setKeyFocused(true)}
              onBlur={() => setKeyFocused(false)}
              placeholder="0x…"
            />
          </Field>
          <Field id="wz-bc-usdc" label="USDC address" tooltip={BLOCKCHAIN_TOOLTIPS.usdcAddress}>
            <input
              id="wz-bc-usdc"
              className="font-mono text-xs"
              value={usdcAddress}
              onChange={(e) => setUsdcAddress(e.target.value)}
              placeholder="0x…"
            />
          </Field>
          <Field
            id="wz-bc-forwarder"
            label="Forwarder address"
            tooltip={BLOCKCHAIN_TOOLTIPS.forwarderAddress}
          >
            <input
              id="wz-bc-forwarder"
              className="font-mono text-xs"
              value={forwarderAddress}
              onChange={(e) => setForwarderAddress(e.target.value)}
              placeholder="0x…"
            />
          </Field>
          <Err msg={err} />

          {authOpen && (
            <BlockchainWriteAuthModal
              enrolled={authEnrolled}
              busy={busy}
              onConfirm={writeBlockchain}
              onCancel={() => setAuthOpen(false)}
            />
          )}
        </div>
      </Shell>
    );
  }

  // ── Step 5 — DocuSign ─────────────────────────────────────────────────────

  if (step === 5) {
    return (
      <Shell
        step={5}
        title="Configure DocuSign eSign"
        subtitle="Enable electronic signatures — send documents for signature via email or let internal parties sign directly within LexEscrow."
        footer={
          <>
            {backButton}
            <button
              className="btn btn-primary"
              disabled={busy || !userId || !accountId || !baseUri}
              onClick={saveDocuSign}
            >
              Save &amp; Continue →
            </button>
            <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => skip("docusign")}>
              Skip →
            </button>
            <SkipNote>
              Signature conditions will need to be confirmed manually without DocuSign.
            </SkipNote>
          </>
        }
      >
        <div className="card space-y-4 p-5">
          <Field id="wz-ds-key" label="Integration Key">
            <SecretInput
              id="wz-ds-key"
              value={integrationKey}
              onChange={setIntegrationKey}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Field>
          <Field id="wz-ds-user" label="User ID">
            <input
              id="wz-ds-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="impersonation subject GUID"
            />
          </Field>
          <Field id="wz-ds-account" label="Account ID">
            <input
              id="wz-ds-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="DocuSign account GUID"
            />
          </Field>
          <Field id="wz-ds-uri" label="Base URI">
            <input
              id="wz-ds-uri"
              value={baseUri}
              onChange={(e) => setBaseUri(e.target.value)}
              placeholder={DEFAULT_BASE_URI}
            />
          </Field>
          <Field id="wz-ds-jwt" label="JWT Private Key (RSA PEM)">
            <SecretTextarea
              id="wz-ds-jwt"
              value={jwtPrivateKey}
              onChange={setJwtPrivateKey}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
            />
          </Field>
          <Field id="wz-ds-env" label="Environment">
            <select
              id="wz-ds-env"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          </Field>
          <p className="text-xs text-text-muted">
            Don't have DocuSign credentials yet? Create a free developer sandbox account at
            developers.docusign.com
          </p>
          <Err msg={err} />
        </div>
      </Shell>
    );
  }

  // ── Step 6 — Notifications ────────────────────────────────────────────────

  if (step === 6) {
    return (
      <Shell
        step={6}
        title="Configure Notifications"
        subtitle="LexEscrow notifies all parties after settlement via email and optional SMS."
        footer={
          <>
            {backButton}
            <button
              className="btn btn-primary"
              disabled={busy || !smtpHost}
              onClick={saveNotifications}
            >
              Save &amp; Continue →
            </button>
            <button
              className="btn btn-ghost text-sm"
              disabled={busy}
              onClick={() => skip("notifications")}
            >
              Skip →
            </button>
            <SkipNote>Post-settlement notifications will be disabled.</SkipNote>
          </>
        }
      >
        <div className="space-y-4">
          <div className="card space-y-4 p-5">
            <div className="text-sm font-semibold text-text-primary">Email (SMTP)</div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Field id="wz-smtp-host" label="Host">
                  <input
                    id="wz-smtp-host"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                  />
                </Field>
              </div>
              <Field id="wz-smtp-port" label="Port">
                <input
                  id="wz-smtp-port"
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(parseInt(e.target.value, 10) || 0)}
                />
              </Field>
            </div>
            <Field id="wz-smtp-user" label="Username">
              <input
                id="wz-smtp-user"
                value={smtpUsername}
                onChange={(e) => setSmtpUsername(e.target.value)}
              />
            </Field>
            <Field id="wz-smtp-pass" label="Password">
              <SecretInput id="wz-smtp-pass" value={smtpPassword} onChange={setSmtpPassword} />
            </Field>
          </div>

          <div className="card space-y-4 p-5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-text-primary">SMS — Twilio (optional)</div>
              <label className="flex items-center gap-1.5 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={skipSms}
                  onChange={(e) => setSkipSms(e.target.checked)}
                />
                Skip SMS
              </label>
            </div>
            {!skipSms && (
              <>
                <Field id="wz-tw-sid" label="Account SID">
                  <input
                    id="wz-tw-sid"
                    value={twilioSid}
                    onChange={(e) => setTwilioSid(e.target.value)}
                    placeholder="AC…"
                  />
                </Field>
                <Field id="wz-tw-from" label="From number">
                  <input
                    id="wz-tw-from"
                    value={twilioFrom}
                    onChange={(e) => setTwilioFrom(e.target.value)}
                    placeholder="+15550000000"
                  />
                </Field>
                <Field id="wz-tw-token" label="Auth token">
                  <SecretInput id="wz-tw-token" value={twilioToken} onChange={setTwilioToken} />
                </Field>
              </>
            )}
          </div>
          <Err msg={err} />
        </div>
      </Shell>
    );
  }

  // ── Step 7 — Ready ────────────────────────────────────────────────────────

  const rows: { key: string; icon: string; label: string; done: string; skippedLabel: string }[] = [
    { key: "vault", icon: "🔐", label: "Vault", done: "Created", skippedLabel: "" },
    {
      key: "ai",
      icon: "🤖",
      label: "AI Provider",
      done: "Configured",
      skippedLabel: "Skipped (Manual Entry mode)",
    },
    { key: "blockchain", icon: "🔗", label: "Blockchain", done: "Configured", skippedLabel: "Demo Mode" },
    { key: "docusign", icon: "✍️", label: "DocuSign", done: "Configured", skippedLabel: "Skipped" },
    {
      key: "notifications",
      icon: "📧",
      label: "Notifications",
      done: "Configured",
      skippedLabel: "Skipped",
    },
  ];

  return (
    <Shell
      step={7}
      title="LexEscrow is Ready"
      subtitle="You can update any of these settings at any time from the Configuration screen (⚙️ icon in the header)."
      footer={
        <button
          className="btn btn-primary btn-lg mx-auto"
          onClick={() => completeWizard()}
        >
          Start Using LexEscrow →
        </button>
      }
    >
      <div className="card divide-y divide-app-border">
        {rows.map((r) => {
          const wasSkipped = skipped.has(r.key);
          return (
            <div key={r.key} className="flex items-center justify-between gap-4 px-5 py-3">
              <div className="flex items-center gap-2.5 text-sm text-text-muted">
                <span>{r.icon}</span>
                <span>{r.label}</span>
              </div>
              <div className="text-right">
                <div
                  data-testid={`summary-${r.key}`}
                  className={`text-sm ${wasSkipped ? "text-amber-400" : "text-emerald-400"}`}
                >
                  {wasSkipped ? `⚠️ ${r.skippedLabel}` : `✅ ${r.done}`}
                </div>
                {wasSkipped && (
                  <div className="text-[11px] text-text-muted">Configure anytime in Settings ⚙️</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Shell>
  );
}
