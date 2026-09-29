# OpenHarness on an OpenShell host

This folder deploys, on the machine that will run the sandboxes, the NVIDIA OpenShell gateway (Docker compute
driver) and the **OpenHarness edge**: one container that talks to that gateway over its gRPC API, dials **out** to
the OpenHarness device gateway over WebSocket, exposes OpenShell as MCP tools (sandboxes, execution, logs,
policies, rule proposals) and launches **executors**: sandboxes that run the OpenHarness connector under an
OpenShell policy and register in the inventory as machines. Nothing here listens for the harness; the harness can
be on a public network while this host stays private.

```
OpenHarness server (public)                       OpenShell host (private)
  studio ─ api ─ device gateway  ◄── wss ──────── openharness-edge ── gRPC ── openshell-gateway
                                 ◄── wss ──────── executor sandbox (openharness-connector, confined)
```

## Steps

1. **Enroll the machine.** In the studio: _Inventory → Add resource → OpenShell managed machine → Create token_.
   Note the machine id and the token (shown once).
2. **Images.** On this host, either pull the images from your registry or build them from a checkout:
   `sh deploy/openshell/build-images.sh`. The executor image must be visible to this host's Docker daemon,
   because the OpenShell gateway creates sandboxes through the Docker socket.
3. **Configure.** `cp .env.example .env` and fill in `OPENHARNESS_GATEWAY_URL`, `OPENHARNESS_DEVICE_ID`,
   `OPENHARNESS_TOKEN`. If the harness uses the self-signed TLS front (`scripts/enable-tls.sh` on the server),
   copy the server's `data/tls/ca.crt` into `./certs/` and keep `OPENHARNESS_CA_FILE=/certs/ca.crt`. That value is a
   path inside the edge container, where `./certs` is mounted as `/certs`; if you give a path on this host instead,
   `up.sh` copies the file into `./certs` and updates `.env`.
4. **Start.** `sh up.sh` (the first run creates the OpenShell PKI under `/var/lib/openshell/tls` with the
   gateway's own `generate-certs`; the gateway then requires client certificates and mints the launch-scoped
   credentials the Docker driver needs), then `docker compose logs -f openharness-edge` until it reports
   `gateway connected`. The machine turns online in the inventory and the **OpenShell** page shows the gateway.
5. **Launch executors** from the OpenShell page (_Launch executor_): the studio enrolls a Linux machine, hands the
   edge its token, and the edge creates a sandbox from `EXECUTOR_IMAGE` whose policy allows only the harness
   gateway (and `EXECUTOR_ALLOWED_HOSTS`). The executor appears in the inventory with a _sandboxed_ badge; every
   command a harness runs on it is confined by OpenShell.

## Requirements and constraints

- Docker Engine 28 or later, a kernel with Landlock ABI v3 or later (the executor policy sets
  `landlock.compatibility: hard_requirement`, so a host without it refuses to start the sandbox rather than run
  it unconfined), and `/var/lib/openshell` writable on the host.
- The OpenShell gateway API uses mTLS: the edge presents the client certificate from the PKI, sandboxes use the
  guest bundle, and the port is published on loopback only. To use the `openshell` CLI on this host, copy
  `/var/lib/openshell/tls/.config/openshell/gateways/openshell/mtls` to `~/.config/openshell/gateways/openshell/mtls`
  and run `openshell gateway add https://127.0.0.1:8080 --local --name openshell`.
- Loopback, link-local and the metadata address are always blocked inside a sandbox: the harness gateway must be
  a routable address for executors, not `localhost`.
- The executor's rule for the harness gateway uses `tls: skip`, so OpenShell relays the WebSocket without
  terminating TLS and the executor verifies the harness certificate itself (with `GATEWAY_CA_PEM` when the
  harness is self-signed, passed base64-encoded as `GATEWAY_CA_PEM_BASE64`).
- OpenShell telemetry is disabled here (`OPENSHELL_TELEMETRY_ENABLED=false`).

## Operations

| Task                               | Command                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Follow the edge                    | `docker compose logs -f openharness-edge`                                                                               |
| Follow the OpenShell gateway       | `docker compose logs -f openshell-gateway`                                                                              |
| Use the OpenShell CLI on this host | copy the `mtls` bundle as described above, then `openshell gateway add https://127.0.0.1:8080 --local --name openshell` |
| Upgrade                            | edit `OPENSHELL_VERSION` / image tags in `.env` and `gateway.toml`, then `docker compose up -d`                         |
| Stop                               | `docker compose down` (sandboxes created by OpenShell are separate containers; delete them from the console first)      |

See `docs/openshell.md` in the repository for the tool list, the edge settings and how to verify enforcement.
