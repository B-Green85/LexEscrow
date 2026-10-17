# RetainerRelease — deployment & on-chain test record

**Network:** Ethereum Sepolia (chainId `11155111`, CRE `ethereum-testnet-sepolia`)

| | |
| --- | --- |
| RetainerRelease | [`0x6f532f0eefc61a5792ad211850a8b48fbc388674`](https://sepolia.etherscan.io/address/0x6f532f0eefc61a5792ad211850a8b48fbc388674) |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| CRE forwarder | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Deployer / owner / workflow / arbitrator | `0x0b370090317443afFa8124Af45b7C2FeB5a01810` |
| AnchorRegistry | [`0x0906Be060A47B3A44A3Ae42707c7538dBB0451Fb`](https://sepolia.etherscan.io/address/0x0906Be060A47B3A44A3Ae42707c7538dBB0451Fb) — deploy tx [`0x57b51db1…f1a7`](https://sepolia.etherscan.io/tx/0x57b51db1cc9e738d14ae7fe61be97abeb1bd20c4aca272cbfc1d63fcd159f1a7) (`forge create`, no ownership) |

## Deployment

- Deploy tx: [`0xf59bcbe1f73b209c162b2bb5b47a43750e3d3b12e1f47cd64e2c02dfabf246c8`](https://sepolia.etherscan.io/tx/0xf59bcbe1f73b209c162b2bb5b47a43750e3d3b12e1f47cd64e2c02dfabf246c8) (block 11281134)
- On-chain verified: 6,293 bytes of bytecode; `usdc` and `getForwarderAddress`
  match the expected addresses; `supportsInterface` returns true for both
  ERC-165 (`0x01ffc9a7`) and IReceiver (`0x805f2132`).

## Path A — DirectSettlement (verified end-to-end)

- Fund escrow (20 USDC): [`0xb13002106674d9c26edb35e20ff028fb4f047dd9b0adba735bf802168c51833f`](https://sepolia.etherscan.io/tx/0xb13002106674d9c26edb35e20ff028fb4f047dd9b0adba735bf802168c51833f)
- `directSettle` (client 4.20 + firm 0.80 USDC): [`0x9dcb93a01410ffe882c345b1227090a808aa6f0f960ccddba7c464ca4cbab736`](https://sepolia.etherscan.io/tx/0x9dcb93a01410ffe882c345b1227090a808aa6f0f960ccddba7c464ca4cbab736) (block 11281180, gas 77,381)
- Result: escrow −5 USDC, recipient +5 USDC (atomic). `RetainerSettled` event
  emitted with documentHash `0xa14bf2f8870a67c95372b1352e989e02dc3ceb8caf8f6e4c3efe48e1ede36430`,
  clientAmount 4,200,000 + firmAmount 800,000 base units.
- Escrow balance after settlement: **15 USDC**.

## CRE workflow — full end-to-end simulation (verified)

Ran `cre workflow simulate` (HTTP trigger, `--broadcast`) against the deployed
contract with a stub bar-verification endpoint behind `barVerifyUrl`.
The workflow verified the attorney, converted USD→USDC, generated the signed
report, and wrote it through the real Sepolia KeystoneForwarder
(`0x15fC…9F88`) to the contract:

- writeReport tx: [`0xad2d0338fc5cbca00967bbdd9a9e37353dd22eec006c3268c8eea05fe426b9de`](https://sepolia.etherscan.io/tx/0xad2d0338fc5cbca00967bbdd9a9e37353dd22eec006c3268c8eea05fe426b9de) (block 11281294)
- `RetainerSettled` emitted: client `0x1111…1111` 10 USDC + firm `0x2222…2222` 5 USDC, documentHash `0xc2c88764…baa53`.
- Escrow drained 15 → 0 USDC.

(Payload amounts were sized to the 15 USDC escrow. In production the CA-bar mock
is replaced by the real Chainlink Functions call to the State Bar portal.)

## Path B — ArbitrationEscrow

Not yet exercised on-chain. `4_testArbitration.ts` locks a disputed retainer and
runs the 2-of-3 resolution (needs `SECOND_PRIVATE_KEY` for a distinct second
signer to fully release).
