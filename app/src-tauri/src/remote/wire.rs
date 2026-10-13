//! What the desktop and a phone agree on about pairing (#341).
//!
//! **No Tauri and nothing desktop-only, on purpose.** The shared `app/remote/`
//! crate (#345) takes this file as it is, so the phone parses a QR payload and
//! computes a matching code with the very same lines the desktop does. Two
//! copies of either would be two answers to "do these six digits match", which
//! is the one question pairing exists to answer.
//!
//! Hex and percent-encoding are written here rather than taken as crates: each
//! is a dozen lines, and a dependency the phone also has to carry for that is
//! not worth its weight.
//!
//! The parser, the messages and the decoders have no desktop caller yet: the
//! phone reads a payload, and the `vibe/pair/1` handler (#342) reads the
//! messages. The tests here are their caller until then.
#![allow(dead_code)]

use std::fmt;

use iroh_base::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The scheme and version a pairing payload starts with.
pub const SCHEME: &str = "vibe-pair";
pub const VERSION: &str = "1";

/// The domain separator for the matching code. Changing it changes every code.
pub const CODE_DOMAIN: &[u8] = b"vibe-pair-code/1";

/// The longest phone name kept, in characters.
pub const NAME_MAX: usize = 64;

/// What a QR code carries: where to dial, and the one-time secret.
///
/// **Never the matching code.** The six digits are computed from the key that
/// actually connected, after it connected; a code in the QR would be a code
/// somebody who photographed it already knows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairPayload {
    /// The desktop's endpoint id.
    pub id: PublicKey,
    /// The desktop's home relay, as an address hint. Absent until an endpoint
    /// exists to have one.
    pub relay: Option<String>,
    /// The pairing secret.
    pub secret: [u8; 32],
    /// The desktop's name as a person reads it. Absent when it could not be
    /// read, rather than invented.
    pub name: Option<String>,
}

impl PairPayload {
    /// `vibe-pair:1?id=<id>&relay=<url>&s=<hex>&n=<name>`, with `relay` and `n`
    /// left out when there is nothing to say.
    pub fn to_uri(&self) -> String {
        let mut out = format!("{SCHEME}:{VERSION}?id={}", self.id);
        if let Some(relay) = &self.relay {
            out.push_str("&relay=");
            out.push_str(&percent_encode(relay));
        }
        out.push_str("&s=");
        out.push_str(&hex(&self.secret));
        if let Some(name) = &self.name {
            out.push_str("&n=");
            out.push_str(&percent_encode(name));
        }
        out
    }

    /// Read a payload back. **Fails closed with a reason**: a payload that is
    /// nearly right is not a payload, and guessing at the rest would dial
    /// somebody nobody chose. Unknown keys are ignored, so a field a later
    /// desktop adds does not stop an older phone pairing.
    pub fn parse(text: &str) -> Result<PairPayload, PayloadError> {
        let rest = text
            .strip_prefix(SCHEME)
            .and_then(|r| r.strip_prefix(':'))
            .ok_or(PayloadError::WrongScheme)?;
        let (version, query) = rest.split_once('?').unwrap_or((rest, ""));
        if version != VERSION {
            return Err(PayloadError::WrongVersion(version.to_string()));
        }

        let (mut id, mut relay, mut secret, mut name) = (None, None, None, None);
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            let (key, raw) = pair.split_once('=').unwrap_or((pair, ""));
            let slot = match key {
                "id" => &mut id,
                "relay" => &mut relay,
                "s" => &mut secret,
                "n" => &mut name,
                _ => continue,
            };
            if slot.is_some() {
                return Err(PayloadError::Malformed {
                    field: field_name(key),
                    why: "it appears twice".into(),
                });
            }
            let value = percent_decode(raw).map_err(|why| PayloadError::Malformed {
                field: field_name(key),
                why,
            })?;
            *slot = Some(value);
        }

        let id = id.ok_or(PayloadError::Missing("id"))?;
        let id: PublicKey = id.parse().map_err(|e| PayloadError::Malformed {
            field: "id",
            why: format!("{e}"),
        })?;
        let secret = secret.ok_or(PayloadError::Missing("s"))?;
        let secret = hex_decode32(&secret).map_err(|why| PayloadError::Malformed { field: "s", why })?;
        Ok(PairPayload { id, relay, secret, name })
    }
}

fn field_name(key: &str) -> &'static str {
    match key {
        "id" => "id",
        "relay" => "relay",
        "s" => "s",
        _ => "n",
    }
}

/// Why a payload was refused, as a sentence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayloadError {
    WrongScheme,
    WrongVersion(String),
    Missing(&'static str),
    Malformed { field: &'static str, why: String },
}

impl fmt::Display for PayloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PayloadError::WrongScheme => write!(f, "this is not a vibe pairing code"),
            PayloadError::WrongVersion(v) => {
                write!(f, "this pairing code is version {v:?}, and this app reads version {VERSION}")
            }
            PayloadError::Missing(field) => write!(f, "the pairing code has no {field:?} field"),
            PayloadError::Malformed { field, why } => {
                write!(f, "the pairing code's {field:?} field is malformed: {why}")
            }
        }
    }
}

/// The phone's first message on `vibe/pair/1`: the secret it scanned, and what
/// it calls itself. The phone's id is never in here - it is the one the QUIC
/// handshake authenticated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairHello {
    /// Lowercase hex, as in the QR code.
    pub secret: String,
    pub phone_name: String,
}

/// The desktop's answer to a right secret: the nonce both ends hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairChallenge {
    /// Lowercase hex, 16 bytes.
    pub nonce: String,
}

/// How a pairing ended, as the phone is told it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PairResult {
    #[serde(rename_all = "camelCase")]
    Paired { desktop_name: Option<String> },
    Declined,
    Refused { reason: String },
}

/// The six digits both screens show.
///
/// `SHA-256("vibe-pair-code/1" ‖ desktop id ‖ phone id ‖ nonce)`, the first 8
/// bytes read as a big-endian `u64`, mod 10⁶, zero-padded. Taking 8 bytes
/// rather than the whole digest narrows the design's "a big-endian integer mod
/// 10⁶"; the bias of a 64-bit value mod 10⁶ is about 5 in 10¹⁴, which is nothing.
pub fn matching_code(desktop: &[u8; 32], phone: &[u8; 32], nonce: &[u8; 16]) -> String {
    let mut hash = Sha256::new();
    hash.update(CODE_DOMAIN);
    hash.update(desktop);
    hash.update(phone);
    hash.update(nonce);
    let digest = hash.finalize();
    let mut first = [0u8; 8];
    first.copy_from_slice(&digest[..8]);
    format!("{:06}", u64::from_be_bytes(first) % 1_000_000)
}

/// The matching code for two endpoint ids.
pub fn matching_code_for(desktop: &PublicKey, phone: &PublicKey, nonce: &[u8; 16]) -> String {
    matching_code(desktop.as_bytes(), phone.as_bytes(), nonce)
}

/// Why a phone name was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NameError {
    Empty,
}

impl fmt::Display for NameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NameError::Empty => write!(f, "the phone sent no name"),
        }
    }
}

/// A phone's name, made fit to draw: control characters stripped, trimmed, and
/// cut to 64 characters. An empty one is refused rather than drawn as
/// *Allow ``?*, which nobody could answer.
pub fn phone_name(raw: &str) -> Result<String, NameError> {
    let stripped: String = raw.chars().filter(|c| !c.is_control()).collect();
    let cut: String = stripped.trim().chars().take(NAME_MAX).collect();
    let name = cut.trim().to_string();
    if name.is_empty() {
        Err(NameError::Empty)
    } else {
        Ok(name)
    }
}

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0xf) as usize] as char);
    }
    out
}

fn hex_decode<const N: usize>(text: &str) -> Result<[u8; N], String> {
    let bytes = text.as_bytes();
    if bytes.len() != N * 2 {
        return Err(format!("expected {} hex digits, found {}", N * 2, bytes.len()));
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(format!("{:?} is not a hex digit", c as char)),
    };
    let mut out = [0u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = (nibble(bytes[2 * i])? << 4) | nibble(bytes[2 * i + 1])?;
    }
    Ok(out)
}

/// 32 bytes from hex: a pairing secret.
pub fn hex_decode32(text: &str) -> Result<[u8; 32], String> {
    hex_decode::<32>(text)
}

/// 16 bytes from hex: a nonce.
pub fn hex_decode16(text: &str) -> Result<[u8; 16], String> {
    hex_decode::<16>(text)
}

/// Percent-encode everything outside RFC 3986's unreserved set.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = text.get(i + 1..i + 3).ok_or("a % escape is cut short")?;
            let byte = hex_decode::<1>(pair).map_err(|_| format!("%{pair} is not an escape"))?;
            out.push(byte[0]);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "it is not UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh_base::SecretKey;

    fn key(seed: u8) -> PublicKey {
        SecretKey::from_bytes(&[seed; 32]).public()
    }

    fn payload() -> PairPayload {
        PairPayload { id: key(7), relay: None, secret: [0xab; 32], name: None }
    }

    #[test]
    fn the_matching_code_is_pinned_by_a_fixed_vector() {
        // The phone checks against this same vector, so a change here is a
        // change on both ends. Recompute with:
        //   python3 -c "import hashlib; d=bytes(range(80)); h=hashlib.sha256(b'vibe-pair-code/1'+d).digest(); print('%06d' % (int.from_bytes(h[:8],'big') % 10**6))"
        // (desktop = bytes 0..32, phone = 32..64, nonce = 64..80; digest
        // da6fad2ce1d38dd9d4655840e09cbf66ef97550a27bc03f430ae0364761765c3).
        let desktop: [u8; 32] = std::array::from_fn(|i| i as u8);
        let phone: [u8; 32] = std::array::from_fn(|i| 32 + i as u8);
        let nonce: [u8; 16] = std::array::from_fn(|i| 64 + i as u8);
        assert_eq!(matching_code(&desktop, &phone, &nonce), "077145");
    }

    #[test]
    fn both_ends_compute_the_same_code_from_the_same_inputs() {
        let nonce = [3u8; 16];
        let desktop_side = matching_code_for(&key(1), &key(2), &nonce);
        let phone_side = matching_code_for(&key(1), &key(2), &nonce);
        assert_eq!(desktop_side, phone_side);
        assert_eq!(desktop_side.len(), 6);
        assert!(desktop_side.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn another_phone_or_another_nonce_gets_another_code() {
        // The whole reason the code exists: an attacker's key, given the same
        // secret, cannot make the owner's digits.
        let nonce = [3u8; 16];
        let owner = matching_code_for(&key(1), &key(2), &nonce);
        assert_ne!(owner, matching_code_for(&key(1), &key(9), &nonce));
        assert_ne!(owner, matching_code_for(&key(1), &key(2), &[4u8; 16]));
    }

    #[test]
    fn a_payload_round_trips() {
        let bare = payload();
        assert_eq!(PairPayload::parse(&bare.to_uri()), Ok(bare.clone()));

        let full = PairPayload {
            relay: Some("https://relay.example/x?y=1".into()),
            name: Some("Adam's Mac & co = é中".into()),
            ..bare
        };
        let uri = full.to_uri();
        assert!(uri.starts_with("vibe-pair:1?id="));
        assert!(!uri.contains(' ') && !uri.contains('é'), "{uri}");
        assert_eq!(PairPayload::parse(&uri), Ok(full));
    }

    #[test]
    fn the_payload_carries_the_secret_in_lowercase_hex_and_no_code() {
        let uri = payload().to_uri();
        assert!(uri.contains(&format!("&s={}", "ab".repeat(32))));
        assert!(!uri.contains("code"));
        assert!(!uri.contains("&n="), "an absent name is left out, not invented");
        assert!(!uri.contains("relay"));
    }

    #[test]
    fn every_way_a_payload_is_wrong_is_refused_with_its_reason() {
        let good = payload().to_uri();
        let id = key(7).to_string();
        let s = "ab".repeat(32);
        let cases: Vec<(String, PayloadError)> = vec![
            (good.replacen("vibe-pair", "vibe-pear", 1), PayloadError::WrongScheme),
            (good.replacen(":1?", ":2?", 1), PayloadError::WrongVersion("2".into())),
            (format!("vibe-pair:1?s={s}"), PayloadError::Missing("id")),
            (format!("vibe-pair:1?id={id}"), PayloadError::Missing("s")),
        ];
        for (text, want) in cases {
            assert_eq!(PairPayload::parse(&text), Err(want), "{text}");
        }
        let malformed = [
            (format!("vibe-pair:1?id=nothex&s={s}"), "id"),
            (format!("vibe-pair:1?id={id}&s=abcd"), "s"),
            (format!("vibe-pair:1?id={id}&s={}", "zz".repeat(32)), "s"),
            (format!("vibe-pair:1?id={id}&s={s}&n=%E"), "n"),
            (format!("vibe-pair:1?id={id}&s={s}&n=%ZZ"), "n"),
            (format!("vibe-pair:1?id={id}&s={s}&n=%FF"), "n"),
            (format!("vibe-pair:1?id={id}&id={id}&s={s}"), "id"),
        ];
        for (text, field) in malformed {
            match PairPayload::parse(&text) {
                Err(e @ PayloadError::Malformed { .. }) => {
                    assert!(matches!(&e, PayloadError::Malformed { field: f, .. } if *f == field), "{text}: {e}");
                    assert!(e.to_string().contains(field));
                }
                other => panic!("{text} should be malformed, got {other:?}"),
            }
        }
    }

    #[test]
    fn an_unknown_field_is_ignored() {
        let uri = format!("{}&future=1", payload().to_uri());
        assert_eq!(PairPayload::parse(&uri), Ok(payload()));
    }

    #[test]
    fn a_phone_name_is_cleaned_and_bounded() {
        assert_eq!(phone_name("  Pixel\u{0007} 9\n "), Ok("Pixel 9".into()));
        let long: String = "中".repeat(100);
        assert_eq!(phone_name(&long).map(|n| n.chars().count()), Ok(64));
        for empty in ["", "   ", "\n\t", "\u{0000}\u{001b}"] {
            assert_eq!(phone_name(empty), Err(NameError::Empty));
        }
        assert_eq!(NameError::Empty.to_string(), "the phone sent no name");
    }

    #[test]
    fn the_messages_have_the_wire_shape() {
        let hello = serde_json::to_value(PairHello { secret: "ab".into(), phone_name: "p".into() }).unwrap();
        assert_eq!(hello, serde_json::json!({ "secret": "ab", "phoneName": "p" }));
        let paired = serde_json::to_value(PairResult::Paired { desktop_name: None }).unwrap();
        assert_eq!(paired, serde_json::json!({ "kind": "paired", "desktopName": null }));
        let challenge = serde_json::to_value(PairChallenge { nonce: hex(&[9u8; 16]) }).unwrap();
        assert_eq!(challenge, serde_json::json!({ "nonce": "09".repeat(16) }));
        assert_eq!(hex_decode16(&hex(&[9u8; 16])), Ok([9u8; 16]));
    }
}
