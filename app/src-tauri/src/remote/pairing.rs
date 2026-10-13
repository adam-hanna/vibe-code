//! Pairing as a state machine: no network, no Tauri, no clock of its own (#341).
//!
//! Everything a pairing depends on that is not state - the time, the random
//! secret and nonce, whether the phone is already on the list - is a
//! parameter, so every rule here is a test away. The endpoint (#342) is what
//! will call `attempt`; until then only the tests do.

use std::fmt;

use iroh_base::PublicKey;
use subtle::ConstantTimeEq;

use super::wire::{matching_code_for, phone_name, NameError};

/// How long a pairing code lives: five minutes, the design's figure.
pub const CODE_TTL_MS: u64 = 5 * 60 * 1000;

/// The live code, if any, and the prompt waiting for a person, if any.
#[derive(Default)]
pub struct Pairing {
    code: Option<Code>,
    pending: Option<Pending>,
}

struct Code {
    secret: [u8; 32],
    expires_at: u64,
    burnt: bool,
}

/// *Allow `<phone_name>`?*, waiting for a yes or a no.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    /// The id the QUIC handshake authenticated - never one a message claimed.
    pub phone_id: PublicKey,
    pub phone_name: String,
    /// The six digits.
    pub code: String,
    pub nonce: [u8; 16],
    /// The code's own expiry, not five minutes after the attempt.
    pub expires_at: u64,
}

/// What `begin` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Begun {
    pub expires_at: u64,
    /// Whether a prompt was waiting and is now gone, so the window can be told.
    pub replaced_prompt: bool,
}

/// Why an attempt was refused. Each is its own fact and says so.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    NoCode,
    Expired,
    Burnt,
    Wrong,
    AlreadyPaired,
    Name(NameError),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::NoCode => write!(f, "no pairing code is live on this desktop"),
            Refusal::Expired => write!(f, "the pairing code has expired"),
            Refusal::Burnt => write!(f, "the pairing code has already been used"),
            Refusal::Wrong => write!(f, "that is not the pairing code"),
            Refusal::AlreadyPaired => write!(f, "this phone is already paired with this desktop"),
            Refusal::Name(why) => write!(f, "{why}"),
        }
    }
}

/// How a prompt was answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Paired { id: PublicKey, name: String },
    Declined,
    Expired,
    NothingPending,
}

impl Pairing {
    /// A new code. **At most one is live**: this replaces any earlier code, so
    /// a code shown and abandoned stops working the moment another is made.
    pub fn begin(&mut self, now: u64, secret: [u8; 32]) -> Begun {
        let expires_at = now + CODE_TTL_MS;
        self.code = Some(Code { secret, expires_at, burnt: false });
        let replaced_prompt = self.pending.take().is_some();
        Begun { expires_at, replaced_prompt }
    }

    /// A phone presents a secret.
    ///
    /// **Any attempt that reaches the comparison burns the code, right or
    /// wrong**, so a photographed code can be tried once and an attacker racing
    /// the owner makes the owner's attempt fail visibly. Expiry is checked
    /// first so an expired code says *expired* rather than *used*.
    #[allow(clippy::too_many_arguments)]
    pub fn attempt(
        &mut self,
        secret: &[u8],
        phone_id: PublicKey,
        raw_name: &str,
        desktop_id: &PublicKey,
        already_paired: bool,
        nonce: [u8; 16],
        now: u64,
    ) -> Result<&Pending, Refusal> {
        let code = self.code.as_mut().ok_or(Refusal::NoCode)?;
        if code.burnt {
            return Err(Refusal::Burnt);
        }
        if now >= code.expires_at {
            return Err(Refusal::Expired);
        }
        code.burnt = true;
        // A slice of another length is a mismatch, compared in constant time
        // like any other: `ct_eq` on unequal lengths answers false.
        if !bool::from(code.secret.as_slice().ct_eq(secret)) {
            return Err(Refusal::Wrong);
        }
        if already_paired {
            return Err(Refusal::AlreadyPaired);
        }
        let phone_name = phone_name(raw_name).map_err(Refusal::Name)?;
        let code = matching_code_for(desktop_id, &phone_id, &nonce);
        let expires_at = self.code.as_ref().map_or(now, |c| c.expires_at);
        Ok(self.pending.insert(Pending { phone_id, phone_name, code, nonce, expires_at }))
    }

    /// The person's yes or no. Whatever the answer, no prompt is left behind.
    pub fn answer(&mut self, yes: bool, now: u64) -> Answer {
        let Some(pending) = self.pending.take() else {
            return Answer::NothingPending;
        };
        if now >= pending.expires_at {
            Answer::Expired
        } else if !yes {
            Answer::Declined
        } else {
            Answer::Paired { id: pending.phone_id, name: pending.phone_name }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh_base::SecretKey;

    const SECRET: [u8; 32] = [5; 32];
    const NONCE: [u8; 16] = [6; 16];
    const MINUTE: u64 = 60_000;

    fn key(seed: u8) -> PublicKey {
        SecretKey::from_bytes(&[seed; 32]).public()
    }

    fn try_with(p: &mut Pairing, secret: &[u8], now: u64) -> Result<Pending, Refusal> {
        p.attempt(secret, key(2), "Pixel", &key(1), false, NONCE, now).cloned()
    }

    fn begun() -> Pairing {
        let mut p = Pairing::default();
        p.begin(0, SECRET);
        p
    }

    #[test]
    fn a_wrong_secret_burns_the_code() {
        let mut p = begun();
        assert_eq!(try_with(&mut p, &[9; 32], MINUTE), Err(Refusal::Wrong));
        assert_eq!(try_with(&mut p, &SECRET, MINUTE), Err(Refusal::Burnt));
    }

    #[test]
    fn a_wrong_length_is_wrong_and_burns() {
        let mut p = begun();
        assert_eq!(try_with(&mut p, &SECRET[..16], MINUTE), Err(Refusal::Wrong));
        assert_eq!(try_with(&mut p, &SECRET, MINUTE), Err(Refusal::Burnt));
    }

    #[test]
    fn a_right_secret_burns_the_code_too() {
        let mut p = begun();
        let pending = try_with(&mut p, &SECRET, MINUTE).expect("pairs");
        assert_eq!(pending.code, matching_code_for(&key(1), &key(2), &NONCE));
        assert_eq!(pending.phone_name, "Pixel");
        assert_eq!(pending.nonce, NONCE);
        assert_eq!(try_with(&mut p, &SECRET, MINUTE), Err(Refusal::Burnt));
    }

    #[test]
    fn an_expired_code_says_so() {
        let mut p = begun();
        assert_eq!(try_with(&mut p, &SECRET, CODE_TTL_MS), Err(Refusal::Expired));
    }

    #[test]
    fn with_no_code_there_is_nothing_to_try() {
        let mut p = Pairing::default();
        assert_eq!(try_with(&mut p, &SECRET, 0), Err(Refusal::NoCode));
    }

    #[test]
    fn a_second_begin_replaces_the_first() {
        let mut p = begun();
        let second = p.begin(MINUTE, [8; 32]);
        assert_eq!(second, Begun { expires_at: MINUTE + CODE_TTL_MS, replaced_prompt: false });
        assert_eq!(try_with(&mut p, &SECRET, 2 * MINUTE), Err(Refusal::Wrong));

        p.begin(3 * MINUTE, [8; 32]);
        assert!(try_with(&mut p, &[8; 32], 4 * MINUTE).is_ok());
    }

    #[test]
    fn a_begin_over_a_waiting_prompt_takes_it_away_and_says_so() {
        let mut p = begun();
        try_with(&mut p, &SECRET, MINUTE).expect("pairs");
        assert!(p.begin(2 * MINUTE, [8; 32]).replaced_prompt);
        assert_eq!(p.answer(true, 2 * MINUTE), Answer::NothingPending);
    }

    #[test]
    fn an_already_paired_phone_is_refused_and_the_code_burns() {
        let mut p = begun();
        let got = p.attempt(&SECRET, key(2), "Pixel", &key(1), true, NONCE, MINUTE).cloned();
        assert_eq!(got, Err(Refusal::AlreadyPaired));
        assert_eq!(try_with(&mut p, &SECRET, MINUTE), Err(Refusal::Burnt));
    }

    #[test]
    fn an_empty_name_is_refused_by_name() {
        let mut p = begun();
        let got = p.attempt(&SECRET, key(2), " \n ", &key(1), false, NONCE, MINUTE).cloned();
        assert_eq!(got, Err(Refusal::Name(NameError::Empty)));
        assert_eq!(Refusal::Name(NameError::Empty).to_string(), "the phone sent no name");
    }

    #[test]
    fn yes_pairs_the_phone_the_handshake_authenticated() {
        let mut p = begun();
        try_with(&mut p, &SECRET, MINUTE).expect("pairs");
        assert_eq!(p.answer(true, MINUTE), Answer::Paired { id: key(2), name: "Pixel".into() });
        assert_eq!(p.answer(true, MINUTE), Answer::NothingPending, "nothing is left behind");
    }

    #[test]
    fn no_declines() {
        let mut p = begun();
        try_with(&mut p, &SECRET, MINUTE).expect("pairs");
        assert_eq!(p.answer(false, MINUTE), Answer::Declined);
        assert_eq!(p.answer(true, MINUTE), Answer::NothingPending);
    }

    #[test]
    fn the_prompt_expires_with_the_code_not_five_minutes_after_the_attempt() {
        let mut p = begun();
        let pending = try_with(&mut p, &SECRET, 4 * MINUTE).expect("pairs");
        assert_eq!(pending.expires_at, CODE_TTL_MS);
        assert_eq!(p.answer(true, 5 * MINUTE), Answer::Expired);
    }

    #[test]
    fn an_answer_with_nothing_pending_is_said() {
        let mut p = begun();
        assert_eq!(p.answer(true, 0), Answer::NothingPending);
    }
}
