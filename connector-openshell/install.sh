#!/bin/sh
# Installs the OpenHarness OpenShell connector as a systemd *user* service for the OpenShell operator account.
# Run it as the user who registered the OpenShell gateway (the one that can run `openshell status`), not as root:
#   GATEWAY_URL=wss://gateway.example.com/connect DEVICE_ID=openshell-1 DEVICE_TOKEN=dv_... sh install.sh
set -eu
: "${GATEWAY_URL:?set GATEWAY_URL (wss://<gateway>/connect)}"
: "${DEVICE_ID:?set DEVICE_ID}"
: "${DEVICE_TOKEN:?set DEVICE_TOKEN (the one-time enrollment token)}"
SRC="${SRC:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/openharness-openshell-connector"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/openharness-openshell-connector"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/openharness-openshell-connector"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
[ "$(id -u)" -ne 0 ] || { echo 'run as the OpenShell operator user, not root: the connector uses that user’s ~/.config/openshell'; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js 22 or later is required (https://nodejs.org)'; exit 1; }
node -e 'const [m,n]=process.versions.node.split(".").map(Number); process.exit(m>22||(m===22&&n>=13)?0:1)' || { echo 'Node.js >= 22.13 is required'; exit 1; }
command -v "${OPENSHELL_BIN:-openshell}" >/dev/null 2>&1 || { echo 'The openshell CLI is not on PATH; install OpenShell 0.1.2 first (https://github.com/NVIDIA/OpenShell)'; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required for the user service'; exit 1; }
umask 077
mkdir -p "$PREFIX" "$CONF" "$STATE" "$UNIT_DIR"
cp -R "$SRC/connector-core" "$SRC/connector-openshell" "$PREFIX/"
( cd "$PREFIX/connector-core" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null )
( cd "$PREFIX/connector-openshell" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null )
[ -d "$PREFIX/connector-core/dist" ] && [ -d "$PREFIX/connector-openshell/dist" ] || { echo 'build the connector first (npm run build in connector-core and connector-openshell)'; exit 1; }
config_source="$CONF/config.json"
[ -f "$config_source" ] || config_source="$SRC/connector-openshell/config.example.json"
config_temp="$CONF/config.json.new.$$"
token_temp="$CONF/token.new.$$"
trap 'rm -f "$config_temp" "$token_temp"' EXIT HUP INT TERM
AUDIT_FILE="${AUDIT_FILE:-$STATE/audit.jsonl}" node "$PREFIX/connector-openshell/install-config.mjs" "$config_source" "$config_temp" "$CONF/token"
printf '%s\n' "$DEVICE_TOKEN" > "$token_temp"
chmod 600 "$token_temp" "$config_temp"
mv -f "$token_temp" "$CONF/token"
mv -f "$config_temp" "$CONF/config.json"
node - "$SRC/connector-openshell/systemd/openharness-openshell-connector.service" "$(command -v node)" > "$UNIT_DIR/openharness-openshell-connector.service" <<'NODE'
const fs = require('node:fs');
const unit = fs.readFileSync(process.argv[2], 'utf8');
process.stdout.write(unit.replace('ExecStart=/usr/bin/node ', `ExecStart=${JSON.stringify(process.argv[3])} `));
NODE
chmod 644 "$UNIT_DIR/openharness-openshell-connector.service"
systemctl --user daemon-reload
systemctl --user enable openharness-openshell-connector
systemctl --user restart openharness-openshell-connector
echo "Installed. Status: systemctl --user status openharness-openshell-connector   Logs: journalctl --user -u openharness-openshell-connector -f"
echo "Keep it running after logout with: sudo loginctl enable-linger $USER"
echo "Edit $CONF/config.json (the \"openshell\" section) to restrict images, workspaces or policy changes."
