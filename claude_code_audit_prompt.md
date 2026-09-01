# Claude Code Prompt — LexEscrow Integration Audit

## Task

Do not change any code. This is a read-only audit. Scan the codebase and produce a clear status report for every integration and known bug item listed below. For each item report exactly one of:

- **LIVE** — connected, tested, produces real output
- **STUB** — interface defined, feature-flagged or returns mock/placeholder
- **BROKEN** — wired but throws errors or produces wrong output
- **NOT STARTED** — no implementation exists

---

## Integrations to audit

### 1. Chainlink CRE

- Is the CRE workflow compiled and deployable via CRE CLI?
- Does `HTTPTrigger` receive a LexGuard-validated payload from the Tauri app?
- Does `directSettle()` on the RetainerRelease contract execute on Sepolia?
- Does `lockArbitration()` exist and is it callable?
- Does `stagedRelease()` exist and is it callable?
- Does `resolveArbitration()` exist and is it callable?
- Are Chainlink Functions calls wired for condition verification?
- Are Chainlink Price Feeds wired for currency conversion?
- Is CCIP wired for cross-chain delivery?
- Is LogTrigger wired for post-settlement notification?
- Contract address confirmed at `0x6f532f0eefc61a5792ad211850a8b48fbc388674` on Sepolia?

### 2. DocuSign JWT Grant

- Is the JWT Grant flow complete end to end?
- Does a real signature request email get sent to a real address?
- What is the current `from` / sender domain — is it still `@in-app.lexescrow.local` or has it been updated?
- Are both parties wired as required signers across all six asset classes?

### 3. SMTP Notification

- Does the SMTP notification path send a real email on settlement?
- Is the credential pulled from the active credential store backend (not hardcoded)?

### 4. Twilio SMS

- Does the Twilio path send a real SMS on settlement?
- Is the credential pulled from the active credential store backend?

### 5. Credential Store

- Is `OsKeychainStore` live and performing real macOS Keychain round-trips?
- Is `VaultStore` live with AES-256-GCM + scrypt intact?
- Is the first-launch `CredentialStoreSelector` rendering correctly?
- Is the lazy vault gate (`useVaultGuard`) wired at all 6 action entry points?
- Is the blockchain write gate (`set_blockchain_credential` + bcrypt) implemented?

### 6. LexGuard

- Are all 6 modules live against real payloads (not mocks)?
- Do all 10 stress test scenarios pass?

### 7. TrueTitle / AnchorReceipt

- Is SHA-256 hashing computed in Rust backend (not browser)?
- Is HMAC seal computed correctly?
- Is on-chain registration via CRE wired?
- Is the portable receipt JSON generated and downloadable?

### 8. Clio (V2 scaffold)

- Is the interface defined?
- Is the feature flag present?
- Does it return gracefully without crashing?

### 9. PracticePanther (V2 scaffold)

- Is the interface defined?
- Is the feature flag present?
- Does it return gracefully without crashing?

### 10. HelloSign / Adobe Sign (V2 scaffolds)

- Are interfaces defined?
- Are feature flags present?
- Do they return gracefully?

---

## Known bugs to audit

| Bug | Expected status |
|---|---|
| Audit report generates as HTML despite PDF label | BROKEN |
| California state dropdown initial render bug | BROKEN |
| `extractionToPayload` collapses StagedRelease → DirectSettlement | BROKEN |
| `lopdf` pure-Rust PDF replacement for pdftotext/poppler | NOT STARTED |
| DocuSign `@in-app.lexescrow.local` synthetic sender domain | BROKEN (pre-production) |

Confirm the actual status of each — do not assume. Check the code.

---

## Output format

Produce a report in this exact structure:

```
## Integration Audit — LexEscrow
Date: [today]
Auditor: Claude Code

### CRE
- HTTPTrigger: [LIVE/STUB/BROKEN/NOT STARTED] — [one line explanation]
- directSettle(): [status] — [explanation]
... (one line per item)

### DocuSign
...

### SMTP
...

### Twilio
...

### Credential Store
...

### LexGuard
...

### TrueTitle / AnchorReceipt
...

### V2 Scaffolds
...

---

### Known Bugs
| Bug | Status | Notes |
|---|---|---|
| Audit report HTML/PDF | BROKEN | [where the bug is] |
...

---

### Summary
LIVE: X items
STUB: X items
BROKEN: X items
NOT STARTED: X items

### Pre-bootcamp priority (items that block demo or judging)
1. [item] — [why it blocks]
...

### Post-deadline acceptable
1. [item]
...
```

---

## What NOT to do

- Do not fix anything
- Do not refactor anything
- Do not add TODOs
- Do not run the app
- Read the code only
