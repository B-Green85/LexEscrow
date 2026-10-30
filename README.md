# LexEscrow

**AI-Governed Legal Retainer Release** — a desktop application that automates the
legal retainer release process using AI document parsing, deterministic
**LexGuard** integrity validation, and **Chainlink CRE** for trustless on-chain
settlement.

> AI parses. LexGuard validates. Humans decide. CRE executes.

Built for the BLI Legal Tech Hackathon 2.

---

## Design philosophy

AI should never have unilateral executive authority over irreversible legal
financial transactions. Every layer has one job:

| Layer        | Responsibility                                                        |
| ------------ | -------------------------------------------------------------------- |
| **AI**       | Cognitive labor — read unstructured legal prose → structured data     |
| **LexGuard** | Integrity work — deterministically validate AI output vs. the source  |
| **Human**    | Executive action — review validated output and authorize execution    |
| **CRE**      | Trustless execution — atomic, cryptographically proven settlement      |

## Architecture

```
LexEscrow/
├── src/                     # React 19 + TypeScript frontend (Vite)
│   ├── lexguard/            # LexGuard Utility Suite (6 deterministic modules)
│   │   ├── index.ts         #   barrel export
│   │   ├── types.ts         #   shared parsed-payload / execution-path types
│   │   ├── vdb.ts           #   session-scoped VDB store (prime / query / bind)
│   │   ├── artifact-guard.ts#   Tauri IPC bridge to Rust ArtifactGuard
│   │   ├── payload-diff.ts  #   BigInt integer-cents arithmetic + numeric diff
│   │   ├── anchor-matcher.ts#   proper-noun + bar-number matching
│   │   ├── anomaly-watcher.ts#  anomaly-suppression detection
│   │   ├── scope-guard.ts   #   field-access whitelist enforcement
│   │   └── pipeline.ts      #   async co-validation + AI nudge loop
│   ├── lib/                 # backend bridge, AI providers, browser vault fallback
│   │   ├── ai/              #   model-agnostic providers (HTTP / WebSocket / local)
│   │   ├── adapters/        #   bar-verification adapter
│   │   ├── cannaverify/     #   Metrc license / inventory / transfer compliance
│   │   ├── conditions/      #   release-condition builder
│   │   ├── esign/           #   eSignProvider (DocuSign + mock)
│   │   ├── export/          #   audit-report PDF export
│   │   ├── integrations/    #   Clio / PracticePanther webhooks
│   │   ├── releasePaths/    #   staged + arbitration release paths
│   │   ├── backend.ts       #   Tauri-or-browser bridge (incl. vault + AI transport)
│   │   ├── browserVault.ts  #   Web-Crypto AES-GCM + PBKDF2 fallback vault
│   │   ├── aiParse.ts       #   deterministic heuristic parser (local provider)
│   │   ├── anchor-receipt.ts#   AnchorReceipt fingerprint + seal
│   │   ├── clio.ts          #   Clio matter intake
│   │   └── suggest-anchors.ts#  trust-anchor suggestions from document text
│   ├── screens/             # Twelve screens (Load, Processing, Review, Execute, Escalation, Configuration, Batch,
│   │                        #   Setup Wizard, Condition Definition, Escrow Monitor, Recent Workflows, AnchorReceipt Console)
│   ├── store/               # Zustand session + batch stores
│   ├── components/          # Shared UI primitives
│   ├── mock/                # DocuSign / Metrc mock adapters
│   └── stress/              # LexGuard stress harness
├── src-tauri/               # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── artifact_guard.rs# SHA-256 hashing + UTF-8 normalization + final verify
│   │   ├── db.rs            #   SQLite (sqlx) — sessions, payloads, audit trail
│   │   ├── vault.rs         #   AES-256-GCM credential vault (scrypt KDF)
│   │   ├── credential_store.rs# vault vs OS keychain backend (store_config.rs picks)
│   │   ├── blockchain_write_auth.rs# write-auth gate for the deployer key
│   │   ├── ai.rs            #   AI transport (HTTP + WebSocket) — secret stays in core
│   │   ├── extractor.rs     #   document text extraction
│   │   ├── bar_verify.rs    #   attorney bar verification (Apify)
│   │   ├── anchor.rs        #   AnchorReceipt registration on AnchorRegistry
│   │   ├── cre.rs           #   CRE workflow config from the vault
│   │   ├── cre_trigger.rs   #   signed HTTPTrigger to the deployed workflow
│   │   ├── debug_console.rs #   LexTrace read-only CRE debug console
│   │   ├── docusign.rs      #   DocuSign eSignature
│   │   ├── esign_callback.rs#   embedded-signing return-URL listener
│   │   ├── clio.rs          #   Clio Manage OAuth matter intake
│   │   ├── integrations.rs  #   practice-management webhook delivery
│   │   ├── notify.rs        #   SMTP (lettre) + Twilio SMS (reqwest), vault-backed
│   │   ├── menu.rs          #   native application menu
│   │   ├── main.rs
│   │   └── lib.rs           #   Tauri command registration
│   └── migrations/          # SQLite schema (5 migrations, 10 tables, hash-chained audit trail)
├── cre/                     # Chainlink CRE workflow (bun + @chainlink/cre-sdk)
│   ├── main.ts              #   two-handler pattern: onHTTPTrigger + onLogTrigger
│   ├── workflow.yaml
│   ├── project.yaml
│   ├── config.json.example
│   └── secrets.yaml.example
├── lexescrow-cw/            # Confidential Workflow (TEE re-parse + HMAC-sealed verdict)
├── contracts/               # Solidity RetainerRelease receiver (Chainlink CRE)
│   ├── src/RetainerRelease.sol  # directSettle / lockArbitration / 2-of-3 resolve
│   ├── src/AnchorRegistry.sol   # anchor(bytes32) — Sepolia 0x0906Be060A47B3A44A3Ae42707c7538dBB0451Fb
│   ├── interfaces/          #   IReceiver, IERC165, ReceiverTemplate
│   ├── abi/                 #   generated RetainerRelease ABI
│   ├── DEPLOYMENT.md        #   deployed addresses + on-chain test record
│   └── 1_deploy.ts … 5_testStaged.ts  # viem deploy + fund + test scripts
└── demo/                    # offline demo suite (documents, mock adapters, scripts)
```

## Core invariants

- **All money is integer cents.** No floating-point in any financial operation.
  Validation runs on `BigInt` cents; SQLite stores cents as `INTEGER`. Dollars
  are reconstructed for display only.
- **Artifacts are ground truth.** SHA-256 hashed in Rust on load; a final
  blocking re-verify runs the instant *Proceed to Execution* is pressed.
- **Text is normalized before extraction.** UTF-8 normalization strips control /
  zero-width / BOM / soft-hyphen characters in the Rust backend before AI or
  LexGuard touch the text.
- **The audit trail is append-only and hash-chained.** Each entry's hash covers
  the previous entry's hash; tampering breaks the chain from that point forward.

## Tech stack

- **Desktop:** Tauri v2 (Rust backend + WebView), React 19 + TypeScript, Vite,
  Tailwind CSS v4, Zustand
- **Backend:** Rust — `sha2`, `sqlx` (SQLite), `lettre` (SMTP), `reqwest` (Twilio)
- **Blockchain:** Chainlink CRE (TypeScript SDK), Functions, Price Feeds
- **Notification:** SMTP + Twilio (post-settlement only)

## Prerequisites

- Node ≥ 20.19 and npm (frontend + Rust app)
- Rust stable + Cargo (Tauri backend)
- [bun](https://bun.com/docs/installation) (CRE workflow only)
- Chainlink CRE CLI (for workflow simulate / deploy)

## Development

```bash
npm install            # install frontend deps
npm run dev            # Vite dev server only (browser)
npm run tauri dev      # full desktop app (Rust + WebView)
npm run build          # typecheck + production frontend build
npm test               # LexGuard unit tests (Vitest)

# CRE workflow
cd cre && bun install
cre workflow simulate . --target local-simulation
```

### Notifications

Copy `.env.example` to `.env` and fill in SMTP and/or Twilio credentials. A
channel left unconfigured is reported as `skipped` (and recorded as such in the
audit log), so the app runs fine without them. Notifications fire only after CRE
confirms settlement.

### Running in the browser

The UI degrades gracefully outside Tauri: `npm run dev` serves it in a plain
browser with Web-Crypto hashing, a JS port of the normalizer, and an in-memory
hash-chained audit log. The Document Load screen has one-click **sample**
documents — "Clean retainer" flows through to settlement; "Discrepancy" trips a
LexGuard escalation.

## Credential vault & AI providers

Credentials live in an **AES-256-GCM encrypted vault** (`credentials.vault` in
the Tauri app data dir — never the project root). The key is derived with
**scrypt**; a wrong password fails the GCM auth tag on decrypt. Decrypted
contents stay in backend memory only, the derived key is zeroized on lock, and
writes are atomic (temp + rename, mode 0600). Manage it on the **Configuration**
screen (the gear icon). Only secret-free public metadata crosses IPC — stored
secrets are write-only from the UI. The vault holds three groups: **AI provider**
(name, endpoint, connection type, API key), **SMTP**, and **Twilio**; notifications
prefer vault credentials over environment variables.

Document parsing is **model-agnostic** via the `AIParserProvider` interface. The
provider is resolved at runtime from the vault's AI metadata — `connection_type`
selects `HTTPProvider` vs `WebSocketProvider` (no model or provider is
hardcoded), and the endpoint + API key are pulled from the vault *inside the Rust
core* at parse time, so the WebView never sees the key. The model receives a
system prompt instructing it to return **only** a JSON object of integer-cent
fields; the response is validated with a Zod schema (`AiExtractionSchema` in
`lexguard/types.ts`), retried once on failure, then converted cents→dollars into
`ParsedRetainerPayload`. LexGuard then co-validates — the VDB cross-reference and
five modules run, and numeric discrepancies are **nudged back to the same
provider** (up to three times) before escalating to the user.

A configured, unlocked provider is required to parse: a locked vault prompts to
unlock, a missing provider redirects to Configuration, and network / unparseable
responses surface a plain-English error without proceeding. The endpoint is a
parse adapter or compatible API accepting `{model, system, user, messages}` and
returning the JSON object (Anthropic / OpenAI response shapes are also
tolerated).

> Outside Tauri, the vault falls back to a Web-Crypto AES-GCM vault using PBKDF2
> (the browser analogue of scrypt) persisted to localStorage, so the vault and
> provider flow are demoable in a plain browser.

## Manual entry & batch processing

**Manual entry.** The Processing screen offers an entry-mode toggle before
parsing — *AI Parse* or *Manual Entry*. Manual entry skips AI and shows a
structured form for every `ParsedRetainerPayload` field (money entered as dollars,
stored/validated as integer cents). On submit, the **full LexGuard pipeline runs
against the typed payload exactly as it would against AI output** — arithmetic,
anchor matching, anomaly-suppression, scope, and VDB cross-reference — and routes
to the same forced-acknowledgment review or an escalation. The audit log records
`entry_mode: "manual"` vs `"ai"`. LexGuard does not trust AI or humans blindly.

**Batch processing** (7th screen, folder icon). Load a folder of retainer
documents; up to **3 parse concurrently**. Each document gets its own
ArtifactGuard hash and its own SQLite session (audit entries carry a shared
`batch_id`), and LexGuard validates each independently — clean → **Parsed**,
discrepancy → **Flagged**. A summary bar shows *X ready | Y flagged | Z pending*;
**Review** opens the standard single-document review for that retainer, and a
settled row shows its transaction hash inline. Entry mode is per-document
(default AI; switch a row to Manual). The batch summary exports as CSV. Batch uses
the same credential vault for the AI provider across all documents (falling back
to the local parser when none is configured).

## On-chain settlement

The CRE workflow writes a signed report to the **`RetainerRelease`** Solidity
receiver (`contracts/src/RetainerRelease.sol`), which settles in USDC on Ethereum
Ethereum Sepolia — Path A pays client + firm atomically, Path B locks the total for a
2-of-3 arbitration release. It implements the CRE `IReceiver` interface (via
`ReceiverTemplate`), and the report tuple decoded on chain matches the workflow's
`encodeAbiParameters` exactly. All amounts are USDC base units — no floats on
chain. See `contracts/README.md` for compile / deploy / test steps.

## Tests

```bash
npm test                                              # frontend suite (977 tests)
cargo test --manifest-path src-tauri/Cargo.toml       # backend (295 tests)
cd cre && bun run typecheck                            # CRE workflow types
```

## Status

V1 implemented across all seven layers (Tauri scaffold, ArtifactGuard, SQLite +
hash-chained audit trail, LexGuard suite, CRE workflow, five-screen UI,
notification layer). See the product specification (`LexEscrow_Platform_Spec_Complete.docx`)
for the complete design, edge-case analysis, and roadmap.

---

© 2026 ProvenyxRD. Licensed under the GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).
