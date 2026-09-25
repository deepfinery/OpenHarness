# Machines — installation guide

How to let the orchestrator operate machines that have no public IP: Linux hosts, containers, and (in the
next release) Windows hosts and Chrome browsers. Every machine runs a small **connector** that dials **out**
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

`gateway/compose.yaml` runs the gateway with Caddy on another host:

```sh
GATEWAY_PUBLIC_URL=wss://gateway.example.com \
GATEWAY_API_TOKENS=orchestrator:$(openssl rand -hex 32) \
GATEWAY_ADMIN_TOKEN=$(openssl rand -hex 32) \
docker compose -f gateway/compose.yaml up --build -d
```

Point the orchestrator at it with `GATEWAY_URL=https://gateway.example.com`, `GATEWAY_PUBLIC_URL=wss://gateway.example.com`,
`GATEWAY_API_TOKEN=<the orchestrator token>`, `GATEWAY_ADMIN_TOKEN=<admin token>`.

Gateway settings (environment):

| Variable                            | Default               | Purpose                                                                          |
| ----------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `GATEWAY_API_TOKENS`                | —                     | `name:token,…` bearer tokens orchestrators use; `name` appears in the audit      |
| `GATEWAY_ADMIN_TOKEN`               | —                     | Bearer token for `/admin/*` (enrollment); unset disables the admin API           |
| `GATEWAY_PUBLIC_URL`                | `ws://localhost:8090` | Address machines dial; also shown in the studio                                  |
| `GATEWAY_ALLOW_INSECURE_WS`         | `false`               | Accept sockets without TLS (development only)                                    |
| `GATEWAY_TOOL_TIMEOUT_SECONDS`      | `120`                 | Per tool call; `GATEWAY_TOOL_TIMEOUTS=run_command=600,…` overrides               |
| `GATEWAY_APPROVAL_TOOLS`            | —                     | Tools that need an approval decision (`GATEWAY_APPROVAL_PROVIDER=noop\|webhook`) |
| `GATEWAY_APPROVAL_URL`              | —                     | Webhook that receives the pending call and answers `approved`/`denied`           |
| `GATEWAY_AUDIT_FILE`                | stdout                | JSON lines, one per tool call                                                    |
| `GATEWAY_DATA_DIR` / `DATABASE_URL` | `./data`              | SQLite file; Postgres via `DATABASE_URL` is reserved for a later release         |
| `GATEWAY_HEARTBEAT_SECONDS`         | `30`                  | Ping interval; two misses mark a machine offline                                 |

CLI (works on the data directory even when the server is down):

```sh
docker compose exec gateway node gateway/dist/cli.js list
docker compose exec gateway node gateway/dist/cli.js enroll --id box-1 --platform linux --owner <tenant> --allow run_command,read_file
docker compose exec gateway node gateway/dist/cli.js allow box-1 run_command,read_file,list_dir
```

The studio's **Machines** page does the same through the admin API and is the normal way to enroll.

## 2. Enroll a machine

**Machines → Add machine**: choose Linux host, Container, Windows or Chrome, name it, tick the tools the
agent may use (deny by default; **acts** marks tools that change things), and click **Create token**. The
next dialog shows the one-time device token and a copy-paste install command for each platform, and flips
to **Connected** as soon as the connector dials in. Tokens are stored hashed (argon2id) and never shown
again; **New token** in the machine's settings issues another.

## 3. Linux host

Requirements: Node.js 22.13 or later, outbound HTTPS (443) to the gateway, root for the install.

```sh
git clone https://github.com/deepfinery/orchestrator.git && cd orchestrator
npm --prefix connector-core ci && npm --prefix connector-core run build
npm --prefix connector-linux ci && npm --prefix connector-linux run build
sudo GATEWAY_URL=wss://gateway.example.com/connect DEVICE_ID=box-1 DEVICE_TOKEN=dv_… sh connector-linux/install.sh
```

The script creates the `agentic-connector` system user, installs to `/opt/agentic-connector`, writes the
token to `/etc/agentic-connector/token` (mode 600) and the config to `/etc/agentic-connector/config.json`,
and enables the hardened `agentic-connector` systemd unit (`ProtectSystem=strict`, `NoNewPrivileges=yes`,
`ReadWritePaths=/var/lib/agentic-connector`, no capabilities). The work directory the agent may read and
write is `/var/lib/agentic-connector/work`; the command allow-list starts with read-mostly programs (`ls`,
`cat`, `grep`, `df`, `systemctl`, `journalctl`, `git`, `docker`, …) and `rm`, `dd`, `sudo`, `shutdown` are
denied. Edit `config.json` (see `connector-linux/config.example.json`) and `systemctl restart agentic-connector`.

Firewall: only outbound 443 to the gateway is needed. To pin it, uncomment `IPAddressAllow` in the unit.

Verify locally without a gateway: `CONNECTOR_STDIO=1 WORK_DIR=$PWD npx @modelcontextprotocol/inspector --cli node connector-linux/dist/main.js --method tools/list`.

## 4. Container

Any Docker host, including the orchestrator's own:

```sh
docker build -f connector-linux/Dockerfile -t agentic-connector-linux .
docker run -d --name agentic-box-1 --restart unless-stopped \
  -e GATEWAY_URL=wss://gateway.example.com/connect -e DEVICE_ID=box-1 -e DEVICE_TOKEN=dv_… \
  -v "$PWD/machine-work:/work" agentic-connector-linux
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
`connector-chrome` (Manifest V3 extension) are the next release; the Machines page already accepts their
enrollment so the tokens and allow-lists are in place. Notes that apply when they ship:

- A Windows **service** runs in Session 0 and cannot drive the interactive desktop; UI Automation tools need
  the connector installed as a logon scheduled task in the user's session, and UIPI still blocks elevated
  windows.
- The Chrome connector should run in a dedicated Chrome profile with a per-site allow-list; `evaluate_js`
  stays off unless enabled in the extension options.

## 6. Use a machine

- **Playground:** pick the workflow, then the machine in the top bar. Every agent in the run receives the
  machine's allowed tools and an instruction naming the machine; commands and results appear in the trace.
- **Workflows:** machines also appear in the designer's toolbox under **Machines**; drag one onto an agent to
  bind it permanently to that agent.
- **API:** `POST /api/runs` or `/api/chat` with `"deviceId": "box-1"`; a conversation remembers its machine.

## 7. Troubleshooting

| Symptom                                 | Check                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Machine stays **offline** after install | `journalctl -u agentic-connector -f` (or `docker logs`). Close code 4001 = wrong token or not enrolled; 4003 = disabled or platform mismatch; TLS errors = `GATEWAY_URL` must be `wss://`. |
| Online but **no tools**                 | Click **Sync** on the Machines page; the connector's `ALLOW_COMMANDS` does not affect the tool list, the machine's allowed tools in the studio do.                                         |
| `tool not allowed`                      | Add the tool in the machine's **Tools** dialog (gateway allow-list).                                                                                                                       |
| `command is not on the allow-list`      | Add the program to `allow_commands` in the connector config (host) or `ALLOW_COMMANDS` (container).                                                                                        |
| `device timeout`                        | Raise `GATEWAY_TOOL_TIMEOUTS=run_command=600` or the connector's `command_timeout_seconds`.                                                                                                |
| Studio says the gateway is unreachable  | `docker compose ps gateway`, `GATEWAY_URL` from the api container, `GATEWAY_ADMIN_TOKEN` matches.                                                                                          |
