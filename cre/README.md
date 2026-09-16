# LexEscrow — CRE Workflow

Chainlink CRE TypeScript workflow for LexEscrow. Two handlers:

- **`onHTTPTrigger`** — receives a LexGuard-validated retainer payload from the
  desktop app, verifies the attorney's CA State Bar status (Chainlink
  Functions), converts USD → USDC, and writes a signed settlement report to the
  `RetainerRelease` receiver contract (Path A direct settlement or Path B
  arbitration escrow).
- **`onLogTrigger`** — catches the on-chain `RetainerReleased` event and POSTs
  settlement details to the notification endpoint (triggers client email / SMS).

## Setup

```bash
cd cre
bun install
cp .env.example .env          # add a private key (dummy is fine for read-only sims)
cp config.json.example config.json   # fill in your adapter/contract addresses
```

Edit `project.yaml` with your Ethereum Sepolia RPC URL.

## Typecheck

```bash
bun run typecheck
```

## Simulate

From this directory:

```bash
cre workflow simulate . --target local-simulation
```

`http_trigger_payload.json` contains a sample validated payload (integer-cent
strings, 32-byte document hash) shaped exactly as the desktop app posts it.

### Full end-to-end run (HTTP trigger + mock bar adapter)

`onHTTPTrigger` verifies the attorney against `barVerifyUrl` before anything
else. That endpoint must return HTTP 200 for an active licensee and a non-2xx
status otherwise; point `config.json` at one before simulating:

```bash
# 1) config.json → "barVerifyUrl": "https://registry.example.com/verify/"
# 2) run the HTTP trigger (index 1) with the validated payload, broadcasting:
cre workflow simulate . --broadcast --target local-simulation \
  --non-interactive --trigger-index 1 \
  --http-payload ./http_trigger_payload.json --env ./.env
```

This has been verified on Sepolia end-to-end: attorney verified → USD→USDC →
signed report → `writeReport` through the KeystoneForwarder → `RetainerSettled`
emitted, escrow drained. In production the mock is replaced by the real
Chainlink Functions call to the CA State Bar portal.

## Where configuration actually lives

Two consumers, two sources — worth being precise about, because they used to be
conflated:

- **The desktop app** reads network settings, contract addresses and the
  deployer key from the **credential vault** (Configuration → Blockchain).
  Nothing settlement-related is read from `.env` or `config.json` at runtime.
  The Rust side assembles it in `src-tauri/src/cre.rs`; the private key and the
  full RPC URL never cross IPC to the WebView, so the UI can display *which*
  contract it settles against without being able to sign.
- **The `cre` CLI simulator** is a separate, developer-only tool with its own
  loader. It still reads `config.json`, `.env` and `project.yaml` from this
  directory. Those files are gitignored and hold local simulation values only.

The workflow source (`main.ts`) hardcodes nothing in either case — it takes
every address and endpoint from its `Config` schema. That has always been true,
and is why moving the app to vault-held configuration required no change to it.

> **Never put a real deployer key in `.env`, or a real API key in
> `project.yaml`.** `project.yaml` is committed; the placeholder is there to
> stay. Simulation only needs a funded key when you pass `--broadcast`.

## Config

| key                       | meaning                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `barVerifyUrl`            | GET `{bar}` → HTTP 200 = active CA licensee (state-bar adapter) |
| `notificationUrl`         | POST target that triggers the post-settlement notification     |
| `evms[].retainerReleaseAddress` | deployed `RetainerRelease` receiver contract             |
| `evms[].chainSelectorName`      | e.g. `ethereum-testnet-sepolia`                          |
| `evms[].gasLimit`               | write-report gas limit                                   |
