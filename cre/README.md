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
else. For a self-contained end-to-end run, start the local mock CA State Bar
adapter and point the config at it:

```bash
# 1) start the mock (returns HTTP 200 "active" for any bar number)
bun ../src/mock/calbar-adapter.ts        # http://localhost:3001/calbar/:barNumber

# 2) config.json → "barVerifyUrl": "http://localhost:3001/calbar/"
# 3) run the HTTP trigger (index 1) with the validated payload, broadcasting:
cre workflow simulate . --broadcast --target local-simulation \
  --non-interactive --trigger-index 1 \
  --http-payload ./http_trigger_payload.json --env ./.env
```

This has been verified on Sepolia end-to-end: attorney verified → USD→USDC →
signed report → `writeReport` through the KeystoneForwarder → `RetainerSettled`
emitted, escrow drained. In production the mock is replaced by the real
Chainlink Functions call to the CA State Bar portal.

## Config

| key                       | meaning                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `barVerifyUrl`            | GET `{bar}` → HTTP 200 = active CA licensee (state-bar adapter) |
| `notificationUrl`         | POST target that triggers the post-settlement notification     |
| `evms[].retainerReleaseAddress` | deployed `RetainerRelease` receiver contract             |
| `evms[].chainSelectorName`      | e.g. `ethereum-testnet-sepolia`                          |
| `evms[].gasLimit`               | write-report gas limit                                   |
