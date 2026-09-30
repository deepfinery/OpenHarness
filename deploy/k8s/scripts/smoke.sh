#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
: "${PUBLIC_URL:?Set PUBLIC_URL}"
kube() { kubectl --context "$KUBE_CONTEXT" -n openharness "$@"; }
curl --max-time 20 --fail --silent --show-error --cacert "${TLS_CA:-deploy/k8s/.local/tls.crt}" "$PUBLIC_URL/api/health"
curl --max-time 20 --fail --silent --show-error --cacert "${TLS_CA:-deploy/k8s/.local/tls.crt}" "$PUBLIC_URL/api/auth/status"
curl --max-time 20 --fail --silent --show-error --cacert "${TLS_CA:-deploy/k8s/.local/tls.crt}" "$PUBLIC_URL/" | python3 -c 'import sys; assert "<html" in sys.stdin.read().lower(); print("Studio HTML: OK")'
kube exec deployment/app -c api -- node -e '
(async()=>{for (const [name,url] of [["gateway","http://gateway:8090/healthz"],["guardrails","http://guardrails:8000/v1/health"],["garak","http://guardrail-evaluation:8001/health"]]) {const r=await fetch(url);if(!r.ok)throw new Error(name+": "+r.status);console.log(name+": OK");}})().catch(e=>{console.error(e);process.exit(1)})'
kube exec deployment/app -c runner -- node -e 'const fs=require("fs");if(Date.now()-Number(fs.readFileSync("/tmp/openharness-worker-heartbeat","utf8"))>20000)process.exit(1);console.log("Runner heartbeat: OK")'
# Both processes must see the same files volume.
kube exec deployment/app -c api -- node -e 'require("fs").writeFileSync("/data/.k8s-smoke","shared-volume")'
kube exec deployment/app -c runner -- node -e 'const fs=require("fs");if(fs.readFileSync("/data/.k8s-smoke","utf8")!=="shared-volume")process.exit(1);fs.unlinkSync("/data/.k8s-smoke");console.log("Shared storage: OK")'
