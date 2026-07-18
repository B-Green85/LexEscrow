-- 0002 — Asset class abstraction.
--
-- Extends the schema for seven asset classes (platform spec §4/§13):
--   release_sessions   + asset_class, batch_id, anchor_tx; execution_path and
--                        current_state CHECKs gain StagedRelease / VERIFYING /
--                        FUNDED.
--   parsed_payloads    + asset_class, entry_mode, payload_json.
--   new tables         cannaverify_results, docusign_envelopes,
--                        registered_fingerprints.
--
-- SQLite cannot ALTER a CHECK constraint, so the two constrained tables are
-- rebuilt. Rebuilding a parent means DROP TABLE release_sessions, whose implicit
-- row delete would trip cryptographic_audit_trail's (unmodifiable) FK back to
-- it. `PRAGMA defer_foreign_keys=ON` defers ALL FK enforcement to COMMIT — and
-- unlike `PRAGMA foreign_keys`, it is honoured *inside* a transaction, which is
-- what sqlx wraps every migration in. By commit time every session_id has been
-- copied into the rebuilt table, so no constraint is actually violated. This is
-- SQLite's documented procedure for schema changes. audit_trail is untouched.
PRAGMA defer_foreign_keys = ON;

-- ── 1. New parent (expanded CHECKs + asset_class / batch_id / anchor_tx) ──────
CREATE TABLE release_sessions_new (
    session_id          TEXT PRIMARY KEY,
    client_id           TEXT NOT NULL,
    attorney_bar_number TEXT NOT NULL,
    document_hash       TEXT NOT NULL,
    asset_class         TEXT NOT NULL DEFAULT 'legal',
    anchor_tx           TEXT,                    -- AnchorReceipt on-chain registration tx
    batch_id            TEXT,
    execution_path      TEXT CHECK(execution_path IN
                          ('DirectSettlement', 'ArbitrationEscrow', 'StagedRelease')),
    current_state       TEXT CHECK(current_state IN
                          ('LOADED', 'PARSING', 'ESCALATED', 'APPROVED',
                           'FUNDED', 'VERIFYING', 'EXECUTED', 'FAILED'))
                        DEFAULT 'LOADED',
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO release_sessions_new
    (session_id, client_id, attorney_bar_number, document_hash,
     execution_path, current_state, created_at, updated_at)
SELECT session_id, client_id, attorney_bar_number, document_hash,
       execution_path, current_state, created_at, updated_at
FROM release_sessions;

-- ── 2. New child referencing the NEW parent (avoids cascade on the old drop) ──
CREATE TABLE parsed_payloads_new (
    payload_id              TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL,
    asset_class             TEXT NOT NULL DEFAULT 'legal',
    entry_mode              TEXT CHECK(entry_mode IN ('ai', 'manual')),
    total_held_cents        INTEGER NOT NULL,
    earned_fees_cents       INTEGER NOT NULL DEFAULT 0,
    unearned_balance_cents  INTEGER NOT NULL DEFAULT 0,
    disputed_hours          REAL    DEFAULT 0.0,
    disputed_amount_cents   INTEGER DEFAULT 0,
    payload_json            TEXT,               -- full asset-class payload (any class)
    -- References the FINAL parent name. With foreign_keys OFF during this
    -- migration the reference is not resolved until after the rename below, at
    -- which point `release_sessions` is the rebuilt table.
    FOREIGN KEY(session_id)
        REFERENCES release_sessions(session_id)
        ON DELETE CASCADE
);

INSERT INTO parsed_payloads_new
    (payload_id, session_id, total_held_cents, earned_fees_cents,
     unearned_balance_cents, disputed_hours, disputed_amount_cents)
SELECT payload_id, session_id, total_held_cents, earned_fees_cents,
       unearned_balance_cents, disputed_hours, disputed_amount_cents
FROM parsed_payloads;

-- ── 3. Drop old (child first; old parent then has no referencing child) ──────
DROP TABLE parsed_payloads;
DROP TABLE release_sessions;

-- ── 4. Rename into place. parsed_payloads_new already targets the final name
--        `release_sessions`, which this rename brings back into existence. ────
ALTER TABLE release_sessions_new RENAME TO release_sessions;
ALTER TABLE parsed_payloads_new  RENAME TO parsed_payloads;

-- ── 5. Recreate the trigger + index dropped with the old tables ─────────────
CREATE TRIGGER IF NOT EXISTS update_session_timestamp
AFTER UPDATE ON release_sessions
BEGIN
    UPDATE release_sessions
    SET updated_at = CURRENT_TIMESTAMP
    WHERE session_id = NEW.session_id;
END;

CREATE INDEX IF NOT EXISTS idx_parsed_payloads_session
    ON parsed_payloads(session_id);
CREATE INDEX IF NOT EXISTS idx_release_sessions_batch
    ON release_sessions(batch_id);

-- ── 6. CannaVerify results (spec §5/§13) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS cannaverify_results (
    verify_id           TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    check_type          TEXT NOT NULL,
    metrc_facility_id   TEXT,
    state_license_num   TEXT,
    result              TEXT CHECK(result IN ('PASS', 'FAIL', 'ERROR')),
    on_chain_tx         TEXT,
    verified_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES release_sessions(session_id)
);

-- ── 7. DocuSign envelopes (spec §21) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS docusign_envelopes (
    envelope_id       TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    document_label    TEXT NOT NULL,
    signers_json      TEXT NOT NULL,
    status            TEXT CHECK(status IN ('SENT', 'DELIVERED', 'COMPLETED', 'DECLINED', 'VOIDED'))
                      DEFAULT 'SENT',
    provider          TEXT NOT NULL DEFAULT 'docusign',
    sent_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at      TIMESTAMP,
    certificate_hash  TEXT,
    on_chain_tx       TEXT,
    anchor_match      INTEGER,               -- 1 = pass, 0 = fail, NULL = pending
    FOREIGN KEY(session_id) REFERENCES release_sessions(session_id)
);

-- ── 8. AnchorReceipt registered fingerprints (spec §8/§13) ──────────────────
CREATE TABLE IF NOT EXISTS registered_fingerprints (
    hmac            TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    asset_class     TEXT NOT NULL,
    on_chain_tx     TEXT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES release_sessions(session_id)
);
