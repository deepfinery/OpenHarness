import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  machineTag,
  machinesNote,
  requestedMachines,
  wrongMachineNotice,
  type MachineRef,
} from '../../packages/core/src/machineContext.js';

const vm1: MachineRef = {
  connectionId: 'c1',
  name: 'vm1',
  deviceId: 'vm1',
  hostname: 'computeinstance-u02fwee855tr83zgt3',
  platform: 'linux',
};
const vm2: MachineRef = {
  connectionId: 'c2',
  name: 'vm2',
  deviceId: 'vm2',
  hostname: 'computeinstance-u02xvrbvyd6pd3dk9v',
  platform: 'linux',
};
const lab: MachineRef = { connectionId: 'c3', name: 'Lab OpenShell', deviceId: 'os1', platform: 'openshell' };

test('every machine result is tagged with where it ran', () => {
  assert.equal(machineTag(vm1), '[machine vm1 · computeinstance-u02fwee855tr83zgt3]');
  assert.equal(machineTag(lab), '[machine Lab OpenShell · id os1]');
  assert.equal(machineTag({ connectionId: 'c', name: 'box', deviceId: 'box' }), '[machine box]');
});

test('a request names machines by name, id or hostname, as whole words', () => {
  const machines = [vm1, vm2, lab];
  assert.deepEqual(requestedMachines('run gpu troubleshooting on vm2', machines), [vm2]);
  assert.deepEqual(requestedMachines('Compare VM1 with vm2, please', machines), [vm1, vm2]);
  assert.deepEqual(requestedMachines('check computeinstance-u02xvrbvyd6pd3dk9v', machines), [vm2]);
  assert.deepEqual(requestedMachines('what is on os1?', machines), [lab]);
  assert.deepEqual(requestedMachines('is vm10 up?', machines), [], 'vm1 is not a word inside vm10');
  assert.deepEqual(requestedMachines('troubleshoot the gpus', machines), [], 'no machine named');
  assert.deepEqual(
    requestedMachines('restart it', [{ connectionId: 'c9', name: 'it' }]),
    [],
    'names shorter than three characters are ignored',
  );
});

test('the roster tells the model which tools belong to which machine and how to attribute results', () => {
  const note = machinesNote([vm1, vm2], (id) =>
    id === 'c1' ? ['mcp_a_run_command'] : ['mcp_b_run_command'],
  );
  assert.match(note, /Machines you can reach \(2\)/);
  assert.match(note, /- vm1 \(linux, computeinstance-u02fwee855tr83zgt3\): tools mcp_a_run_command/);
  assert.match(note, /- vm2 \(linux, computeinstance-u02xvrbvyd6pd3dk9v\): tools mcp_b_run_command/);
  assert.match(note, /use only that machine’s tools/);
  assert.match(note, /\[machine …\] tag naming where it ran/);
  assert.match(note, /names a machine that is not listed here, say so/);
  assert.equal(
    machinesNote([], () => []),
    '',
  );
});

test('a call on the wrong machine is refused once, with the right tools and a way to insist', () => {
  const text = wrongMachineNotice(vm1, vm2, ['mcp_b_run_command', 'mcp_b_gpu_inspect']);
  assert.match(
    text,
    /^Not executed: the request names the machine "vm2" \(computeinstance-u02xvrbvyd6pd3dk9v\)/,
  );
  assert.match(text, /this tool belongs to "vm1"/);
  assert.match(text, /Use vm2’s tools instead: mcp_b_run_command, mcp_b_gpu_inspect/);
  assert.match(text, /call this tool again and it will run/);
});
