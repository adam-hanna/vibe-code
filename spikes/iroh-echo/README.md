# iroh spike (#339)

Throwaway. This branch is never merged.

```bash
cargo build --release
./target/release/iroh-echo serve --key desk.key          # prints the endpoint id
./target/release/iroh-echo dial <endpoint-id> --pings 20  # from another machine or network
```

`--mdns` adds local-network discovery; `--offline --mdns` uses no relay and no internet.
`dial` prints how long the connection took, whether the path is direct or relayed, and
every path change, so a network switch mid-session shows up in the log.
