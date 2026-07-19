# LexEscrow Adapter Library

Each adapter wraps an external regulatory API as a Chainlink Functions call
target. V1 adapters call mock local servers. V2 adapters call real external
APIs.

The contract at the CRE boundary does not change between the two — the mock and
the production endpoint return the same shape, so promoting an adapter from V1
to V2 is a base-URL change plus a response mapping, not a rewrite of everything
downstream.

## Pattern

Each adapter exports:

- A result interface
- A verify/check function
- A state/jurisdiction routing map

Three properties every adapter is expected to hold:

- **Never throws.** Callers are settlement gates. An unreachable registry, a
  malformed response and an unimplemented jurisdiction all return a result with
  a `detail` an escrow officer can act on — an exception there is
  indistinguishable from a crash.
- **Unknown is never pass.** A status the adapter does not recognize, or a
  jurisdiction it has not implemented, resolves to `error` — never to the
  affirmative value. "We could not check" and "it checks out" must not be the
  same value, because the caller reduces the result to a boolean that moves
  money.
- **The reason survives.** `detail` is carried into the condition metadata and
  the audit trail, because "not verified" is not actionable on its own —
  suspended, unreachable, and not-yet-built call for three different responses.

## Adapters

- `bar-verify.ts` — 50-state bar association (CA live, others scaffold)
- `cannaverify/` — Cannabis regulatory (Metrc + state DCC)
- `[V2] uspto-verify.ts` — USPTO patent/trademark status
- `[V2] entity-verify.ts` — Secretary of State entity standing
- `[V3] title-verify.ts` — County recorder (where APIs exist)

## Adding a new state to BarVerify

1. Add the state to `STATE_ADAPTER_MAP` in `bar-verify.ts`
2. Implement `verifyBarForState_{STATE}()` function
3. Add to the router switch statement
4. Add a mock adapter in `src/mock/` for local testing

Flip `implemented: true` on the map entry as part of step 3 — it is what tells
the UI the difference between "this attorney did not verify" and "this state has
no adapter yet".

## Demo data policy

All mock adapters must use clearly fictional data only. No real person names,
real firm names, real bar numbers, or real contact information may appear in any
mock adapter, test fixture, or sample document.

This is a correctness rule, not just a courtesy: a fixture that names a real
licensee has the mock asserting something about that person's standing —
a claim no demo server is in any position to make.
