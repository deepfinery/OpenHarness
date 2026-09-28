# Machines — installation guide

How to let the orchestrator operate machines that have no public IP: Linux hosts, containers, OpenShell managed
machines ([openshell.md](openshell.md)), and (in the next release) Windows hosts and Chrome browsers. Every machine runs a small **connector** that dials **out**
to the **gateway** over WebSocket; the orchestrator never connects inbound to a machine.

```
[connector on the machine] --wss--> [gateway]  <--HTTPS MCP-- [orchestrator api + runner]
```

## 1. The gateway

### Bundled with the orchestrator (default)

`./start.sh` adds `GATEWAY_API_TOKEN`, `GATEWAY_ADMIN_TOKEN`, `GATEWAY_PORT` and `GATEWAY_PUBLIC_URL` to
`.env` (existing installations get them appended on the next start) and `docker compose up` starts the
`gateway` service next to the api and runner. Internally the orchestrator talks to `http://gateway:8090`;
machines dial `GATEWAY_PUBLIC_URL` (`ws://localhost:8090` by default, which only works for machines on the
same host).

For machines elsewhere, put the gateway port behind TLS and set `GATEWAY_PUBLIC_URL=wss://gateway.example.com`:

- Publish `GATEWAY_PORT` (default 8090) through your reverse proxy with WebSocket support, or use the
  provided [`gateway/Caddyfile`](../gateway/Caddyfile), which terminates TLS with automatic certificates and
  forwards `X-Forwarded-Proto`.
- Then set `GATEWAY_ALLOW_INSECURE_WS=false` in `.env` so the gateway refuses device sockets that did not
  arrive over TLS.
- The gateway is the **only** component that needs a public address. Keep `/admin/*` private (the
  Caddyfile returns 404 for it; the orchestrator reaches the admin API over the internal network).

### Standalone

`gateway/compose.yaml` runs the gateway with Caddy and its own MongoDB on another host:

```sh
GATEWAY_PUBLIC_URL=wss://gateway.example.com \
GATEWAY_MONGO_PASSWORD=$(openssl rand -hex 24) \
GATEWAY_API_TOKENS=orchestrator:$(openssl rand -hex 32) \
GATEWAY_ADMIN_TOKEN=$(openssl rand -hex 32) \
docker compose -f gateway/compose.yaml up --build -d
```

Point the orchestrator at it with `GATEWAY_URL=https://gateway.example.com`, `GATEWAY_PUBLIC_URL=wss://gateway.example.com`,
`GATEWAY_API_TOKEN=<the orchestrator token>`, `GATEWAY_ADMIN_TOKEN=<admin token>`.

Gateway settings (environment):

| Variable                       | Default               | Purpose                                                                          |
| ------------------------------ | --------------------- | -------------------------------------------------------------------------------- |
| `GATEWAY_API_TOKENS`           | —                     | `name:token,…` bearer tokens orchestrators use; `name` appears in the audit      |
| `GATEWAY_ADMIN_TOKEN`          | —                     | Bearer token for `/admin/*` (enrollment); unset disables the admin API           |
| `GATEWAY_PUBLIC_URL`           | `ws://localhost:8090` | Address machines dial; also shown in the studio                                  |
| `GATEWAY_ALLOW_INSECURE_WS`    | `false`               | Accept sockets without TLS (development only)                                    |
| `GATEWAY_TOOL_TIMEOUT_SECONDS` | `120`                 | Per tool call; `GATEWAY_TOOL_TIMEOUTS=run_command=600,…` overrides               |
| `GATEWAY_APPROVAL_TOOLS`       | —                     | Tools that need an approval decision (`GATEWAY_APPROVAL_PROVIDER=noop\|webhook`) |
| `GATEWAY_APPROVAL_URL`         | —                     | Webhook that receives the pending call and answers `approved`/`denied`           |
| `GATEWAY_AUDIT_FILE`           | stdout                | JSON-line copy of each audit entry (the record itself is stored in MongoDB)      |
| `GATEWAY_MONGODB_URI`          | —                     | MongoDB for the device registry and audit trail (the bundled stack sets it)      |
| `GATEWAY_MONGODB_DATABASE`     | `agentic_gateway`     | Database name, separate from the orchestrator's                                  |
| `GATEWAY_AUDIT_RETENTION_DAYS` | `90`                  | Audit entries older than this are deleted automatically; `0` keeps them forever  |
| `GATEWAY_HEARTBEAT_SECONDS`    | `30`                  | Ping interval; two misses mark a machine offline                                 |

CLI (talks to MongoDB directly, so it works while the gateway server is down):

```sh
docker compose exec gateway node gateway/dist/cli.js list
docker compose exec gateway node gateway/dist/cli.js enroll --id box-1 --platform linux --owner <tenant> --allow run_command,read_file
docker compose exec gateway node gateway/dist/cli.js allow box-1 run_command,read_file,list_dir
```

The studio's **Inventory** page does the same through the admin API and is the normal way to enroll.

## 2. Enroll a machine

**Machines → Add machine**: choose Linux host, Container, Windows or Chrome, name it, tick the tools the
agent may use (deny by default; **acts** marks tools that change things), and click **Create token**. The
next dialog shows the one-time device token and a copy-paste install command for each platform, and flips
to **Connected** as soon as the connector dials in. Tokens are stored hashed (argon2id) and never shown
again; **New token** in the machine's settings issues another.

## 3. Linux host

Requirements: Node.js 22.13 or later, outbound HTTPS (443) to the gateway, root for the install.

```sh
git clone https://github.com/deepfinery/OpenHarness.git && cd OpenHarness
npm --prefix connector-core ci && npm --prefix connector-core run build
npm --prefix connector-linux ci && npm --prefix connector-linux run build
sudo GATEWAY_URL=wss://gateway.example.com/connect DEVICE_ID=box-1 DEVICE_TOKEN=dv_… sh connector-linux/install.sh
```

The script creates the `openharness-connector` system user, installs to `/opt/openharness-connector`, writes the
token to `/etc/openharness-connector/token` (mode 600) and the config to `/etc/openharness-connector/config.json`,
and enables the hardened `openharness-connector` systemd unit (`ProtectSystem=strict`, `NoNewPrivileges=yes`,
`ReadWritePaths=/var/lib/openharness-connector`, no capabilities). The work directory the agent may read and
write is `/var/lib/openharness-connector/work`; the command allow-list starts with read-mostly programs (`ls`,
`cat`, `grep`, `df`, `systemctl`, `journalctl`, `git`, `docker`, …) and `rm`, `dd`, `sudo`, `shutdown` are
denied. Edit `config.json` (see `connector-linux/config.example.json`) and `systemctl restart openharness-connector`.

The config is owned by `root:openharness-connector` with mode `0640`; the config directory is `0750`.
Re-running the installer repairs ownership, updates the gateway URL and device ID, replaces the token,
and restarts the service. Existing command allow-lists and other local policy settings are preserved.

For a local development gateway without TLS, pass `GATEWAY_ALLOW_INSECURE=true` alongside a `ws://`
`GATEWAY_URL`. The installer writes `allow_insecure: true` into the config used by systemd. This sends
credentials and commands without transport encryption; use `wss://` for deployment. Set
`GATEWAY_ALLOW_INSECURE=false` to remove a previous insecure override. The gateway address must be
reachable from the machine: `localhost` points to that machine, not the orchestrator. Set
`GATEWAY_PUBLIC_URL` to the reachable gateway address and recreate the API service before copying the
studio's install command for a remote machine.

Firewall: only outbound 443 to the gateway is needed. To pin it, uncomment `IPAddressAllow` in the unit.

Verify locally without a gateway: `CONNECTOR_STDIO=1 WORK_DIR=$PWD npx @modelcontextprotocol/inspector --cli node connector-linux/dist/main.js --method tools/list`.

## 4. Container

Any Docker host, including the orchestrator's own:

```sh
docker build -f connector-linux/Dockerfile -t openharness-connector-linux .
docker run -d --name openharness-box-1 --restart unless-stopped \
  -e GATEWAY_URL=wss://gateway.example.com/connect -e DEVICE_ID=box-1 -e DEVICE_TOKEN=dv_… \
  -v "$PWD/machine-work:/work" openharness-connector-linux
```

The image runs as the `node` user with `/work` as the work directory and `ALLOW_COMMANDS=ls,cat,grep,find,head,tail,wc,df,du,uname,uptime,ps,env,echo,date,sh`.
Override `ALLOW_COMMANDS`, `READ_ONLY=true`, `MAX_OUTPUT_BYTES`, `COMMAND_TIMEOUT_SECONDS` as needed. Add
`--cap-drop ALL --security-opt no-new-privileges` and a read-only root filesystem for production. A container
is the recommended isolation when the connector should reach an application (mount only what it needs) and
the "OpenShell" option for hosts where you would rather not install Node.js.

For a gateway without TLS (local development) add `-e GATEWAY_ALLOW_INSECURE=true`; the connector refuses
`ws://` otherwise.

## 5. Windows and Chrome

`connector-windows` (PowerShell tools, optional UI Automation, Windows service or logon task) and
`connector-chrome` (Manifest V3 extension) are the next release; the Inventory page already accepts their
enrollment so the tokens and allow-lists are in place. Notes that apply when they ship:

- A Windows **service** runs in Session 0 and cannot drive the interactive desktop; UI Automation tools need
  the connector installed as a logon scheduled task in the user's session, and UIPI still blocks elevated
  windows.
- The Chrome connector should run in a dedicated Chrome profile with a per-site allow-list; `evaluate_js`
  stays off unless enabled in the extension options.

## 5b. OpenShell managed machine

An OpenShell managed machine is enrolled like a Linux machine (**Inventory → Add resource → OpenShell managed
machine**) and deploys `deploy/openshell/compose.yaml` on the private host: the NVIDIA OpenShell 0.1.2 gateway
(Docker driver) and the OpenHarness edge, a Go service that talks to that gateway over its gRPC API and dials out
to the device gateway. The edge exposes sandboxes, execution inside them, logs and policies as MCP tools and
launches executors: sandboxes that run the Go connector under a policy and register as sandboxed Linux machines.
Settings, tools, constraints and the enforcement check are in [openshell.md](openshell.md).

## 5c. TLS with a self-signed certificate

`./scripts/enable-tls.sh <public-host-or-ip>` creates a local certificate authority and a server certificate under
`data/tls/`, and switches `.env` so `./start.sh` runs Caddy on `TLS_PORT` (8443): `https://<host>:8443` is the
studio and API, `wss://<host>:8443/connect` is where machines dial in, and the plain ports stay on loopback. Give
connectors the CA: `GATEWAY_CA_FILE=/etc/openharness/ca.crt` (mounted) for the Go connector and edge,
`OPENHARNESS_CA_FILE=/certs/ca.crt` in the OpenShell deployment, `NODE_EXTRA_CA_CERTS` for the Node connector.
Import `data/tls/ca.crt` into your browser to avoid the warning.

## 6. Use a machine

- **Playground:** pick the workflow, then the machine in the top bar. Every agent in the run receives the
  machine's allowed tools and an instruction naming the machine; commands and results appear in the trace.
- **Workflows:** machines also appear in the designer's toolbox under **Machines**; drag one onto an agent to
  bind it permanently to that agent.
- **API:** `POST /api/runs` or `/api/chat` with `"deviceId": "box-1"`; a conversation remembers its machine.

## 7. Troubleshooting

| Symptom                                 | Check                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine stays **offline** after install | `sudo journalctl -u openharness-connector -f` (or `docker logs`). Close code 4001 = wrong token or not enrolled; 4003 = disabled or platform mismatch; TLS errors = `GATEWAY_URL` must be `wss://`. |
| Online but **no tools**                 | Click **Sync tools** on the Inventory page; the connector's `ALLOW_COMMANDS` does not affect the tool list, the machine's allowed tools in the studio do.                                           |
| `tool not allowed`                      | Add the tool in the machine's **Tools** dialog (gateway allow-list).                                                                                                                                |
| `command is not on the allow-list`      | Add the program to `allow_commands` in the connector config (host) or `ALLOW_COMMANDS` (container).                                                                                                 |
| `device timeout`                        | Raise `GATEWAY_TOOL_TIMEOUTS=run_command=600` or the connector's `command_timeout_seconds`.                                                                                                         |
| Studio says the gateway is unreachable  | `docker compose ps gateway`, `GATEWAY_URL` from the api container, `GATEWAY_ADMIN_TOKEN` matches.                                                                                                   |

## Restricted or privileged VM host access

For a standalone Linux machine, **Inventory → Add resource / Configure → Machine access** offers two modes:

- **Restricted connector** keeps the existing command allow-list and work-directory boundary. Commands run in the connector environment; seeing host kernel entries in `/proc` does not prove host userspace access.
- **Privileged VM host (root)** is an administrator-only setting for the Linux Docker connector. Its generated command uses `--privileged --pid=host --user 0`, `HOST_ACCESS=true`, and `MACHINE_ACCESS_MODE=host`. `run_command` enters the VM host’s mount, PID, network, UTS and IPC namespaces with the host root and working directory. It can execute any host command as root, including disruptive operations; sudo is not needed. This is full administrator access, not read-only diagnostics.

The setting alone cannot elevate a running container. Save it, open **Installation instructions**, enter the reachable **Harness gateway address** and your saved token, then rebuild/recreate the connector on that VM. Instructions include the repository clone, build, private environment file, Docker flags and log command. An existing token can be reused. If it was lost, issue a new token and update the connector.

The connector refuses host mode without root, local host-access opt-in, and a separate target mount namespace. The gateway requires the machine’s host-access setting both at connection time and before tool dispatch. Changing back to restricted disconnects the privileged connector and refuses its reconnection; reinstall in restricted mode to restore connectivity. Already-started host commands may have acted before revocation.

In host mode, `nvidia-smi`, `dcgmi`, `journalctl` and similar programs run from the VM’s own filesystem and use its libraries, devices and services. Install missing NVIDIA/DCGM utilities **on the VM**. This mode does not require duplicating the driver’s userland packages in the connector image or adding `--gpus all` to expose devices inside the connector namespace. `system_info` verifies host identity and labels connector facts separately. `run_command` reports its execution scope. The file tools remain restricted to the connector work directory; use host `run_command` for other VM files and processes.

Gateway tool allow-lists, agent approvals, tool auditing, output caps, command deadlines and idempotency remain in effect. Full host command access intentionally removes the local executable deny-list for `run_command`; cluster drain/cooldown checks cannot constrain arbitrary standalone root commands. For bounded fleet operations, use the separate [cluster diagnostics and remediation](gpu-clusters.md) flow. Shared cluster tokens cannot enroll unrestricted host-command connectors. OpenShell is not part of this mode.
