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
//! **Transport is stdio, not a localhost socket.** The core has no network code
//! and this crate should not grow a port, an allocation strategy and an auth
//! story in order to talk to itself; the process boundary already exists. The
//! network code this crate does have is two clients, both outbound and both
//! here rather than in the core: the pilot's vendor adapters (`pilot/`) and the
//! updater (`update.rs`), which fetches one public file.
//!
//! **The Node side is a set of processes, one per run** (#246). One long-lived
//! *service* host answers everything that is not a run - reads, config writes,
//! the pilot and commands - and every `invoke` gets a *run* host of its own that
//! serves that one invoke and is closed after its `result`. Every relayed event
//! carries the handle of the host it came from; see `host.rs`.
//!
//! **The webview is given no shell permission at all.** The host is spawned from
//! here with a path this crate resolved, and `host_send` writes one line to a
//! process that is already running. There is deliberately no command that takes
//! a program name - the app will grow a pilot chat that can drive the session
//! (#144), and "run this program" must never be in reach of it.
//!
//! **A directory chooser is not that** (#189). `dialog:allow-open` returns a path
//! the OS itself produced through a UI a person drove; it starts no process and
//! reads no file. It is still a capability reaching the window, so it is granted
//! by name in `capabilities/default.json` rather than by taking `dialog:default`,
//! and the path it returns is not trusted any further than a typed one: the host
//! decides what a usable repository is, exactly as it does today.

mod applog;
mod host;
mod keys;
mod pilot;
mod reaper;
mod shellenv;
mod update;

use host::{app_quit, host_send, host_start, host_status, launch, HostProcess};
use keys::{key_clear, key_set, key_status};
use pilot::models::pilot_models;
use pilot::{pilot_cancel, pilot_send, Pilot};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use update::{update_check, update_install};

/// The tray's Quit (#246). See the menu handler.
fn tray_quit(app: &tauri::AppHandle) {
    let hosts = app.state::<HostProcess>();
    if !hosts.has_run_hosts() {
        hosts.quit(app);
        return;
    }
    if !hosts.request_quit() {
        show(app);
        let _ = app.emit("app://quit-requested", ());
        return;
    }
    let me = app.clone();
    app.dialog()
        .message("Runs are still going. Quitting stops each one where it is; every one can be resumed, and only the turn each is in is redone.")
        .title("Quit Vibe?")
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
        .show(move |yes| {
            let hosts = me.state::<HostProcess>();
            hosts.clear_quit();
            if yes {
                hosts.quit(&me);
            }
        });
}

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
        // The repository field's directory chooser (#189), and the only plugin
        // besides single-instance that the window can reach. A plugin command is
        // not on the `generate_handler!` list below, so the guard that pins that
        // list pins this line too - a third plugin has to be added on purpose.
        .plugin(tauri_plugin_dialog::init())
        // The updater (#299). Registered so the two commands below can drive it
        // from Rust; the window is granted no updater permission, so it cannot
        // call the plugin's own commands, has no network access, and never names
        // a URL. `update.rs` says what it fetches and when.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(HostProcess::default())
        .manage(Pilot::default())
        .manage(update::Pending::default())
        // Every command the window may call, and the list is worth reading as a
        // whole: three that talk to a process this crate already started, three
        // that manage a credential the window can store and check but **never
        // read back**, and two that start and stop a pilot turn.
        //
        // There is deliberately no `key_get` and there is deliberately no
        // command that returns a reply. The key is read inside `pilot_send`'s
        // thread and the answer arrives as events, so a credential never crosses
        // this boundary in either direction (#143).
        .invoke_handler(tauri::generate_handler![
            host_start,
            host_send,
            host_status,
            key_set,
            key_clear,
            key_status,
            pilot_send,
            pilot_cancel,
            // The one command that answers with data from a vendor, and it is a
            // list of model names - never a key and never a reply (#223).
            pilot_models,
            // Quit, once the window has confirmed it with runs going (#246). It
            // only exits, through the same `stop()` the tray uses - narrower
            // than a process-exit permission, which could skip the stop.
            app_quit,
            // Ask whether a newer version exists, and install it or open the
            // release page (#299). Neither takes a URL or a program: the
            // endpoint is config or `VIBE_UPDATE_ENDPOINT`, the page a constant.
            update_check,
            update_install
        ])
        .setup(|app| {
            // Before `launch`, because the first thing worth keeping is why the
            // host did not start. A release build has no console for it (#186).
            match applog::open(app.handle()) {
                Some(path) => applog::app(&format!(
                    "vibe-desktop {} starting; log at {}",
                    env!("CARGO_PKG_VERSION"),
                    path.display()
                )),
                // Said the only way left. Nothing else changes: the app runs
                // exactly as it did before there was a log to fail to open.
                None => eprintln!("no app log could be opened; this session is console-only"),
            }
            // Whenever the update endpoint is overridden, so a stray value is
            // never silently pointing every check somewhere else (#299).
            update::log_override();

            // Before the tray, and before a window can ask. The service host IS
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
                    // The one path that stops the hosts deliberately - every
                    // one of them, the service host and each run's. Closing the
                    // window does not, because a run outliving its window is the
                    // normal case rather than an edge one.
                    //
                    // **With runs going it asks first** (#246). The window is
                    // shown and told, and draws one confirmation naming every run;
                    // it calls `app_quit` on yes. A second Quit while that is
                    // unanswered - the window hung, or hidden again - is asked
                    // natively, because Rust knows handles and not names, and a
                    // quit must never be lost to a window that cannot answer.
                    "quit" => tray_quit(app),
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
