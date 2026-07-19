-- 0004 — Session condition tracking (spec §6 Stage 7).
--
-- One row per release condition, of any type, for any asset class. The
-- heterogeneous per-type detail (document hash, envelope id, signer statuses,
-- CannaVerify result) lives in `metadata_json` rather than in seven sparse
-- columns: the condition engine reads the type-specific fields as a unit, and
-- a wide sparse table would make every new condition type a schema migration.
--
-- Like 0003 this is a pure addition — no existing table is rebuilt, so no
-- foreign-key dance is needed.

CREATE TABLE IF NOT EXISTS session_conditions (
    condition_id    TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    condition_type  TEXT NOT NULL,
    label           TEXT NOT NULL,
    description     TEXT NOT NULL,
    status          TEXT CHECK(status IN
                      ('pending','in_progress','met','failed','waived'))
                    DEFAULT 'pending',
    metadata_json   TEXT,           -- type-specific metadata as JSON
    met_at          TIMESTAMP,
    failed_at       TIMESTAMP,
    failure_reason  TEXT,
    on_chain_tx     TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES release_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_conditions_session
    ON session_conditions(session_id);

CREATE TRIGGER IF NOT EXISTS update_condition_timestamp
AFTER UPDATE ON session_conditions
BEGIN
    UPDATE session_conditions
    SET updated_at = CURRENT_TIMESTAMP
    WHERE condition_id = NEW.condition_id;
END;
