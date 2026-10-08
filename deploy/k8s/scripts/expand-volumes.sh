#!/usr/bin/env bash
# Grows StatefulSet volumes to the sizes in the rendered manifests, without losing data.
#
# volumeClaimTemplates are immutable, so a larger size in the manifest would make `kubectl apply` fail. deploy.sh runs
# this script twice:
#   expand-volumes.sh <overlay>           before apply: expand each existing claim in place and delete only the
#                                         StatefulSet object (--cascade=orphan), so the apply recreates it with the
#                                         larger template and adopts the running pods.
#   expand-volumes.sh <overlay> --finish  after apply: wait for the disks to reach the new size. CSI drivers that
#                                         only expand detached volumes (for example compute.csi.nebius.com) get the
#                                         StatefulSet scaled to zero until the disk has grown, then back up. That is
#                                         a short outage of that store; the apps reconnect on their own.
# Volumes never shrink: a smaller size in the manifest stops the deployment.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
OVERLAY="${1:-deploy/k8s/.local}"
PHASE="${2:-prepare}"
kube() { kubectl --context "$KUBE_CONTEXT" -n openharness --request-timeout=60s "$@"; }
kube_cluster() { kubectl --context "$KUBE_CONTEXT" --request-timeout=60s "$@"; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
kubectl kustomize "$OVERLAY" | kubectl create --dry-run=client -o json -f - > "$work/rendered.json"
kube get statefulset,pvc -o json > "$work/live.json"
kube_cluster get storageclass -o json > "$work/classes.json"
# One row per claim whose live size (request before apply, capacity after) is below the rendered size:
#   pvc <claim> <target> <statefulset> <template>
# plus one `statefulset <name>` row per StatefulSet that needs its template replaced (prepare phase only).
python3 - "$work" "$PHASE" <<'PY' > "$work/plan.tsv"
import json, re, sys
work, phase = sys.argv[1], sys.argv[2]
units = {'': 1, 'Ki': 2**10, 'Mi': 2**20, 'Gi': 2**30, 'Ti': 2**40, 'Pi': 2**50,
         'k': 10**3, 'M': 10**6, 'G': 10**9, 'T': 10**12, 'P': 10**15}
def size(q):
    m = re.fullmatch(r'(\d+(?:\.\d+)?)([KMGTP]i?|k)?', q)
    if not m: sys.exit(f'Unsupported storage quantity: {q}')
    return float(m[1]) * units[m[2] or '']
def items(path):
    # kubectl prints a List, or one object after another for multi-document input.
    text, docs, at = open(f'{work}/{path}').read(), [], 0
    decoder = json.JSONDecoder()
    while text[at:].strip():
        doc, at = decoder.raw_decode(text, at + len(text[at:]) - len(text[at:].lstrip()))
        docs.extend(doc['items'] if doc.get('kind') == 'List' else [doc])
    return docs
rendered = {o['metadata']['name']: o for o in items('rendered.json') if o['kind'] == 'StatefulSet'}
live = items('live.json')
sets = {o['metadata']['name']: o for o in live if o['kind'] == 'StatefulSet'}
claims = {o['metadata']['name']: o for o in live if o['kind'] == 'PersistentVolumeClaim'}
classes = {o['metadata']['name']: o for o in items('classes.json')}
default_class = next((n for n, c in classes.items()
                      if c['metadata'].get('annotations', {}).get('storageclass.kubernetes.io/is-default-class') == 'true'), None)
for name, want in rendered.items():
    have = sets.get(name)
    if not have: continue
    current = {t['metadata']['name']: t for t in have['spec'].get('volumeClaimTemplates', [])}
    grow = False
    for template in want['spec'].get('volumeClaimTemplates', []):
        tpl = template['metadata']['name']
        target = template['spec']['resources']['requests']['storage']
        old = current.get(tpl)
        if not old: continue
        before = old['spec']['resources']['requests']['storage']
        if size(target) < size(before):
            sys.exit(f'{name}/{tpl}: the manifest asks for {target} but the volume is {before}; volumes cannot shrink')
        if phase == 'prepare' and size(target) > size(before): grow = True
        for claim_name, claim in claims.items():
            if not re.fullmatch(rf'{re.escape(tpl)}-{re.escape(name)}-\d+', claim_name): continue
            cls = claim['spec'].get('storageClassName') or default_class
            if not classes.get(cls, {}).get('allowVolumeExpansion'):
                sys.exit(f'{claim_name}: StorageClass {cls} does not allow volume expansion')
            live_size = claim['spec']['resources']['requests']['storage'] if phase == 'prepare' \
                else claim.get('status', {}).get('capacity', {}).get('storage', '0')
            if size(live_size) < size(target):
                print(f'pvc\t{claim_name}\t{target}\t{name}\t{tpl}')
    if grow: print(f'statefulset\t{name}\t-\t-\t-')
PY
[[ -s "$work/plan.tsv" ]] || exit 0

capacity() { kube get pvc "$1" -o jsonpath='{.status.capacity.storage}'; }
attached() {
  local pv
  pv="$(kube get pvc "$1" -o jsonpath='{.spec.volumeName}')"
  kube_cluster get volumeattachment -o jsonpath="{range .items[?(@.spec.source.persistentVolumeName=='$pv')]}{.metadata.name}{'\n'}{end}" | grep -c . || true
}
# The external resizer retries with a growing backoff; touching the claim makes it look again right away.
nudge() { kube annotate pvc "$1" openharness.io/expand-requested="$(date +%s)" --overwrite >/dev/null; }
# The disk has grown once the capacity matches, or once only the filesystem step is left: that step runs when a
# pod mounts the volume again, so the StatefulSet can come back.
disk_grown() {
  [[ "$(capacity "$1")" == "$2" ]] ||
    kube get pvc "$1" -o jsonpath='{.status.conditions[*].type}' | grep -q FileSystemResizePending
}

if [[ "$PHASE" == prepare ]]; then
  # Claims first: if a claim cannot grow, the StatefulSet is left untouched.
  while IFS=$'\t' read -r kind name target _; do
    [[ "$kind" == pvc ]] || continue
    echo "Expanding $name to $target"
    kube patch pvc "$name" --type merge -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"$target\"}}}}"
  done < "$work/plan.tsv"
  while IFS=$'\t' read -r kind name _; do
    [[ "$kind" == statefulset ]] || continue
    echo "Recreating statefulset/$name with the larger claim template; its pods keep running"
    kube delete statefulset "$name" --cascade=orphan --wait=true
  done < "$work/plan.tsv"
  exit 0
fi

# --finish: every claim here still has a disk smaller than its request.
while IFS=$'\t' read -r kind name target set _; do
  [[ "$kind" == pvc ]] || continue
  echo "Waiting for $name to reach $target"
  for _ in $(seq 1 9); do
    [[ "$(capacity "$name")" == "$target" ]] && break
    sleep 10
  done
  if [[ "$(capacity "$name")" != "$target" ]]; then
    # Not grown while attached: the driver needs the volume detached. Scale the StatefulSet down until it has grown.
    replicas="$(kube get statefulset "$set" -o jsonpath='{.spec.replicas}')"
    echo "$name did not grow while in use; scaling statefulset/$set to 0 so the disk can be expanded offline"
    kube scale statefulset "$set" --replicas=0
    for _ in $(seq 1 60); do
      [[ "$(attached "$name")" == 0 ]] && break
      sleep 5
    done
    [[ "$(attached "$name")" == 0 ]] || { echo "$name is still attached after 5 minutes" >&2; kube scale statefulset "$set" --replicas="$replicas"; exit 1; }
    nudge "$name"
    for i in $(seq 1 90); do
      disk_grown "$name" "$target" && break
      (( i % 6 == 0 )) && nudge "$name"
      sleep 10
    done
    echo "Scaling statefulset/$set back to $replicas"
    kube scale statefulset "$set" --replicas="$replicas"
    kube rollout status "statefulset/$set" --timeout=900s
    # The filesystem grows on mount; the reported capacity follows shortly after.
    for _ in $(seq 1 30); do
      [[ "$(capacity "$name")" == "$target" ]] && break
      sleep 5
    done
  fi
  if [[ "$(capacity "$name")" == "$target" ]]; then
    echo "$name is $target"
  else
    echo "$name is still $(capacity "$name") (requested $target)" >&2
    kube get pvc "$name" -o custom-columns=NAME:.metadata.name,REQUEST:.spec.resources.requests.storage,CAPACITY:.status.capacity.storage,CONDITIONS:.status.conditions[*].type >&2
    kube get events --field-selector "involvedObject.name=$name" --sort-by=.lastTimestamp -o custom-columns=LAST:.lastTimestamp,REASON:.reason,MESSAGE:.message 2>/dev/null | tail -5 >&2
    exit 1
  fi
done < "$work/plan.tsv"
