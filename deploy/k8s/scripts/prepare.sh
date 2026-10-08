#!/usr/bin/env bash
# Creates credentials once and renders a local overlay. Never rotates existing keys.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
: "${PUBLIC_URL:?Set PUBLIC_URL to the HTTPS origin}"
KUSTOMIZE_BASE="${KUSTOMIZE_BASE:-../overlays/nebius}"
export PUBLIC_URL KUSTOMIZE_BASE
[[ "$PUBLIC_URL" == https://* ]] || { echo 'PUBLIC_URL must use HTTPS' >&2; exit 1; }
kube() { kubectl --context "$KUBE_CONTEXT" -n openharness "$@"; }
umask 077
mkdir -p deploy/k8s/.local
[[ -f "deploy/k8s/.local/$KUSTOMIZE_BASE/kustomization.yaml" ]] || { echo "No kustomization.yaml at $KUSTOMIZE_BASE (relative to deploy/k8s/.local)" >&2; exit 1; }
kubectl --context "$KUBE_CONTEXT" apply -f deploy/k8s/base/namespace.yaml
if ! kube get secret openharness-secrets >/dev/null 2>&1; then
  python3 - <<'PY' > deploy/k8s/.local/secrets.json
import json, secrets
v={key:secrets.token_hex(32) for key in ['MONGO_PASSWORD','RABBITMQ_PASSWORD','RABBITMQ_ERLANG_COOKIE','WEAVIATE_API_KEY','ENCRYPTION_KEY','SETUP_TOKEN','GATEWAY_API_TOKEN','GATEWAY_ADMIN_TOKEN']}
v['MONGODB_URI']=f"mongodb://agentic:{v['MONGO_PASSWORD']}@mongo:27017/agentic?authSource=admin"
v['RABBITMQ_URL']=f"amqp://agentic:{v['RABBITMQ_PASSWORD']}@rabbitmq:5672"
v['GATEWAY_MONGODB_URI']=f"mongodb://agentic:{v['MONGO_PASSWORD']}@mongo:27017/?authSource=admin"
v['GATEWAY_API_TOKENS']='orchestrator:'+v['GATEWAY_API_TOKEN']
v['MONGODB_MCP_TOKEN']=secrets.token_hex(32)
v['MONGODB_MCP_PASSWORD']=secrets.token_hex(24)
v['MDB_MCP_CONNECTION_STRING']=f"mongodb://openharness_mcp:{v['MONGODB_MCP_PASSWORD']}@mongo:27017/?authSource=admin"
v['MDB_MCP_HTTP_HEADERS']=json.dumps({'authorization':'Bearer '+v['MONGODB_MCP_TOKEN']})
print(json.dumps({'apiVersion':'v1','kind':'Secret','metadata':{'name':'openharness-secrets','namespace':'openharness'},'type':'Opaque','stringData':v}))
PY
  kube create -f deploy/k8s/.local/secrets.json
elif [[ -z "$(kube get secret openharness-secrets -o jsonpath='{.data.MONGODB_MCP_TOKEN}')" ]]; then
  # Installations from before MongoDB collections get the MCP server's credentials added, never rotated.
  python3 - <<'PY' | kube patch secret openharness-secrets --type merge --patch-file /dev/stdin
import json, secrets
token, password = secrets.token_hex(32), secrets.token_hex(24)
print(json.dumps({'stringData': {
  'MONGODB_MCP_TOKEN': token,
  'MONGODB_MCP_PASSWORD': password,
  'MDB_MCP_CONNECTION_STRING': f'mongodb://openharness_mcp:{password}@mongo:27017/?authSource=admin',
  'MDB_MCP_HTTP_HEADERS': json.dumps({'authorization': 'Bearer ' + token}),
}}))
PY
fi
if [[ -n "${TLS_CERT:-}" && -n "${TLS_KEY:-}" ]]; then
  kube create secret tls openharness-tls --cert="$TLS_CERT" --key="$TLS_KEY" --dry-run=client -o yaml | kube apply -f -
elif ! kube get secret openharness-tls >/dev/null 2>&1; then
  [[ "${SELF_SIGNED_TLS:-0}" == 1 ]] || { echo 'Set TLS_CERT and TLS_KEY, or SELF_SIGNED_TLS=1 for evaluation.' >&2; exit 1; }
  python3 - <<'PY' > deploy/k8s/.local/openssl.cnf
import os, ipaddress
from urllib.parse import urlsplit
host=urlsplit(os.environ['PUBLIC_URL']).hostname
try:
    ipaddress.ip_address(host); san='IP:'+host
except ValueError: san='DNS:'+host
print('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN='+host+'\n[ext]\nsubjectAltName='+san+'\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth')
PY
  openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
    -config deploy/k8s/.local/openssl.cnf \
    -keyout deploy/k8s/.local/tls.key -out deploy/k8s/.local/tls.crt 2>/dev/null
  kube create secret tls openharness-tls --cert=deploy/k8s/.local/tls.crt --key=deploy/k8s/.local/tls.key
fi
# Export only the public certificate, for curl/connector trust and the local overlay.
kube get secret openharness-tls -o jsonpath='{.data.tls\.crt}' | python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > deploy/k8s/.local/tls.crt
python3 - <<'PY' > deploy/k8s/.local/kustomization.yaml
import os, json, base64
url=os.environ['PUBLIC_URL'].rstrip('/')
patch={'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'openharness-config'},'data':{'PUBLIC_URL':url,'GATEWAY_PUBLIC_URL':'wss://'+url.removeprefix('https://')}}
if os.environ.get('SELF_SIGNED_TLS')=='1': patch['data']['PUBLIC_CA_PEM_BASE64']=base64.b64encode(open('deploy/k8s/.local/tls.crt','rb').read()).decode()
print(json.dumps({'apiVersion':'kustomize.config.k8s.io/v1beta1','kind':'Kustomization','resources':[os.environ['KUSTOMIZE_BASE']],'patches':[{'patch':json.dumps(patch)}]},indent=2))
PY
printf 'Prepared deploy/k8s/.local for %s in %s\n' "$PUBLIC_URL" "$KUBE_CONTEXT"
