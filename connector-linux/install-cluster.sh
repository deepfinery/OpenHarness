#!/bin/sh
# Run from any fresh repository checkout. The cluster env file is data, never sourced as shell code.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this installer with sudo.' >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { echo 'Usage: install-cluster.sh cluster.env [--host-access]' >&2; exit 1; }
host_access=${2:-}
env_file=$(realpath "$1")
[ -f "$env_file" ] || { echo 'Cluster env file not found' >&2; exit 1; }
case "${2:-}" in ''|--host-access) ;; *) echo 'Unknown install option' >&2; exit 1;; esac
command -v docker >/dev/null
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ -s /etc/machine-id ] || { echo "A unique /etc/machine-id is required" >&2; exit 1; }
node_id="gpu-$(sha256sum /etc/machine-id | cut -c1-24)"
state=/var/lib/openharness-cluster
install -d -m 700 "$state"
if [ "$env_file" != "$state/cluster.env" ]; then install -m 600 "$env_file" "$state/cluster.env"; else chmod 600 "$env_file"; fi
docker build -f "$repo/connector-linux/Dockerfile" -t openharness-connector-linux "$repo"
# Fail before replacing the running connector if credentials/configuration are malformed.
docker run --rm --env-file "$state/cluster.env" -e DEVICE_ID="$node_id" openharness-connector-linux --print-config >/dev/null
if docker container inspect openharness-cluster-node >/dev/null 2>&1; then
  # Only replace this installer's named container with its ownership label.
  [ "$(docker inspect -f '{{ index .Config.Labels "openharness.cluster-connector" }}' openharness-cluster-node)" = true ] || { echo 'Container name is owned by another installation' >&2; exit 1; }
  docker rm -f openharness-cluster-node >/dev/null
fi
set -- docker run -d --name openharness-cluster-node --label openharness.cluster-connector=true --restart unless-stopped \
  --env-file "$state/cluster.env" -e DEVICE_ID="$node_id" -e DEVICE_HOSTNAME="$(hostname)" \
  --add-host host.docker.internal:host-gateway -v "$state:/host-state"
# Explicit opt-in provides namespace access to the host. No Docker socket is mounted.
if [ "$host_access" = --host-access ]; then
  set -- "$@" --privileged --pid=host --user 0 -e HOST_ACCESS=true
fi
"$@" openharness-connector-linux >/dev/null
echo "Connector installed as $node_id. View its status on the Clusters page."
