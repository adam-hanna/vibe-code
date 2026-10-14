//! One message on a QUIC stream: a big-endian `u32` length and that many bytes
//! of JSON (#342).
//!
//! The pairing handshake uses it, and the control stream will (#343). Each
//! caller names its own bound, because a pairing hello and a run's replay are
//! not the same size; the length is checked before the body is read, so a
//! claimed length past the bound costs nothing to refuse.

use std::fmt;

use iroh::endpoint::{RecvStream, SendStream};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Read one message of at most `max` bytes. `what` names it in the sentence a
/// refusal carries back to the other end, e.g. `"pairing message"`.
pub async fn read_message<T: DeserializeOwned>(recv: &mut RecvStream, max: usize, what: &str) -> Result<T, String> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len)
        .await
        .map_err(|e| format!("the message could not be read: {e}"))?;
    let len = u32::from_be_bytes(len) as usize;
    if len > max {
        return Err(format!("a {what} may be at most {max} bytes, and this one is {len}"));
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .map_err(|e| format!("the message could not be read: {e}"))?;
    serde_json::from_slice(&body).map_err(|e| format!("the message is not a {what}: {e}"))
}

/// Why a message could not be written.
#[derive(Debug)]
pub enum WriteError {
    Encode(serde_json::Error),
    /// Longer than a `u32` length can say.
    TooLong(usize),
    Stream(iroh::endpoint::WriteError),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::Encode(e) => write!(f, "the message could not be encoded: {e}"),
            WriteError::TooLong(n) => write!(f, "the message is {n} bytes, more than a length can say"),
            WriteError::Stream(e) => write!(f, "the message could not be sent: {e}"),
        }
    }
}

impl std::error::Error for WriteError {}

/// Write one message. Bounding it is the reader's job.
pub async fn write_message<T: Serialize>(send: &mut SendStream, message: &T) -> Result<(), WriteError> {
    let body = serde_json::to_vec(message).map_err(WriteError::Encode)?;
    let len = u32::try_from(body.len()).map_err(|_| WriteError::TooLong(body.len()))?;
    send.write_all(&len.to_be_bytes()).await.map_err(WriteError::Stream)?;
    send.write_all(&body).await.map_err(WriteError::Stream)?;
    Ok(())
}
