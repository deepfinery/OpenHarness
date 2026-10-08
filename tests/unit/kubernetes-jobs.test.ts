import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// The Kubernetes side of the Python executor: the manifests that let the runner create Jobs, and what Job pods
// may reach. Rendered with kustomize when kubectl is available.
const rendered = (() => {
  try {
    return execFileSync('kubectl', ['kustomize', 'deploy/k8s/overlays/generic'], { encoding: 'utf8' });
  } catch {
    return undefined;
  }
})();
const documents = (rendered ?? '').split(/\n---\n/);
const find = (kind: string, name: string) =>
  documents.find((d) => d.includes(`kind: ${kind}\n`) && new RegExp(`\\n  name: ${name}\\n`).test(d));

test('the runner can create, watch and delete Jobs and read their pods, nothing else', { skip: !rendered }, () => {
  const role = find('Role', 'openharness-python-jobs')!;
  assert.ok(role, 'Role rendered');
  assert.match(role, /resources:\n\s+- jobs\n\s+verbs:\n\s+- create\n\s+- get\n\s+- list\n\s+- watch\n\s+- delete/);
  assert.doesNotMatch(role, /secrets|configmaps|deployments|statefulsets|\*/);
  const app = find('Deployment', 'app')!;
  assert.match(app, /serviceAccountName: openharness-app/);
  assert.match(app, /name: executor-image/);
  assert.match(app, /name: POD_NAME/);
});

test('Job pods reach only the API, MongoDB, DNS and the public internet', { skip: !rendered }, () => {
  const policy = find('NetworkPolicy', 'python-jobs')!;
  assert.ok(policy, 'NetworkPolicy rendered');
  assert.match(policy, /app.kubernetes.io\/name: python-job/);
  assert.match(policy, /- Ingress\n\s+- Egress/);
  assert.match(policy, /port: 8088/);
  assert.match(policy, /port: 27017/);
  for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'])
    assert.ok(policy.includes(range), `${range} is excluded from internet egress`);
});

test('the executor image pins every library the agent code and the runner use', () => {
  const requirements = readFileSync('python-executor/requirements.txt', 'utf8');
  for (const pin of [
    'numpy==2.5.3',
    'pandas==3.0.6',
    'pyarrow==25.0.1',
    'polars==2.0.0',
    'duckdb==1.5.6',
    'scipy==1.18.1',
    'numba==0.68.0',
    'statsmodels==0.15.0',
    'scikit-learn==1.9.1',
    'lightgbm==4.7.0',
    'ta-lib==0.8.1',
    'empyrical-reloaded==0.5.12',
    'exchange-calendars==4.13.2',
    'pytz==2026.5',
    'pymongo==4.18.2',
    'psycopg[binary]==3.3.6',
    'boto3==1.43.109',
    'pydantic==2.13.5',
    'orjson==3.13.0',
  ])
    assert.ok(requirements.split('\n').includes(pin), pin);
  assert.match(readFileSync('python-executor/Dockerfile', 'utf8'), /FROM python:3\.12-slim/);
});
