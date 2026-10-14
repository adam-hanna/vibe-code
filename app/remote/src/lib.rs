//! What the vibe desktop app and the vibe phone app share about a remote
//! connection (#345).
//!
//! One crate so that neither app copies it: two copies of the matching code,
//! the framing or the close code would be two answers to questions that need
//! one. It holds no Tauri, no keychain, no settings and no state. The desktop's
//! side (accepting, the paired list, the pairing state machine) stays in
//! `app/src-tauri/src/remote/`, and the phone's in `app/mobile/`.
//!
//! - [`wire`]: the pairing payload, its messages, the matching code and the
//!   names, as #341 built them.
//! - [`framing`]: how one message is carried on a QUIC stream.
//! - [`reach`]: how an endpoint reaches the internet, the same on both ends.
//! - The two ALPNs and the one close code, below.

pub mod framing;
pub mod reach;
pub mod wire;

/// The pairing handshake. Anybody may open it; the one-time secret is the bound.
pub const PAIR_ALPN: &[u8] = b"vibe/pair/1";

/// Everything a paired phone does. Paired endpoint ids only.
pub const REMOTE_ALPN: &[u8] = b"vibe/remote/1";

/// The close code for an endpoint id that is not on the paired list, including
/// one that was revoked while connected.
///
/// A stable number on the wire: the phone draws *`<desktop>` removed this phone*
/// from it, and an older phone has to read a newer desktop's code. Never renumber.
pub const NOT_PAIRED: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    /// The phone and the desktop are released separately, so these are a
    /// promise to every build of the other one.
    #[test]
    fn the_alpns_and_the_close_code_are_pinned() {
        assert_eq!(PAIR_ALPN, b"vibe/pair/1");
        assert_eq!(REMOTE_ALPN, b"vibe/remote/1");
        assert_eq!(NOT_PAIRED, 1);
    }
}
