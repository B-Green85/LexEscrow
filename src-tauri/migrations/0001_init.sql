-- LexEscrow schema — three tables persist session state, LexGuard-validated
-- payload data, and the cryptographic audit trail.
--
-- Invariants:
--   * All financial values are stored as INTEGER cents. No floating point in
--     the persistence layer (disputed_hours is the only REAL — it is a count of
--     hours, not money).
--   * release_sessions.current_state is a CHECK-constrained state machine.
--   * cryptographic_audit_trail is append-only and hash-chained: each entry's
--     entry_hash covers the previous entry's hash, so a tampered row breaks the
--     chain from that point forward.

-- ---------------------------------------------------------------------------
-- Retainer release sessions — one row per workflow execution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS release_sessions (
    session_id          TEXT PRIMARY KEY,
    client_id           TEXT NOT NULL,
    attorney_bar_number TEXT NOT NULL,
    document_hash       TEXT NOT NULL,
    execution_path      TEXT CHECK(execution_path IN
                          ('DirectSettlement', 'ArbitrationEscrow')),
    current_state       TEXT CHECK(current_state IN
                          ('LOADED', 'PARSING', 'ESCALATED',
                           'APPROVED', 'EXECUTED', 'FAILED'))
                        DEFAULT 'LOADED',
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Touch updated_at on every mutation. SQLite runs with recursive_triggers OFF
-- by default, so the inner UPDATE does not re-fire this trigger.
CREATE TRIGGER IF NOT EXISTS update_session_timestamp
AFTER UPDATE ON release_sessions
BEGIN
    UPDATE release_sessions
    SET updated_at = CURRENT_TIMESTAMP
    WHERE session_id = NEW.session_id;
END;

-- ---------------------------------------------------------------------------
-- LexGuard-validated payload — all financials in integer cents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parsed_payloads (
    payload_id              TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL,
    total_held_cents        INTEGER NOT NULL,
    earned_fees_cents       INTEGER NOT NULL,
    unearned_balance_cents  INTEGER NOT NULL,
    disputed_hours          REAL    DEFAULT 0.0,
    disputed_amount_cents   INTEGER DEFAULT 0,
    FOREIGN KEY(session_id)
        REFERENCES release_sessions(session_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_parsed_payloads_session
    ON parsed_payloads(session_id);

-- ---------------------------------------------------------------------------
-- Hash-chained append-only audit trail.
--
-- entry_hash = SHA-256(log_id ⋮ session_id ⋮ event_type ⋮ user_identity ⋮
--              payload_json ⋮ block_timestamp ⋮ previous_hash)
-- where ⋮ is the ASCII Unit Separator (0x1F), and previous_hash is the empty
-- string for the first entry (NULL column). Chaining is GLOBAL across the whole
-- table: exactly one entry (log_id = 1) has a NULL previous_hash.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cryptographic_audit_trail (
    log_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    event_type      TEXT    NOT NULL,
    user_identity   TEXT    NOT NULL,
    payload_json    TEXT    NOT NULL,
    block_timestamp TEXT    NOT NULL,
    previous_hash   TEXT,   -- NULL for the first entry only
    entry_hash      TEXT    NOT NULL,
    FOREIGN KEY(session_id)
        REFERENCES release_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_session
    ON cryptographic_audit_trail(session_id);
