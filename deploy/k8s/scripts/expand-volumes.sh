#!/usr/bin/env bash
# Grows StatefulSet volumes to the sizes in the rendered manifests, without touching pods or data.
#
# volumeClaimTemplates are immutable, so a larger size in the manifest would make `kubectl apply` fail. For each
# StatefulSet whose rendered claim size is larger than the live one, this expands every existing claim in place
# (the StorageClass must allow volume expansion), then deletes only the StatefulSet object with --cascade=orphan so
# the following apply recreates it with the new template and adopts the running pods. Volumes never shrink.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
OVERLAY="${1:-deploy/k8s/.local}"
kube() { kubectl --context "$KUBE_CONTEXT" -n openharness "$@"; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
kubectl kustomize "$OVERLAY" | kubectl create --dry-run=client -o json -f - > "$work/rendered.json"
kube get statefulset,pvc -o json > "$work/live.json"
kubectl --context "$KUBE_CONTEXT" get storageclass -o json > "$work/classes.json"
python3 - "$work" <<'PY' > "$work/plan.tsv"
import json, re, sys
work = sys.argv[1]
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
        if size(target) == size(before): continue
        grow = True
        for claim_name, claim in claims.items():
            if not re.fullmatch(rf'{re.escape(tpl)}-{re.escape(name)}-\d+', claim_name): continue
            cls = claim['spec'].get('storageClassName') or default_class
            if not classes.get(cls, {}).get('allowVolumeExpansion'):
                sys.exit(f'{claim_name}: StorageClass {cls} does not allow volume expansion')
            if size(claim['spec']['resources']['requests']['storage']) < size(target):
                print(f'pvc\t{claim_name}\t{target}')
    if grow: print(f'statefulset\t{name}\t-')
PY
[[ -s "$work/plan.tsv" ]] || exit 0
# Claims first: if a claim cannot grow, the StatefulSet is left untouched.
while IFS=$'\t' read -r kind name target; do
  [[ "$kind" == pvc ]] || continue
  echo "Expanding $name to $target"
  kube patch pvc "$name" --type merge -p "{\"spec\":{\"resources\":{\"requests\":{\"storage\":\"$target\"}}}}"
done < "$work/plan.tsv"
while IFS=$'\t' read -r kind name _; do
  [[ "$kind" == statefulset ]] || continue
  echo "Recreating statefulset/$name with the larger claim template; its pods keep running"
  kube delete statefulset "$name" --cascade=orphan --wait=true
done < "$work/plan.tsv"
# The CSI driver grows the disk and the filesystem online; report claims whose filesystem still waits for a restart.
for _ in $(seq 1 60); do
  pending="$(while IFS=$'\t' read -r kind name target; do
    [[ "$kind" == pvc ]] || continue
    [[ "$(kube get pvc "$name" -o jsonpath='{.status.capacity.storage}')" == "$target" ]] || echo "$name"
  done < "$work/plan.tsv")"
  [[ -z "$pending" ]] && exit 0
  sleep 10
done
echo "Still resizing after 10 minutes: $pending" >&2
kube get pvc $pending -o custom-columns=NAME:.metadata.name,REQUEST:.spec.resources.requests.storage,CAPACITY:.status.capacity.storage,CONDITIONS:.status.conditions[*].type >&2
echo 'If a claim reports FileSystemResizePending, restart its pod once to finish the filesystem resize.' >&2
