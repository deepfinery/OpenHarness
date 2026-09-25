#!/bin/sh
# Installs the agentic Linux connector as a hardened systemd service running as a dedicated non-root user.
# Usage (run as root):  GATEWAY_URL=wss://gateway.example.com/connect DEVICE_ID=laptop-1 DEVICE_TOKEN=dv_... sh install.sh
set -eu
: "${GATEWAY_URL:?set GATEWAY_URL (wss://<gateway>/connect)}"
: "${DEVICE_ID:?set DEVICE_ID}"
: "${DEVICE_TOKEN:?set DEVICE_TOKEN (the one-time enrollment token)}"
SRC="${SRC:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
PREFIX=/opt/agentic-connector
CONF=/etc/agentic-connector
STATE=/var/lib/agentic-connector
[ "$(id -u)" -eq 0 ] || { echo 'run as root (sudo)'; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'Node.js 22 or later is required (https://nodejs.org)'; exit 1; }
node -e 'const [m,n]=process.versions.node.split(".").map(Number); process.exit(m>22||(m===22&&n>=13)?0:1)' || { echo 'Node.js >= 22.13 is required'; exit 1; }
id agentic-connector >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin agentic-connector
mkdir -p "$PREFIX" "$CONF" "$STATE/work"
cp -R "$SRC/connector-core" "$SRC/connector-linux" "$PREFIX/"
( cd "$PREFIX/connector-core" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null )
( cd "$PREFIX/connector-linux" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null )
[ -d "$PREFIX/connector-core/dist" ] && [ -d "$PREFIX/connector-linux/dist" ] || { echo 'build the connector first (npm run build in connector-core and connector-linux)'; exit 1; }
umask 077
printf '%s\n' "$DEVICE_TOKEN" > "$CONF/token"
chown agentic-connector:agentic-connector "$CONF/token"
chmod 600 "$CONF/token"
if [ ! -f "$CONF/config.json" ]; then
  sed -e "s#wss://gateway.example.com/connect#$GATEWAY_URL#" -e "s#\"laptop-1\"#\"$DEVICE_ID\"#" "$SRC/connector-linux/config.example.json" > "$CONF/config.json"
  chmod 640 "$CONF/config.json"
fi
chown -R agentic-connector:agentic-connector "$STATE"
cp "$SRC/connector-linux/systemd/agentic-connector.service" /etc/systemd/system/agentic-connector.service
systemctl daemon-reload
systemctl enable --now agentic-connector
echo "Installed. Status: systemctl status agentic-connector   Logs: journalctl -u agentic-connector -f"
echo "Edit $CONF/config.json to change the allow-list; the work directory is $STATE/work."
