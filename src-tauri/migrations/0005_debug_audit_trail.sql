-- 0005 — LexTrace debug audit trail.
--
-- Every line the LexTrace debug console shows an IT operator is recorded here,
-- hash-chained the same way `cryptographic_audit_trail` is: each entry's
-- SHA-256 covers the previous entry's hash, so a tampered row breaks the chain
-- from that point forward.
--
-- Deliberately a *second*, independent chain rather than more rows in the
-- existing one. The two answer different questions and have different
-- retention pressure: the cryptographic trail is the legal record of what was
-- decided about a client's money, and it is verified end-to-end as a unit. A
-- debug console polling a CLI every three seconds would bury that record under
-- thousands of operational lines, and one truncated debug run would then break
-- the legal chain. Separate tables, separate chains, no interference.
--
-- `session_id` is nullable and carries no foreign key, unlike its counterpart
-- in the cryptographic trail. Debug observation is not part of a release
-- workflow — an operator opens the console to look at the DON, usually with no
-- escrow session open at all — so requiring a session would mean inventing one.
--
-- A pure addition: no existing table is read, rebuilt or referenced, so no
-- foreign-key dance is needed (cf. 0002).

CREATE TABLE IF NOT EXISTS debug_audit_trail (
    log_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT,
    operator_id     TEXT NOT NULL,
    command         TEXT NOT NULL,
    output_line     TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    previous_hash   TEXT,   -- NULL for the first entry only
    entry_hash      TEXT NOT NULL
);

-- The console reads back newest-first and filters by operator when an install
-- has more than one; both are covered by the primary key and this index.
CREATE INDEX IF NOT EXISTS idx_debug_audit_operator
    ON debug_audit_trail(operator_id);
