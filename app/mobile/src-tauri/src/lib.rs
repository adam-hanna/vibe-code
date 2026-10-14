//! The vibe phone app's Rust side (#345).
//!
//! **A client only.** No Node host, no agent CLI and nothing that runs a turn:
//! everything the cockpit does is a command on a paired desktop, carried there
//! by [`desktop::Desktop`]. What lives here is what belongs to the device in
//! somebody's hand: its key, and opening a page in its browser.
//!
//! Three commands, and the window's capability grants nothing else:
//!
//! - `remote_call`: one desktop command, carried to the desktop.
//! - `phone_identity`: this phone's endpoint id, the public half of its key.
//! - `phone_open_release_page`: the release page in the phone's browser, when
//!   the desktop answers an update with `openOnPhone`.

mod desktop;
mod identity;
#[cfg(feature = "mock-desktop")]
mod mock;

use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

use desktop::Desktop;

/// What the phone holds for the life of the app.
pub struct Phone {
    desktop: Box<dyn Desktop>,
    /// The endpoint id, or why there is none. Decided once, at start: a key
    /// store that could not be read stays a sentence until the app restarts,
    /// rather than being retried into a new key.
    identity: Result<String, String>,
}

/// `phone_identity`'s answer. The public id and nothing else.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityReport {
    endpoint_id: String,
}

#[tauri::command]
async fn remote_call(phone: State<'_, Phone>, command: String, args: Value) -> Result<Value, String> {
    phone.desktop.call(&command, args).await
}

#[tauri::command]
fn phone_identity(phone: State<'_, Phone>) -> Result<IdentityReport, String> {
    phone.identity.clone().map(|endpoint_id| IdentityReport { endpoint_id })
}

#[tauri::command]
fn phone_open_release_page(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(vibe_remote::RELEASE_PAGE, None::<&str>)
        .map_err(|e| format!("could not open {}: {e}", vibe_remote::RELEASE_PAGE))
}

/// The device key, read or made, as the endpoint id or a sentence.
fn identity() -> Result<String, String> {
    identity::install_store()?;
    vibe_remote::identity::read_or_create(&identity::Store).map(|key| key.public().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // One target: the defaults add stdout and a log file of their own.
                .clear_targets()
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let identity = identity();
            match &identity {
                Ok(id) => log::info!("vibe-mobile: device key ready, endpoint id {id}"),
                Err(why) => log::error!("vibe-mobile: no device key: {why}"),
            }
            #[cfg(feature = "mock-desktop")]
            let desktop: Box<dyn Desktop> = Box::new(mock::Recorded::new(app.handle().clone()));
            #[cfg(not(feature = "mock-desktop"))]
            let desktop: Box<dyn Desktop> = Box::new(desktop::Unconnected);
            app.manage(Phone { desktop, identity });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![remote_call, phone_identity, phone_open_release_page])
        .run(tauri::generate_context!())
        .expect("the phone app could not start");
}
