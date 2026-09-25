#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v docker >/dev/null 2>&1 || { echo 'Docker with Compose is required.' >&2; exit 1; }
if [ ! -f .env ]; then
  command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required to generate local secrets.' >&2; exit 1; }
  umask 077
  studio_port="${STUDIO_PORT:-8088}"
  cat > .env <<EOF
PUBLIC_URL=${PUBLIC_URL:-http://localhost:$studio_port}
STUDIO_BIND=${STUDIO_BIND:-127.0.0.1}
STUDIO_PORT=$studio_port
MONGO_PASSWORD=$(openssl rand -hex 24)
RABBITMQ_PASSWORD=$(openssl rand -hex 24)
WEAVIATE_API_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
SETUP_TOKEN=$(openssl rand -hex 32)
ALLOWED_PRIVATE_HOSTS=host.docker.internal,ollama,gateway
GATEWAY_PORT=${GATEWAY_PORT:-8090}
GATEWAY_PUBLIC_URL=${GATEWAY_PUBLIC_URL:-ws://localhost:${GATEWAY_PORT:-8090}}
GATEWAY_API_TOKEN=$(openssl rand -hex 32)
GATEWAY_ADMIN_TOKEN=$(openssl rand -hex 32)
EOF
  echo 'Created .env with unique credentials. Keep a backup of this file with your data.'
fi
# Installations created before the device gateway existed get its credentials appended, never rewritten.
if ! grep -q '^GATEWAY_API_TOKEN=' .env; then
  command -v openssl >/dev/null 2>&1 || { echo 'OpenSSL is required to generate gateway credentials.' >&2; exit 1; }
  umask 077
  cat >> .env <<EOF
GATEWAY_PORT=${GATEWAY_PORT:-8090}
GATEWAY_PUBLIC_URL=${GATEWAY_PUBLIC_URL:-ws://localhost:${GATEWAY_PORT:-8090}}
GATEWAY_API_TOKEN=$(openssl rand -hex 32)
GATEWAY_ADMIN_TOKEN=$(openssl rand -hex 32)
EOF
  echo 'Added device gateway credentials to .env.'
fi
if [ "${1:-}" = '--configure-only' ]; then
  echo 'Configuration is ready.'
  exit 0
fi
docker compose up --build -d --wait --wait-timeout 240
echo 'Studio is ready at the PUBLIC_URL in .env (default http://localhost:8088).'
echo 'For first-time setup, copy SETUP_TOKEN from .env into the account creation form.'
