import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllDocuments } from 'yaml';
import { clusterGatewayUrl, clusterInstallGuide } from '../../packages/core/src/clusterInstall.js';

test('shared-token guides include complete installs and the selected reachable address', () => {
  const token = 'cl_952ad839-8190-4133-9e71-f53bc3861ce4.dv_shared-token-123456';
  const guide = clusterInstallGuide({ gatewayUrl: 'ws://192.0.2.10:8090', token, hostAccess: true });
  for (const value of [guide.docker, guide.native]) {
    assert.match(value, /git clone https:\/\/github.com\/deepfinery\/OpenHarness.git/);
    assert.ok(value.includes(`DEVICE_TOKEN=${token}`));
    assert.ok(value.includes('ws://192.0.2.10:8090/connect'));
    assert.match(value, /--host-access/);
  }
  const docs = parseAllDocuments(guide.kubernetes).map((d) => d.toJSON());
  assert.equal(docs[1].stringData.token, token);
  const pod = docs[2].spec.template.spec;
  assert.equal(pod.hostPID, true);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers[0].securityContext.privileged, true);
  assert.equal(
    pod.containers[0].env.find((e: any) => e.name === 'CLUSTER_NODE_NAME').valueFrom.fieldRef.fieldPath,
    'spec.nodeName',
  );
  assert.ok(!guide.kubernetes.includes('DEVICE_ID')); // Never reuse a fixed device ID across the fleet.
  const restricted = parseAllDocuments(
    clusterInstallGuide({ gatewayUrl: 'wss://gpu.example.com', token }).kubernetes,
  )[2].toJSON().spec.template.spec;
  assert.equal(restricted.hostPID, undefined);
  assert.equal(restricted.containers[0].securityContext.runAsNonRoot, true);
});
test('installation values cannot inject commands, environment entries, or YAML fields', () => {
  for (const url of [
    'http://server',
    'ws://user:password@server',
    'ws://server?secret=x',
    'ws://server/$(id)',
    'ws://server/other',
    'ws://server\nDEVICE_TOKEN=evil',
  ])
    assert.throws(() => clusterGatewayUrl(url));
  assert.equal(clusterGatewayUrl('wss://[2001:db8::1]:8443/connect'), 'wss://[2001:db8::1]:8443/connect');
  assert.throws(() => clusterInstallGuide({ gatewayUrl: 'ws://server', token: 'secret\nEVIL=value' }));
  assert.throws(() => clusterInstallGuide({ gatewayUrl: 'ws://server', image: "image'; id" }));
});
