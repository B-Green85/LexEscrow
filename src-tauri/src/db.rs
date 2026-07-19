//! Persistence layer — SQLite via sqlx.
//!
//! Three tables (see `migrations/0001_init.sql`): `release_sessions`,
//! `parsed_payloads`, and the append-only, hash-chained
//! `cryptographic_audit_trail`.
//!
//! Financial values are integer cents end-to-end. The audit trail is the legal
//! record: every write goes through [`Db::append_audit`], which chains each
//! entry's SHA-256 over the previous entry's hash so any later tampering is
//! detectable by a single sequential pass ([`Db::verify_chain`]).

use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteQueryResult};
use sqlx::{ConnectOptions, Connection, SqlitePool};
use tauri::State;
use tokio::sync::Mutex;

/// ASCII Unit Separator — delimits audit-hash fields. JSON never contains a
/// literal 0x1F (control chars are escaped), so it is collision-free here.
const FIELD_SEP: &[u8] = b"\x1f";

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

// ============================================================================
// Row / DTO types
// ============================================================================

// Serde defaults for the asset-class fields, so existing callers that omit them
// over IPC keep the legacy Legal / AI behavior.
fn default_legal() -> String {
    "legal".to_string()
}
fn default_ai() -> String {
    "ai".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSession {
    pub session_id: String,
    pub client_id: String,
    pub attorney_bar_number: String,
    pub document_hash: String,
    pub execution_path: Option<String>,
    pub current_state: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub session_id: String,
    pub client_id: String,
    pub attorney_bar_number: String,
    pub document_hash: String,
    /// Asset class (spec §4). Defaults to `legal` when omitted by the caller.
    #[serde(default = "default_legal")]
    pub asset_class: String,
    /// Batch grouping id (null for single-document sessions).
    #[serde(default)]
    pub batch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPayload {
    pub payload_id: String,
    pub session_id: String,
    /// Asset class (spec §4). Defaults to `legal` when omitted by the caller.
    #[serde(default = "default_legal")]
    pub asset_class: String,
    /// Entry mode — `ai` or `manual`. Defaults to `ai` when omitted.
    #[serde(default = "default_ai")]
    pub entry_mode: String,
    pub total_held_cents: i64,
    pub earned_fees_cents: i64,
    pub unearned_balance_cents: i64,
    #[serde(default)]
    pub disputed_hours: f64,
    #[serde(default)]
    pub disputed_amount_cents: i64,
    /// Full asset-class payload JSON (any class); null for legacy Legal rows.
    #[serde(default)]
    pub payload_json: Option<String>,
}

/// One Path C milestone (spec §6 Path C). `amount_cents` crosses IPC as `i64`
/// because Tauri's JSON transport has no bigint; the frontend widens it back to
/// `bigint` at the `lib/releasePaths` boundary.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneRow {
    pub milestone_id: String,
    pub session_id: String,
    pub label: String,
    pub description: String,
    pub amount_cents: i64,
    pub condition_type: String,
    pub release_date: Option<String>,
    pub evidence_required: Option<String>,
    pub status: String,
    pub sort_order: i64,
    pub submitted_at: Option<String>,
    pub approved_at: Option<String>,
    pub released_at: Option<String>,
    pub tx_hash: Option<String>,
    pub evidence_hash: Option<String>,
    pub created_at: String,
}

/// Path B 2-of-3 multi-sig tally (spec §6 Path B). `locked_at` doubles as the
/// lock flag — a row with a timestamp is a locked escrow.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ArbitrationRow {
    pub session_id: String,
    pub locked_at: Option<String>,
    pub arbiter_address: Option<String>,
    pub party1_signed: i64,
    pub party2_signed: i64,
    pub arbiter_signed: i64,
    pub threshold: i64,
    pub resolved_at: Option<String>,
    pub resolution_tx_hash: Option<String>,
    pub resolution_notes: Option<String>,
}

/// One tracked release condition (spec §6 Stage 7).
///
/// `metadata_json` carries the type-specific detail — document hash, envelope
/// id and per-signer statuses, CannaVerify result — as an opaque JSON blob.
/// The backend never interprets it; the condition engine on the frontend owns
/// that shape, and keeping it opaque here means a new condition type needs no
/// schema change.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ConditionRow {
    pub condition_id: String,
    pub session_id: String,
    pub condition_type: String,
    pub label: String,
    pub description: String,
    pub status: String,
    pub metadata_json: Option<String>,
    pub met_at: Option<String>,
    pub failed_at: Option<String>,
    pub failure_reason: Option<String>,
    pub on_chain_tx: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub log_id: i64,
    pub session_id: String,
    pub event_type: String,
    pub user_identity: String,
    pub payload_json: String,
    pub block_timestamp: String,
    pub previous_hash: Option<String>,
    pub entry_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainVerification {
    pub valid: bool,
    pub entries: i64,
    pub broken_at: Option<i64>,
}

// ============================================================================
// Db
// ============================================================================

pub struct Db {
    pool: SqlitePool,
    /// Serializes audit appends so two concurrent writers can never read the
    /// same `previous_hash` and fork the chain.
    append_lock: Mutex<()>,
}

impl Db {
    /// Open (creating if needed) the SQLite database at `path`, run migrations,
    /// and return a runtime pool with WAL and foreign keys enabled.
    ///
    /// Migration 0002 rebuilds the CHECK-constrained `release_sessions` and
    /// `parsed_payloads` tables, which requires dropping `release_sessions`.
    /// `cryptographic_audit_trail` holds a foreign key back to it that the
    /// migration cannot alter, so the drop trips FK enforcement. Because sqlx
    /// wraps every migration in a transaction, SQLite's `defer_foreign_keys`
    /// cannot decrement the violation counter a DDL rebuild creates, and the
    /// commit always fails. SQLite's documented remedy is to run schema changes
    /// with foreign keys OFF. So: migrate on a dedicated single connection with
    /// `foreign_keys = OFF`, close it, then open the runtime pool with
    /// `foreign_keys = ON` (the existing behavior).
    pub async fn connect_and_migrate(path: &Path) -> Result<Self, DbError> {
        // 1) Dedicated migration connection — foreign keys OFF.
        let mut migration_conn = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(false)
            .connect()
            .await?;

        // 2) Run migrations on that single connection.
        sqlx::migrate!("./migrations").run(&mut migration_conn).await?;

        // 3) Close the migration connection.
        migration_conn.close().await?;

        // 4) Runtime pool — foreign keys ON.
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        // 5) Return the pool as normal.
        Ok(Self {
            pool,
            append_lock: Mutex::new(()),
        })
    }

    // ---- sessions --------------------------------------------------------

    pub async fn create_session(&self, s: &NewSession) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO release_sessions
                (session_id, client_id, attorney_bar_number, document_hash,
                 asset_class, batch_id, current_state)
             VALUES (?, ?, ?, ?, ?, ?, 'LOADED')",
        )
        .bind(&s.session_id)
        .bind(&s.client_id)
        .bind(&s.attorney_bar_number)
        .bind(&s.document_hash)
        .bind(&s.asset_class)
        .bind(&s.batch_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_session_state(&self, session_id: &str, state: &str) -> Result<(), DbError> {
        sqlx::query("UPDATE release_sessions SET current_state = ? WHERE session_id = ?")
            .bind(state)
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_execution_path(&self, session_id: &str, path: &str) -> Result<(), DbError> {
        sqlx::query("UPDATE release_sessions SET execution_path = ? WHERE session_id = ?")
            .bind(path)
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_session(&self, session_id: &str) -> Result<Option<ReleaseSession>, DbError> {
        let row = sqlx::query_as::<_, ReleaseSession>(
            "SELECT session_id, client_id, attorney_bar_number, document_hash,
                    execution_path, current_state, created_at, updated_at
             FROM release_sessions WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    // ---- payloads --------------------------------------------------------

    /// Insert or replace the validated payload for a session (all integer cents).
    pub async fn save_payload(&self, p: &ParsedPayload) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO parsed_payloads
                (payload_id, session_id, asset_class, entry_mode, total_held_cents,
                 earned_fees_cents, unearned_balance_cents, disputed_hours,
                 disputed_amount_cents, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(payload_id) DO UPDATE SET
                asset_class            = excluded.asset_class,
                entry_mode             = excluded.entry_mode,
                total_held_cents       = excluded.total_held_cents,
                earned_fees_cents      = excluded.earned_fees_cents,
                unearned_balance_cents = excluded.unearned_balance_cents,
                disputed_hours         = excluded.disputed_hours,
                disputed_amount_cents  = excluded.disputed_amount_cents,
                payload_json           = excluded.payload_json",
        )
        .bind(&p.payload_id)
        .bind(&p.session_id)
        .bind(&p.asset_class)
        .bind(&p.entry_mode)
        .bind(p.total_held_cents)
        .bind(p.earned_fees_cents)
        .bind(p.unearned_balance_cents)
        .bind(p.disputed_hours)
        .bind(p.disputed_amount_cents)
        .bind(&p.payload_json)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    #[allow(dead_code)] // read back by later phases; part of the persistence API
    pub async fn get_payload(&self, session_id: &str) -> Result<Option<ParsedPayload>, DbError> {
        let row = sqlx::query_as::<_, ParsedPayload>(
            "SELECT payload_id, session_id, asset_class,
                    COALESCE(entry_mode, 'ai') AS entry_mode,
                    total_held_cents, earned_fees_cents, unearned_balance_cents,
                    disputed_hours, disputed_amount_cents, payload_json
             FROM parsed_payloads WHERE session_id = ? LIMIT 1",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    // ---- CannaVerify results (spec §5/§13) -------------------------------

    /// Record a CannaVerify regulatory check result for a session.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_cannaverify_result(
        &self,
        verify_id: &str,
        session_id: &str,
        check_type: &str,
        metrc_facility_id: Option<&str>,
        state_license_num: Option<&str>,
        result: &str,
        on_chain_tx: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO cannaverify_results
                (verify_id, session_id, check_type, metrc_facility_id,
                 state_license_num, result, on_chain_tx)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(verify_id)
        .bind(session_id)
        .bind(check_type)
        .bind(metrc_facility_id)
        .bind(state_license_num)
        .bind(result)
        .bind(on_chain_tx)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ---- DocuSign envelopes (spec §21) -----------------------------------

    /// Insert a freshly-sent DocuSign envelope (status defaults to `SENT`).
    pub async fn save_docusign_envelope(
        &self,
        envelope_id: &str,
        session_id: &str,
        document_label: &str,
        signers_json: &str,
        provider: &str,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO docusign_envelopes
                (envelope_id, session_id, document_label, signers_json, status, provider)
             VALUES (?, ?, ?, ?, 'SENT', ?)",
        )
        .bind(envelope_id)
        .bind(session_id)
        .bind(document_label)
        .bind(signers_json)
        .bind(provider)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Update an existing envelope on a status change / completion.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_docusign_envelope(
        &self,
        envelope_id: &str,
        status: &str,
        completed_at: Option<&str>,
        certificate_hash: Option<&str>,
        on_chain_tx: Option<&str>,
        anchor_match: Option<i64>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "UPDATE docusign_envelopes
                SET status = ?, completed_at = ?, certificate_hash = ?,
                    on_chain_tx = ?, anchor_match = ?
             WHERE envelope_id = ?",
        )
        .bind(status)
        .bind(completed_at)
        .bind(certificate_hash)
        .bind(on_chain_tx)
        .bind(anchor_match)
        .bind(envelope_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ---- AnchorReceipt registered fingerprints (spec §8/§13) -------------

    /// Register an HMAC fingerprint on-chain anchor for a session.
    pub async fn save_registered_fingerprint(
        &self,
        hmac: &str,
        session_id: &str,
        asset_class: &str,
        on_chain_tx: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO registered_fingerprints (hmac, session_id, asset_class, on_chain_tx)
             VALUES (?, ?, ?, ?)",
        )
        .bind(hmac)
        .bind(session_id)
        .bind(asset_class)
        .bind(on_chain_tx)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ---- milestones — Path C StagedRelease (spec §6) ----------------------

    /// Insert one milestone. Status starts at `pending`; the lifecycle is
    /// driven forward exclusively by [`Db::update_milestone_status`].
    #[allow(clippy::too_many_arguments)]
    pub async fn create_milestone(
        &self,
        session_id: &str,
        milestone_id: &str,
        label: &str,
        description: &str,
        amount_cents: i64,
        condition_type: &str,
        release_date: Option<&str>,
        evidence_required: Option<&str>,
        sort_order: i32,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO milestones
                (milestone_id, session_id, label, description, amount_cents,
                 condition_type, release_date, evidence_required, status, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        )
        .bind(milestone_id)
        .bind(session_id)
        .bind(label)
        .bind(description)
        .bind(amount_cents)
        .bind(condition_type)
        .bind(release_date)
        .bind(evidence_required)
        .bind(sort_order)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Advance a milestone's status, writing only the fields the caller
    /// supplied.
    ///
    /// Every optional column is written through `COALESCE(?, col)` so a `None`
    /// argument *preserves* the stored value rather than nulling it. This is
    /// deliberate and load-bearing: the lifecycle is incremental (submit sets
    /// `submitted_at`, approve sets `approved_at`, release sets `released_at`
    /// and `tx_hash`), so a blind overwrite would erase the earlier stages'
    /// timestamps — and those timestamps are the audit evidence that the
    /// human-authorization gate was actually passed.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_milestone_status(
        &self,
        milestone_id: &str,
        status: &str,
        submitted_at: Option<&str>,
        approved_at: Option<&str>,
        released_at: Option<&str>,
        tx_hash: Option<&str>,
        evidence_hash: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "UPDATE milestones
                SET status        = ?,
                    submitted_at  = COALESCE(?, submitted_at),
                    approved_at   = COALESCE(?, approved_at),
                    released_at   = COALESCE(?, released_at),
                    tx_hash       = COALESCE(?, tx_hash),
                    evidence_hash = COALESCE(?, evidence_hash)
             WHERE milestone_id = ?",
        )
        .bind(status)
        .bind(submitted_at)
        .bind(approved_at)
        .bind(released_at)
        .bind(tx_hash)
        .bind(evidence_hash)
        .bind(milestone_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// All milestones for a session, in definition order.
    pub async fn get_milestones(&self, session_id: &str) -> Result<Vec<MilestoneRow>, DbError> {
        let rows = sqlx::query_as::<_, MilestoneRow>(
            "SELECT milestone_id, session_id, label, description, amount_cents,
                    COALESCE(condition_type, 'manual') AS condition_type,
                    release_date, evidence_required,
                    COALESCE(status, 'pending') AS status,
                    sort_order, submitted_at, approved_at, released_at,
                    tx_hash, evidence_hash, created_at
             FROM milestones
             WHERE session_id = ?
             ORDER BY sort_order ASC, created_at ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    // ---- arbitration — Path B ArbitrationEscrow (spec §6) -----------------

    /// Lock a session into arbitration, stamping `locked_at`.
    ///
    /// `INSERT OR REPLACE` keeps the call idempotent: re-locking an already
    /// locked session resets the signature tally rather than erroring, which is
    /// the right behavior for a re-opened dispute.
    pub async fn create_arbitration(
        &self,
        session_id: &str,
        arbiter_address: Option<&str>,
        threshold: i32,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT OR REPLACE INTO arbitration_state
                (session_id, locked_at, arbiter_address, party1_signed,
                 party2_signed, arbiter_signed, threshold)
             VALUES (?, CURRENT_TIMESTAMP, ?, 0, 0, 0, ?)",
        )
        .bind(session_id)
        .bind(arbiter_address)
        .bind(threshold)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Record a signature and/or the final resolution.
    ///
    /// Same `COALESCE` discipline as milestones — signing as party 2 must not
    /// clear party 1's signature, or the 2-of-3 threshold could never be met.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_arbitration(
        &self,
        session_id: &str,
        party1_signed: Option<bool>,
        party2_signed: Option<bool>,
        arbiter_signed: Option<bool>,
        resolved_at: Option<&str>,
        resolution_tx_hash: Option<&str>,
        resolution_notes: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "UPDATE arbitration_state
                SET party1_signed      = COALESCE(?, party1_signed),
                    party2_signed      = COALESCE(?, party2_signed),
                    arbiter_signed     = COALESCE(?, arbiter_signed),
                    resolved_at        = COALESCE(?, resolved_at),
                    resolution_tx_hash = COALESCE(?, resolution_tx_hash),
                    resolution_notes   = COALESCE(?, resolution_notes)
             WHERE session_id = ?",
        )
        .bind(party1_signed.map(i64::from))
        .bind(party2_signed.map(i64::from))
        .bind(arbiter_signed.map(i64::from))
        .bind(resolved_at)
        .bind(resolution_tx_hash)
        .bind(resolution_notes)
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_arbitration(
        &self,
        session_id: &str,
    ) -> Result<Option<ArbitrationRow>, DbError> {
        let row = sqlx::query_as::<_, ArbitrationRow>(
            "SELECT session_id, locked_at, arbiter_address, party1_signed,
                    party2_signed, arbiter_signed, threshold, resolved_at,
                    resolution_tx_hash, resolution_notes
             FROM arbitration_state WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    // ---- conditions — Stage 7 condition tracking (spec §6) ----------------

    /// Insert a condition, or refresh the descriptive fields of one already
    /// stored.
    ///
    /// The upsert deliberately does **not** touch `status`, `met_at`,
    /// `failed_at` or `failure_reason`. `build_conditions` on the frontend
    /// re-derives the whole checklist on every poll tick and re-saves it, so a
    /// blind overwrite here would reset an officer's waiver — or a recorded
    /// failure — back to `pending` thirty seconds after it was set. Status is
    /// owned exclusively by [`Db::update_condition_status`], exactly as the
    /// milestone lifecycle is owned by `update_milestone_status`.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_condition(
        &self,
        session_id: &str,
        condition_id: &str,
        condition_type: &str,
        label: &str,
        description: &str,
        status: &str,
        metadata_json: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO session_conditions
                (condition_id, session_id, condition_type, label, description,
                 status, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(condition_id) DO UPDATE SET
                condition_type = excluded.condition_type,
                label          = excluded.label,
                description    = excluded.description,
                metadata_json  = excluded.metadata_json",
        )
        .bind(condition_id)
        .bind(session_id)
        .bind(condition_type)
        .bind(label)
        .bind(description)
        .bind(status)
        .bind(metadata_json)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Move a condition to a new status.
    ///
    /// Same `COALESCE` discipline as milestones: a condition that was met,
    /// then later waived, keeps its original `met_at`. Those timestamps are the
    /// evidence of *when* each gate opened, and the settlement record is only
    /// defensible if they survive subsequent transitions.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_condition_status(
        &self,
        condition_id: &str,
        status: &str,
        met_at: Option<&str>,
        failed_at: Option<&str>,
        failure_reason: Option<&str>,
        on_chain_tx: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "UPDATE session_conditions
                SET status         = ?,
                    met_at         = COALESCE(?, met_at),
                    failed_at      = COALESCE(?, failed_at),
                    failure_reason = COALESCE(?, failure_reason),
                    on_chain_tx    = COALESCE(?, on_chain_tx)
             WHERE condition_id = ?",
        )
        .bind(status)
        .bind(met_at)
        .bind(failed_at)
        .bind(failure_reason)
        .bind(on_chain_tx)
        .bind(condition_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Every condition for a session, in insertion order.
    pub async fn get_conditions(&self, session_id: &str) -> Result<Vec<ConditionRow>, DbError> {
        let rows = sqlx::query_as::<_, ConditionRow>(
            "SELECT condition_id, session_id, condition_type, label, description,
                    COALESCE(status, 'pending') AS status,
                    metadata_json, met_at, failed_at, failure_reason, on_chain_tx,
                    created_at, updated_at
             FROM session_conditions
             WHERE session_id = ?
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    // ---- audit trail -----------------------------------------------------

    /// Append one entry to the hash-chained audit trail and return it.
    ///
    /// Runs in a transaction: read the current chain head, insert a row to let
    /// SQLite assign `log_id`, compute `entry_hash` over that id + content +
    /// previous hash, then write it back. The `append_lock` guarantees a single
    /// writer at a time so the chain cannot fork.
    pub async fn append_audit(
        &self,
        session_id: &str,
        event_type: &str,
        user_identity: &str,
        payload_json: &str,
    ) -> Result<AuditEntry, DbError> {
        let _guard = self.append_lock.lock().await;
        let block_timestamp = chrono::Utc::now().to_rfc3339();

        let mut tx = self.pool.begin().await?;

        // Current chain head (None => this is the first entry).
        let previous_hash: Option<String> = sqlx::query_scalar(
            "SELECT entry_hash FROM cryptographic_audit_trail ORDER BY log_id DESC LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;

        // Insert with a placeholder hash to obtain the AUTOINCREMENT log_id.
        let result: SqliteQueryResult = sqlx::query(
            "INSERT INTO cryptographic_audit_trail
                (session_id, event_type, user_identity, payload_json,
                 block_timestamp, previous_hash, entry_hash)
             VALUES (?, ?, ?, ?, ?, ?, '')",
        )
        .bind(session_id)
        .bind(event_type)
        .bind(user_identity)
        .bind(payload_json)
        .bind(&block_timestamp)
        .bind(&previous_hash)
        .execute(&mut *tx)
        .await?;

        let log_id = result.last_insert_rowid();
        let entry_hash = compute_entry_hash(
            log_id,
            session_id,
            event_type,
            user_identity,
            payload_json,
            &block_timestamp,
            previous_hash.as_deref(),
        );

        sqlx::query("UPDATE cryptographic_audit_trail SET entry_hash = ? WHERE log_id = ?")
            .bind(&entry_hash)
            .bind(log_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;

        Ok(AuditEntry {
            log_id,
            session_id: session_id.to_string(),
            event_type: event_type.to_string(),
            user_identity: user_identity.to_string(),
            payload_json: payload_json.to_string(),
            block_timestamp,
            previous_hash,
            entry_hash,
        })
    }

    pub async fn get_audit_trail(&self, session_id: &str) -> Result<Vec<AuditEntry>, DbError> {
        let rows = sqlx::query_as::<_, AuditEntry>(
            "SELECT log_id, session_id, event_type, user_identity, payload_json,
                    block_timestamp, previous_hash, entry_hash
             FROM cryptographic_audit_trail
             WHERE session_id = ? ORDER BY log_id ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    async fn full_trail(&self) -> Result<Vec<AuditEntry>, DbError> {
        let rows = sqlx::query_as::<_, AuditEntry>(
            "SELECT log_id, session_id, event_type, user_identity, payload_json,
                    block_timestamp, previous_hash, entry_hash
             FROM cryptographic_audit_trail ORDER BY log_id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Verify the entire (global) chain: previous_hash linkage plus a recompute
    /// of every entry_hash. Returns the first broken log_id if any.
    pub async fn verify_chain(&self) -> Result<ChainVerification, DbError> {
        let rows = self.full_trail().await?;
        let mut prev: Option<String> = None;
        for e in &rows {
            let linkage_ok = e.previous_hash.as_deref() == prev.as_deref();
            let recomputed = compute_entry_hash(
                e.log_id,
                &e.session_id,
                &e.event_type,
                &e.user_identity,
                &e.payload_json,
                &e.block_timestamp,
                e.previous_hash.as_deref(),
            );
            if !linkage_ok || recomputed != e.entry_hash {
                return Ok(ChainVerification {
                    valid: false,
                    entries: rows.len() as i64,
                    broken_at: Some(e.log_id),
                });
            }
            prev = Some(e.entry_hash.clone());
        }
        Ok(ChainVerification {
            valid: true,
            entries: rows.len() as i64,
            broken_at: None,
        })
    }
}

/// entry_hash = `sha256:` + hex(SHA-256(log_id ⋮ session_id ⋮ event_type ⋮
/// user_identity ⋮ payload_json ⋮ block_timestamp ⋮ previous_hash)), where ⋮ is
/// 0x1F and a NULL previous_hash is hashed as the empty string.
fn compute_entry_hash(
    log_id: i64,
    session_id: &str,
    event_type: &str,
    user_identity: &str,
    payload_json: &str,
    block_timestamp: &str,
    previous_hash: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    for field in [
        log_id.to_string().as_str(),
        session_id,
        event_type,
        user_identity,
        payload_json,
        block_timestamp,
        previous_hash.unwrap_or(""),
    ] {
        hasher.update(field.as_bytes());
        hasher.update(FIELD_SEP);
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

// ============================================================================
// Tauri IPC surface
// ============================================================================

#[tauri::command]
pub async fn create_session(state: State<'_, Db>, session: NewSession) -> Result<(), String> {
    state.create_session(&session).await.map_err(err)
}

#[tauri::command]
pub async fn update_session_state(
    state: State<'_, Db>,
    session_id: String,
    new_state: String,
) -> Result<(), String> {
    state
        .update_session_state(&session_id, &new_state)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn set_execution_path(
    state: State<'_, Db>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    state.set_execution_path(&session_id, &path).await.map_err(err)
}

#[tauri::command]
pub async fn get_session(
    state: State<'_, Db>,
    session_id: String,
) -> Result<Option<ReleaseSession>, String> {
    state.get_session(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn save_payload(state: State<'_, Db>, payload: ParsedPayload) -> Result<(), String> {
    state.save_payload(&payload).await.map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_cannaverify_result(
    state: State<'_, Db>,
    verify_id: String,
    session_id: String,
    check_type: String,
    metrc_facility_id: Option<String>,
    state_license_num: Option<String>,
    result: String,
    on_chain_tx: Option<String>,
) -> Result<(), String> {
    state
        .save_cannaverify_result(
            &verify_id,
            &session_id,
            &check_type,
            metrc_facility_id.as_deref(),
            state_license_num.as_deref(),
            &result,
            on_chain_tx.as_deref(),
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn save_docusign_envelope(
    state: State<'_, Db>,
    envelope_id: String,
    session_id: String,
    document_label: String,
    signers_json: String,
    provider: String,
) -> Result<(), String> {
    state
        .save_docusign_envelope(&envelope_id, &session_id, &document_label, &signers_json, &provider)
        .await
        .map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_docusign_envelope(
    state: State<'_, Db>,
    envelope_id: String,
    status: String,
    completed_at: Option<String>,
    certificate_hash: Option<String>,
    on_chain_tx: Option<String>,
    anchor_match: Option<i64>,
) -> Result<(), String> {
    state
        .update_docusign_envelope(
            &envelope_id,
            &status,
            completed_at.as_deref(),
            certificate_hash.as_deref(),
            on_chain_tx.as_deref(),
            anchor_match,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn save_registered_fingerprint(
    state: State<'_, Db>,
    hmac: String,
    session_id: String,
    asset_class: String,
    on_chain_tx: Option<String>,
) -> Result<(), String> {
    state
        .save_registered_fingerprint(&hmac, &session_id, &asset_class, on_chain_tx.as_deref())
        .await
        .map_err(err)
}

// ---- milestones — Path C ---------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_milestone(
    state: State<'_, Db>,
    session_id: String,
    milestone_id: String,
    label: String,
    description: String,
    amount_cents: i64,
    condition_type: String,
    release_date: Option<String>,
    evidence_required: Option<String>,
    sort_order: i32,
) -> Result<(), String> {
    state
        .create_milestone(
            &session_id,
            &milestone_id,
            &label,
            &description,
            amount_cents,
            &condition_type,
            release_date.as_deref(),
            evidence_required.as_deref(),
            sort_order,
        )
        .await
        .map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_milestone_status(
    state: State<'_, Db>,
    milestone_id: String,
    status: String,
    submitted_at: Option<String>,
    approved_at: Option<String>,
    released_at: Option<String>,
    tx_hash: Option<String>,
    evidence_hash: Option<String>,
) -> Result<(), String> {
    state
        .update_milestone_status(
            &milestone_id,
            &status,
            submitted_at.as_deref(),
            approved_at.as_deref(),
            released_at.as_deref(),
            tx_hash.as_deref(),
            evidence_hash.as_deref(),
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_milestones(
    state: State<'_, Db>,
    session_id: String,
) -> Result<Vec<MilestoneRow>, String> {
    state.get_milestones(&session_id).await.map_err(err)
}

// ---- arbitration — Path B --------------------------------------------------

#[tauri::command]
pub async fn create_arbitration(
    state: State<'_, Db>,
    session_id: String,
    arbiter_address: Option<String>,
    threshold: i32,
) -> Result<(), String> {
    state
        .create_arbitration(&session_id, arbiter_address.as_deref(), threshold)
        .await
        .map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_arbitration(
    state: State<'_, Db>,
    session_id: String,
    party1_signed: Option<bool>,
    party2_signed: Option<bool>,
    arbiter_signed: Option<bool>,
    resolved_at: Option<String>,
    resolution_tx_hash: Option<String>,
    resolution_notes: Option<String>,
) -> Result<(), String> {
    state
        .update_arbitration(
            &session_id,
            party1_signed,
            party2_signed,
            arbiter_signed,
            resolved_at.as_deref(),
            resolution_tx_hash.as_deref(),
            resolution_notes.as_deref(),
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_arbitration(
    state: State<'_, Db>,
    session_id: String,
) -> Result<Option<ArbitrationRow>, String> {
    state.get_arbitration(&session_id).await.map_err(err)
}

// ---- conditions — Stage 7 --------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_condition(
    state: State<'_, Db>,
    session_id: String,
    condition_id: String,
    condition_type: String,
    label: String,
    description: String,
    status: String,
    metadata_json: Option<String>,
) -> Result<(), String> {
    state
        .save_condition(
            &session_id,
            &condition_id,
            &condition_type,
            &label,
            &description,
            &status,
            metadata_json.as_deref(),
        )
        .await
        .map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_condition_status(
    state: State<'_, Db>,
    condition_id: String,
    status: String,
    met_at: Option<String>,
    failed_at: Option<String>,
    failure_reason: Option<String>,
    on_chain_tx: Option<String>,
) -> Result<(), String> {
    state
        .update_condition_status(
            &condition_id,
            &status,
            met_at.as_deref(),
            failed_at.as_deref(),
            failure_reason.as_deref(),
            on_chain_tx.as_deref(),
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_conditions(
    state: State<'_, Db>,
    session_id: String,
) -> Result<Vec<ConditionRow>, String> {
    state.get_conditions(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn log_event(
    state: State<'_, Db>,
    session_id: String,
    event_type: String,
    user_identity: String,
    payload_json: String,
) -> Result<AuditEntry, String> {
    state
        .append_audit(&session_id, &event_type, &user_identity, &payload_json)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_audit_trail(
    state: State<'_, Db>,
    session_id: String,
) -> Result<Vec<AuditEntry>, String> {
    state.get_audit_trail(&session_id).await.map_err(err)
}

#[tauri::command]
pub async fn verify_audit_chain(state: State<'_, Db>) -> Result<ChainVerification, String> {
    state.verify_chain().await.map_err(err)
}

fn err(e: DbError) -> String {
    e.to_string()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("lexescrow_test_{}.db", uuid::Uuid::new_v4()));
        Db::connect_and_migrate(&path).await.expect("db init")
    }

    fn new_session(id: &str) -> NewSession {
        NewSession {
            session_id: id.to_string(),
            client_id: "client-001".into(),
            attorney_bar_number: "123456".into(),
            document_hash: "sha256:deadbeef".into(),
            asset_class: "legal".into(),
            batch_id: None,
        }
    }

    #[tokio::test]
    async fn session_state_machine_roundtrips() {
        let db = temp_db().await;
        db.create_session(&new_session("s1")).await.unwrap();
        let s = db.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s.current_state, "LOADED");
        assert!(s.execution_path.is_none());

        db.update_session_state("s1", "APPROVED").await.unwrap();
        db.set_execution_path("s1", "DirectSettlement").await.unwrap();
        let s = db.get_session("s1").await.unwrap().unwrap();
        assert_eq!(s.current_state, "APPROVED");
        assert_eq!(s.execution_path.as_deref(), Some("DirectSettlement"));
    }

    #[tokio::test]
    async fn payload_persists_integer_cents() {
        let db = temp_db().await;
        db.create_session(&new_session("s2")).await.unwrap();
        db.save_payload(&ParsedPayload {
            payload_id: "p2".into(),
            session_id: "s2".into(),
            asset_class: "legal".into(),
            entry_mode: "ai".into(),
            total_held_cents: 500_000,
            earned_fees_cents: 80_000,
            unearned_balance_cents: 420_000,
            disputed_hours: 0.0,
            disputed_amount_cents: 0,
            payload_json: None,
        })
        .await
        .unwrap();
        let p = db.get_payload("s2").await.unwrap().unwrap();
        assert_eq!(p.earned_fees_cents + p.unearned_balance_cents, p.total_held_cents);
    }

    #[tokio::test]
    async fn audit_chain_links_and_verifies() {
        let db = temp_db().await;
        db.create_session(&new_session("s3")).await.unwrap();

        let e1 = db.append_audit("s3", "document_loaded", "para@firm.com", "{}").await.unwrap();
        let e2 = db.append_audit("s3", "acknowledgment_checked", "para@firm.com", "{}").await.unwrap();
        let e3 = db.append_audit("s3", "cre_execution_started", "para@firm.com", "{}").await.unwrap();

        // First entry has no predecessor; each subsequent links to the prior.
        assert!(e1.previous_hash.is_none());
        assert_eq!(e2.previous_hash.as_deref(), Some(e1.entry_hash.as_str()));
        assert_eq!(e3.previous_hash.as_deref(), Some(e2.entry_hash.as_str()));

        let v = db.verify_chain().await.unwrap();
        assert!(v.valid);
        assert_eq!(v.entries, 3);
        assert!(v.broken_at.is_none());
    }

    #[tokio::test]
    async fn milestone_lifecycle_preserves_earlier_timestamps() {
        let db = temp_db().await;
        db.create_session(&new_session("s5")).await.unwrap();
        db.create_milestone(
            "s5",
            "m1",
            "Due diligence complete",
            "Buyer completes review",
            250_000,
            "document",
            None,
            Some("Diligence memo"),
            0,
        )
        .await
        .unwrap();

        // submit → approve → release, each supplying only its own timestamp.
        db.update_milestone_status("m1", "submitted", Some("2026-07-18T10:00:00Z"), None, None, None, Some("sha256:eee"))
            .await
            .unwrap();
        db.update_milestone_status("m1", "approved", None, Some("2026-07-18T11:00:00Z"), None, None, None)
            .await
            .unwrap();
        db.update_milestone_status("m1", "released", None, None, Some("2026-07-18T12:00:00Z"), Some("0xmilestone-abc"), None)
            .await
            .unwrap();

        let rows = db.get_milestones("s5").await.unwrap();
        assert_eq!(rows.len(), 1);
        let m = &rows[0];
        assert_eq!(m.status, "released");
        assert_eq!(m.amount_cents, 250_000);
        // The whole point: releasing did not erase the submit/approve trail.
        assert_eq!(m.submitted_at.as_deref(), Some("2026-07-18T10:00:00Z"));
        assert_eq!(m.approved_at.as_deref(), Some("2026-07-18T11:00:00Z"));
        assert_eq!(m.released_at.as_deref(), Some("2026-07-18T12:00:00Z"));
        assert_eq!(m.evidence_hash.as_deref(), Some("sha256:eee"));
        assert_eq!(m.tx_hash.as_deref(), Some("0xmilestone-abc"));
    }

    #[tokio::test]
    async fn milestones_come_back_in_definition_order() {
        let db = temp_db().await;
        db.create_session(&new_session("s6")).await.unwrap();
        for (id, order) in [("m-c", 2), ("m-a", 0), ("m-b", 1)] {
            db.create_milestone("s6", id, "L", "D", 100, "manual", None, None, order)
                .await
                .unwrap();
        }
        let ids: Vec<String> = db
            .get_milestones("s6")
            .await
            .unwrap()
            .into_iter()
            .map(|m| m.milestone_id)
            .collect();
        assert_eq!(ids, vec!["m-a", "m-b", "m-c"]);
    }

    #[tokio::test]
    async fn arbitration_signatures_accumulate() {
        let db = temp_db().await;
        db.create_session(&new_session("s7")).await.unwrap();
        assert!(db.get_arbitration("s7").await.unwrap().is_none());

        db.create_arbitration("s7", Some("0xarbiter"), 2).await.unwrap();
        let a = db.get_arbitration("s7").await.unwrap().unwrap();
        assert!(a.locked_at.is_some(), "locking must stamp locked_at");
        assert_eq!(a.threshold, 2);
        assert_eq!((a.party1_signed, a.party2_signed, a.arbiter_signed), (0, 0, 0));

        db.update_arbitration("s7", Some(true), None, None, None, None, None).await.unwrap();
        db.update_arbitration("s7", None, Some(true), None, None, None, None).await.unwrap();

        let a = db.get_arbitration("s7").await.unwrap().unwrap();
        // Party 2 signing must not have cleared party 1 — else 2-of-3 is unreachable.
        assert_eq!(a.party1_signed, 1);
        assert_eq!(a.party2_signed, 1);
        assert_eq!(a.arbiter_signed, 0);

        db.update_arbitration("s7", None, None, None, Some("2026-07-18T12:00:00Z"), Some("0xarb-resolve-1234"), Some("split agreed"))
            .await
            .unwrap();
        let a = db.get_arbitration("s7").await.unwrap().unwrap();
        assert_eq!(a.resolution_tx_hash.as_deref(), Some("0xarb-resolve-1234"));
        assert_eq!(a.party1_signed, 1);
    }

    #[tokio::test]
    async fn condition_status_survives_a_rebuild_upsert() {
        let db = temp_db().await;
        db.create_session(&new_session("s8")).await.unwrap();

        db.save_condition(
            "s8",
            "s8-esign-env1",
            "esign",
            "All parties signed — Retainer",
            "Signature collection via DocuSign for 2 required signers.",
            "pending",
            Some(r#"{"envelopeId":"env1"}"#),
        )
        .await
        .unwrap();

        db.update_condition_status(
            "s8-esign-env1",
            "met",
            Some("2026-07-18T10:00:00Z"),
            None,
            None,
            Some("0xanchor-esign-1234"),
        )
        .await
        .unwrap();

        // The poll loop re-derives and re-saves the whole checklist every tick.
        // That must not walk the condition back to `pending`.
        db.save_condition(
            "s8",
            "s8-esign-env1",
            "esign",
            "All parties signed — Retainer",
            "Signature collection via DocuSign for 2 required signers.",
            "pending",
            Some(r#"{"envelopeId":"env1","certificateHash":"sha256:abc"}"#),
        )
        .await
        .unwrap();

        let rows = db.get_conditions("s8").await.unwrap();
        assert_eq!(rows.len(), 1, "upsert must not duplicate the row");
        let c = &rows[0];
        assert_eq!(c.status, "met", "re-save must not clobber a resolved status");
        assert_eq!(c.met_at.as_deref(), Some("2026-07-18T10:00:00Z"));
        assert_eq!(c.on_chain_tx.as_deref(), Some("0xanchor-esign-1234"));
        // Descriptive fields *do* refresh — new evidence arrived.
        assert!(c.metadata_json.as_deref().unwrap().contains("certificateHash"));

        // Waiving preserves the earlier met_at — the audit needs both facts.
        db.update_condition_status("s8-esign-env1", "waived", None, None, Some("counterparty absent"), None)
            .await
            .unwrap();
        let c = &db.get_conditions("s8").await.unwrap()[0];
        assert_eq!(c.status, "waived");
        assert_eq!(c.met_at.as_deref(), Some("2026-07-18T10:00:00Z"));
        assert_eq!(c.failure_reason.as_deref(), Some("counterparty absent"));
    }

    #[tokio::test]
    async fn conditions_are_scoped_to_their_session() {
        let db = temp_db().await;
        db.create_session(&new_session("s9")).await.unwrap();
        db.create_session(&new_session("s10")).await.unwrap();

        for (session, id) in [("s9", "s9-bar"), ("s9", "s9-doc-0"), ("s10", "s10-bar")] {
            db.save_condition(session, id, "bar_verify", "L", "D", "pending", None)
                .await
                .unwrap();
        }

        assert_eq!(db.get_conditions("s9").await.unwrap().len(), 2);
        assert_eq!(db.get_conditions("s10").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn tampering_breaks_the_chain() {
        let db = temp_db().await;
        db.create_session(&new_session("s4")).await.unwrap();
        db.append_audit("s4", "document_loaded", "u", "{}").await.unwrap();
        let target = db.append_audit("s4", "acknowledgment_checked", "u", "{\"ok\":true}").await.unwrap();
        db.append_audit("s4", "cre_execution_started", "u", "{}").await.unwrap();

        // Tamper with the stored payload of the middle entry.
        sqlx::query("UPDATE cryptographic_audit_trail SET payload_json = ? WHERE log_id = ?")
            .bind("{\"ok\":false}")
            .bind(target.log_id)
            .execute(&db.pool)
            .await
            .unwrap();

        let v = db.verify_chain().await.unwrap();
        assert!(!v.valid);
        assert_eq!(v.broken_at, Some(target.log_id));
    }
}
