#!/bin/sh
# Starts OpenShell and the OpenHarness edge on this host. The first run creates the OpenShell PKI (certificate
# authority, gateway and client certificates, sandbox JWT signing keys) under the state directory with the
# gateway image's own generate-certs; later runs reuse it. Usage: sh up.sh [docker compose up arguments]
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ -f .env ] || { echo 'Copy .env.example to .env and fill in the harness gateway, machine id and token first.' >&2; exit 1; }
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
