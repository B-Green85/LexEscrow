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

Edit `project.yaml` with your Sepolia RPC URL.

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

## Config

| key                       | meaning                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `barVerifyUrl`            | GET `{bar}` → HTTP 200 = active CA licensee (state-bar adapter) |
| `notificationUrl`         | POST target that triggers the post-settlement notification     |
| `evms[].retainerReleaseAddress` | deployed `RetainerRelease` receiver contract             |
| `evms[].chainSelectorName`      | e.g. `ethereum-testnet-sepolia`                          |
| `evms[].gasLimit`               | write-report gas limit                                   |
