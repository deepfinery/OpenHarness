#!/bin/sh
# Turns on HTTPS for the studio and WSS for the device gateway with a self-signed certificate.
#
#   ./scripts/enable-tls.sh [host-or-ip ...]
#
# It creates a local certificate authority and a server certificate for every name the server answers to (the
# arguments, the host name, its IP addresses, localhost and the compose service names), writes them under TLS_DIR
# (default ./data/tls), and updates .env so `./start.sh` runs the TLS front on TLS_PORT (default 8443) while the
# plain ports stay on loopback. Give machines and the OpenShell edge the CA file it prints.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required.' >&2; exit 1; }
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || ./start.sh --configure-only
TLS_DIR="${TLS_DIR:-$PWD/data/tls}"
PORT="${TLS_PORT:-8443}"
mkdir -p "$TLS_DIR"
umask 077

current() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
primary="${1:-}"
if [ -z "$primary" ]; then
  primary="$(current PUBLIC_URL | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
fi
case "$primary" in ''|localhost|127.0.0.1) primary="$(hostname -I 2>/dev/null | awk '{print $1}')";; esac
[ -n "$primary" ] || primary=localhost

# Every name and address the certificate must cover.
names="localhost host.docker.internal caddy api gateway $(hostname) $*"
ips="127.0.0.1 $(hostname -I 2>/dev/null || true)"
san=""
i=0
for n in $names; do
  case "$n" in *[!0-9.]*) i=$((i+1)); san="${san}DNS.$i = $n
";; esac
done
j=0
for ip in $ips $primary $names; do
  case "$ip" in *[!0-9.]*) ;; *) j=$((j+1)); san="${san}IP.$j = $ip
";; esac
done

if [ ! -f "$TLS_DIR/ca.crt" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 3650 \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" -subj "/CN=OpenHarness local CA/O=OpenHarness" >/dev/null 2>&1
  echo "Created certificate authority $TLS_DIR/ca.crt"
fi
cat > "$TLS_DIR/server.cnf" <<CNF
[req]
distinguished_name = dn
req_extensions = ext
prompt = no
[dn]
CN = $primary
O = OpenHarness
[ext]
subjectAltName = @alt
extendedKeyUsage = serverAuth
keyUsage = digitalSignature, keyEncipherment
[alt]
$san
CNF
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 \
  -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.csr" -config "$TLS_DIR/server.cnf" >/dev/null 2>&1
openssl x509 -req -in "$TLS_DIR/server.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
  -out "$TLS_DIR/server.crt" -days 825 -sha256 -extensions ext -extfile "$TLS_DIR/server.cnf" >/dev/null 2>&1
rm -f "$TLS_DIR/server.csr"
# Caddy runs as root in its container; the server key must be readable there but stays private on the host.
chmod 644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"
chmod 600 "$TLS_DIR/ca.key" "$TLS_DIR/server.key"
echo "Issued server certificate for $primary ($(printf '%s' "$san" | tr '\n' ' '))"

# Update .env in place, keeping a backup. The plain ports move to loopback; Caddy owns the public port.
backup="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp "$ENV_FILE" "$backup"
set_key() {
  if grep -q "^$1=" "$ENV_FILE"; then
    tmp="$ENV_FILE.tmp.$$"
    sed "s|^$1=.*|$1=$2|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
profiles="$(current COMPOSE_PROFILES)"
case ",$profiles," in *,tls,*) ;; *) profiles="${profiles:+$profiles,}tls";; esac
set_key COMPOSE_PROFILES "$profiles"
set_key TLS_PORT "$PORT"
set_key TLS_DIR "$TLS_DIR"
set_key TLS_BIND "${TLS_BIND:-0.0.0.0}"
set_key PUBLIC_URL "https://$primary:$PORT"
set_key GATEWAY_PUBLIC_URL "wss://$primary:$PORT"
set_key STUDIO_BIND 127.0.0.1
set_key GATEWAY_BIND 127.0.0.1
set_key TRUST_PROXY 1
# The API embeds the CA in the install commands it shows, so connectors enrolled from the studio trust this server.
set_key PUBLIC_CA_PEM_BASE64 "$(base64 < "$TLS_DIR/ca.crt" | tr -d '\n')"
chmod 600 "$ENV_FILE"
echo "Updated $ENV_FILE (backup: $backup):"
echo "  PUBLIC_URL=https://$primary:$PORT   GATEWAY_PUBLIC_URL=wss://$primary:$PORT   COMPOSE_PROFILES=$profiles"
echo "Next: ./start.sh, then open https://$primary:$PORT (import $TLS_DIR/ca.crt into your browser to avoid the warning)."
echo "Install commands in the studio now embed this CA; connectors set up by hand need it as GATEWAY_CA_FILE (Go connector, edge), NODE_EXTRA_CA_CERTS (Node connector) or OPENHARNESS_CA_FILE (OpenShell deployment)."
