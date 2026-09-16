//! Attorney bar verification against official state registries, via Apify.
//!
//! The legal asset class turns on one fact an escrow cannot assume: that the
//! attorney of record is admitted and in good standing *right now*. A regex
//! over the bar number cannot detect a suspension — a disbarred attorney's
//! number is still six digits — so this asks a registry.
//!
//! The lookup runs through the `jungle_synthesizer/multi-state-bar-scraper`
//! actor, which crawls fourteen official state bar sites and returns one record
//! per attorney. It replaces a local mock adapter that was never running
//! outside a demo and therefore failed every real session.
//!
//! Three properties are load-bearing and none is guessable from the shape of
//! the JSON:
//!
//!   * The actor's `states` input is an **enum of uppercase two-letter codes**
//!     (`["CA"]`). A full state name is rejected by its input schema, so
//!     [`normalize_state`] resolves whatever the trust anchors carry down to a
//!     code before the request is built.
//!   * The actor's **output is snake_case** (`bar_status`, `full_name`,
//!     `has_disciplinary_history`), not camelCase. Reading a camelCase field
//!     yields `None` on every record, which would report a live attorney as
//!     unverified.
//!   * An unconfigured token is **not an error**. It comes back as a normal
//!     result carrying [`NOT_CONFIGURED`], because "we never asked" and "this
//!     attorney is not in good standing" are different facts and the caller
//!     renders them differently.
//!
//! Nothing here ever returns `verified: true` on a path that did not actually
//! read a registry record. That asymmetry is the whole safety property: the
//! caller turns this into a gate on money.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::credential_store::CredentialStoreState;

/// The actor, addressed by its permanent `username~name` slug. Fixed in code
/// rather than configured: what varies per install is who pays for the run, not
/// which registry is authoritative.
const ACTOR_SLUG: &str = "jungle_synthesizer~multi-state-bar-scraper";

/// Shown when no Apify token is stored. Phrased as the action the operator can
/// take, because that is the only thing standing between them and a verified
/// attorney.
pub const NOT_CONFIGURED: &str =
    "Bar verification not configured — add Apify token in Configuration";

/// The actor's `states` enum, verbatim. A state outside this list has no
/// crawler behind it, so the request is refused here rather than sent and
/// silently returned empty — an empty dataset is indistinguishable from "no
/// such attorney", and those must not collapse.
pub const SUPPORTED_STATES: &[&str] = &[
    "AZ", "CA", "FL", "GA", "ID", "IL", "MA", "MN", "NJ", "NY", "OH", "PA", "TN", "TX",
];

/// Full names for the fourteen, so an unsupported jurisdiction can be reported
/// by name rather than by code.
const STATE_NAMES: &[(&str, &str)] = &[
    ("AZ", "arizona"),
    ("CA", "california"),
    ("FL", "florida"),
    ("GA", "georgia"),
    ("ID", "idaho"),
    ("IL", "illinois"),
    ("MA", "massachusetts"),
    ("MN", "minnesota"),
    ("NJ", "new jersey"),
    ("NY", "new york"),
    ("OH", "ohio"),
    ("PA", "pennsylvania"),
    ("TN", "tennessee"),
    ("TX", "texas"),
];

/// The actor can spend ~30s on a single lookup; the run-sync endpoint holds the
/// connection until it finishes. Double that, so a slow-but-successful run is
/// not thrown away by the client.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(60);

/// What the renderer receives. Deliberately small: the settlement gate needs a
/// verdict, a name to show, and the discipline flag — not the actor's 29-field
/// record.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BarVerifyResult {
    pub verified: bool,
    pub name: Option<String>,
    pub license_status: Option<String>,
    pub has_public_discipline: bool,
    /// Echoed back as the resolved two-letter code, so the caller records what
    /// was actually queried rather than what it asked for.
    pub state: String,
    pub error: Option<String>,
}

impl BarVerifyResult {
    /// A result that asserts nothing about the attorney. Every early return
    /// goes through here, so no failure path can accidentally ship
    /// `verified: true`.
    fn unverified(state: &str, error: impl Into<String>) -> Self {
        BarVerifyResult {
            verified: false,
            name: None,
            license_status: None,
            has_public_discipline: false,
            state: state.to_string(),
            error: Some(error.into()),
        }
    }
}

/// One record from the actor's dataset.
///
/// snake_case because that is what the actor emits — see the module note. Only
/// the fields this gate consumes are modelled; the rest of the record is
/// ignored rather than rejected, so the actor adding a field cannot break a
/// lookup.
#[derive(Debug, Deserialize)]
struct BarRecord {
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    bar_status: Option<String>,
    #[serde(default)]
    has_disciplinary_history: Option<bool>,
}

/// Resolve whatever the caller has into the actor's two-letter code.
///
/// Trust anchors carry a full state name ("California"); config and adapters
/// tend to carry a code ("CA"). Both resolve, because forcing one spelling at
/// this boundary would turn a data-entry difference into an unsupported state.
/// Returns `None` for anything outside the fourteen the actor crawls.
pub fn normalize_state(state: &str) -> Option<&'static str> {
    let trimmed = state.trim();
    if trimmed.is_empty() {
        return None;
    }

    let upper = trimmed.to_ascii_uppercase();
    if let Some(code) = SUPPORTED_STATES.iter().find(|c| **c == upper) {
        return Some(code);
    }

    let lower = trimmed.to_ascii_lowercase();
    STATE_NAMES
        .iter()
        .find(|(_, name)| *name == lower)
        .map(|(code, _)| *code)
}

/// Is this record's status one that means "may practice"?
///
/// Case-insensitive because the registries are inconsistent about it (`Active`
/// from California, `active` from the status filter). Anything else — inactive,
/// suspended, disbarred, retired, deceased, or a value we have never seen — is
/// not a pass. An unrecognized status must never default to verified.
fn is_active(status: &str) -> bool {
    status.trim().eq_ignore_ascii_case("active")
}

/// Turn the actor's dataset into a verdict.
///
/// Split from the transport so the shapes that actually vary — an empty array,
/// a record with a missing status, a disciplined-but-active attorney — are
/// testable without a network or a token.
fn interpret(records: &[BarRecord], code: &str) -> BarVerifyResult {
    let Some(record) = records.first() else {
        // The registry answered, and it has no such attorney. That is a real
        // finding, not a failure — hence no `error`. `error` is reserved for
        // the three ways a lookup can fail to produce an answer at all: an
        // unreachable service, a non-2xx, and a body that will not parse. An
        // empty dataset is none of those, and the caller renders it as
        // something to check by hand rather than as a broken run.
        return BarVerifyResult {
            verified: false,
            name: None,
            license_status: None,
            has_public_discipline: false,
            state: code.to_string(),
            error: None,
        };
    };

    let status = record.bar_status.as_deref().unwrap_or_default();

    BarVerifyResult {
        verified: is_active(status),
        name: record.full_name.clone().filter(|s| !s.trim().is_empty()),
        license_status: record.bar_status.clone().filter(|s| !s.trim().is_empty()),
        // Absent means "the record did not say", which is not the same as
        // "clean" — but it is the only safe default that does not invent a
        // disciplinary finding against a named attorney.
        has_public_discipline: record.has_disciplinary_history.unwrap_or(false),
        state: code.to_string(),
        error: None,
    }
}

/// Verify an attorney's standing with their state bar.
///
/// Never panics and never blocks the parse flow: every failure — no token, an
/// unsupported jurisdiction, an unreachable gateway, a malformed body — comes
/// back as `Ok` with `verified: false` and an `error` the officer can act on.
/// An `Err` from here would surface as a thrown exception at a settlement gate,
/// which is indistinguishable from a crash.
#[tauri::command]
pub async fn verify_bar_number(
    vault: State<'_, CredentialStoreState>,
    bar_number: String,
    state: String,
) -> Result<BarVerifyResult, String> {
    let Some(code) = normalize_state(&state) else {
        return Ok(BarVerifyResult::unverified(
            state.trim(),
            format!(
                "Bar verification does not cover \"{}\" — supported states are {}.",
                state.trim(),
                SUPPORTED_STATES.join(", ")
            ),
        ));
    };

    let trimmed = bar_number.trim().to_string();
    if trimmed.is_empty() {
        return Ok(BarVerifyResult::unverified(
            code,
            format!("No bar number was provided for {code}."),
        ));
    }

    // Read the token under lock and drop the guard before any await.
    let token = vault
        .resolve_apify()
        .map(|e| e.api_token.clone())
        .filter(|t| !t.trim().is_empty());
    let Some(token) = token else {
        return Ok(BarVerifyResult::unverified(code, NOT_CONFIGURED));
    };

    // The token goes on the query string because that is the only auth the
    // run-sync endpoint accepts. `.query()` percent-encodes it rather than
    // interpolating it, so a token containing a reserved character cannot
    // truncate the URL.
    let url = format!("https://api.apify.com/v2/acts/{ACTOR_SLUG}/run-sync-get-dataset-items");

    let body = serde_json::json!({
        "states": [code],
        "barNumber": trimmed,
        "maxItems": 1,
    });

    let client = match reqwest::Client::builder().timeout(VERIFY_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return Ok(BarVerifyResult::unverified(
                code,
                format!("Could not build the bar verification HTTP client: {e}"),
            ))
        }
    };

    let response = match client
        .post(&url)
        .query(&[("token", token.trim())])
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(BarVerifyResult::unverified(
                code,
                format!("Could not reach the bar verification service: {e}"),
            ))
        }
    };

    let status = response.status();
    if !status.is_success() {
        // Status only. The body can echo the request back, and the request
        // carries the token in its query string.
        return Ok(BarVerifyResult::unverified(
            code,
            format!(
                "Bar verification service returned HTTP {}.",
                status.as_u16()
            ),
        ));
    }

    let records = match response.json::<Vec<BarRecord>>().await {
        Ok(r) => r,
        Err(e) => {
            return Ok(BarVerifyResult::unverified(
                code,
                format!("Bar verification service returned an unreadable body: {e}"),
            ))
        }
    };

    Ok(interpret(&records, code))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(status: Option<&str>, name: Option<&str>, discipline: Option<bool>) -> BarRecord {
        BarRecord {
            full_name: name.map(String::from),
            bar_status: status.map(String::from),
            has_disciplinary_history: discipline,
        }
    }

    #[test]
    fn resolves_a_two_letter_code_in_any_case() {
        assert_eq!(normalize_state("CA"), Some("CA"));
        assert_eq!(normalize_state("ca"), Some("CA"));
        assert_eq!(normalize_state("  ny  "), Some("NY"));
    }

    #[test]
    fn resolves_a_full_state_name_as_the_trust_anchors_spell_it() {
        assert_eq!(normalize_state("California"), Some("CA"));
        assert_eq!(normalize_state("new jersey"), Some("NJ"));
        assert_eq!(normalize_state("TEXAS"), Some("TX"));
    }

    /// The actor's input schema enumerates fourteen states. Anything else has
    /// no crawler, so it must be refused rather than sent.
    #[test]
    fn rejects_a_state_the_actor_does_not_crawl() {
        assert_eq!(normalize_state("WY"), None);
        assert_eq!(normalize_state("Wyoming"), None);
        assert_eq!(normalize_state("Narnia"), None);
        assert_eq!(normalize_state(""), None);
        assert_eq!(normalize_state("   "), None);
    }

    #[test]
    fn the_supported_list_is_exactly_the_actors_enum() {
        assert_eq!(SUPPORTED_STATES.len(), 14);
        assert_eq!(STATE_NAMES.len(), SUPPORTED_STATES.len());
        for (code, _) in STATE_NAMES {
            assert!(SUPPORTED_STATES.contains(code), "{code} missing from the enum");
        }
    }

    #[test]
    fn an_active_record_verifies_and_carries_the_attorney_name() {
        let r = interpret(
            &[record(Some("Active"), Some("Hae-Ri You"), Some(false))],
            "CA",
        );
        assert!(r.verified);
        assert_eq!(r.name.as_deref(), Some("Hae-Ri You"));
        assert_eq!(r.license_status.as_deref(), Some("Active"));
        assert!(!r.has_public_discipline);
        assert_eq!(r.error, None);
    }

    /// The registries disagree about capitalization; the verdict must not.
    #[test]
    fn status_matching_is_case_insensitive() {
        assert!(interpret(&[record(Some("active"), None, None)], "CA").verified);
        assert!(interpret(&[record(Some("ACTIVE"), None, None)], "CA").verified);
        assert!(interpret(&[record(Some(" Active "), None, None)], "CA").verified);
    }

    #[test]
    fn a_suspended_or_disbarred_attorney_does_not_verify() {
        for status in ["Suspended", "Disbarred", "Inactive", "Retired", "Deceased"] {
            let r = interpret(&[record(Some(status), Some("A. Lawyer"), Some(true))], "CA");
            assert!(!r.verified, "{status} must not verify");
            assert_eq!(r.license_status.as_deref(), Some(status));
        }
    }

    /// A status the registries have never emitted before must not resolve to
    /// "in good standing" by default.
    #[test]
    fn an_unrecognized_or_missing_status_does_not_verify() {
        assert!(!interpret(&[record(Some("Pending Review"), None, None)], "CA").verified);
        assert!(!interpret(&[record(None, Some("A. Lawyer"), None)], "CA").verified);
    }

    /// An empty dataset means the registry answered and holds no such
    /// attorney — a finding, not a failure, so no error is attached.
    ///
    /// This is what keeps the caller from halting a run over it: the frontend
    /// tells "no record" apart from "the lookup failed" by the presence of
    /// `error`, and only the latter is a broken run.
    #[test]
    fn an_empty_dataset_is_unverified_without_an_error() {
        let r = interpret(&[], "CA");
        assert!(!r.verified);
        assert_eq!(r.error, None);
        assert_eq!(r.name, None);
        assert_eq!(r.license_status, None);
        assert_eq!(r.state, "CA");
    }

    /// The distinction the caller renders as amber-versus-red: only a lookup
    /// that failed to produce an answer carries `error`. An empty dataset is a
    /// successful lookup with nothing in it.
    #[test]
    fn only_a_failed_lookup_carries_an_error() {
        assert_eq!(interpret(&[], "CA").error, None);
        assert_eq!(
            interpret(&[record(Some("Active"), None, None)], "CA").error,
            None
        );
        for failure in [
            "Could not reach the bar verification service: timeout",
            "Bar verification service returned HTTP 503.",
            "Bar verification service returned an unreadable body: expected value",
            NOT_CONFIGURED,
        ] {
            assert!(
                BarVerifyResult::unverified("CA", failure).error.is_some(),
                "{failure} must carry an error"
            );
        }
    }

    /// Discipline is reported independently of the verdict: an attorney can be
    /// active and still carry a public record, and the officer needs both.
    #[test]
    fn discipline_is_surfaced_even_on_an_active_licence() {
        let r = interpret(&[record(Some("Active"), Some("A. Lawyer"), Some(true))], "CA");
        assert!(r.verified);
        assert!(r.has_public_discipline);
    }

    #[test]
    fn a_blank_name_is_dropped_rather_than_shown_empty() {
        let r = interpret(&[record(Some("Active"), Some("   "), None)], "CA");
        assert_eq!(r.name, None);
    }

    /// Every constructed failure must be unverified — this is the property the
    /// settlement gate depends on.
    #[test]
    fn the_unverified_constructor_never_asserts_standing() {
        let r = BarVerifyResult::unverified("CA", NOT_CONFIGURED);
        assert!(!r.verified);
        assert!(!r.has_public_discipline);
        assert_eq!(r.name, None);
        assert_eq!(r.license_status, None);
        assert_eq!(r.error.as_deref(), Some(NOT_CONFIGURED));
    }
}
