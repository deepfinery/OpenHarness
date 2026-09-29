#!/bin/sh
# Starts OpenShell and the OpenHarness edge on this host. The first run creates the OpenShell PKI (certificate
# authority, gateway and client certificates, sandbox JWT signing keys) under the state directory with the
# gateway image's own generate-certs; later runs reuse it. Usage: sh up.sh [docker compose up arguments]
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ -f .env ] || { echo 'Copy .env.example to .env and fill in the harness gateway, machine id and token first.' >&2; exit 1; }
# The edge reads OPENHARNESS_CA_FILE inside its container, where only ./certs is mounted (as /certs), so a path on
# this host is invisible to it. A host path is copied into ./certs and .env is pointed at /certs/<name>; a /certs path
# must exist in ./certs. The file must be a PEM certificate, and readable by the edge's own user.
ca="$(sed -n 's/^OPENHARNESS_CA_FILE=//p' .env | tail -1 | tr -d "\"'")"
case "$ca" in
  '') ;;
  /certs/*) src="certs/${ca#/certs/}" ;;
  *)
    [ -f "$ca" ] || { echo "OPENHARNESS_CA_FILE=$ca does not exist on this host. Copy the harness ca.crt (data/tls/ca.crt on the server) to $PWD/certs/ca.crt and set OPENHARNESS_CA_FILE=/certs/ca.crt in .env." >&2; exit 1; }
    name="$(basename "$ca")"
    mkdir -p certs
    cp "$ca" "certs/$name"
    tmp=".env.tmp.$$"
    sed "s#^OPENHARNESS_CA_FILE=.*#OPENHARNESS_CA_FILE=/certs/$name#" .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
    echo "Copied $ca to ./certs/$name and set OPENHARNESS_CA_FILE=/certs/$name in .env: the edge reads it inside its container, where only ./certs is mounted."
    ca="/certs/$name"
    src="certs/$name"
    ;;
esac
if [ -n "$ca" ]; then
  [ -f "$src" ] || { echo "OPENHARNESS_CA_FILE=$ca, but $PWD/$src does not exist. Copy the harness ca.crt (data/tls/ca.crt on the server) there." >&2; exit 1; }
  grep -q 'BEGIN CERTIFICATE' "$src" || { echo "$PWD/$src is not a PEM certificate. Copy the harness ca.crt again, for example with scp, rather than pasting it." >&2; exit 1; }
  # A certificate is public; the edge runs as its own user, so make sure it can read the file.
  chmod a+r "$src"
fi
STATE="${OPENSHELL_STATE_DIR:-/var/lib/openshell}"
VERSION="$(sed -n 's/^OPENSHELL_VERSION=//p' .env | tail -1)"
VERSION="${VERSION:-0.1.2}"
if [ ! -f "$STATE/tls/ca.crt" ]; then
  echo "Creating the OpenShell PKI under $STATE/tls"
  # The gateway runs as root and owns the state directory; the PKI is owned by uid 1000 so the edge (uid 1000)
  # can read its client certificate and generate-certs can run unprivileged.
  docker run --rm -v "$STATE:$STATE" alpine:3.22 sh -c "mkdir -p '$STATE/tls' && chown 1000:1000 '$STATE/tls'"
  docker run --rm --user 1000:1000 -e HOME="$STATE/tls" -v "$STATE:$STATE" "ghcr.io/nvidia/openshell/gateway:$VERSION" \
    generate-certs --output-dir "$STATE/tls" --server-san host.openshell.internal --server-san openshell-gateway
fi
docker compose up -d "$@"
echo 'Started. Follow the edge with: docker compose logs -f openharness-edge'
echo "OpenShell CLI on this host: copy $STATE/tls/.config/openshell/gateways/openshell/mtls to ~/.config/openshell/gateways/openshell/mtls, then: openshell gateway add https://127.0.0.1:8080 --local --name openshell"
