//! Spike for #339: is iroh good enough to connect a phone to a desktop?
//! Throwaway. Never merged.

use std::{path::PathBuf, str::FromStr, time::{Duration, Instant}};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use iroh::{endpoint::{presets, Connection}, Endpoint, EndpointAddr, EndpointId, SecretKey};
use n0_future::StreamExt;

const ALPN: &[u8] = b"vibe/spike/0";

#[derive(Parser)]
struct Cli {
    /// Also look up peers on the local network over mDNS.
    #[arg(long, global = true)]
    mdns: bool,
    /// Use no internet discovery and no relays (LAN-only test, needs --mdns).
    #[arg(long, global = true)]
    offline: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// The desktop side: a persistent key, echoing every stream.
    Serve {
        #[arg(long, default_value = "spike.key")]
        key: PathBuf,
    },
    /// The phone side: dial by endpoint id only, then ping.
    Dial {
        id: String,
        /// Pings after connecting, one per --interval.
        #[arg(long, default_value_t = 10)]
        pings: u32,
        #[arg(long, default_value_t = 1.0)]
        interval: f64,
        /// Seconds to wait after binding before dialing (lets mDNS hear the peer).
        #[arg(long, default_value_t = 0.0)]
        wait: f64,
    },
}

fn t0() -> &'static Instant {
    static T: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    T.get_or_init(Instant::now)
}
macro_rules! log { ($($a:tt)*) => { println!("[{:8.3}s] {}", t0().elapsed().as_secs_f64(), format!($($a)*)) } }

fn load_key(path: &PathBuf) -> Result<SecretKey> {
    if let Ok(hexed) = std::fs::read_to_string(path) {
        let bytes: [u8; 32] = hex::decode(hexed.trim())?.try_into().map_err(|_| anyhow::anyhow!("bad key"))?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let key = SecretKey::generate();
    std::fs::write(path, hex::encode(key.to_bytes()))?;
    Ok(key)
}

async fn bind(cli: &Cli, key: Option<SecretKey>, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    let mut b = if cli.offline { Endpoint::builder(presets::Minimal) } else { Endpoint::builder(presets::N0) };
    if cli.offline { b = b.relay_mode(iroh::RelayMode::Disabled); }
    if let Some(k) = key { b = b.secret_key(k); }
    if cli.mdns {
        b = b.address_lookup(iroh_mdns_address_lookup::MdnsAddressLookup::builder());
    }
    Ok(b.alpns(alpns).bind().await?)
}

fn describe(conn: &Connection) -> String {
    conn.paths().iter().map(|p| {
        let kind = if p.is_relay() { "relay" } else { "direct" };
        format!("{}{} {:?}", if p.is_selected() { "*" } else { " " }, kind, p.remote_addr())
    }).collect::<Vec<_>>().join(" | ")
}

fn watch_paths(conn: Connection, who: String) {
    tokio::spawn(async move {
        let mut last = String::new();
        let mut s = conn.paths_stream();
        while s.next().await.is_some() {
            let now = describe(&conn);
            if now != last { log!("{who} paths: {now}"); last = now; }
        }
    });
}

#[tokio::main]
async fn main() -> Result<()> {
    t0();
    let cli = Cli::parse();
    match &cli.cmd {
        Cmd::Serve { key } => {
            let ep = bind(&cli, Some(load_key(key)?), vec![ALPN.to_vec()]).await?;
            log!("endpoint id: {}", ep.id());
            if !cli.offline {
                tokio::time::timeout(Duration::from_secs(30), ep.online()).await.context("not online in 30s")?;
                log!("online; addr: {:?}", ep.addr());
            }
            while let Some(inc) = ep.accept().await {
                tokio::spawn(async move {
                    let conn = match inc.await { Ok(c) => c, Err(e) => { log!("accept failed: {e}"); return; } };
                    let who = conn.remote_id().fmt_short().to_string();
                    log!("accepted {who}");
                    watch_paths(conn.clone(), who.clone());
                    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                        tokio::spawn(async move {
                            let _ = tokio::io::copy(&mut recv, &mut send).await;
                            let _ = send.finish();
                        });
                    }
                    log!("{who} closed: {:?}", conn.close_reason());
                });
            }
        }
        Cmd::Dial { id, pings, interval, wait } => {
            let id = EndpointId::from_str(id)?;
            let ep = bind(&cli, None, vec![]).await?;
            log!("bound as {}", ep.id().fmt_short());
            tokio::time::sleep(Duration::from_secs_f64(*wait)).await;
            let start = Instant::now();
            let conn = ep.connect(EndpointAddr::from(id), ALPN).await?;
            log!("connected in {:.3}s: {}", start.elapsed().as_secs_f64(), describe(&conn));
            watch_paths(conn.clone(), "server".into());
            for i in 0..*pings {
                let s = Instant::now();
                let r = async {
                    let (mut send, mut recv) = conn.open_bi().await?;
                    send.write_all(format!("ping {i}").as_bytes()).await?;
                    send.finish()?;
                    let back = recv.read_to_end(64).await?;
                    anyhow::Ok(back)
                };
                match tokio::time::timeout(Duration::from_secs(10), r).await {
                    Ok(Ok(_)) => log!("ping {i}: {:.1}ms", s.elapsed().as_secs_f64() * 1000.0),
                    Ok(Err(e)) => log!("ping {i} failed: {e}"),
                    Err(_) => log!("ping {i} timed out"),
                }
                tokio::time::sleep(Duration::from_secs_f64(*interval)).await;
            }
            conn.close(0u32.into(), b"bye");
            ep.close().await;
        }
    }
    Ok(())
}
