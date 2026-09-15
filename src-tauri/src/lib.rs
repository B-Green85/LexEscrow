//! LexEscrow Tauri backend entrypoint.
//!
//! Wires the Rust integrity/persistence/notification layers to the WebView via
//! IPC commands. Managed state:
//!   * `ArtifactGuardState` — session-scoped SHA-256 registry (Phase 2).
//!   * `Db`                  — SQLite pool + hash-chained audit trail (Phase 3).
//!   * `DebugConsoleState`   — LexTrace command alternation + run guard.

mod adapters;
mod ai;
mod artifact_guard;
mod blockchain_write_auth;
mod clio;
mod cre;
mod cre_trigger;
mod credential_store;
mod db;
mod debug_console;
mod docusign;
mod esign_callback;
mod extractor;
mod integrations;
mod menu;
mod notify;
mod store_config;
mod vault;

use std::sync::Arc;

use artifact_guard::ArtifactGuardState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load SMTP / Twilio config from a local .env if present (optional).
    let _ = dotenvy::dotenv();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ArtifactGuardState::new())
        .setup(|app| {
            // Open (and migrate) the SQLite database under the app data dir.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("lexescrow.db");
            let db = tauri::async_runtime::block_on(db::Db::connect_and_migrate(&db_path))?;
            app.manage(db);

            // Credential storage. The vault is always constructed — unopened it
            // is just a path — so switching backends or migrating away from one
            // an earlier launch created never has to build it mid-flight.
            //
            // The active backend comes from the plain config file, which is
            // readable before any store is open (that is the whole reason it is
            // not itself a credential). No file means first launch: state stays
            // unselected and the frontend runs `CredentialStoreSelector`.
            let store_state =
                credential_store::CredentialStoreState::new(Arc::new(vault::VaultState::new(&data_dir)));
            credential_store::init_from_config(&store_state, &data_dir);
            app.manage(store_state);

            // Loopback listener for DocuSign's embedded-signing return URL.
            // Bound to 127.0.0.1 only — the sole client is a WebView on this
            // machine following a redirect (see esign_callback.rs).
            app.manage(esign_callback::spawn(app.handle().clone()));

            // Clio Manage OAuth. Holds only the pending authorization's CSRF
            // nonce and the handle that closes its loopback listener — the
            // tokens live in the credential store like every other secret.
            app.manage(clio::ClioState::new());

            // LexTrace. Holds only which of the two CRE commands runs next and
            // a one-run-at-a-time guard — everything the console can actually
            // reach lives in the Db and credential-store states above.
            app.manage(debug_console::DebugConsoleState::new());

            // Native application menu. The two custom File items emit events
            // the WebView turns into session-store actions (see menu.rs).
            app.set_menu(menu::build(app.handle())?)?;
            app.on_menu_event(menu::handle_event);
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
            artifact_guard::save_audit_report,
            // Persistence + audit
            db::create_session,
            db::update_session_state,
            db::set_execution_path,
            db::get_session,
            db::get_recent_sessions,
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
            // Credential store — backend selection and migration
            credential_store::get_store_backend,
            credential_store::set_store_backend,
            credential_store::check_os_keychain,
            credential_store::migrate_credentials,
            credential_store::get_credential_masked,
            credential_store::set_credential,
            credential_store::delete_credential,
            // Vault lifecycle (App Vault backend)
            credential_store::vault_status,
            credential_store::vault_unlock,
            credential_store::vault_lock,
            credential_store::vault_change_password,
            // Credentials — routed through whichever backend is active
            credential_store::vault_get_public,
            credential_store::vault_set_ai,
            credential_store::vault_set_smtp,
            credential_store::vault_set_twilio,
            credential_store::vault_set_docusign,
            credential_store::vault_get_docusign_public,
            credential_store::vault_has_docusign,
            credential_store::vault_delete,
            // Blockchain settlement config (replaces contracts/.env).
            // The write goes through one gated command — `set_credential`
            // refuses this group, so there is no ungated path to the key.
            credential_store::set_blockchain_credential,
            credential_store::has_blockchain_write_auth,
            credential_store::change_blockchain_write_auth,
            credential_store::vault_get_blockchain_public,
            credential_store::vault_has_blockchain,
            // LexTrace debug console (read-only CRE observation)
            credential_store::vault_set_debug_console,
            credential_store::vault_get_debug_console_public,
            credential_store::vault_has_debug_console,
            credential_store::debug_console_authenticate,
            debug_console::run_cre_debug,
            cre::get_cre_config,
            cre::execute_direct_settle,
            cre::get_usdc_price,
            cre_trigger::trigger_cre_workflow,
            // Practice-management integrations (Clio / PracticePanther)
            credential_store::vault_set_clio,
            credential_store::vault_get_clio_public,
            // Clio Manage — read-only matter intake over OAuth 2.0
            clio::clio_get_auth_url,
            clio::clio_exchange_code,
            clio::clio_refresh_token,
            clio::clio_check_connection,
            clio::clio_disconnect,
            clio::clio_fetch_matter,
            clio::clio_search_matters,
            credential_store::vault_set_practice_panther,
            credential_store::vault_get_practice_panther_public,
            integrations::integration_send_webhook,
            // External adapter HTTP calls (backend-issued, no WebView CORS)
            adapters::verify_bar_number,
            // Document text extraction (field suggestion at Document Load)
            extractor::extract_document_text,
            extractor::extract_document_text_bytes,
            // AI provider transport
            ai::ai_request_http,
            ai::ai_request_ws,
            // DocuSign eSign
            docusign::docusign_send_envelope,
            docusign::docusign_poll_status,
            docusign::docusign_get_certificate,
            docusign::docusign_get_embedded_signing_url,
            docusign::docusign_list_recipients,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Built rather than `run()` directly so the embedded-signing listener can
    // be closed on exit instead of holding port 55432 until the process dies.
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(server) = app_handle.try_state::<esign_callback::CallbackServer>() {
                server.shutdown();
            }
        }
    });
}
