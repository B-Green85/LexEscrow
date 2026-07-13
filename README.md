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
├── src/                     # React 18/19 + TypeScript frontend (Vite)
│   ├── lexguard/            # LexGuard Utility Suite (6 deterministic modules)
│   │   ├── types.ts         #   shared parsed-payload / execution-path types
│   │   ├── vdb.ts           #   session-scoped VDB store (prime / query / bind)
│   │   ├── artifact-guard.ts#   Tauri IPC bridge to Rust ArtifactGuard
│   │   ├── payload-diff.ts  #   BigInt integer-cents arithmetic + numeric diff
│   │   ├── anchor-matcher.ts#   proper-noun + bar-number matching
│   │   ├── anomaly-watcher.ts#  anomaly-suppression detection
│   │   └── scope-guard.ts   #   field-access whitelist enforcement
│   ├── screens/             # Five screens (Load, Processing, Review, Execute, Escalation)
│   ├── store/               # Zustand session store
│   └── components/          # Shared UI primitives
├── src-tauri/               # Rust backend (Tauri v2)
│   ├── src/
│   │   ├── artifact_guard.rs# SHA-256 hashing + UTF-8 normalization + final verify
│   │   ├── db.rs            #   SQLite (sqlx) — sessions, payloads, audit trail
│   │   ├── notify.rs        #   SMTP (lettre) + Twilio SMS (reqwest)
│   │   └── lib.rs           #   Tauri command registration
│   └── migrations/          # SQLite schema (3 tables, hash-chained audit trail)
└── cre/                     # Chainlink CRE workflow (bun + @chainlink/cre-sdk)
    ├── main.ts              #   two-handler pattern: onHTTPTrigger + onLogTrigger
    ├── workflow.yaml
    └── config.json
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

- **Desktop:** Tauri v2 (Rust backend + WebView), React + TypeScript, Vite,
  Tailwind CSS v4, Zustand
- **Backend:** Rust — `sha2`, `sqlx` (SQLite), `lettre` (SMTP), `reqwest` (Twilio)
- **Blockchain:** Chainlink CRE (TypeScript SDK), Functions, Price Feeds, CCIP
- **Notification:** SMTP + Twilio (post-settlement only)

## Prerequisites

- Node ≥ 20 and npm (frontend + Rust app)
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
cre workflow simulate ./cre --target local-simulation
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

## Tests

```bash
npm test                                              # LexGuard suite (31 tests)
cargo test --manifest-path src-tauri/Cargo.toml       # backend (16 tests)
cd cre && bun run typecheck                            # CRE workflow types
```

## Status

V1 implemented across all seven layers (Tauri scaffold, ArtifactGuard, SQLite +
hash-chained audit trail, LexGuard suite, CRE workflow, five-screen UI,
notification layer). See the product specification (`LexEscrow_Spec_v1.docx`)
for the complete design, edge-case analysis, and roadmap.

---

_CONFIDENTIAL — ALL RIGHTS RESERVED_
