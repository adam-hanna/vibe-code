// Prevents a console window opening beside the app on Windows in a release
// build. Kept off debug builds on purpose: `println!` from Rust and the host's
// stderr are worth seeing while developing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF renderer paints nothing under some GPUs, and the window
    // is then a blank white rectangle with nothing in any log. Measured on
    // 2026-10-06 on the VMware VM this repo is developed on (Fedora 44, X11,
    // webkit2gtk 2.54): three plain launches blank, the same binary painting
    // normally with this variable set, and the previous build blank the same
    // way - so it is the renderer and not the page. Set before `run()` because
    // WebKit reads it when the web process starts, and only when nobody has
    // set it, so a person who needs the renderer on can still say so.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    vibe_desktop_lib::run()
}
