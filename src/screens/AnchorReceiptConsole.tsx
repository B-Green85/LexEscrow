/**
 * Screen 8 — AnchorReceipt Console (spec §12).
 *
 * Standalone document fingerprinting, deliberately *outside* any escrow
 * workflow: load → SHA-256 → HMAC seal → register on-chain → receipt, plus an
 * always-available verify panel for receipts issued elsewhere.
 *
 * The four registration steps are shown as separate, individually-triggered
 * stages rather than one button. Each answers a different question ("are the
 * bytes what I think", "did LexEscrow attest that", "is it anchored publicly"),
 * and collapsing them would hide which guarantee the officer actually obtained.
 *
 * Split into a pure `AnchorReceiptConsoleView` and a store container, matching
 * Execution Confirmation and Condition Definition: the view takes all state as
 * props so it render-tests without a live store.
 */

import { useRef, useState } from "react";
import { useSession } from "../store/session";
import * as backend from "../lib/backend";
import {
  computeHmacSeal,
  downloadReceipt,
  issueReceipt,
  verifyReceiptFile,
  type AnchorReceipt,
  type ReceiptFileVerification,
} from "../lib/anchor-receipt";
import {
  AnchorReceiptCard,
  AnchorTxLink,
  ReceiptVerificationPanel,
  shortHash,
} from "../components/AnchorReceiptCard";
import { ASSET_CLASS_LIST, ASSET_CLASSES, type AssetClass } from "../lib/assetClasses";

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One numbered stage. Dimmed and non-interactive until its turn. */
function Step({
  index,
  title,
  done,
  active,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`card mt-4 p-5 ${active || done ? "" : "opacity-50"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
              done
                ? "bg-emerald-100 text-emerald-700"
                : active
                  ? "bg-brand-500 text-white"
                  : "bg-slate-200 text-slate-500"
            }`}
          >
            {done ? "✓" : index}
          </span>
          <span className="text-sm font-semibold text-slate-700">{title}</span>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-slate-100 pt-2.5 first:border-0 first:pt-0">
      <span className="shrink-0 text-sm text-slate-500">{label}</span>
      <span className="min-w-0 break-all text-right">{children}</span>
    </div>
  );
}

// ── Pure view ────────────────────────────────────────────────────────────────

export interface AnchorReceiptConsoleViewProps {
  /** Registration flow */
  file: File | null;
  artifact: backend.LoadedArtifact | null;
  hmac: string | null;
  assetClass: AssetClass;
  receipt: AnchorReceipt | null;
  registeredAt: string | null;
  busy: boolean;
  error: string | null;
  copied: boolean;
  onSelectFile: (file: File | null) => void;
  onSetAssetClass: (cls: AssetClass) => void;
  onComputeSeal: () => void;
  onRegister: () => void;
  onDownload: () => void;
  onCopyHash: () => void;
  /** Verify flow — independent of everything above */
  verifyFile: File | null;
  verifyResult: ReceiptFileVerification | null;
  verifyError: string | null;
  verifyBusy: boolean;
  onSelectVerifyFile: (file: File | null) => void;
  onVerify: () => void;
  onClose: () => void;
}

export function AnchorReceiptConsoleView(props: AnchorReceiptConsoleViewProps) {
  const {
    file,
    artifact,
    hmac,
    assetClass,
    receipt,
    registeredAt,
    busy,
    error,
    copied,
    verifyFile,
    verifyResult,
    verifyError,
    verifyBusy,
  } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const verifyInputRef = useRef<HTMLInputElement>(null);

  const hashed = Boolean(artifact);
  const sealed = Boolean(hmac);
  const registered = Boolean(receipt);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">AnchorReceipt Console</h1>
          <p className="mt-1 text-sm text-slate-500">
            Standalone document integrity registration — fingerprint, seal, register, and verify
            documents outside of an escrow workflow.
          </p>
        </div>
        <button className="btn btn-secondary shrink-0" onClick={props.onClose}>
          Close
        </button>
      </div>

      {/* ── Step 1 — Load Document ── */}
      <Step index={1} title="Load Document" done={hashed} active>
        <div
          onClick={() => inputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40"
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md,text/plain"
            className="hidden"
            aria-label="Document to fingerprint"
            onChange={(e) => props.onSelectFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div>
              <div className="text-sm font-semibold text-slate-800">{file.name}</div>
              <div className="mt-0.5 text-xs text-slate-500">
                {bytesLabel(file.size)} · click to replace
              </div>
            </div>
          ) : (
            <div>
              <div className="text-sm font-medium text-slate-600">Click to select a document</div>
              <div className="mt-0.5 text-xs text-slate-400">.pdf, .docx, .txt, .md</div>
            </div>
          )}
        </div>

        {artifact && (
          <div className="mt-4 space-y-2.5">
            <Row label="Filename">
              <span className="text-sm text-slate-700">{artifact.filename}</span>
            </Row>
            <Row label="Size">
              <span className="text-sm text-slate-700">{bytesLabel(artifact.size)}</span>
            </Row>
            <Row label="SHA-256">
              <span className="font-mono text-xs text-slate-800" data-selectable>
                {artifact.hash}
              </span>
            </Row>
            <Row label="Status">
              <span className="badge badge-emerald">✅ Hashed</span>
            </Row>
          </div>
        )}
      </Step>

      {/* ── Step 2 — HMAC Seal ── */}
      {hashed && (
        <Step index={2} title="HMAC Seal" done={sealed} active={!sealed}>
          <p className="text-xs text-slate-500">
            The HMAC seal proves this system attested this exact fingerprint. The raw hash proves
            bytes are unchanged; the seal proves LexEscrow attested it.
          </p>
          {hmac ? (
            <div className="mt-4 space-y-2.5">
              <Row label="Seal (HMAC-SHA256)">
                <span className="font-mono text-xs text-slate-800" data-selectable>
                  {shortHash(hmac, 16, 8)}
                </span>
              </Row>
              <Row label="Status">
                <span className="badge badge-emerald">✅ Sealed</span>
              </Row>
            </div>
          ) : (
            <button
              className="btn btn-primary mt-4"
              disabled={busy}
              onClick={props.onComputeSeal}
            >
              {busy ? "Sealing…" : "Compute Seal"}
            </button>
          )}
        </Step>
      )}

      {/* ── Step 3 — Register On-Chain ── */}
      {sealed && (
        <Step index={3} title="Register On-Chain" done={registered} active={!registered}>
          {registered ? (
            <div className="space-y-2.5">
              <Row label="Asset class">
                <span className="text-sm text-slate-700">
                  {ASSET_CLASSES[assetClass].icon} {ASSET_CLASSES[assetClass].displayName}
                </span>
              </Row>
              <Row label="Registration tx">
                <AnchorTxLink hash={receipt?.items[0]?.onChainTx} />
              </Row>
              <Row label="Registered at">
                <span className="text-sm text-slate-700">
                  {registeredAt ? new Date(registeredAt).toLocaleString() : "—"}
                </span>
              </Row>
              <Row label="Status">
                <span className="badge badge-emerald">✅ Registered</span>
              </Row>
            </div>
          ) : (
            <>
              <label className="label" htmlFor="anchor-asset-class">
                Asset class
              </label>
              <select
                id="anchor-asset-class"
                className="input"
                value={assetClass}
                onChange={(e) => props.onSetAssetClass(e.target.value as AssetClass)}
              >
                {ASSET_CLASS_LIST.map((cls) => (
                  <option key={cls} value={cls} className="bg-[#1A2435] text-[#F8FAFC]">
                    {ASSET_CLASSES[cls].icon} {ASSET_CLASSES[cls].displayName}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary mt-4" disabled={busy} onClick={props.onRegister}>
                {busy ? "Registering…" : "Register"}
              </button>
            </>
          )}
        </Step>
      )}

      {/* ── Step 4 — Receipt ── */}
      {receipt && (
        <Step index={4} title="Receipt" done active>
          <AnchorReceiptCard
            receipt={receipt}
            heading="Portable AnchorReceipt"
            onDownload={props.onDownload}
            actions={
              <button className="btn btn-secondary" onClick={props.onCopyHash}>
                {copied ? "Copied ✓" : "Copy Receipt Hash"}
              </button>
            }
          />
        </Step>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Step 5 — Verify (independent, always visible) ── */}
      <div className="card mt-8 p-5">
        <div className="text-sm font-semibold text-slate-700">Verify an Existing Receipt</div>
        <p className="mt-1 text-xs text-slate-500">
          Recomputes the receipt hash from the file's own contents. No database lookup, no network
          call — a counterparty can run this check with nothing but the JSON.
        </p>

        <div
          onClick={() => verifyInputRef.current?.click()}
          className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40"
        >
          <input
            ref={verifyInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Receipt JSON to verify"
            onChange={(e) => props.onSelectVerifyFile(e.target.files?.[0] ?? null)}
          />
          {verifyFile ? (
            <div className="text-sm font-semibold text-slate-800">{verifyFile.name}</div>
          ) : (
            <div>
              <div className="text-sm font-medium text-slate-600">Select a receipt JSON file</div>
              <div className="mt-0.5 text-xs text-slate-400">anchor-receipt-….json</div>
            </div>
          )}
        </div>

        <button
          className="btn btn-primary mt-4"
          disabled={!verifyFile || verifyBusy}
          onClick={props.onVerify}
        >
          {verifyBusy ? "Verifying…" : "Verify"}
        </button>

        <ReceiptVerificationPanel result={verifyResult} error={verifyError} />

        {verifyResult && (
          <div className="mt-4 space-y-2.5 border-t border-slate-100 pt-4">
            <Row label="Receipt ID">
              <span className="font-mono text-sm text-slate-800" data-selectable>
                {shortHash(verifyResult.receipt.receiptId, 8, 4)}
              </span>
            </Row>
            <Row label="Issued at">
              <span className="text-sm text-slate-700">
                {verifyResult.receipt.issuedAt
                  ? new Date(verifyResult.receipt.issuedAt).toLocaleString()
                  : "—"}
              </span>
            </Row>
            <Row label="Asset class">
              <span className="text-sm text-slate-700">
                {ASSET_CLASSES[verifyResult.receipt.assetClass]
                  ? `${ASSET_CLASSES[verifyResult.receipt.assetClass].icon} ${
                      ASSET_CLASSES[verifyResult.receipt.assetClass].displayName
                    }`
                  : String(verifyResult.receipt.assetClass)}
              </span>
            </Row>
            <Row label="Documents verified">
              <span className="text-sm text-slate-700">
                {verifyResult.receipt.summary?.verifiedCount ?? 0} of{" "}
                {verifyResult.receipt.summary?.totalCount ?? 0}
              </span>
            </Row>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Store container ──────────────────────────────────────────────────────────

export function AnchorReceiptConsole() {
  const { closeConfig, operator } = useSession();

  const [file, setFile] = useState<File | null>(null);
  const [artifact, setArtifact] = useState<backend.LoadedArtifact | null>(null);
  const [hmac, setHmac] = useState<string | null>(null);
  const [assetClass, setAssetClass] = useState<AssetClass>("legal");
  const [receipt, setReceipt] = useState<AnchorReceipt | null>(null);
  const [registeredAt, setRegisteredAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [verifyFile, setVerifyFile] = useState<File | null>(null);
  const [verifyResult, setVerifyResult] = useState<ReceiptFileVerification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  /** A new document invalidates every downstream stage — the seal and the
   *  registration belong to the bytes that produced them, not to the screen. */
  const onSelectFile = async (next: File | null) => {
    setFile(next);
    setArtifact(null);
    setHmac(null);
    setReceipt(null);
    setRegisteredAt(null);
    setError(null);
    setCopied(false);
    if (!next) return;

    setBusy(true);
    try {
      const bytes = new Uint8Array(await next.arrayBuffer());
      setArtifact(await backend.loadArtifact(next.name, bytes));
    } catch (e) {
      setError(`Hashing failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onComputeSeal = async () => {
    if (!artifact) return;
    setBusy(true);
    setError(null);
    try {
      setHmac(await computeHmacSeal(artifact.hash, artifact.size));
    } catch (e) {
      setError(`Seal computation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onRegister = async () => {
    if (!artifact || !hmac) return;
    setBusy(true);
    setError(null);
    try {
      // A standalone registration still gets a session row: the fingerprint
      // registry is foreign-keyed to one, and the audit trail for a Console
      // registration has to live somewhere addressable. It never enters the
      // escrow workflow — no payload, no execution path, no settlement.
      const sessionId = `anchor-${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16)}`;
      await backend.createSession({
        sessionId,
        clientId: "standalone",
        attorneyBarNumber: "",
        documentHash: artifact.hash,
        assetClass,
      });
      await backend.logEvent(
        sessionId,
        "anchor_console_document_loaded",
        operator,
        JSON.stringify({ filename: artifact.filename, hash: artifact.hash, size: artifact.size }),
      );

      const issued = await issueReceipt({
        sessionId,
        assetClass,
        items: [{ label: artifact.filename, hash: artifact.hash, size: artifact.size }],
      });
      setReceipt(issued);
      setRegisteredAt(issued.items[0]?.registeredAt ?? issued.issuedAt);

      await backend.logEvent(
        sessionId,
        "anchor_receipt_issued",
        operator,
        JSON.stringify({
          standalone: true,
          receipt_id: issued.receiptId,
          on_chain_tx: issued.items[0]?.onChainTx ?? null,
          hmac: issued.items[0]?.hmac ?? null,
          receipt_hash: issued.receiptHash,
        }),
      );
    } catch (e) {
      setError(`Registration failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const onCopyHash = async () => {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(receipt.receiptHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy to the clipboard — select the hash and copy it manually.");
    }
  };

  const onVerify = async () => {
    if (!verifyFile) return;
    setVerifyBusy(true);
    setVerifyResult(null);
    setVerifyError(null);
    try {
      setVerifyResult(await verifyReceiptFile(verifyFile));
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifyBusy(false);
    }
  };

  return (
    <AnchorReceiptConsoleView
      file={file}
      artifact={artifact}
      hmac={hmac}
      assetClass={assetClass}
      receipt={receipt}
      registeredAt={registeredAt}
      busy={busy}
      error={error}
      copied={copied}
      onSelectFile={(f) => void onSelectFile(f)}
      onSetAssetClass={setAssetClass}
      onComputeSeal={() => void onComputeSeal()}
      onRegister={() => void onRegister()}
      onDownload={() => receipt && downloadReceipt(receipt)}
      onCopyHash={() => void onCopyHash()}
      verifyFile={verifyFile}
      verifyResult={verifyResult}
      verifyError={verifyError}
      verifyBusy={verifyBusy}
      onSelectVerifyFile={(f) => {
        setVerifyFile(f);
        setVerifyResult(null);
        setVerifyError(null);
      }}
      onVerify={() => void onVerify()}
      // `closeConfig` returns to `prevScreen`, which the Console's open action
      // sets the same way Configuration does.
      onClose={() => closeConfig()}
    />
  );
}
