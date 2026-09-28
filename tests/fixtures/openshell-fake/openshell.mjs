// A stand-in for the OpenShell 0.1.2 CLI used by the connector tests and the isolated test stack. It accepts the
// same subcommands and flags the connector issues, keeps sandboxes in a JSON state file, prints the JSON shapes of
// the real CLI (crates/openshell-cli/src/run.rs at v0.1.2), and emulates policy denials for curl and file writes.
// Policies are JSON objects; YAML text is kept verbatim with its `host:` values extracted as endpoints.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE = process.env.OPENSHELL_FAKE_STATE ?? join(tmpdir(), 'openshell-fake-state.json');
const VERSION = '0.1.2';
const BOOLEAN_FLAGS = new Set([
  '--base',
  '--full',
  '--global',
  '--wait',
  '--detach',
  '--no-keep',
  '--no-tty',
  '--tty',
  '--no-login-shell',
  '--no-auto-providers',
  '--auto-providers',
  '--dry-run',
  '--yes',
  '--tail',
  '--all',
  '--all-workspaces',
  '--any-binary',
  '--ids',
  '--names',
  '--policy-only',
  '--gateway-insecure',
  '--no-git-ignore',
  '--no-credential-warnings',
  '-v',
  '-vv',
  '-vvv',
  '-h',
  '--help',
]);
const argv = process.argv.slice(2);
if (process.env.OPENSHELL_FAKE_LOG)
  appendFileSync(process.env.OPENSHELL_FAKE_LOG, JSON.stringify(argv) + '\n');

function parse(args) {
  const flags = {},
    positional = [];
  let command;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      command = args.slice(i + 1);
      break;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      let key = a,
        value;
      if (a.includes('=') && a.startsWith('--'))
        [key, value] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      if (value === undefined) value = args[++i];
      if (flags[key] === undefined) flags[key] = value;
      else flags[key] = [].concat(flags[key], value);
      continue;
    }
    positional.push(a);
  }
  return { flags, positional, command };
}
const { flags, positional, command } = parse(argv);
const many = (v) => (v === undefined ? [] : [].concat(v));
const output = flags['--output'] ?? flags['-o'] ?? 'table';
const workspace = flags['--workspace'] ?? process.env.OPENSHELL_WORKSPACE ?? 'default';
const fail = (message, code = 1) => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
};
const print = (value) =>
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
const now = () => new Date().toISOString();
const hash = (text) => createHash('sha256').update(text).digest('hex');

function loadState() {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, 'utf8'));
  return { workspaces: ['default'], sandboxes: [], global_policy: null, seq: 0 };
}
function saveState(state) {
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}
const state = loadState();
if (!state.workspaces.includes(workspace)) fail(`workspace "${workspace}" not found`);

const defaultPolicy = () => ({
  version: 1,
  filesystem: { read_write: ['/sandbox'], read_only: ['/usr', '/lib', '/etc/ssl'] },
  landlock: { compatibility: 'hard_requirement' },
  process: { run_as_user: 1000, run_as_group: 1000 },
  network_policies: {},
});
function parsePolicy(text) {
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) {
    const policy = JSON.parse(trimmed);
    if (policy.invalid) throw new Error('policy validation failed: unknown field `invalid`');
    return policy;
  }
  if (!/^version:\s*1/m.test(trimmed)) throw new Error('policy validation failed: missing `version: 1`');
  const endpoints = [...trimmed.matchAll(/host:\s*['"]?([^\s'"]+)['"]?/g)].map((m) => ({
    host: m[1],
    port: 443,
  }));
  return {
    version: 1,
    raw_yaml: trimmed,
    network_policies: endpoints.length ? { imported: { name: 'imported', endpoints, binaries: [] } } : {},
  };
}
const policyHosts = (policy) =>
  Object.values(policy.network_policies ?? {}).flatMap((rule) => (rule.endpoints ?? []).map((e) => e.host));
const hostAllowed = (policy, host) =>
  policyHosts(policy).some((h) => h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))));
function findSandbox(name, { required = true } = {}) {
  if (!name) fail('a sandbox name is required (no last-used sandbox in the test double)');
  const sandbox = state.sandboxes.find((s) => s.name === name && s.workspace === workspace);
  if (!sandbox && required) fail(`sandbox "${name}" not found in workspace "${workspace}"`);
  return sandbox;
}
function addRevision(sandbox, policy, provenance = 'cli') {
  const text = JSON.stringify(policy);
  const version = sandbox.revisions.length + 1;
  sandbox.revisions.push({
    version,
    hash: hash(text),
    status: 'loaded',
    created_at_ms: Date.now(),
    loaded_at_ms: Date.now(),
    provenance,
    policy,
  });
  sandbox.policy = policy;
  sandbox.current_policy_version = version;
  sandbox.logs.push(`${now()} INFO policy revision ${version} loaded hash=${hash(text).slice(0, 12)}`);
  return version;
}
const sandboxJson = (s) => ({
  id: s.id,
  name: s.name,
  workspace: s.workspace,
  labels: s.labels,
  annotations: {},
  resource_version: s.resource_version,
  created_at: s.created_at,
  phase: s.phase,
  current_policy_version: s.current_policy_version,
  exit_code: s.exit_code,
  conditions: [
    {
      type: 'Ready',
      status: s.phase === 'Ready' ? 'True' : 'False',
      reason: s.phase,
      transition_time: s.created_at,
    },
  ],
  endpoint_statuses: [],
  configuration_admission: { state: 'accepted', error: '', policy_version: s.current_policy_version },
  provisioning: null,
  created_from_workload_template: s.template ? { name: s.template, resource_version: 1 } : null,
  image: s.image,
});
const sandboxDetail = (s) => ({
  ...sandboxJson(s),
  policy_source: state.global_policy ? 'global' : 'sandbox',
  revision: s.current_policy_version,
  policy: state.global_policy?.policy ?? s.policy,
});
const revisionJson = (scope, sandboxName, rev, view) => ({
  scope,
  ...(sandboxName ? { sandbox: sandboxName } : {}),
  version: rev.version,
  hash: rev.hash,
  status: rev.status,
  created_at_ms: rev.created_at_ms,
  ...(rev.loaded_at_ms ? { loaded_at_ms: rev.loaded_at_ms } : {}),
  ...(rev.load_error ? { load_error: rev.load_error } : {}),
  provenance: rev.provenance,
  ...(view ? { policy: view === 'full' ? { ...rev.policy, provider_rules: {} } : rev.policy } : {}),
});
const table = (rows) => rows.map((r) => r.join('  ')).join('\n');

const [group, sub, ...rest] = positional;
if (flags['--version'] || flags['-V'] || group === '--version') {
  print(`openshell ${VERSION}`);
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-V')) {
  print(`openshell ${VERSION}`);
  process.exit(0);
}

switch (group) {
  case 'status': {
    const value = {
      gateway: 'openshell',
      server: 'https://127.0.0.1:17670',
      status: 'connected',
      version: VERSION,
      authentication: { status: 'authenticated', provider: 'mtls' },
    };
    print(
      output === 'json'
        ? value
        : `Gateway: openshell\nStatus: Connected\nAuthentication: Authenticated\nVersion: ${VERSION}`,
    );
    break;
  }
  case 'whoami':
    print(
      output === 'json'
        ? { subject: 'fake-operator', roles: ['openshell-admin'], scopes: ['openshell:all'] }
        : 'Subject: fake-operator',
    );
    break;
  case 'gateway': {
    if (sub === 'info') {
      const value = {
        gateway: 'openshell',
        server: 'https://127.0.0.1:17670',
        auth: 'mtls',
        status: 'healthy',
        version: VERSION,
        compute_drivers: [
          { name: 'docker', capabilities: { driver_name: 'docker', driver_version: VERSION } },
        ],
        extensions: [],
      };
      print(output === 'json' ? value : 'Status: healthy');
    } else if (sub === 'list')
      print(
        output === 'json'
          ? [
              {
                name: 'openshell',
                endpoint: 'https://127.0.0.1:17670',
                active: true,
                type: 'local',
                auth: 'mtls',
                source: 'user',
              },
            ]
          : '* openshell https://127.0.0.1:17670',
      );
    else fail(`unknown gateway subcommand ${sub}`);
    break;
  }
  case 'workspace': {
    if (sub !== 'list') fail(`unsupported workspace subcommand ${sub}`);
    const workspaces = state.workspaces.map((name, i) => ({
      name,
      id: `ws-${i + 1}`,
      resource_version: 1,
      created_at: '2026-09-01T00:00:00Z',
      status: 'active',
    }));
    print(
      output === 'json'
        ? { workspaces, next_page_token: '' }
        : table(workspaces.map((w) => [w.name, w.status])),
    );
    break;
  }
  case 'sandbox': {
    switch (sub) {
      case 'list': {
        const selector = Object.fromEntries(
          many(flags['--selector'])
            .flatMap((s) => s.split(','))
            .map((kv) => kv.split('=')),
        );
        const sandboxes = state.sandboxes.filter(
          (s) =>
            (flags['--all-workspaces'] || s.workspace === workspace) &&
            Object.entries(selector).every(([k, v]) => s.labels[k] === v),
        );
        print(
          output === 'json'
            ? { sandboxes: sandboxes.map(sandboxJson), next_page_token: '' }
            : table(sandboxes.map((s) => [s.name, s.phase, s.image])),
        );
        break;
      }
      case 'get': {
        const s = findSandbox(rest[0]);
        if (flags['--policy-only']) print(JSON.stringify(s.policy, null, 2));
        else print(output === 'json' ? sandboxDetail(s) : `Name: ${s.name}\nPhase: ${s.phase}`);
        break;
      }
      case 'create': {
        const name = flags['--name'] ?? `sandbox-${randomBytes(3).toString('hex')}`;
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) fail(`invalid sandbox name "${name}"`);
        if (findSandbox(name, { required: false })) fail(`sandbox "${name}" already exists`);
        const image =
          flags['--from'] ??
          (flags['--template'] ? `template:${flags['--template']}` : 'nvcr.io/nvidia/base/ubuntu:24.04');
        if (/forbidden/.test(image)) fail(`failed to pull image ${image}: access denied`);
        let policy;
        try {
          policy = flags['--policy'] ? parsePolicy(readFileSync(flags['--policy'], 'utf8')) : defaultPolicy();
        } catch (e) {
          fail(e.message);
        }
        const labels = Object.fromEntries(
          many(flags['--label']).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
        );
        const sandbox = {
          id: `sb-${++state.seq}-${randomBytes(4).toString('hex')}`,
          name,
          workspace,
          labels,
          image,
          template: flags['--template'],
          command: command ?? [],
          env: Object.fromEntries(
            many(flags['--env']).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
          ),
          providers: many(flags['--provider']),
          cpu: flags['--cpu'],
          memory: flags['--memory'],
          no_keep: Boolean(flags['--no-keep']),
          resource_version: 1,
          created_at: now(),
          phase: 'Ready',
          exit_code: null,
          revisions: [],
          logs: [`${now()} INFO sandbox ${name} started image=${image}`],
          proposals: [],
        };
        addRevision(sandbox, policy, 'create');
        state.sandboxes.push(sandbox);
        saveState(state);
        print(output === 'json' ? sandboxJson(sandbox) : `Created sandbox ${name}`);
        break;
      }
      case 'delete': {
        const names = flags['--all']
          ? state.sandboxes.filter((s) => s.workspace === workspace).map((s) => s.name)
          : rest;
        if (!names.length) fail('a sandbox name is required');
        for (const name of names) {
          findSandbox(name);
          state.sandboxes = state.sandboxes.filter((s) => !(s.name === name && s.workspace === workspace));
          print(`Deleted sandbox ${name}`);
        }
        saveState(state);
        break;
      }
      case 'stop':
      case 'start': {
        const s = findSandbox(rest[0]);
        s.phase = sub === 'stop' ? 'Stopped' : 'Ready';
        s.logs.push(`${now()} INFO sandbox ${sub === 'stop' ? 'stopped' : 'started'}`);
        saveState(state);
        print(`${sub === 'stop' ? 'Stopped' : 'Started'} sandbox ${s.name}`);
        break;
      }
      case 'exec': {
        const s = findSandbox(flags['-n'] ?? flags['--name']);
        if (s.phase !== 'Ready') fail(`sandbox "${s.name}" is ${s.phase}; start it first`);
        if (!command?.length) fail('a command is required after --');
        const timeout = Number(flags['--timeout'] ?? 0);
        const workdir = flags['--workdir'] ?? '/sandbox';
        const env = {
          ...s.env,
          ...Object.fromEntries(
            many(flags['--env']).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
          ),
        };
        const policy = state.global_policy?.policy ?? s.policy;
        const [program, ...args] = command;
        const finish = (code) => {
          saveState(state);
          process.exit(code);
        };
        s.logs.push(`${now()} INFO exec argv=${JSON.stringify(command)} workdir=${workdir}`);
        switch (program) {
          case 'echo':
            print(args.join(' '));
            finish(0);
            break;
          case 'true':
            finish(0);
            break;
          case 'false':
            finish(1);
            break;
          case 'pwd':
            print(workdir);
            finish(0);
            break;
          case 'uname':
            print(`Linux ${s.name} 6.8.0-openshell #1 SMP x86_64 GNU/Linux`);
            finish(0);
            break;
          case 'printenv': {
            const v = env[args[0]];
            if (v === undefined) finish(1);
            print(v);
            finish(0);
            break;
          }
          case 'ls':
            print(['workspace', 'README.md'].join('\n'));
            finish(0);
            break;
          case 'cat':
            print(args[0] === '/etc/hostname' ? s.name : `hello from ${s.name}`);
            finish(0);
            break;
          case 'sleep': {
            const seconds = Number(args[0] ?? 0);
            if (timeout && seconds > timeout) {
              setTimeout(() => {
                process.stderr.write('command timed out\n');
                finish(124);
              }, timeout * 1000);
            } else setTimeout(() => finish(0), seconds * 1000);
            break;
          }
          case 'touch': {
            const path = args[0] ?? '';
            if (/^\/(sandbox|tmp)(\/|$)/.test(path)) {
              finish(0);
              break;
            }
            process.stderr.write(`touch: cannot touch '${path}': Operation not permitted\n`);
            s.logs.push(
              `${now()} WARN policy_denied kind=filesystem op=write path=${path} enforcement=landlock`,
            );
            finish(1);
            break;
          }
          case 'curl': {
            const url = args.find((a) => /^https?:\/\//.test(a));
            if (!url) {
              process.stderr.write('curl: no URL specified\n');
              finish(2);
              break;
            }
            const host = new URL(url).hostname;
            if (hostAllowed(policy, host)) {
              s.logs.push(`${now()} INFO request_allowed dest=${host}:443 binary=/usr/bin/curl method=GET`);
              print(`HTTP/1.1 200 OK\n{"ok":true,"host":"${host}"}`);
              finish(0);
              break;
            }
            process.stderr.write(
              `curl: (7) policy_denied: connection to ${host}:443 was blocked by the sandbox policy\n`,
            );
            s.logs.push(
              `${now()} WARN policy_denied dest=${host}:443 binary=/usr/bin/curl method=GET path=/ reason=no_matching_rule`,
            );
            let proposal = s.proposals.find((p) => p.host === host && p.status === 'pending');
            if (proposal) proposal.hits++;
            else
              s.proposals.push({
                id: randomBytes(8).toString('hex'),
                status: 'pending',
                host,
                rule_name: host.replace(/[^a-z0-9]/gi, '_'),
                binary: '/usr/bin/curl',
                confidence: 0.92,
                rationale: `curl attempted ${host}:443 and was denied`,
                hits: 1,
                first_seen: now(),
                reason: '',
              });
            finish(7);
            break;
          }
          default:
            process.stderr.write(`sh: 1: ${program}: not found\n`);
            finish(127);
        }
        break;
      }
      default:
        fail(`unsupported sandbox subcommand ${sub}`);
    }
    break;
  }
  case 'logs': {
    const s = findSandbox(sub);
    const lines = Number(flags['-n'] ?? 200);
    const since = flags['--since'];
    let entries = s.logs;
    if (since) {
      const ms = Number(since.slice(0, -1)) * { s: 1000, m: 60000, h: 3600000 }[since.slice(-1)];
      entries = entries.filter((line) => Date.now() - Date.parse(line.slice(0, 24)) <= ms);
    }
    print(entries.slice(-lines).join('\n'));
    break;
  }
  case 'policy': {
    const view = flags['--full'] ? 'full' : flags['--base'] ? 'base' : undefined;
    switch (sub) {
      case 'get': {
        if (flags['--global']) {
          if (!state.global_policy) fail('no global policy is set');
          print(
            output === 'json'
              ? revisionJson('global', undefined, state.global_policy, view ?? 'full')
              : `Version: ${state.global_policy.version}`,
          );
          break;
        }
        const s = findSandbox(rest[0]);
        const revNumber = Number(flags['--rev'] ?? 0);
        const rev = revNumber ? s.revisions.find((r) => r.version === revNumber) : s.revisions.at(-1);
        if (!rev) fail(`revision ${revNumber} not found`);
        const value = {
          ...revisionJson('sandbox', s.name, rev, view),
          active_version: s.current_policy_version,
          ...(revNumber
            ? {}
            : { status: 'effective', policy_source: state.global_policy ? 'global' : 'sandbox' }),
        };
        print(
          output === 'json'
            ? value
            : `Version: ${rev.version}\nHash: ${rev.hash}\nStatus: ${rev.status}\nActive: ${s.current_policy_version}`,
        );
        break;
      }
      case 'list': {
        const revisions = flags['--global']
          ? state.global_policy
            ? [state.global_policy]
            : []
          : findSandbox(rest[0]).revisions;
        const scope = flags['--global'] ? 'global' : 'sandbox';
        print(
          output === 'json'
            ? revisions.map((r) => revisionJson(scope, flags['--global'] ? undefined : rest[0], r))
            : table(revisions.map((r) => [String(r.version), r.hash.slice(0, 12), r.status])),
        );
        break;
      }
      case 'set': {
        if (!flags['--policy']) fail('--policy <file> is required');
        let policy;
        try {
          policy = parsePolicy(readFileSync(flags['--policy'], 'utf8'));
        } catch (e) {
          fail(e.message);
        }
        if (flags['--global']) {
          if (!flags['--yes']) fail('refusing to change the global policy without --yes');
          state.global_policy = {
            version: (state.global_policy?.version ?? 0) + 1,
            hash: hash(JSON.stringify(policy)),
            status: 'loaded',
            created_at_ms: Date.now(),
            provenance: 'cli',
            policy,
          };
          saveState(state);
          print(`Global policy revision ${state.global_policy.version} applied`);
          break;
        }
        const s = findSandbox(rest[0]);
        if (state.global_policy) fail('a global policy is active; sandbox policy changes are locked');
        if (policy.slow_load && flags['--wait']) {
          const version = addRevision(s, policy, 'cli');
          const seconds = Number(flags['--timeout'] ?? 60);
          if (policy.slow_load > seconds) {
            s.revisions.at(-1).status = 'pending';
            saveState(state);
            process.stderr.write(`timed out waiting for revision ${version}\n`);
            process.exit(124);
          }
        }
        if (policy.reject_on_load) {
          const version = addRevision(s, policy, 'cli');
          s.revisions.at(-1).status = 'failed';
          s.revisions.at(-1).load_error = 'sandbox rejected revision: binary /usr/bin/none does not exist';
          saveState(state);
          if (flags['--wait']) {
            process.stderr.write(`revision ${version} failed to load\n`);
            process.exit(1);
          }
        } else {
          const version = addRevision(s, policy, 'cli');
          saveState(state);
          print(
            flags['--wait']
              ? `Policy revision ${version} loaded on ${s.name}`
              : `Policy revision ${version} accepted for ${s.name}`,
          );
        }
        break;
      }
      case 'update': {
        const s = findSandbox(rest[0]);
        const policy = JSON.parse(JSON.stringify(s.policy));
        policy.network_policies ??= {};
        const binaries = many(flags['--binary']).map((path) => ({ path }));
        for (const spec of many(flags['--add-endpoint'])) {
          const [host, port, access = 'read-write', protocol = 'tcp', enforcement = 'enforce'] =
            spec.split(':');
          const ruleName = flags['--rule-name'] ?? host.replace(/[^a-z0-9]/gi, '_');
          const rule = (policy.network_policies[ruleName] ??= {
            name: ruleName,
            endpoints: [],
            binaries: [],
          });
          rule.endpoints.push({ host, port: Number(port), access, protocol, enforcement });
          if (binaries.length) rule.binaries = binaries;
        }
        for (const spec of many(flags['--remove-endpoint'])) {
          const [host, port] = spec.split(':');
          for (const [name, rule] of Object.entries(policy.network_policies)) {
            rule.endpoints = rule.endpoints.filter((e) => !(e.host === host && String(e.port) === port));
            if (!rule.endpoints.length) delete policy.network_policies[name];
          }
        }
        for (const spec of [
          ...many(flags['--add-allow']).map((s) => ['allow', s]),
          ...many(flags['--add-deny']).map((s) => ['deny', s]),
        ]) {
          if (!flags['--rule-name']) fail('--add-allow/--add-deny require --rule-name');
          const rule = policy.network_policies[flags['--rule-name']];
          if (!rule) fail(`rule "${flags['--rule-name']}" not found`);
          if (
            !flags['--any-binary'] &&
            JSON.stringify(rule.binaries.map((b) => b.path).sort()) !==
              JSON.stringify(binaries.map((b) => b.path).sort())
          )
            fail('the --binary list does not match the rule');
          (rule.rules ??= []).push({ effect: spec[0], match: spec[1] });
        }
        for (const name of many(flags['--remove-rule'])) {
          if (!policy.network_policies[name]) fail(`rule "${name}" not found`);
          delete policy.network_policies[name];
        }
        if (flags['--dry-run']) {
          print(policy);
          break;
        }
        const version = addRevision(s, policy, 'cli');
        saveState(state);
        print(`Policy revision ${version} loaded on ${s.name}`);
        break;
      }
      case 'delete': {
        if (!flags['--global']) fail('only --global can be deleted');
        state.global_policy = null;
        saveState(state);
        print('Global policy deleted');
        break;
      }
      default:
        fail(`unsupported policy subcommand ${sub}`);
    }
    break;
  }
  case 'rule': {
    const s = findSandbox(rest[0]);
    switch (sub) {
      case 'get': {
        const status = flags['--status'];
        const chunks = s.proposals.filter((p) => !status || p.status === status);
        const lines = [`Network rules for ${s.name}`, ''];
        for (const p of chunks) {
          lines.push(
            `  Chunk: ${p.id}`,
            `  Status: ${p.status}`,
            `  Rule: ${p.rule_name}`,
            `  Binary: ${p.binary}`,
            `  Confidence: ${Math.round(p.confidence * 100)}%`,
            `  Rationale: ${p.rationale}`,
            `  Prover: no new findings`,
            `  Endpoints: ${p.host}:443`,
            `  Binaries: ${p.binary}`,
          );
          if (p.hits > 1) lines.push(`  Hits: ${p.hits} (first seen ${p.first_seen}, last seen ${now()})`);
          lines.push('');
        }
        print(lines.join('\n'));
        break;
      }
      case 'approve':
      case 'reject': {
        const id = flags['--chunk-id'];
        const p = s.proposals.find((x) => x.id === id);
        if (!p) fail(`draft chunk '${id}' not found`);
        if (p.status !== 'pending') fail(`draft chunk '${id}' is already ${p.status}`);
        p.status = sub === 'approve' ? 'approved' : 'rejected';
        if (sub === 'reject') p.reason = flags['--reason'] ?? '';
        else {
          const policy = JSON.parse(JSON.stringify(s.policy));
          policy.network_policies ??= {};
          (policy.network_policies[p.rule_name] ??= {
            name: p.rule_name,
            endpoints: [],
            binaries: [{ path: p.binary }],
          }).endpoints.push({
            host: p.host,
            port: 443,
            access: 'read-only',
            protocol: 'rest',
            enforcement: 'enforce',
          });
          addRevision(s, policy, `advisor:${p.id}`);
        }
        saveState(state);
        print(`${sub === 'approve' ? 'Approved' : 'Rejected'} rule chunk ${id} on ${s.name}`);
        break;
      }
      default:
        fail(`unsupported rule subcommand ${sub}`);
    }
    break;
  }
  default:
    fail(`unknown command ${group ?? '(none)'}`);
}
