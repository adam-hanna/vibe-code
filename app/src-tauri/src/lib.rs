//! The window, the tray, and the supervision of the process that does the work.
//!
//! Three processes, and the division between them is the design rather than an
//! implementation detail:
//!
//! | process    | owns                                                   |
//! |------------|--------------------------------------------------------|
//! | **Rust**   | window, tray, single instance, spawning and relaying    |
//! | **Node**   | `orchestrate()`, the agents, the sessions, run state    |
//! | **webview**| the screens, and nothing it cannot re-derive from an event |
//!
//! The core is Node ESM that spawns `claude` and `codex` through
//! `node:child_process`. It cannot run in a webview and it cannot run in Rust,
//! so every line of judgement about a run stays on the Node side and this crate
//! is transport plus OS.
//!
//! **Transport is stdio, not a localhost socket.** The repo has no network code
//! of its own and should not grow a port, an allocation strategy and an auth
//! story in order to talk to itself; the process boundary already exists.
//!
//! **The webview is given no shell permission at all.** The host is spawned from
//! here with a path this crate resolved, and `host_send` writes one line to a
//! process that is already running. There is deliberately no command that takes
//! a program name - the app will grow a pilot chat that can drive the session
//! (#144), and "run this program" must never be in reach of it.

mod host;
mod reaper;

use host::{host_send, host_start, host_status, launch, HostProcess};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

/// Bring the window back, creating nothing and assuming nothing.
///
/// Used by the tray, by a click on the tray icon, and by a second launch. All
/// three mean the same thing and none of them should behave differently.
fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, and it has to be: two windows driving two hosts against one run
        // directory is a way to corrupt a run, and `src/lock.ts` is written
        // expecting one process. A second launch raises the first window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show(app);
        }))
        .manage(HostProcess::default())
        .invoke_handler(tauri::generate_handler![host_start, host_send, host_status])
        .setup(|app| {
            // Before the tray, and before a window can ask. The host process IS
            // the app; a webview that fails to load should leave a running host
            // and a stderr line saying so, not a silent nothing.
            //
            // A failure here is deliberately not fatal. The window still opens,
            // and it can show the reason - which is far more use than an app that
            // refuses to start and explains itself to no one.
            let _ = launch(app.handle());

            let quit = MenuItem::with_id(app, "quit", "Quit Vibe", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Vibe", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().ok_or("no window icon")?)
                .tooltip("Vibe")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    // The one path that stops the host deliberately. Closing the
                    // window does not, because a run outliving its window is the
                    // normal case rather than an edge one.
                    "quit" => {
                        app.state::<HostProcess>().stop();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it. A run takes tens of minutes and
            // survives the window being put away; ending it because somebody hit
            // the X would throw away a warm agent session for nothing, which is
            // the whole cost the app exists to avoid.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // The backstop for every way out that is not the tray's Quit - a
            // signal, a logout, an update restart. A host left running is a
            // second writer against a run directory.
            if let tauri::RunEvent::Exit = event {
                app.state::<HostProcess>().stop();
            }
        });
}
