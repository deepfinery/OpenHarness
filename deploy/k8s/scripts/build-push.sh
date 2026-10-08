#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${REGISTRY:?Set REGISTRY to cr.us-north1.nebius.cloud/REGISTRY_ID_WITHOUT_registry_PREFIX}"
: "${IMAGE_TAG:?Set IMAGE_TAG to a unique release tag}"
for tool in docker nebius; do command -v "$tool" >/dev/null; done
# Uses the logged-in Nebius profile without putting a token on the command line.
nebius registry configure-helper
for entry in 'openharness:Dockerfile' 'gateway:gateway/Dockerfile' 'guardrails:guardrails/Dockerfile' 'garak-probes:guardrails/evaluation/Dockerfile' 'mongodb-mcp:mongodb-mcp/Dockerfile'; do
  image="${entry%%:*}"
  dockerfile="${entry#*:}"
  docker buildx build --platform "${PLATFORMS:-linux/amd64}" --push \
    -f "$dockerfile" -t "$REGISTRY/$image:$IMAGE_TAG" .
done
# Optional outbound machine executors; these run where the target machines live.
if [[ "${BUILD_CONNECTORS:-0}" == 1 ]]; then
  docker buildx build --platform "${PLATFORMS:-linux/amd64}" --push -f connector-go/Dockerfile -t "$REGISTRY/connector:$IMAGE_TAG" .
  docker buildx build --platform "${PLATFORMS:-linux/amd64}" --push -f connector-go/Dockerfile --target edge -t "$REGISTRY/edge:$IMAGE_TAG" .
fi
