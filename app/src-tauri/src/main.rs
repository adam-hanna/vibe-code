// Prevents a console window opening beside the app on Windows in a release
// build. Kept off debug builds on purpose: `println!` from Rust and the host's
// stderr are worth seeing while developing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vibe_desktop_lib::run()
}
