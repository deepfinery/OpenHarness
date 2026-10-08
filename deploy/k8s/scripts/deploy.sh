#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kube() { kubectl --context "$KUBE_CONTEXT" -n openharness "$@"; }
[[ -f deploy/k8s/.local/kustomization.yaml ]] || { echo 'Run prepare.sh first.' >&2; exit 1; }
# Grow StatefulSet volumes whose manifest size increased; their claim templates cannot change in place.
deploy/k8s/scripts/expand-volumes.sh deploy/k8s/.local
kube apply --dry-run=server -k deploy/k8s/.local >/dev/null
kube apply -k deploy/k8s/.local
# Disks that only expand while detached are grown now, with their StatefulSet briefly scaled to zero.
deploy/k8s/scripts/expand-volumes.sh deploy/k8s/.local --finish
# Environment variables and mounted TLS/config files need a process restart.
kube rollout restart deployment/app deployment/gateway deployment/proxy
for workload in statefulset/mongo statefulset/rabbitmq statefulset/weaviate deployment/app deployment/gateway deployment/mongodb-mcp deployment/guardrails deployment/guardrail-evaluation deployment/proxy; do
  kube rollout status "$workload" --timeout=900s
done
kube get pods,pvc,service
