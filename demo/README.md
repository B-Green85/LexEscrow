# LexEscrow Demo Suite

Complete end-to-end demonstration of all platform capabilities, running fully
offline against local mock adapters.

## Quick Start

```bash
# 1. Start everything (mock adapters + app in demo mode)
bash demo/scripts/run_demo.sh

# 2. Load demo documents
# In the app: click Load Folder → select demo/documents/

# 3. Reset between runs
bash demo/scripts/reset_demo.sh
```

To run the adapters on their own (useful when the app is already running):

```bash
npm run demo          # mock adapters only
npm run dev:demo      # Vite in demo mode, no Tauri shell
```

## What Demo Mode Changes

`--mode demo` (or `VITE_DEMO_MODE=true`) swaps only the **external seams**:

- eSign goes to `MockDocuSignProvider` instead of the DocuSign REST API
- adapters point at `localhost:3001/3002/3003`
- AnchorReceipt on-chain registration uses the mock tx format

Everything between those seams — ArtifactGuard hashing, the LexGuard pipeline,
the hash-chained audit trail, the condition engine, the three release paths —
runs the production code path unchanged. A demo that took a different route
through the workflow would not be demonstrating the product.

## What the Demo Shows

### Seven Asset Classes

Loading `demo/documents/` puts all seven asset classes in the batch dashboard
simultaneously. Each sub-folder name maps to its asset class automatically.

### Live AI Parsing

Documents parse concurrently. LexGuard validates each payload. Six intentional
anomalies fire across the batch — one per class except cannabis, which is a
clean happy path.

### Intentional Anomalies

| Asset Class  | Anomaly Type                  | LexGuard Module     |
| ------------ | ----------------------------- | ------------------- |
| Legal        | Arithmetic drift ($450)       | payload-diff        |
| Real Estate  | Name mismatch (Whitfeld)      | anchor-matcher      |
| Business     | EUR vs USD currency           | Price Feed trigger  |
| IP           | Anomaly suppression (4%/4.5%) | anomaly-watcher     |
| Art          | Zero-width space              | Hidden char strip   |
| Natural Res. | Scope violation attempt       | scope-guard         |
| Cannabis IND | Clean — happy path            | All PASS            |

Each anomaly is planted so the document reads as ordinary: nothing in the text
flags it. The detection has to come from the pipeline, not from a hint.

### CannaVerify

The cannabis row runs live against the mock Metrc adapter (port 3002).
License active: PASS, compliance holds: 0, inventory confirmed.

### DocuSign eSign

Send for Signature → the mock adapter completes the envelope in ~30 seconds.
Sign Here → the embedded signing panel opens in-app.

### AnchorReceipt

Every document is fingerprinted, sealed and registered. Download the receipt
JSON and verify it independently:

```bash
npx tsx demo/scripts/verify_receipt.ts <receipt.json>
```

The verifier imports nothing from `src/` — it is the offline check a
counterparty would run, so it re-implements the canonicalization rather than
sharing it.

### Settlement

- **Path A** — Legal demo settles directly.
- **Path B** — Business demo demonstrates arbitration multi-sig (2-of-3).
- **Path C** — IP demo demonstrates milestone staged release.

### Audit Report Export

From the settlement screen: **Audit report (PDF)** opens a print-ready report of
the full hash-chained trail — chain verification banner, colour-coded events,
expandable payloads. **JSON** exports the machine-readable extract.

### Practice-Management Webhooks

Configure Clio or PracticePanther under Configuration → Integrations, and the
six lifecycle events (`session.created`, `review.approved`, `funds.deposited`,
`conditions.met`, `settlement.complete`, `receipt.issued`) are forwarded as they
occur. Delivery is best-effort — a failed webhook never blocks a settlement.

## Mock Adapters

| Adapter  | Port | What it simulates              |
| -------- | ---- | ------------------------------ |
| CA Bar   | 3001 | California State Bar lookup    |
| Metrc    | 3002 | Cannabis regulatory API        |
| DocuSign | 3003 | DocuSign eSignature REST API   |

`reset_demo.sh` also clears the DocuSign adapter's envelope state via
`POST /reset`, so a second run does not inherit the first run's envelopes.

## Demo Data Policy

All demo documents use entirely fictional data. No real persons, firms,
addresses, bar numbers, license numbers, or identifying information. Every
email is `@example.com`; every document carries a "FICTIONAL PARTIES — NOT A
LEGAL INSTRUMENT" banner.

## Verification

After settlement, verify the on-chain registration at:

https://sepolia.etherscan.io/address/0x6f532f0eefc61a5792ad211850a8b48fbc388674

## Troubleshooting

**Adapters won't start** — ports 3001–3003 may already be bound. Check with
`lsof -i :3001` and stop the previous run.

**Database not found** — launch LexEscrow once so it initializes
`lexescrow.db`, then re-run `reset_demo.sh`.

**Registration unavailable during processing** — the AnchorReceipt seal key
lives in the credential vault, so the vault must be unlocked before a document
can be registered. Unlock it under Configuration.
