#!/bin/bash
# LexEscrow Demo Reset — wipes session state for a clean demo run.
#
# Deletes in reverse foreign-key order: every table that references
# release_sessions goes first, so the final delete cannot fail on a constraint.
# The credential vault is deliberately NOT touched — it holds the AnchorReceipt
# seal key, and dropping that would orphan every receipt this install has ever
# issued.

set -e

echo "Resetting LexEscrow demo state..."

# Find the SQLite database (macOS first, then Linux).
DB_PATH="$HOME/Library/Application Support/com.lexescrow.app/lexescrow.db"
if [ ! -f "$DB_PATH" ]; then
  DB_PATH="$HOME/.local/share/com.lexescrow.app/lexescrow.db"
fi
if [ ! -f "$DB_PATH" ]; then
  echo "Database not found — may not have been initialized yet."
  echo "Launch LexEscrow once to initialize, then run this script."
  exit 0
fi

if ! command -v sqlite3 > /dev/null 2>&1; then
  echo "❌ sqlite3 is not installed — cannot clear the database."
  echo "   macOS: it ships with the system. Linux: apt install sqlite3"
  exit 1
fi

sqlite3 "$DB_PATH" "
  DELETE FROM session_conditions;
  DELETE FROM cannaverify_results;
  DELETE FROM docusign_envelopes;
  DELETE FROM registered_fingerprints;
  DELETE FROM cryptographic_audit_trail;
  DELETE FROM parsed_payloads;
  DELETE FROM milestones;
  DELETE FROM arbitration_state;
  DELETE FROM release_sessions;
"

echo "✅ Database cleared."

# Reset mock adapter state (envelopes issued during the previous run).
if curl -s -f -X POST http://localhost:3003/reset > /dev/null 2>&1; then
  echo "✅ DocuSign mock adapter reset."
else
  echo "ℹ️  DocuSign mock adapter not running (start with npm run demo)."
fi

echo ""
echo "Demo state reset complete. Ready for a fresh run."
echo "Start mock adapters: npm run demo"
