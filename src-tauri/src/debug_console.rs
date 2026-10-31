// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

//! LexTrace — the read-only CRE debug console.
//!
//! One Tauri command, [`run_cre_debug`], which runs a fixed CRE CLI invocation
//! and hands its output back to the WebView. Three properties define it:
//!
//!  * **Read only.** The command list is a compile-time constant. Nothing the
//!    WebView sends selects, extends or parameterises it, so there is no path
//!    from the UI to an arbitrary subprocess — the panel observes, it does not
//!    act. This is the same posture the rest of the app takes toward the chain.
//!  * **Gated.** A run is refused unless the `debug-console` credential group
//!    is configured. The password check itself lives in `credential_store.rs`
//!    (`debug_console_authenticate`) and is held by the frontend for the app
//!    session; this module's own check is the one that cannot be skipped by
//!    a caller that never asked.
//!  * **Recorded.** Every line handed back is appended to `debug_audit_trail`
//!    under the operator's name, hash-chained. What the operator saw is
//!    reconstructible later, line for line.
//!
//! ## Redaction
//!
//! CRE CLI output is operational data an IT operator needs — wallet addresses,
//! contract addresses, workflow IDs, file paths, DON IDs — and it must survive
//! intact, or the panel is worse than useless. What must not survive is a
//! credential or a financial figure. Those two requirements collide on the word
//! "key": `private_key` has to go and `KeystoneForwarder` has to stay.
//!
//! A substring match cannot tell them apart, so [`is_sensitive`] matches on
//! *identifiers* instead: the line is split on non-alphanumeric characters and
//! again at camel-case boundaries, and a line is withheld only when one of the
//! resulting tokens *is* a sensitive term rather than merely contains one.
//! `privateKey`, `PRIVATE_KEY` and `Private Key` all reduce to a `private`
//! token; `KeystoneForwarder`, `monkey` and a hex address never do. The known
//! gap is an unseparated all-caps run (`APIKEY`), which no boundary rule can
//! split — see the tests, which pin both the matches and the exemptions.
//!
//! A withheld line is replaced by a visible marker rather than dropped. A debug
//! console that silently removes lines teaches its operator to distrust the
//! line count, and the audit trail would then record a run that never happened
//! the way it reads.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tauri::State;
use tokio::sync::Mutex;

use crate::credential_store::CredentialStoreState;
use crate::db::Db;

/// The two CRE invocations the console alternates between, argv-style.
///
/// A constant, not configuration. Every argument is fixed here, so the WebView
/// cannot influence what runs — which is what lets this command exist at all in
/// an app whose governing rule is "observe, don't act".
const CRE_COMMANDS: [&[&str]; 2] = [
    &["execution", "list", "lexescrow-cw-staging"],
    &["workflow", "get", "my-workflow", "--target", "staging-settings"],
];

/// How long a single CRE invocation may run before it is killed.
///
/// The frontend polls every three seconds; without a ceiling, one CLI call
/// waiting on an unreachable DON would wedge the panel with no output and no
/// error for as long as the app stayed open. Generous enough for a slow network
/// round trip, short enough that the operator sees *something* go wrong.
const RUN_TIMEOUT: Duration = Duration::from_secs(20);

/// Terms that make a line unfit to show. Compared against whole identifier
/// tokens, never as substrings — see the module docs.
const SENSITIVE_TERMS: [&str; 5] = ["amount", "usdc", "private", "key", "secret"];

/// What replaces a withheld line.
const REDACTION_MARKER: &str = "[LexTrace] line withheld — matched a sensitive term";

pub const CRE_NOT_FOUND: &str = "CRE CLI not found. Ensure cre is installed and in PATH.";
pub const NOT_CONFIGURED: &str = "Debug console requires IT setup. Configure in Settings.";

/// Session state for the console.
///
/// The alternation counter lives here rather than in the WebView on purpose.
/// Which command runs is part of what gets recorded in the audit trail, and a
/// value the renderer supplied would be a value the renderer could choose —
/// exactly the "no command execution from the UI layer" line this feature is
/// not allowed to cross.
#[derive(Default)]
pub struct DebugConsoleState {
    next_command: AtomicUsize,
    /// Held for the duration of a run. A three-second poll against a CLI call
    /// that occasionally takes longer would otherwise stack runs on top of each
    /// other, and the audit trail would record two interleaved commands as one
    /// contiguous chain.
    running: Mutex<()>,
}

impl DebugConsoleState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next invocation, advancing the alternation.
    fn take_next(&self) -> &'static [&'static str] {
        let i = self.next_command.fetch_add(1, Ordering::Relaxed);
        CRE_COMMANDS[i % CRE_COMMANDS.len()]
    }
}

// ============================================================================
// Binary and project resolution
// ============================================================================

#[cfg(windows)]
const CRE_EXE: &str = "cre.exe";
#[cfg(not(windows))]
const CRE_EXE: &str = "cre";

/// Locate the `cre` binary.
///
/// A bare `Command::new("cre")` is not enough, and for the reason
/// `extractor.rs` already documents for `pdftotext`: a GUI process on macOS
/// does not inherit the login shell's PATH, so a tool installed under
/// `~/.cre/bin` — which is where CRE's own installer puts it — is invisible to
/// the app even though it resolves fine in the operator's terminal.
///
/// `LEXESCROW_CRE_BIN` wins when set, so an install that keeps `cre` somewhere
/// none of these candidates covers has a way to say so without a code change.
pub fn resolve_cre_binary() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("LEXESCROW_CRE_BIN") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/usr/local/bin").join(CRE_EXE),
        PathBuf::from("/opt/homebrew/bin").join(CRE_EXE),
        PathBuf::from("/usr/bin").join(CRE_EXE),
    ];
    // The CRE installer's default location, which is per-user and therefore
    // cannot be hardcoded as an absolute path.
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        candidates.insert(0, PathBuf::from(home).join(".cre").join("bin").join(CRE_EXE));
    }
    // Whatever PATH this process actually has, last: an inherited PATH is the
    // right answer when it works, but it is the one that silently is not there
    // under a bundled app, so it does not get to shadow the known locations.
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|d| d.join(CRE_EXE)));
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// Locate the CRE project directory — the one holding `project.yaml`.
///
/// Both commands are project-scoped (`--target staging-settings` names a block
/// inside `project.yaml`), so running them from wherever the app happens to
/// have been launched produces a CLI error rather than output. This walks up
/// from the working directory looking for either a `project.yaml` or a
/// `lexescrow-cw/project.yaml`, which covers a dev run started anywhere in the
/// repo.
///
/// `None` means "run wherever we are and let the CLI say so". That is the
/// honest outcome for a packaged build, whose working directory is not inside
/// the repo at all: `LEXESCROW_CRE_PROJECT_DIR` is the supported answer there.
pub fn resolve_project_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("LEXESCROW_CRE_PROJECT_DIR") {
        let path = PathBuf::from(explicit);
        if path.is_dir() {
            return Some(path);
        }
    }
    let start = std::env::current_dir().ok()?;
    project_dir_from(&start)
}

/// The upward search, split out so it is testable against a scratch tree
/// rather than against whatever directory the test runner happens to use.
fn project_dir_from(start: &Path) -> Option<PathBuf> {
    // Six levels covers `src-tauri/target/debug/...` and any sane repo layout
    // without turning a missing project into a walk to the filesystem root.
    start.ancestors().take(6).find_map(|dir| {
        let nested = dir.join("lexescrow-cw");
        if nested.join("project.yaml").is_file() {
            return Some(nested);
        }
        if dir.join("project.yaml").is_file() {
            return Some(dir.to_path_buf());
        }
        None
    })
}

// ============================================================================
// Redaction
// ============================================================================

/// Split a line into lowercase identifier tokens.
///
/// Two boundaries, applied in order: any run of non-alphanumeric characters,
/// then a camel-case transition. The second is what separates `privateKey` into
/// something matchable while leaving `KeystoneForwarder` — two words, neither of
/// them "key" — alone.
fn tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    for chunk in line.split(|c: char| !c.is_alphanumeric()) {
        if chunk.is_empty() {
            continue;
        }
        let chars: Vec<char> = chunk.chars().collect();
        let mut start = 0usize;
        for i in 1..chars.len() {
            // lower→upper ("privateKey"), or the tail of an acronym followed by
            // a word ("APIKey" → "API", "Key").
            let lower_to_upper = chars[i].is_uppercase() && chars[i - 1].is_lowercase();
            let acronym_tail = chars[i].is_uppercase()
                && chars[i - 1].is_uppercase()
                && chars.get(i + 1).is_some_and(|c| c.is_lowercase());
            if lower_to_upper || acronym_tail {
                out.push(chars[start..i].iter().collect::<String>().to_lowercase());
                start = i;
            }
        }
        out.push(chars[start..].iter().collect::<String>().to_lowercase());
    }
    out
}

/// Should this line be withheld from the panel and from the audit trail?
pub fn is_sensitive(line: &str) -> bool {
    tokens(line).iter().any(|t| {
        // A trailing plural is the one inflection worth handling: CLI output
        // says "amounts" and "keys" as readily as the singular, and trimming a
        // final "s" cannot turn an exempt word into a match ("monkeys" is still
        // not "key").
        let singular = t.strip_suffix('s').unwrap_or(t);
        SENSITIVE_TERMS.contains(&t.as_str()) || SENSITIVE_TERMS.contains(&singular)
    })
}

/// Apply redaction to a whole capture, returning the lines to show and record.
pub fn redact(output: &str) -> Vec<String> {
    output
        .lines()
        .map(|line| {
            if is_sensitive(line) {
                REDACTION_MARKER.to_string()
            } else {
                line.to_string()
            }
        })
        .collect()
}

// ============================================================================
// Subprocess
// ============================================================================

/// Run one CRE invocation to completion, returning stdout followed by stderr.
///
/// Colour is *requested* rather than assumed. Go CLIs disable ANSI when stdout
/// is not a terminal, and this capture is a pipe by construction — so without
/// these three variables the panel would faithfully render output that has had
/// every colour stripped before it arrived. `CLICOLOR_FORCE` and `FORCE_COLOR`
/// are the two conventions in circulation; `TERM` gives whichever library is in
/// use a palette to target.
fn run_once(binary: &Path, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .env("CLICOLOR_FORCE", "1")
        .env("FORCE_COLOR", "1")
        .env("TERM", "xterm-256color")
        .stdin(Stdio::null()) // read only: the child gets no input channel
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the CRE CLI: {e}"))?;

    // Deadline enforced by polling rather than by a reader thread: the output
    // of these two commands is a few kilobytes at most, so filling the pipe
    // buffer is not a live concern, and `wait_with_output` gives no way to
    // stop waiting.
    let deadline = Instant::now() + RUN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "CRE CLI timed out after {}s.",
                        RUN_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("CRE CLI could not be waited on: {e}")),
        }
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("CRE CLI output could not be read: {e}"))?;

    // Both streams, stdout first. A non-zero exit is *not* an error here: the
    // CLI's own diagnostic on stderr is exactly what the operator opened this
    // panel to read, and swallowing it in favour of "command failed" would hide
    // the one thing worth showing.
    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&stderr);
    }
    Ok(combined)
}

// ============================================================================
// Tauri command
// ============================================================================

/// Run the next CRE command, record its output, and return it with ANSI intact.
///
/// The spec's shape for this is `State<AppState>`; LexEscrow has no single
/// `AppState` — managed state is split across `Db`, `CredentialStoreState` and
/// `ArtifactGuardState` — so the three this needs are taken individually, which
/// is the same thing every other command in this app does.
///
/// An empty string is a valid answer, and means a run was already in flight.
/// The frontend polls faster than a slow CLI call returns; reporting that as an
/// error would put a red line in the panel every three seconds for a condition
/// that is not a fault.
#[tauri::command]
pub async fn run_cre_debug(
    db: State<'_, Db>,
    store: State<'_, CredentialStoreState>,
    console: State<'_, DebugConsoleState>,
    session_id: Option<String>,
) -> Result<String, String> {
    // 1. Gate. The operator name comes from the same read, so a recorded line
    //    can never be attributed to nobody.
    let operator_id = store.debug_operator_id().ok_or(NOT_CONFIGURED)?;

    // 2. One run at a time.
    let Ok(_guard) = console.running.try_lock() else {
        return Ok(String::new());
    };

    // 3. Which command, and what to run it with.
    let binary = resolve_cre_binary().ok_or(CRE_NOT_FOUND)?;
    let args = console.take_next();
    let cwd = resolve_project_dir();
    let command_line = format!(
        "{} {}",
        binary.file_name().and_then(|n| n.to_str()).unwrap_or("cre"),
        args.join(" ")
    );

    // 4. Off the async runtime — this blocks on a child process.
    let output = {
        let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
        tauri::async_runtime::spawn_blocking(move || {
            let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
            run_once(&binary, &borrowed, cwd.as_deref())
        })
        .await
        .map_err(|e| format!("CRE CLI task failed: {e}"))??
    };

    // 5. Redact, then record. The redacted form is what is written: the trail
    //    lives on the same disk as everything else this app is careful about,
    //    and logging the raw line would make the filter cosmetic.
    let lines = redact(&output);
    db.append_debug_lines(session_id.as_deref(), &operator_id, &command_line, &lines)
        .await
        .map_err(|e| format!("Debug audit write failed: {e}"))?;

    Ok(lines.join("\n"))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Alternation ------------------------------------------------------

    #[test]
    fn the_two_commands_alternate_and_wrap() {
        let state = DebugConsoleState::new();
        assert_eq!(state.take_next(), CRE_COMMANDS[0]);
        assert_eq!(state.take_next(), CRE_COMMANDS[1]);
        assert_eq!(state.take_next(), CRE_COMMANDS[0]);
        assert_eq!(state.take_next(), CRE_COMMANDS[1]);
    }

    #[test]
    fn the_command_list_is_exactly_the_two_read_only_invocations() {
        // The whole read-only claim rests on this list being fixed, so it is
        // asserted rather than assumed. A third entry, or an argument that
        // mutates, has to fail here first.
        assert_eq!(CRE_COMMANDS.len(), 2);
        assert_eq!(CRE_COMMANDS[0], ["execution", "list", "lexescrow-cw-staging"]);
        assert_eq!(
            CRE_COMMANDS[1],
            ["workflow", "get", "my-workflow", "--target", "staging-settings"]
        );
    }

    // ---- Redaction: what must go -----------------------------------------

    #[test]
    fn credential_and_financial_lines_are_withheld() {
        for line in [
            "  private_key: 0xdeadbeef",
            "privateKey=0xdeadbeef",
            "PRIVATE_KEY set",
            "Deployer Private Key ........ configured",
            "amount: 12500",
            "amountCents: 12500",
            "Amounts released: 3",
            "USDC balance 42.00",
            "usdc_address resolved",
            "client secret rotated",
            "API_SECRET=zzz",
            "apiKey: sk-live-xxxx",
            "signing keys rotated",
        ] {
            assert!(is_sensitive(line), "should have been withheld: {line}");
        }
    }

    // ---- Redaction: what must stay ---------------------------------------

    #[test]
    fn operational_reference_data_survives() {
        // Every one of these is something the spec names as data the IT
        // operator legitimately needs, and every one of them would be lost to a
        // naive substring match on "key".
        for line in [
            "Forwarder (KeystoneForwarder): 0x8Ab5D2C1f0e4B6a7C8d9E0f1A2b3C4d5E6f7A8b9",
            "Owner: 0x6f53a1B2c3D4e5F60718293A4b5C6d7E8f901234",
            "Contract: 0xc0ffee254729296a45a3885639AC7E10F9d54979",
            "Workflow ID: 0x1234abcd5678ef901234abcd5678ef901234abcd",
            "Binary URL: file:///Users/ops/.cre/bin/workflow.wasm",
            "Config: /Users/ops/Projects/LexEscrow/lexescrow-cw/my-workflow/config.json",
            "DON ID: 15",
            "Status: ACTIVE",
            "monkey business as usual",
            "keystone milestone reached",
            "Donkeys: 4",
        ] {
            assert!(!is_sensitive(line), "should have survived: {line}");
        }
    }

    #[test]
    fn redaction_replaces_the_line_rather_than_dropping_it() {
        // Line count is how an operator knows they are seeing the whole run.
        let out = redact("alpha\nprivate key: x\nbravo");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], "alpha");
        assert_eq!(out[1], REDACTION_MARKER);
        assert_eq!(out[2], "bravo");
    }

    #[test]
    fn ansi_escapes_survive_redaction_untouched() {
        // Chainlink's signature blue is the reason the panel exists in a
        // terminal emulator rather than in a <pre>. The filter must not be what
        // strips it.
        let blue = "\u{1b}[34mchainlink\u{1b}[0m execution 4 of 4";
        assert_eq!(redact(blue), vec![blue.to_string()]);
    }

    #[test]
    fn a_colour_coded_credential_line_is_still_caught() {
        // The escape sequence must not be a way to smuggle a term past the
        // tokeniser — `[34m` is punctuation-and-digits to `tokens`.
        assert!(is_sensitive("\u{1b}[34mprivate key\u{1b}[0m: 0xdead"));
    }

    #[test]
    fn tokenisation_splits_where_it_claims_to() {
        assert_eq!(tokens("privateKey"), ["private", "key"]);
        assert_eq!(tokens("APIKey"), ["api", "key"]);
        assert_eq!(tokens("KeystoneForwarder"), ["keystone", "forwarder"]);
        assert_eq!(tokens("private_key=1"), ["private", "key", "1"]);
        assert_eq!(tokens(""), Vec::<String>::new());
    }

    #[test]
    fn an_unseparated_all_caps_run_is_the_known_gap() {
        // Documented rather than silently accepted: no boundary rule can split
        // APIKEY, so this is what the filter does not catch. If a future change
        // adds substring fallbacks, this test is the one that should flip —
        // together with `operational_reference_data_survives`, which is what
        // such a fallback would break.
        assert!(!is_sensitive("APIKEY=zzz"));
        assert!(is_sensitive("API KEY=zzz"));
    }

    // ---- Against the real CLI's output ------------------------------------

    /// `cre workflow get my-workflow --target staging-settings`, captured
    /// verbatim from the CLI with `CLICOLOR_FORCE=1`.
    ///
    /// A fixture rather than a live call: the point is to pin the filter
    /// against output that actually exists, without making the test suite
    /// depend on a DON being reachable.
    const REAL_WORKFLOW_GET: &str = concat!(
        "\u{1b}[36mInitializing...\u{1b}[0m\n",
        "\u{1b}[36mResolving workflow \"lexescrow-cw-staging\"...\u{1b}[0m\n",
        "\n",
        "\u{1b}[1mWorkflow: lexescrow-cw-staging\u{1b}[0m\n",
        "\u{1b}[36m     Workflow ID:    00ef7d0a234078399c24b4036e848d358ec1315546bc1c8cd5f00f4d31ef408e\u{1b}[0m\n",
        "\u{1b}[36m     Owner:          10286c6ebba56d22677bc546a8df0b3f3c79c62e\u{1b}[0m\n",
        "\u{1b}[36m     Status:         ACTIVE\u{1b}[0m\n",
        "\u{1b}[36m     Registry:       private\u{1b}[0m\n",
        "\u{1b}[36m     Registered:     2026-09-05 02:20:39 UTC\u{1b}[0m\n",
        "\u{1b}[36m     Last executed:  never\u{1b}[0m\n",
        "\n",
        "\u{1b}[1mDeployment\u{1b}[0m\n",
        "\u{1b}[36m     Deployed at:    2026-09-05 02:29:59 UTC\u{1b}[0m\n",
        "\u{1b}[36m     Binary URL:     https://storage.cre.chain.link/artifacts/00ef7d0a234078399c24b4036e848d358ec1315546bc1c8cd5f00f4d31ef408e/binary.wasm\u{1b}[0m\n",
    );

    #[test]
    fn the_filter_keeps_every_operational_line_of_a_real_workflow_get() {
        let out = redact(REAL_WORKFLOW_GET);

        // Every line the spec names as reference data survives, colour intact.
        for needle in [
            "Workflow ID:    00ef7d0a234078399c24b4036e848d358ec1315546bc1c8cd5f00f4d31ef408e",
            "Owner:          10286c6ebba56d22677bc546a8df0b3f3c79c62e",
            "Binary URL:     https://storage.cre.chain.link/artifacts/",
            "Status:         ACTIVE",
        ] {
            assert!(
                out.iter().any(|l| l.contains(needle)),
                "the filter withheld an operational line containing {needle:?}"
            );
        }
        assert!(out.iter().any(|l| l.contains("\u{1b}[36m")), "colour was lost");
        assert_eq!(out.len(), REAL_WORKFLOW_GET.lines().count());
    }

    #[test]
    fn registry_private_is_the_one_line_the_spec_costs_us() {
        // `Registry: private` is operational metadata — which registry the
        // workflow is published to — and the filter withholds it, because the
        // spec's term list says any line containing "private" goes.
        //
        // Deliberate, not an oversight, and pinned here so the trade is visible
        // rather than surprising: relaxing it means special-casing "private"
        // when it is followed by neither "key" nor a value, and that is a
        // judgement call for whoever owns the redaction policy — not something
        // to smuggle in under a rule that says otherwise. Deleting this test is
        // the first step of making that change.
        assert!(is_sensitive("\u{1b}[36m     Registry:       private\u{1b}[0m"));

        let withheld = redact(REAL_WORKFLOW_GET)
            .iter()
            .filter(|l| l.as_str() == REDACTION_MARKER)
            .count();
        assert_eq!(withheld, 1, "exactly one line of a real run is withheld");
    }

    #[test]
    fn a_real_empty_execution_list_passes_through_whole() {
        // `cre execution list` on a workflow that has never run. Nothing here
        // is sensitive, and the bold-yellow notice is the whole answer.
        let out = redact(concat!(
            "\u{1b}[36mInitializing...\u{1b}[0m\n",
            "\u{1b}[36mFetching executions...\u{1b}[0m\n",
            "\n",
            "\u{1b}[1;93m! No executions found\u{1b}[0m\n",
        ));
        assert!(out.iter().all(|l| l != REDACTION_MARKER));
        assert!(out.iter().any(|l| l.contains("No executions found")));
    }

    // ---- Project discovery ------------------------------------------------

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lextrace_{name}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_project_directory_is_found_from_a_nested_working_directory() {
        let root = scratch("proj");
        let cw = root.join("lexescrow-cw");
        std::fs::create_dir_all(&cw).unwrap();
        std::fs::write(cw.join("project.yaml"), "staging-settings:\n").unwrap();
        let nested = root.join("src-tauri").join("target").join("debug");
        std::fs::create_dir_all(&nested).unwrap();

        assert_eq!(project_dir_from(&nested), Some(cw));
    }

    #[test]
    fn a_directory_that_is_itself_the_project_is_accepted() {
        let root = scratch("selfproj");
        std::fs::write(root.join("project.yaml"), "staging-settings:\n").unwrap();
        assert_eq!(project_dir_from(&root), Some(root.clone()));
    }

    #[test]
    fn no_project_anywhere_above_yields_none() {
        // Not an error: the CLI's own "no project" message is more useful to an
        // operator than one this module invents.
        let root = scratch("noproj");
        let nested = root.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(project_dir_from(&nested).is_none());
    }

    // ---- Binary resolution ------------------------------------------------

    #[test]
    fn a_missing_binary_produces_the_documented_message() {
        // The panel's whole diagnosis of "cre is not installed" is this string.
        assert_eq!(CRE_NOT_FOUND, "CRE CLI not found. Ensure cre is installed and in PATH.");
        assert_eq!(NOT_CONFIGURED, "Debug console requires IT setup. Configure in Settings.");
    }

    #[test]
    fn subprocess_capture_combines_both_streams_and_takes_no_stdin() {
        // `sh` stands in for `cre`: what is under test is this module's capture
        // contract, not Chainlink's CLI. stdin is closed, so a child that reads
        // it sees EOF rather than blocking the panel forever.
        let sh = Path::new("/bin/sh");
        if !sh.is_file() {
            return;
        }
        let out = run_once(
            sh,
            &["-c", "printf 'to-stdout\\n'; printf 'to-stderr\\n' >&2; cat"],
            None,
        )
        .unwrap();
        assert!(out.contains("to-stdout"));
        assert!(out.contains("to-stderr"));
    }

    // ---- End to end, against the real CLI ---------------------------------

    /// The whole chain — resolve the binary, resolve the project, run, capture,
    /// redact — against the actual `cre` on this machine.
    ///
    /// Skips rather than fails when either the CLI or the project is absent, so
    /// CI and a fresh clone stay green. What it proves when it does run is the
    /// part no fixture can: that the resolution logic finds a `cre` a GUI
    /// process would otherwise miss, and that the two invocations are spelled
    /// the way the CLI expects.
    #[test]
    fn the_real_cre_cli_runs_and_its_colour_survives() {
        let (Some(binary), Some(project)) = (resolve_cre_binary(), resolve_project_dir()) else {
            eprintln!("skipping: no cre binary or no CRE project directory");
            return;
        };

        for args in CRE_COMMANDS {
            let out = run_once(&binary, args, Some(&project))
                .unwrap_or_else(|e| panic!("`cre {}` failed: {e}", args.join(" ")));

            assert!(!out.trim().is_empty(), "`cre {}` produced nothing", args.join(" "));
            // The CLI drops colour when stdout is a pipe. `run_once` sets
            // CLICOLOR_FORCE to get it back, and that is the single reason the
            // panel renders in colour at all.
            assert!(
                out.contains('\u{1b}'),
                "`cre {}` came back with no ANSI — CLICOLOR_FORCE stopped working",
                args.join(" ")
            );
            // And the filter leaves that output usable rather than shredding it.
            let lines = redact(&out);
            assert!(
                lines.iter().filter(|l| l.as_str() == REDACTION_MARKER).count() < lines.len() / 2,
                "the filter withheld most of a real run"
            );
        }
    }

    #[test]
    fn a_nonzero_exit_still_returns_its_diagnostic() {
        // The CLI's error text is the point of the panel, not a reason to
        // discard the run.
        let sh = Path::new("/bin/sh");
        if !sh.is_file() {
            return;
        }
        let out = run_once(sh, &["-c", "printf 'boom\\n' >&2; exit 3"], None).unwrap();
        assert!(out.contains("boom"));
    }
}
