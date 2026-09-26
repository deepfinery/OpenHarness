import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remediationCommand, remediateHost } from '../src/gpu.js';
test('host commands are typed, require operator enablement and a drained, idle node, and persist reservations', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'gpu-policy-'));
  const seen: string[][] = [];
  const run = async (argv: string[]) => {
    seen.push(argv);
    return '';
  };
  const args = { action: 'gpu_reset' as const, gpu: 2 };
  try {
    assert.deepEqual(remediationCommand('gpu_reset', 2), ['nvidia-smi', '--gpu-reset', '-i', '2']);
    await assert.rejects(remediateHost(args, { run, stateDir, actions: [] }), /not enabled/);
    await assert.rejects(remediateHost(args, { run, stateDir, actions: ['gpu_reset'] }), /ENOENT/);
    await writeFile(join(stateDir, 'drained'), 'scheduler drained', { mode: 0o600 });
    await chmod(join(stateDir, 'drained'), 0o666);
    await assert.rejects(remediateHost(args, { run, stateDir, actions: ['gpu_reset'] }), /root-owned/);
    await chmod(join(stateDir, 'drained'), 0o600);
    // Positive host authorization is only meaningful in the root test container.
    if (process.getuid?.() !== 0) return;
    await assert.rejects(
      remediateHost(args, { run: async () => '1234', stateDir, actions: ['gpu_reset'] }),
      /workloads/,
    );
    await remediateHost(args, { run, stateDir, actions: ['gpu_reset'] });
    assert.ok(seen.some((argv) => argv.includes('--gpu-reset')));
    const count = seen.filter((argv) => argv.includes('--gpu-reset')).length;
    await assert.rejects(remediateHost(args, { run, stateDir, actions: ['gpu_reset'] }), /cooldown/);
    assert.equal(seen.filter((argv) => argv.includes('--gpu-reset')).length, count);
    await utimes(join(stateDir, 'drained'), new Date(0), new Date(0));
    await assert.rejects(remediateHost(args, { run, stateDir, actions: ['gpu_reset'] }), /fresh/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
