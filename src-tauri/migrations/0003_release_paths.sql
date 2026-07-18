-- 0003 — Release paths B and C (spec §6).
--
-- Adds the two tables the non-direct release paths need:
--   * `milestones`        — Path C StagedRelease, one row per partial release.
--   * `arbitration_state` — Path B ArbitrationEscrow, one row per session
--                           holding the 2-of-3 multi-sig tally.
--
-- Both are pure additions: no existing table is rebuilt, so unlike 0002 this
-- migration needs no foreign-key dance. `release_sessions.execution_path`
-- already admits 'StagedRelease' (added by 0002), so nothing there changes.
--
-- Money is integer cents (INTEGER), consistent with `parsed_payloads`.

-- Milestone tracking for Path C (Staged Release)
CREATE TABLE IF NOT EXISTS milestones (
    milestone_id        TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL,
    label               TEXT NOT NULL,
    description         TEXT NOT NULL,
    amount_cents        INTEGER NOT NULL,
    condition_type      TEXT CHECK(condition_type IN
                          ('document','time','event','manual'))
                        DEFAULT 'manual',
    release_date        TEXT,
    evidence_required   TEXT,
    status              TEXT CHECK(status IN
                          ('pending','submitted','approved',
                           'released','disputed'))
                        DEFAULT 'pending',
    sort_order          INTEGER NOT NULL DEFAULT 0,
    submitted_at        TIMESTAMP,
    approved_at         TIMESTAMP,
    released_at         TIMESTAMP,
    tx_hash             TEXT,
    evidence_hash       TEXT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES release_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_milestones_session
    ON milestones(session_id);

-- Arbitration state for Path B
CREATE TABLE IF NOT EXISTS arbitration_state (
    session_id          TEXT PRIMARY KEY,
    locked_at           TIMESTAMP,
    arbiter_address     TEXT,
    party1_signed       INTEGER DEFAULT 0,
    party2_signed       INTEGER DEFAULT 0,
    arbiter_signed      INTEGER DEFAULT 0,
    threshold           INTEGER DEFAULT 2,
    resolved_at         TIMESTAMP,
    resolution_tx_hash  TEXT,
    resolution_notes    TEXT,
    FOREIGN KEY(session_id) REFERENCES release_sessions(session_id)
);
