# RetainerRelease — on-chain execution layer

The Solidity receiver the Chainlink CRE workflow writes to. It implements the
CRE `IReceiver` interface (via `ReceiverTemplate`): the KeystoneForwarder calls
`onReport`, which decodes the signed settlement report and dispatches to one of
two paths.

- **Path A — DirectSettlement** (`directSettle`): atomically transfers USDC to
  the client and the firm.
- **Path B — ArbitrationEscrow** (`lockArbitration`): earmarks the total; a
  **2-of-3** (client / firm / arbitrator) `resolveArbitration` releases it.

All amounts are USDC base units (integer, 6 decimals) — no floats on chain. The
report tuple decoded in `_processReport` matches `cre/main.ts`'s
`encodeAbiParameters` exactly:

```
uint8 path, address clientWallet, address firmWallet,
uint256 clientAmount, uint256 firmAmount, uint256 totalAmount,
uint256 disputedAmount, bytes32 documentHash
```

Emits `RetainerSettled`, `ArbitrationLocked`, `ArbitrationResolved` — the CRE
`onLogTrigger` listens for `RetainerSettled` / `ArbitrationResolved` to fire the
client notification.

## Layout

```
contracts/
├── src/RetainerRelease.sol      # the contract
├── interfaces/                  # IReceiver, IERC165, ReceiverTemplate (CRE)
├── compile.ts                   # solc-js compile → output/ + abi/
├── viemUtils.ts                 # clients, artifact + address loaders
├── 1_deploy.ts   2_fundEscrow.ts   3_testSettle.ts   4_testArbitration.ts
└── output/  abi/                # compiled ABI + bytecode
```

## Prerequisites

- A **funded Sepolia account**: test ETH for gas
  ([faucet](https://sepoliafaucet.com)) and test USDC to fund the escrow.
- An **Ethereum Sepolia RPC** endpoint (Alchemy / Infura).
- The **Ethereum Sepolia CRE KeystoneForwarder** address
  (`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`) — set as `FORWARDER_ADDRESS` in
  `.env`; verify against the
  [Forwarder Directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts)
  (the owner can also correct it later via `setForwarderAddress`).

## Setup

```bash
cd contracts
bun install                 # or: npm install
cp .env.example .env        # fill in CRE_ETH_PRIVATE_KEY and SEPOLIA_RPC
```

## Compile

```bash
npm run compile             # solc-js → output/RetainerRelease.{abi,bin}
```

## Deploy → Ethereum Sepolia

```bash
npm run deploy              # deploys, then writes the address into cre/config.json
```

Then add `CONTRACT_ADDRESS=<deployed>` to `contracts/.env`. The constructor args
are the Ethereum Sepolia CRE forwarder (`FORWARDER_ADDRESS`), the USDC address,
and the arbitrator (defaults to the deployer).

## Fund + test the paths

```bash
npm run fund                       # transfer test USDC into the escrow
npm run test:settle                # Path A — directSettle
SECOND_PRIVATE_KEY=0x… npm run test:arbitration   # Path B — lock + 2-of-3 release
```

`test:arbitration` needs a second distinct funded key for the second signature
(a single address counts once toward the 2-of-3).

## Verify on Etherscan

```
https://sepolia.etherscan.io/address/<CONTRACT_ADDRESS>#code
```

Verify with your Solidity settings: compiler **0.8.28**, optimizer **enabled
(200 runs)**, constructor args `(forwarder, usdc, arbitrator)`.

## CRE integration

`cre/config.json` `evms[0].retainerReleaseAddress` is set automatically by the
deploy script. `cre/main.ts` already encodes the report to match the contract.
Simulate a chain write with the CRE CLI:

```bash
cd .. && cre workflow simulate ./cre --broadcast --target local-simulation
```

## Ethereum Sepolia addresses

| | address |
| --- | --- |
| Chain | Ethereum Sepolia (id `11155111`, CRE `ethereum-testnet-sepolia`) |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| CRE forwarder | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| RetainerRelease | _populated after deploy_ |
