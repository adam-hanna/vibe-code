//! Start at login (#344), and the one decision it adds to the window: whether a
//! launch shows it.
//!
//! **The OS entry is reached only through [`Autostart`].** The real one is the
//! plugin's manager, built once in `setup`; every test hands in a recorder, so
//! no test run writes `~/.config/autostart` or its macOS and Windows
//! equivalents. The window is granted no autostart permission: it changes the
//! setting through `remote_set`, and Rust asks the plugin.
//!
//! **A launch at login opens to the tray.** The plugin launches the app with
//! [`AUTOSTART_ARG`], fixed when the plugin is built; the `main` window is
//! `visible: false` in `tauri.conf.json`, and [`shows_window`] is the one rule
//! both `setup` and the single-instance callback apply. Without the argument
//! the window is shown, which is every other road in - so this cannot produce
//! an app that starts invisible.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// What the plugin passes to a launch at login.
pub(crate) const AUTOSTART_ARG: &str = "--autostart";

/// Whether a launch with this argv shows the window. False only for a launch
/// at login.
pub(crate) fn shows_window(argv: &[String]) -> bool {
    !argv.iter().any(|a| a == AUTOSTART_ARG)
}

/// The OS's login item for this app.
pub(crate) trait Autostart: Send + Sync {
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
    /// What the OS says now - the entry may have been removed by hand.
    fn is_enabled(&self) -> Result<bool, String>;
}

/// The plugin's manager. Constructed only in `setup`.
pub(crate) struct PluginAutostart(pub(crate) AppHandle);

impl Autostart for PluginAutostart {
    fn enable(&self) -> Result<(), String> {
        self.0.autolaunch().enable().map_err(|e| format!("start at login could not be turned on: {e}"))
    }
    fn disable(&self) -> Result<(), String> {
        self.0.autolaunch().disable().map_err(|e| format!("start at login could not be turned off: {e}"))
    }
    fn is_enabled(&self) -> Result<bool, String> {
        self.0.autolaunch().is_enabled().map_err(|e| format!("the system could not say whether this app starts at login: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_launch_at_login_shows_no_window() {
        assert!(!shows_window(&argv(&["/usr/bin/vibe-desktop", AUTOSTART_ARG])));
        assert!(!shows_window(&argv(&[AUTOSTART_ARG])));
    }

    #[test]
    fn every_other_launch_shows_the_window() {
        assert!(shows_window(&argv(&[])));
        assert!(shows_window(&argv(&["/usr/bin/vibe-desktop"])));
        assert!(shows_window(&argv(&["/usr/bin/vibe-desktop", "--something-else", "--autostart=no"])));
    }

    #[test]
    fn setup_and_the_second_launch_both_ask_the_same_rule() {
        let lib = include_str!("lib.rs");
        let single = lib.find("tauri_plugin_single_instance::init").expect("the single-instance plugin");
        let callback = &lib[single..single + 200];
        assert!(callback.contains("shows_window(&argv)"), "the second launch: {callback}");
        let setup = lib.find(".setup(|app|").expect("setup");
        assert!(lib[setup..].contains("shows_window(&std::env::args()"), "setup must decide too");
        // And the plugin passes the argument the rule reads.
        assert!(lib.contains(".args([AUTOSTART_ARG])"));
    }

    #[test]
    fn the_main_window_starts_hidden_so_setup_decides() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = conf["app"]["windows"].as_array().unwrap().iter().find(|w| w["label"] == "main").unwrap();
        assert_eq!(main["visible"], false);
    }
}
