//! Native application menu (spec §12 Screen 9).
//!
//! Two custom File items — New Transaction and Recent Workflows — alongside the
//! standard submenus. The standard ones are reproduced here rather than
//! inherited: `set_menu` *replaces* the menu Tauri installs by default, so a
//! menu containing only File would cost the officer Quit, Hide and, on macOS,
//! Cut/Copy/Paste. A WebView gets those shortcuts from the menu bar, not from
//! the system, so dropping the Edit submenu silently breaks clipboard support
//! in every text field in the app.
//!
//! Neither custom item touches the backend. Each emits an event the WebView
//! translates into a session-store action, because the screens they open are
//! frontend state — the menu is an input device for the store, not a second
//! controller for the workflow.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Item ids, shared with [`handle_event`] so the two cannot drift apart.
const NEW_TRANSACTION: &str = "new_transaction";
const RECENT_WORKFLOWS: &str = "recent_workflows";
const SETUP_WIZARD: &str = "setup_wizard";

/// Build the application menu.
///
/// Mirrors `Menu::default` for everything except File, which gains the two
/// LexEscrow items above the standard Close Window.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(
                app,
                NEW_TRANSACTION,
                "New Transaction",
                true,
                Some("CmdOrCtrl+N"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                RECENT_WORKFLOWS,
                "Recent Workflows...",
                true,
                Some("CmdOrCtrl+R"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            // No accelerator: this re-runs onboarding, and the two flows either
            // side of it own the obvious File-menu chords already.
            &MenuItem::with_id(app, SETUP_WIZARD, "Setup Wizard...", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            // macOS puts Quit in the app submenu; everywhere else it belongs here.
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            // On macOS About lives in the app submenu below, and the metadata
            // moves with it — exactly one of the two branches compiles.
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &file_menu,
            &edit_menu,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Translate a menu click into a WebView event.
///
/// Predefined items are handled by the OS and never reach here with an id we
/// recognize. A failed emit means no WebView is listening — there is nothing to
/// recover and nothing worth halting the app over, so it is logged and dropped.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let topic = match event.id().as_ref() {
        NEW_TRANSACTION => "menu:new_transaction",
        RECENT_WORKFLOWS => "menu:recent_workflows",
        SETUP_WIZARD => "menu:setup_wizard",
        _ => return,
    };
    if let Err(e) = app.emit(topic, ()) {
        eprintln!("menu event emit failed for {topic}: {e}");
    }
}
