#!/bin/sh
# Installs the OpenHarness Linux connector as a hardened systemd service running as a dedicated non-root user.
# Usage (run as root):  GATEWAY_URL=wss://gateway.example.com/connect DEVICE_ID=laptop-1 DEVICE_TOKEN=dv_... sh install.sh
set -eu
: "${GATEWAY_URL:?set GATEWAY_URL (wss://<gateway>/connect)}"
: "${DEVICE_ID:?set DEVICE_ID}"
: "${DEVICE_TOKEN:?set DEVICE_TOKEN (the one-time enrollment token)}"
SRC="${SRC:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
PREFIX=/opt/openharness-connector
CONF=/etc/openharness-connector
STATE=/var/lib/openharness-connector
[ "$(id -u)" -eq 0 ] || { echo 'run as root (sudo)'; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js 22 or later is required (https://nodejs.org)'; exit 1; }
node -e 'const [m,n]=process.versions.node.split(".").map(Number); process.exit(m>22||(m===22&&n>=13)?0:1)' || { echo 'Node.js >= 22.13 is required'; exit 1; }
umask 022
getent group openharness-connector >/dev/null 2>&1 || groupadd --system openharness-connector
id openharness-connector >/dev/null 2>&1 || useradd --system --gid openharness-connector --home-dir "$STATE" --shell /usr/sbin/nologin openharness-connector
mkdir -p "$PREFIX" "$CONF" "$STATE/work"
chown root:openharness-connector "$CONF"
chmod 750 "$CONF"
cp -R "$SRC/connector-core" "$SRC/connector-linux" "$PREFIX/"
( cd "$PREFIX/connector-core" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null )
( cd "$PREFIX/connector-linux" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null )
[ -d "$PREFIX/connector-core/dist" ] && [ -d "$PREFIX/connector-linux/dist" ] || { echo 'build the connector first (npm run build in connector-core and connector-linux)'; exit 1; }
umask 077
config_source="$CONF/config.json"
[ -f "$config_source" ] || config_source="$SRC/connector-linux/config.example.json"
config_temp="$CONF/config.json.new.$$"
token_temp="$CONF/token.new.$$"
trap 'rm -f "$config_temp" "$token_temp"' EXIT HUP INT TERM
node "$PREFIX/connector-linux/install-config.mjs" "$config_source" "$config_temp" "$CONF/token"
chown root:openharness-connector "$config_temp"
chmod 640 "$config_temp"
printf '%s\n' "$DEVICE_TOKEN" > "$token_temp"
chown openharness-connector:openharness-connector "$token_temp"
chmod 600 "$token_temp"
mv -f "$token_temp" "$CONF/token"
mv -f "$config_temp" "$CONF/config.json"
chown -R openharness-connector:openharness-connector "$STATE"
node - "$SRC/connector-linux/systemd/openharness-connector.service" "$(command -v node)" > /etc/systemd/system/openharness-connector.service <<'NODE'
const fs = require('node:fs');
const unit = fs.readFileSync(process.argv[2], 'utf8');
process.stdout.write(unit.replace('ExecStart=/usr/bin/node ', `ExecStart=${JSON.stringify(process.argv[3])} `));
NODE
chmod 644 /etc/systemd/system/openharness-connector.service
systemctl daemon-reload
systemctl enable openharness-connector
systemctl restart openharness-connector
echo "Installed. Status: systemctl status openharness-connector   Logs: sudo journalctl -u openharness-connector -f"
echo "Edit $CONF/config.json to change the allow-list; the work directory is $STATE/work."
