//! LexEscrow Tauri backend entrypoint.
//!
//! Wires the Rust integrity/persistence/notification layers to the WebView via
//! IPC commands. Managed state:
//!   * `ArtifactGuardState` — session-scoped SHA-256 registry (Phase 2).
//!   * `Db`                  — SQLite pool + hash-chained audit trail (Phase 3).

mod ai;
mod artifact_guard;
mod db;
mod docusign;
mod notify;
mod vault;

use artifact_guard::ArtifactGuardState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load SMTP / Twilio config from a local .env if present (optional).
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ArtifactGuardState::new())
        .setup(|app| {
            // Open (and migrate) the SQLite database under the app data dir.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("lexescrow.db");
            let db = tauri::async_runtime::block_on(db::Db::connect_and_migrate(&db_path))?;
            app.manage(db);

            // Credential vault (locked until the user provides a password).
            app.manage(vault::VaultState::new(&data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ArtifactGuard
            artifact_guard::load_artifact,
            artifact_guard::register_artifact,
            artifact_guard::verify_artifact,
            artifact_guard::final_verify_before_execution,
            artifact_guard::normalize_text,
            artifact_guard::compute_hmac_seal,
            // Persistence + audit
            db::create_session,
            db::update_session_state,
            db::set_execution_path,
            db::get_session,
            db::save_payload,
            db::save_cannaverify_result,
            db::save_docusign_envelope,
            db::update_docusign_envelope,
            db::save_registered_fingerprint,
            // Release paths — Path C milestones, Path B arbitration
            db::create_milestone,
            db::update_milestone_status,
            db::get_milestones,
            db::create_arbitration,
            db::update_arbitration,
            db::get_arbitration,
            // Condition tracking — Stage 7 Escrow Monitor
            db::save_condition,
            db::update_condition_status,
            db::get_conditions,
            db::log_event,
            db::get_audit_trail,
            db::verify_audit_chain,
            // Notifications
            notify::send_client_notification,
            // Credential vault
            vault::vault_status,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_get_public,
            vault::vault_set_ai,
            vault::vault_set_smtp,
            vault::vault_set_twilio,
            vault::vault_set_docusign,
            vault::vault_get_docusign_public,
            vault::vault_has_docusign,
            vault::vault_delete,
            vault::vault_change_password,
            // AI provider transport
            ai::ai_request_http,
            ai::ai_request_ws,
            // DocuSign eSign
            docusign::docusign_send_envelope,
            docusign::docusign_poll_status,
            docusign::docusign_get_certificate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
