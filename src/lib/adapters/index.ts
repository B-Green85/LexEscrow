/**
 * Adapter library barrel (spec §10, "Adapter Library Vision").
 *
 * Each adapter wraps an external regulatory registry as a Chainlink Functions
 * call target. CannaVerify (`../cannaverify`) is the cannabis suite; BarVerify
 * is the legal one. See ./README.md for the pattern and the V2/V3 roadmap.
 */

export {
  verifyBar,
  resolveState,
  STATE_ADAPTER_MAP,
  BAR_VERIFY_SOURCE,
  APIFY_SUPPORTED_STATES,
  interpretBackendResult,
  BAR_VERIFY_UNAVAILABLE,
  type BarVerifyResult,
  type StateBarAdapter,
} from "./bar-verify";
