// The phone app run as a desktop window, for development on a machine with no
// simulator. A phone loads the library through `lib.rs`'s mobile entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    vibe_mobile_lib::run()
}
