//! Pairing from the phone (#346): the race between the desktop and Back.
//!
//! The order is the wire's. The phone dials and sends the secret; the desktop
//! answers with a challenge and raises *Allow?*; **now** both screens show the
//! six digits, so the code is emitted to the webview (`phone://pair-code`)
//! before the phone waits on anything else; then the desktop's answer.
//!
//! Back can be pressed at any point, and the rule for who wins is one sentence:
//! **an answer the phone has already read is acted on, whatever Back says.**
//! The desktop stores a phone before it sends `Paired`, so dropping a `Paired`
//! the phone holds would leave the desktop paired and the phone not. What is
//! left is the moment the answer is still in flight when Back hangs up; that
//! needs the desktop to wait for an acknowledgement, which is a change to the
//! desktop this issue does not make, and the cancel sentence says how to
//! recover.

// A mock build answers from a recording and never dials.
#![cfg_attr(feature = "mock-desktop", allow(dead_code))]

use std::future::Future;

use serde::Serialize;
use tokio::sync::oneshot;
use vibe_remote::client::{Challenged, Reason};
use vibe_remote::paired::{DesktopEntry, PairedList};
use vibe_remote::wire::PairResult;

/// What the webview is told when the code is known.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairCode {
    /// The screen's own number for this attempt, so a code from an earlier
    /// scan is never drawn.
    pub attempt: u64,
    pub code: String,
}

/// A pairing that has its challenge: the code, then the desktop's answer.
pub trait Challenge: Send {
    fn code(&self) -> String;
    fn read_result(&mut self) -> impl Future<Output = Result<PairResult, Reason>> + Send;
    fn commit(self, result: PairResult) -> Result<DesktopEntry, Reason>;
}

/// The real one: the client's challenge, and the list a yes goes into.
pub struct Real<'a> {
    pub challenged: Challenged,
    pub list: &'a PairedList,
    pub now: u64,
}

impl Challenge for Real<'_> {
    fn code(&self) -> String {
        self.challenged.code().to_string()
    }
    fn read_result(&mut self) -> impl Future<Output = Result<PairResult, Reason>> + Send {
        self.challenged.read_result()
    }
    fn commit(self, result: PairResult) -> Result<DesktopEntry, Reason> {
        self.challenged.commit(result, self.list, self.now)
    }
}

/// Pair: race the dial against Back, emit the code, then race the answer
/// against Back - with an answer already read winning.
///
/// `cancel` resolving (or its sender going away) is Back.
pub async fn pair_flow<C: Challenge>(
    pair: impl Future<Output = Result<C, Reason>>,
    emit: impl FnOnce(String),
    mut cancel: oneshot::Receiver<()>,
) -> Result<DesktopEntry, Reason> {
    let mut challenge = tokio::select! {
        biased;
        _ = &mut cancel => return Err(Reason::PairCancelled),
        got = pair => got?,
    };
    emit(challenge.code());
    let read = tokio::select! {
        // The answer first: one that is ready beats a Back that is ready.
        biased;
        read = challenge.read_result() => Some(read),
        _ = &mut cancel => None,
    };
    match read {
        // Back before any answer: hanging up takes the desktop's prompt down.
        None => {
            drop(challenge);
            Err(Reason::PairCancelled)
        }
        Some(Err(reason)) => Err(reason),
        Some(Ok(result)) => challenge.commit(result),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    /// A challenge whose answer the test controls, recording what happened.
    struct Fake {
        answer: Option<oneshot::Receiver<Result<PairResult, Reason>>>,
        commit: Result<DesktopEntry, Reason>,
        log: Arc<Mutex<Vec<&'static str>>>,
        dropped: Arc<AtomicBool>,
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    impl Challenge for Fake {
        fn code(&self) -> String {
            "123456".into()
        }
        async fn read_result(&mut self) -> Result<PairResult, Reason> {
            self.log.lock().unwrap().push("read");
            match self.answer.take() {
                Some(rx) => rx.await.unwrap_or(Err(Reason::Unreachable)),
                None => std::future::pending().await,
            }
        }
        fn commit(self, result: PairResult) -> Result<DesktopEntry, Reason> {
            self.log.lock().unwrap().push("commit");
            match result {
                PairResult::Paired { .. } => self.commit.clone(),
                PairResult::Declined => Err(Reason::PairDeclined),
                PairResult::Refused { reason } => Err(Reason::PairRefused { reason }),
            }
        }
    }

    fn entry() -> DesktopEntry {
        DesktopEntry { id: "d".into(), relay: None, desktop_name: Some("desk".into()), name: None, paired_at: 1, last_seen: Some(1) }
    }

    struct Rig {
        log: Arc<Mutex<Vec<&'static str>>>,
        dropped: Arc<AtomicBool>,
    }

    fn fake(answer: Option<oneshot::Receiver<Result<PairResult, Reason>>>, commit: Result<DesktopEntry, Reason>) -> (Fake, Rig) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let dropped = Arc::new(AtomicBool::new(false));
        (Fake { answer, commit, log: log.clone(), dropped: dropped.clone() }, Rig { log, dropped })
    }

    fn run<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn the_code_is_emitted_before_the_answer_is_waited_on_and_a_yes_is_returned() {
        let (tx, rx) = oneshot::channel();
        let (challenge, rig) = fake(Some(rx), Ok(entry()));
        let log = rig.log.clone();
        let (_keep, cancel) = oneshot::channel::<()>();
        tx.send(Ok(PairResult::Paired { desktop_name: Some("desk".into()) })).unwrap();
        let got = run(pair_flow(
            async { Ok(challenge) },
            move |code| {
                assert_eq!(code, "123456");
                log.lock().unwrap().push("emit");
            },
            cancel,
        ));
        assert_eq!(got, Ok(entry()));
        assert_eq!(*rig.log.lock().unwrap(), ["emit", "read", "commit"]);
    }

    #[test]
    fn every_outcome_is_returned() {
        let outcomes = [
            (Ok(PairResult::Declined), Ok(entry()), Err(Reason::PairDeclined)),
            (Err(Reason::Unreachable), Ok(entry()), Err(Reason::Unreachable)),
            (
                Ok(PairResult::Paired { desktop_name: None }),
                Err(Reason::PairedNotSaved { desktop_name: None, why: "disk".into() }),
                Err(Reason::PairedNotSaved { desktop_name: None, why: "disk".into() }),
            ),
        ];
        for (answer, commit, want) in outcomes {
            let (tx, rx) = oneshot::channel();
            tx.send(answer).unwrap();
            let (challenge, _rig) = fake(Some(rx), commit);
            let (_keep, cancel) = oneshot::channel::<()>();
            assert_eq!(run(pair_flow(async { Ok(challenge) }, |_| {}, cancel)), want);
        }
        let (_keep, cancel) = oneshot::channel::<()>();
        let unreadable = Reason::PhoneListUnreadable { why: "x".into() };
        let got = run(pair_flow(async { Err::<Fake, _>(unreadable.clone()) }, |_| panic!("no code"), cancel));
        assert_eq!(got, Err(unreadable));
    }

    #[test]
    fn back_before_the_challenge_emits_nothing() {
        let (back, cancel) = oneshot::channel::<()>();
        back.send(()).unwrap();
        let got = run(pair_flow(std::future::pending::<Result<Fake, Reason>>(), |_| panic!("no code"), cancel));
        assert_eq!(got, Err(Reason::PairCancelled));
    }

    #[test]
    fn back_after_the_code_with_no_answer_hangs_up() {
        let (challenge, rig) = fake(None, Ok(entry()));
        let (back, cancel) = oneshot::channel::<()>();
        let got = run(async {
            let flow = pair_flow(async { Ok(challenge) }, |_| {}, cancel);
            let press = async {
                tokio::task::yield_now().await;
                back.send(()).unwrap();
            };
            tokio::join!(flow, press).0
        });
        assert_eq!(got, Err(Reason::PairCancelled));
        assert!(rig.dropped.load(Ordering::SeqCst), "the challenge was dropped, which hangs up");
        assert!(!rig.log.lock().unwrap().contains(&"commit"));
    }

    /// The desktop's yes and Back, both ready: the yes the phone holds wins.
    #[test]
    fn an_answer_ready_beside_a_back_is_committed() {
        let (tx, rx) = oneshot::channel();
        tx.send(Ok(PairResult::Paired { desktop_name: Some("desk".into()) })).unwrap();
        let (challenge, rig) = fake(Some(rx), Ok(entry()));
        let (back, cancel) = oneshot::channel::<()>();
        let pressed = Arc::new(AtomicBool::new(false));
        let p = pressed.clone();
        let mut back = Some(back);
        let got = run(pair_flow(
            async { Ok(challenge) },
            move |_| {
                back.take().unwrap().send(()).unwrap();
                p.store(true, Ordering::SeqCst);
            },
            cancel,
        ));
        assert!(pressed.load(Ordering::SeqCst));
        assert_eq!(got, Ok(entry()));
        assert_eq!(*rig.log.lock().unwrap(), ["read", "commit"]);
    }
}
