//! One message on a QUIC stream: a big-endian `u32` length and that many bytes
//! of JSON (#342).
//!
//! The pairing handshake uses it, and so does the control stream (#343). Each
//! caller names its own bound, because a pairing hello and a run's replay are
//! not the same size; the length is checked before the body is read, so a
//! claimed length past the bound costs nothing to refuse.
//!
//! **Memory follows what was sent, not what was claimed** (#343). The control
//! stream's bound is `CONTROL_MAX`, the most a length can say, so a claimed
//! length is nearly free to make. The body is therefore read a chunk at a time
//! and the buffer grows only as bytes arrive: a peer that claims 4 GB and sends
//! ten bytes costs about ten bytes.

use std::fmt;
use std::future::Future;

use iroh::endpoint::{RecvStream, SendStream};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// The most a body read asks the stream for at once, and so the most the
/// buffer grows by before bytes have actually arrived.
const CHUNK: usize = 64 * 1024;

/// Where framed bytes come from. A QUIC stream in the apps; a fake in the
/// tests, which need no runtime because every read is ready at once.
pub(crate) trait Source {
    /// Read some bytes into `buf`. `None` is the end of the stream.
    fn read_some(&mut self, buf: &mut [u8]) -> impl Future<Output = Result<Option<usize>, String>> + Send;
}

impl Source for RecvStream {
    async fn read_some(&mut self, buf: &mut [u8]) -> Result<Option<usize>, String> {
        self.read(buf).await.map_err(|e| e.to_string())
    }
}

/// Read one message of at most `max` bytes. `what` names it in the sentence a
/// refusal carries back to the other end, e.g. `"pairing message"`.
pub async fn read_message<T: DeserializeOwned>(recv: &mut RecvStream, max: usize, what: &str) -> Result<T, String> {
    read_framed(recv, max, what).await
}

/// `read_message`'s whole body, over any [`Source`].
pub(crate) async fn read_framed<T: DeserializeOwned, S: Source>(src: &mut S, max: usize, what: &str) -> Result<T, String> {
    let mut len = [0u8; 4];
    read_exact(src, &mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > max {
        return Err(format!("a {what} may be at most {max} bytes, and this one is {len}"));
    }
    let mut body = Vec::new();
    read_body(src, len, &mut body).await?;
    serde_json::from_slice(&body).map_err(|e| format!("the message is not a {what}: {e}"))
}

async fn read_exact<S: Source>(src: &mut S, buf: &mut [u8]) -> Result<(), String> {
    let mut got = 0;
    while got < buf.len() {
        match src.read_some(&mut buf[got..]).await {
            Ok(Some(n)) => got += n,
            Ok(None) => return Err(short(got, buf.len())),
            Err(e) => return Err(format!("the message could not be read: {e}")),
        }
    }
    Ok(())
}

/// Read `len` bytes into `body`, asking for at most [`CHUNK`] ahead of what has
/// arrived. Never allocates `len` up front: the buffer grows the way a `Vec`
/// grows, so its capacity stays within twice what arrived plus one chunk.
pub(crate) async fn read_body<S: Source>(src: &mut S, len: usize, body: &mut Vec<u8>) -> Result<(), String> {
    while body.len() < len {
        let start = body.len();
        let step = (len - start).min(CHUNK);
        body.resize(start + step, 0);
        match src.read_some(&mut body[start..]).await {
            Ok(Some(n)) => body.truncate(start + n),
            Ok(None) => {
                body.truncate(start);
                return Err(short(start, len));
            }
            Err(e) => {
                body.truncate(start);
                return Err(format!("the message could not be read: {e}"));
            }
        }
    }
    Ok(())
}

fn short(got: usize, wanted: usize) -> String {
    format!("the message could not be read: the stream ended after {got} of {wanted} bytes")
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

/// One message as it goes on the wire: the length, then the JSON.
pub fn encode<T: Serialize>(message: &T) -> Result<Vec<u8>, WriteError> {
    let body = serde_json::to_vec(message).map_err(WriteError::Encode)?;
    let len = u32::try_from(body.len()).map_err(|_| WriteError::TooLong(body.len()))?;
    let mut framed = Vec::with_capacity(4 + body.len());
    framed.extend_from_slice(&len.to_be_bytes());
    framed.extend_from_slice(&body);
    Ok(framed)
}

/// Write one message. Bounding it is the reader's job.
pub async fn write_message<T: Serialize>(send: &mut SendStream, message: &T) -> Result<(), WriteError> {
    let framed = encode(message)?;
    send.write_all(&framed).await.map_err(WriteError::Stream)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::control::CONTROL_MAX;
    use crate::wire::PAIR_MESSAGE_MAX;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    /// Poll a future that is ready at once. The fakes below never wait, so no
    /// runtime is needed - which is the point: this crate has no dev-dependencies.
    pub(crate) fn ready<F: Future>(fut: F) -> F::Output {
        let mut fut = pin!(fut);
        match fut.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(out) => out,
            Poll::Pending => panic!("a fake source never waits"),
        }
    }

    /// Bytes, then the end of the stream. Records the largest slice it was
    /// offered, which is how much a reader had allocated ahead of the bytes.
    struct Fake {
        bytes: Vec<u8>,
        at: usize,
        largest: usize,
    }

    impl Fake {
        fn new(bytes: Vec<u8>) -> Self {
            Fake { bytes, at: 0, largest: 0 }
        }
    }

    impl Source for Fake {
        async fn read_some(&mut self, buf: &mut [u8]) -> Result<Option<usize>, String> {
            self.largest = self.largest.max(buf.len());
            if self.at == self.bytes.len() {
                return Ok(None);
            }
            let n = buf.len().min(self.bytes.len() - self.at);
            buf[..n].copy_from_slice(&self.bytes[self.at..self.at + n]);
            self.at += n;
            Ok(Some(n))
        }
    }

    #[test]
    fn read_message_does_not_allocate_a_claimed_length() {
        // A claim of 4 GB and ten bytes behind it, through the path
        // `read_message` is.
        let mut bytes = u32::MAX.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"0123456789");
        let mut src = Fake::new(bytes.clone());
        let read: Result<serde_json::Value, String> = ready(read_framed(&mut src, CONTROL_MAX, "control message"));
        let why = read.expect_err("a short stream is an error");
        assert!(why.contains("ended after 10 of 4294967295"), "{why}");
        assert!(src.largest <= CHUNK, "offered {} bytes ahead of what arrived", src.largest);

        // And the body reader itself grows only as bytes arrive: amortised
        // doubling, so at most twice what arrived plus one chunk ahead.
        let mut src = Fake::new(bytes[4..].to_vec());
        let mut body = Vec::new();
        assert!(ready(read_body(&mut src, u32::MAX as usize, &mut body)).is_err());
        assert_eq!(body.len(), 10);
        assert!(body.capacity() <= 2 * (body.len() + CHUNK), "capacity {}", body.capacity());
    }

    #[test]
    fn a_frame_larger_than_the_pairing_bound_round_trips_under_control_max() {
        let big = "x".repeat(1024 * 1024);
        let framed = encode(&big).expect("encodes");
        assert!(framed.len() > PAIR_MESSAGE_MAX);

        let back: String = ready(read_framed(&mut Fake::new(framed.clone()), CONTROL_MAX, "control message")).expect("reads");
        assert_eq!(back, big);

        // The pairing path refuses it before reading the body, as it always has.
        let refused: Result<String, String> = ready(read_framed(&mut Fake::new(framed), PAIR_MESSAGE_MAX, "pairing message"));
        let why = refused.expect_err("over the pairing bound");
        assert!(why.starts_with(&format!("a pairing message may be at most {PAIR_MESSAGE_MAX} bytes")), "{why}");
    }

    #[test]
    fn a_short_header_says_so() {
        let read: Result<serde_json::Value, String> = ready(read_framed(&mut Fake::new(vec![0, 0]), 10, "hello"));
        assert!(read.expect_err("short").contains("ended after 2 of 4"));
    }
}
