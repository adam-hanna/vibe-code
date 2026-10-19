//! How an endpoint reaches the internet, as #340 decided: n0's preset (pkarr to
//! `dns.iroh.link`, DNS lookup and n0's public relays), optionally one relay the
//! user runs instead, and optionally mDNS for the local network.
//!
//! Shared so the phone dials with exactly the lookup and relays the desktop
//! publishes to. Each app then adds its own key, ALPNs and hooks.

use iroh::endpoint::{presets, Builder};
use iroh::{Endpoint, RelayMap, RelayMode, RelayUrl};

/// A builder for an internet-facing endpoint. `relay` replaces n0's relays with
/// one the user runs (`iroh-relay`), which is then what the record names.
pub fn internet(relay: Option<RelayUrl>, mdns: bool) -> Builder {
    let mut b = Endpoint::builder(presets::N0);
    if let Some(url) = relay {
        b = b.relay_mode(RelayMode::Custom(RelayMap::from(url)));
    }
    if mdns {
        b = b.address_lookup(iroh_mdns_address_lookup::MdnsAddressLookup::builder());
    }
    b
}

/// The relays an [`internet`] endpoint built with `relay` uses: that one, or
/// n0's. What the phone's network reading compares a desktop's relay against
/// (#346), from the same choice the builder made.
pub fn relays(relay: Option<&RelayUrl>) -> Vec<RelayUrl> {
    match relay {
        Some(url) => vec![url.clone()],
        None => iroh::endpoint::default_relay_mode().relay_map().urls(),
    }
}
