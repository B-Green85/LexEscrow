//! LexEscrow Tauri backend entrypoint.
//!
//! Wires the Rust integrity/persistence/notification layers to the WebView via
//! IPC commands. Managed state:
//!   * `ArtifactGuardState` — session-scoped SHA-256 registry (Phase 2).
//!   * `Db`                  — SQLite pool + hash-chained audit trail (Phase 3).

mod artifact_guard;
mod db;
mod notify;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ArtifactGuard
            artifact_guard::load_artifact,
            artifact_guard::register_artifact,
            artifact_guard::verify_artifact,
            artifact_guard::final_verify_before_execution,
            artifact_guard::normalize_text,
            // Persistence + audit
            db::create_session,
            db::update_session_state,
            db::set_execution_path,
            db::get_session,
            db::save_payload,
            db::log_event,
            db::get_audit_trail,
            db::verify_audit_chain,
            // Notifications
            notify::send_client_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
