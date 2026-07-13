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
use sqlx::SqlitePool;
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
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPayload {
    pub payload_id: String,
    pub session_id: String,
    pub total_held_cents: i64,
    pub earned_fees_cents: i64,
    pub unearned_balance_cents: i64,
    #[serde(default)]
    pub disputed_hours: f64,
    #[serde(default)]
    pub disputed_amount_cents: i64,
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
    /// Open (creating if needed) the SQLite database at `path`, enable WAL and
    /// foreign keys, and run migrations.
    pub async fn connect_and_migrate(path: &Path) -> Result<Self, DbError> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Self {
            pool,
            append_lock: Mutex::new(()),
        })
    }

    // ---- sessions --------------------------------------------------------

    pub async fn create_session(&self, s: &NewSession) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO release_sessions
                (session_id, client_id, attorney_bar_number, document_hash, current_state)
             VALUES (?, ?, ?, ?, 'LOADED')",
        )
        .bind(&s.session_id)
        .bind(&s.client_id)
        .bind(&s.attorney_bar_number)
        .bind(&s.document_hash)
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
                (payload_id, session_id, total_held_cents, earned_fees_cents,
                 unearned_balance_cents, disputed_hours, disputed_amount_cents)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(payload_id) DO UPDATE SET
                total_held_cents       = excluded.total_held_cents,
                earned_fees_cents      = excluded.earned_fees_cents,
                unearned_balance_cents = excluded.unearned_balance_cents,
                disputed_hours         = excluded.disputed_hours,
                disputed_amount_cents  = excluded.disputed_amount_cents",
        )
        .bind(&p.payload_id)
        .bind(&p.session_id)
        .bind(p.total_held_cents)
        .bind(p.earned_fees_cents)
        .bind(p.unearned_balance_cents)
        .bind(p.disputed_hours)
        .bind(p.disputed_amount_cents)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    #[allow(dead_code)] // read back by later phases; part of the persistence API
    pub async fn get_payload(&self, session_id: &str) -> Result<Option<ParsedPayload>, DbError> {
        let row = sqlx::query_as::<_, ParsedPayload>(
            "SELECT payload_id, session_id, total_held_cents, earned_fees_cents,
                    unearned_balance_cents, disputed_hours, disputed_amount_cents
             FROM parsed_payloads WHERE session_id = ? LIMIT 1",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
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
            total_held_cents: 500_000,
            earned_fees_cents: 80_000,
            unearned_balance_cents: 420_000,
            disputed_hours: 0.0,
            disputed_amount_cents: 0,
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
