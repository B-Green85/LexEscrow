# LexEscrow — Confidential Workflow

> "AI parses. LexGuard validates. Humans decide. CRE executes."

The confidential enclave handler that sits between **Stage 3 (AI Parsing)** and
**Stage 5 (Human Authorization)** in the LexEscrow lifecycle.

After a human authorizes an escrow at Stage 4, the Tauri backend POSTs the
escrow payload to this workflow. Inside an AWS Nitro enclave the workflow
re-parses the document with an AI provider, re-validates that parse
deterministically, seals the verdict with HMAC-SHA256, and hands only the sealed
verdict back to the Workflow DON for consensus attestation.

**The enclave is architecturally incapable of executing settlement.** It emits a
validated, sealed payload; a human still has to review it before CRE writes to
`RetainerRelease` on-chain.

> Confidential Workflows requires private beta access via the Chainlink account
> team. Without it, `cre workflow deploy` will not accept a `handlerInTee`
> workflow — `cre workflow simulate` still runs locally.

---

## What the workflow does

| Step | Where | What |
|---|---|---|
| 1 | Enclave | Fetch `AI_PROVIDER_KEY` and `HMAC_VAULT_KEY` from the Vault DON |
| 2 | Enclave | Decode and schema-validate the escrow payload from the HTTP trigger |
| 3 | Enclave | Re-extract the document via the AI provider (`HTTPClient` on the TEE runtime) |
| 4 | Enclave | Three deterministic LexGuard checks → `lexguardScore` |
| 5 | Enclave | HMAC-SHA256 seal over canonical JSON of the verdict |
| 6 | DON | `usingTheDons()` → `report()` with the sealed verdict, ABI-encoded |

Return value is a bare string: `APPROVED (lexguardScore: 1000)` or
`REJECTED (lexguardScore: 400)`.

### The three LexGuard checks

Each starts the score at 1000 and costs 200 on failure, so the range is
1000 / 800 / 600 / 400. `validated = lexguardScore >= config.scoreThreshold`.

| Check | Fails when |
|---|---|
| `validateArithmetic` | An amount is not a safe non-negative integer; `earned + unearned != total`; the parsed total contradicts the total the human authorized; disputed exceeds total |
| `validateAnchors` | A parsed party or identifier has no match in `trust_anchors` (case-insensitive, whitespace-collapsed), or the extraction named no parties at all |
| `validateAnomalies` | An anomaly is marked `suppressed` with no `reason` |

Integer arithmetic throughout — the enclave never rounds. A float in the payload
is a rejected payload, not a rounding problem to fix downstream.

---

## The confidentiality boundary

Everything up to `usingTheDons()` runs inside the enclave. Node operators see
the workflow *binary* (including this logic — a confidential workflow's code is
not secret), but not the data it computes over.

**Stays in the enclave:**

- Both Vault DON secrets
- `document_text` — the raw document, and the request body carrying it
- The AI provider's response and the parsed extraction
- `trust_anchors` (party names, identifiers — PII)
- Every intermediate validation detail (`arithmetic.detail`, `anchors.mismatches`)

**Crosses `usingTheDons()`:**

```
session_id        string
asset_class       string
total_held_cents  uint256   (integer cents)
release_path      string
validated         bool
lexguardScore     uint256
hmac_seal         bytes32
enclave_timestamp string    (ISO8601)
```

That is the whole report. No document text, no AI key, no intermediate parse
state, no trust-anchor PII.

**Logs also leave the boundary.** The handler emits exactly one, carrying no
data, marked `// REMOVE BEFORE PRODUCTION DEPLOY`:

```ts
runtime.log('LexEscrow enclave validation complete')
```

### The HMAC seal

Real HMAC-SHA256 (RFC 2104), built on viem's pure-JS `sha256` — `node:crypto`
is unavailable in the CRE WASM runtime and the SDK ships no HMAC of its own.
It is verified against RFC 4231 test vectors in `workflow.test.ts`, so it is the
genuine construction, not `SHA256(key + ':' + message)`.

The seal covers a **canonical** (sorted-key) JSON rendering of exactly the
fields that cross the boundary, so the Tauri app can recompute it from the DON
report alone and confirm nothing changed in transit. Both sides need the same
`HMAC_VAULT_KEY`.

---

## Secrets

| Secret ID | Env var | Purpose |
|---|---|---|
| `AI_PROVIDER_KEY` | `SECRET_AI_PROVIDER_KEY` | Authenticates the in-enclave Messages API call |
| `HMAC_VAULT_KEY` | `SECRET_HMAC_VAULT_KEY` | Keys the seal; the Tauri vault holds the same value to verify it |

Mapped in `secrets.yaml`; values live in `.env` (gitignored — see `.env.example`).
The Vault DON releases them only into an attested enclave, decrypted at the
moment `getSecret()` runs. There is nothing to declare upfront (unlike
Confidential HTTP's `vaultDonSecrets`).

---

## Config

`my-workflow/config.staging.json`:

```json
{
  "aiProviderUrl": "https://api.anthropic.com/v1/messages",
  "aiProviderSecretId": "AI_PROVIDER_KEY",
  "hmacSecretId": "HMAC_VAULT_KEY",
  "scoreThreshold": 600
}
```

Two further fields carry defaults and may be omitted:

- **`aiModel`** (default `claude-opus-5`) — the Messages API requires a model on
  every request.
- **`authorizedKeys`** (default `[]`) — public keys the HTTP trigger validates
  incoming request signatures against. **An empty list means any caller can
  invoke the enclave.** Pin the Tauri signer's key here before anything but
  staging; `config.production.json` has the placeholder.

---

## Simulate

```bash
cd my-workflow && bun install
cre workflow simulate my-workflow --target staging-settings \
  --http-payload ./my-workflow/sample-payload.json
```

`--http-payload` supplies the trigger body (a JSON string or a path);
`sample-payload.json` is a clean payload that scores 1000. Add
`--non-interactive` in CI. The simulator does not reach a real enclave — it
executes the handler locally — and the AI call is a live outbound request, so it
needs a working `SECRET_AI_PROVIDER_KEY`.

Unit tests need neither:

```bash
cd my-workflow && bun test        # 31 tests, no network
cd my-workflow && bun run typecheck
```

---

## Trigger payload

```typescript
{
  session_id: string,
  asset_class: 'legal' | 'real_estate' | 'business' | 'ip' | 'art'
             | 'natural_resources' | 'cannabis_ind',
  total_held_cents: number,      // integer cents — no floats
  release_path: 'DirectSettlement' | 'ArbitrationEscrow' | 'StagedRelease',
  document_text: string,
  trust_anchors: {
    parties: string[],
    identifiers: string[],
  }
}
```

The asset classes mirror `src/lib/assetClasses.ts` in the main repo — **seven**,
and `natural_resources` is plural. Release paths mirror the `ExecutionPath` enum
in `src/lexguard/types.ts`. An unknown value in either field throws rather than
being sealed.

The HTTP trigger delivers this body as the handler's **second argument**
(`payload.input`, raw JSON bytes) — there is no `runtime.trigger` accessor.

---

## Integration point

```
Tauri backend (Stage 4 authorized)
   │  POST escrow payload
   ▼
HTTPTrigger ──► Nitro enclave ──► AI provider (confidential)
                     │
                     │ LexGuard validation + HMAC seal
                     ▼
              usingTheDons() ──► Workflow DON consensus
                                       │
                                       │ signed report
                                       ▼
                            Stage 5 human authorization
                                       │
                                       ▼
                     evmClient.writeReport → RetainerRelease
```

The AI call is the one nondeterministic step. That is fine here: the enclave
executes it once and the DON verifies the *attestation* of that execution rather
than re-running it. Everything after the parse is deterministic, so the same
extraction always yields the same score and the same seal.

---

## Customization

- **Threshold.** With three checks at 200 each, `scoreThreshold: 600` still
  approves a payload that failed two of them. Raise it to `1000` to require a
  clean pass, or `800` to allow exactly one failure.
- **On-chain delivery.** `donRuntime.report(...)` returns a normal CRE report.
  Pass it to `evmClient.writeReport(donRuntime, report)` to deliver it — the RPCs
  in `project.yaml` are already configured for Sepolia.
- **Provider.** `aiProviderUrl` selects the auth style: an `api.anthropic.com`
  host gets `x-api-key` + `anthropic-version`, anything else gets
  `Authorization: Bearer`. The request body is Anthropic Messages-shaped either
  way, so an OpenAI-compatible endpoint needs the body reshaped in
  `onHttpTrigger`.
