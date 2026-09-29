import { test, expect, type Page } from '@playwright/test';

// The OpenShell console against a scripted connector: the API routes are mocked so the page's behaviour is
// checked without an OpenShell gateway. Real-stack behaviour is covered by tests/integration/openshell.test.ts.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const machine = {
  device_id: 'os-lab',
  name: 'Lab OpenShell gateway',
  platform: 'openshell',
  online: true,
  disabled: false,
  hostname: 'lab-gw',
  connector_version: '0.1.0',
  last_seen: new Date().toISOString(),
  allowed_tools: ['list_sandboxes', 'exec_in_sandbox', 'get_policy'],
  tool_count: 3,
  connectionId: 'conn-os-lab',
  tools: [{ name: 'list_sandboxes' }, { name: 'exec_in_sandbox' }, { name: 'get_policy' }],
  created_at: new Date().toISOString(),
  endpoint: 'http://gateway:8090/mcp/os-lab',
};
const catalog = {
  linux: [{ name: 'run_command', description: 'Run a program', risky: true }],
  openshell: [
    { name: 'list_sandboxes', description: 'Sandboxes' },
    { name: 'exec_in_sandbox', description: 'Run a program inside a sandbox', risky: true },
    { name: 'get_policy', description: 'Policy as JSON' },
    { name: 'set_policy', description: 'Replace a policy', risky: true },
  ],
  windows: [],
  chrome: [],
};
function scriptedOpenShell(page: Page) {
  const policy = {
    version: 1,
    network_policies: {
      pypi: {
        name: 'pypi',
        endpoints: [{ host: 'pypi.org', port: 443 }],
        binaries: [{ path: '/usr/bin/curl' }],
      },
    },
  };
  const state = {
    sandboxes: [
      {
        name: 'agent-one',
        id: 'sb-1',
        workspace: 'default',
        phase: 'Ready',
        created_at: new Date().toISOString(),
        labels: { 'openharness.device': 'os-lab' },
        current_policy_version: 1,
        policy_source: 'sandbox',
        managed: true,
      },
      {
        name: 'operator-box',
        id: 'sb-2',
        workspace: 'default',
        phase: 'Stopped',
        created_at: new Date().toISOString(),
        labels: {},
        current_policy_version: 4,
        policy_source: 'sandbox',
        managed: false,
      },
    ],
    revisions: [
      {
        version: 1,
        hash: 'a1b2c3d4e5f6a7b8',
        status: 'loaded',
        created_at_ms: Date.now() - 60000,
        provenance: 'create',
      },
    ],
    proposals: [
      {
        id: 'chunk-1',
        status: 'pending',
        rule_name: 'api_github_com',
        binary: '/usr/bin/curl',
        confidence: 92,
        rationale: 'curl attempted api.github.com:443 and was denied',
        endpoints: 'api.github.com:443',
        binaries: '/usr/bin/curl',
      },
    ],
    policy,
    calls: [] as string[],
  };
  return {
    state,
    async install() {
      await page.route('**/api/devices', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              json: { configured: true, publicUrl: 'ws://localhost:18090', catalog, machines: [machine] },
            })
          : route.continue(),
      );
      await page.route('**/api/openshell/**', async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname.replace(/^\/api\/openshell\/os-lab/, '');
        const method = route.request().method();
        state.calls.push(`${method} ${path}${url.search}`);
        const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
        if (path === '/status')
          return json({
            edge_version: '0.1.0',
            status: {
              status: 'connected',
              server: 'https://127.0.0.1:17670',
              version: '0.1.2',
              authentication: { status: 'authenticated', provider: 'mtls' },
            },
            gateway_info: { version: '0.1.2', compute_drivers: ['docker'], healthy: true },
            connector_policy: { allow_policy_changes: true },
          });
        if (path === '/policy/global') return json({ error: 'no global policy is set' }, 502);
        if (path === '/sandboxes' && method === 'GET')
          return json({ sandboxes: state.sandboxes, next_page_token: '' });
        if (path === '/executors' && method === 'POST') {
          const body = route.request().postDataJSON();
          state.sandboxes.push({
            name: body.name,
            id: 'sb-exec',
            workspace: 'default',
            phase: 'Ready',
            created_at: new Date().toISOString(),
            labels: { 'openharness.device': 'os-lab', 'openharness.executor': body.name },
            current_policy_version: 1,
            policy_source: 'sandbox',
            managed: true,
            executor: body.name,
          });
          return json(
            {
              machine: { device_id: body.name, platform: 'linux' },
              sandbox: state.sandboxes.at(-1),
              policy: { version: 1 },
              output: 'ready',
            },
            201,
          );
        }
        if (path === '/sandboxes' && method === 'POST') {
          const body = route.request().postDataJSON();
          state.sandboxes.push({
            name: body.name,
            id: 'sb-3',
            workspace: 'default',
            phase: 'Ready',
            created_at: new Date().toISOString(),
            labels: { 'openharness.device': 'os-lab' },
            current_policy_version: 1,
            policy_source: 'sandbox',
            managed: true,
          });
          return json({ name: body.name, managed: true }, 201);
        }
        const sandbox = /^\/sandboxes\/([a-z0-9-]+)(\/.*)?$/.exec(path);
        if (!sandbox) return json({ error: `unmocked ${path}` }, 404);
        const rest = sandbox[2] ?? '';
        if (rest === '/policy' && method === 'GET')
          return json({
            scope: 'sandbox',
            sandbox: sandbox[1],
            version: state.revisions.length,
            status: 'effective',
            hash: 'a1b2c3d4e5f6a7b8',
            policy: state.policy,
          });
        if (rest === '/policy' && method === 'PUT') {
          state.policy = JSON.parse(route.request().postDataJSON().policy);
          state.revisions.unshift({
            version: state.revisions.length + 1,
            hash: 'ffeeddccbbaa9988',
            status: 'loaded',
            created_at_ms: Date.now(),
            provenance: 'cli',
          });
          return json({
            name: sandbox[1],
            output: `Policy revision ${state.revisions.length} loaded`,
            waited: true,
          });
        }
        if (rest === '/policy/revisions') return json({ name: sandbox[1], revisions: state.revisions });
        if (rest === '/policy/rules') {
          state.revisions.unshift({
            version: state.revisions.length + 1,
            hash: '1122334455667788',
            status: 'loaded',
            created_at_ms: Date.now(),
            provenance: 'cli',
          });
          return json({ name: sandbox[1], output: 'Policy revision loaded', dry_run: false });
        }
        if (rest === '/proposals')
          return json({
            name: sandbox[1],
            proposals: state.proposals.filter(
              (p) => !url.searchParams.get('status') || p.status === url.searchParams.get('status'),
            ),
            text: '',
          });
        const decision = /^\/proposals\/([^/]+)\/(approve|reject)$/.exec(rest);
        if (decision) {
          const proposal = state.proposals.find((p) => p.id === decision[1])!;
          proposal.status = decision[2] === 'approve' ? 'approved' : 'rejected';
          return json({ name: sandbox[1], chunk_id: decision[1], output: 'ok' });
        }
        if (rest === '/logs')
          return json({
            name: sandbox[1],
            text: '2026-09-28T10:00:00Z WARN policy_denied dest=api.github.com:443 binary=/usr/bin/curl method=GET path=/ reason=no_matching_rule',
            truncated: false,
          });
        if (rest === '/exec')
          return json({
            name: sandbox[1],
            argv: route.request().postDataJSON().argv,
            exit_code: 7,
            stdout: '',
            stderr:
              'curl: (7) policy_denied: connection to api.github.com:443 was blocked by the sandbox policy',
            truncated: false,
            timed_out: false,
            policy_denied: true,
          });
        if (rest === '/stop' || rest === '/start') {
          const s = state.sandboxes.find((x) => x.name === sandbox[1])!;
          s.phase = rest === '/stop' ? 'Stopped' : 'Ready';
          return json({ name: sandbox[1], action: rest.slice(1), output: 'ok' });
        }
        if (rest === '' && method === 'DELETE') {
          state.sandboxes = state.sandboxes.filter((x) => x.name !== sandbox[1]);
          return json({ name: sandbox[1], action: 'delete', output: 'Deleted' });
        }
        return json({ error: `unmocked ${method} ${path}` }, 404);
      });
    },
  };
}

test('the OpenShell console shows sandboxes and lets an administrator edit policy, decide proposals and run commands', async ({
  page,
}) => {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: base },
    data: { email: 'admin@openharness.test', password: 'Integration-test-password-42' },
  });
  expect(login.ok()).toBeTruthy();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const scripted = scriptedOpenShell(page);
  await scripted.install();
  await page.goto('/openshell');
  await expect(page.getByRole('heading', { name: 'OpenShell', exact: true })).toBeVisible();
  await expect(
    page.locator('.sidebar nav').getByRole('button', { name: 'OpenShell', exact: true }),
  ).toHaveClass(/active/);
  await expect(page.getByLabel('OpenShell machine')).toHaveValue('os-lab');
  const summary = page.getByLabel('OpenShell summary');
  await expect(summary).toContainText('connected');
  await expect(summary).toContainText('authenticated');
  await expect(summary).toContainText('edge 0.1.0 · docker driver');
  const table = page.locator('.openshell-table');
  await expect(table).toContainText('agent-one');
  await expect(table).toContainText('operator-box');
  await expect(table).toContainText('created here');
  await expect(table).toContainText('operator sandbox');
  await page.getByRole('button', { name: 'Policy of agent-one', exact: true }).click();
  const editor = page.getByLabel('Policy JSON');
  await expect(editor).toContainText('pypi.org');
  await expect(page.locator('.revision-list')).toContainText('v1');
  await page.screenshot({
    path: 'test-results/openshell-console-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await editor.fill(JSON.stringify({ version: 1, network_policies: {} }, null, 2));
  await page.getByRole('button', { name: 'Apply policy', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('Policy applied to agent-one');
  await expect(page.locator('.revision-list')).toContainText('v2');
  expect(scripted.state.calls.some((c) => c.startsWith('PUT /sandboxes/agent-one/policy'))).toBeTruthy();
  await page.getByLabel('Rule host').fill('api.openai.com');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('Rule added');
  await page.getByRole('tab', { name: 'Proposals' }).click();
  await expect(page.locator('.proposal-card')).toContainText('api_github_com');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('Rule approved');
  await expect(page.locator('.proposal-card')).toHaveCount(0);
  expect(scripted.state.calls).toContain('POST /sandboxes/agent-one/proposals/chunk-1/approve');
  await page.getByRole('tab', { name: 'Logs' }).click();
  await expect(page.getByLabel('Sandbox log')).toContainText('policy_denied dest=api.github.com:443');
  await page.getByRole('tab', { name: 'Run' }).click();
  await page.getByLabel('Command', { exact: true }).fill('curl https://api.github.com/');
  await page.getByRole('button', { name: 'Run in sandbox', exact: true }).click();
  await expect(page.locator('.run-output')).toContainText('denied by policy');
  await expect(page.getByLabel('Command output')).toContainText('policy_denied');
  await page.getByRole('button', { name: 'Launch executor', exact: true }).click();
  await page.getByLabel('Executor name').fill('worker-1');
  await page.getByLabel('Executor allowed hosts').fill('pypi.org:443:read-only:rest:enforce');
  await page.getByRole('dialog').getByRole('button', { name: 'Launch executor', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('Executor worker-1 launched');
  await expect(table).toContainText('executor worker-1');
  expect(scripted.state.calls).toContain('POST /executors');
  await page.getByRole('button', { name: 'Create sandbox', exact: true }).click();
  await page.getByLabel('Sandbox name').fill('agent-two');
  await page.getByLabel('Sandbox image').fill('registry.example.com/agents/worker:1.0');
  await page.getByRole('dialog').getByRole('button', { name: 'Create sandbox', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('Created agent-two');
  await expect(table).toContainText('agent-two');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: 'test-results/openshell-console-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

test('the inventory offers four resource types and old machine links still open it', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: base },
    data: { email: 'admin@openharness.test', password: 'Integration-test-password-42' },
  });
  expect(login.ok()).toBeTruthy();
  const scripted = scriptedOpenShell(page);
  await scripted.install();
  await page.goto('/machines');
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/inventory$/);
  await expect(page.getByLabel('Inventory summary')).toContainText('1 OpenShell');
  await expect(page.locator('.fleet-table')).toContainText('Lab OpenShell gateway');
  await page.getByRole('button', { name: 'Add resource', exact: true }).first().click();
  const types = page.getByRole('radiogroup', { name: 'Resource type' });
  for (const label of ['Linux machine', 'OpenShell managed machine', 'Chrome', 'Windows'])
    await expect(types.getByRole('radio', { name: new RegExp(label) })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Linux deployment' })).toBeVisible();
  await types.getByRole('radio', { name: /OpenShell managed machine/ }).click();
  await expect(page.getByRole('radiogroup', { name: 'Linux deployment' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('exec_in_sandbox');
  await expect(page.getByRole('dialog')).toContainText('never connects in');
  await page.screenshot({ path: 'test-results/inventory-add-resource.png' });
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByLabel('Filter by type').selectOption('openshell');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(1);
  await page.goto('/clusters');
  await expect(page).toHaveURL(/\/inventory\?view=clusters$/);
});

test('the page trusts its own calls to the connector over a stale machine list', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: base },
    data: { email: 'admin@openharness.test', password: 'Integration-test-password-42' },
  });
  expect(login.ok()).toBeTruthy();
  const scripted = scriptedOpenShell(page);
  await scripted.install();
  // The machine list was loaded before the edge connected, so it still says offline, but the edge answers.
  await page.route('**/api/devices', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            configured: true,
            publicUrl: 'ws://localhost:18090',
            catalog,
            machines: [{ ...machine, online: false }],
          },
        })
      : route.continue(),
  );
  await page.goto('/openshell');
  await expect(page.locator('.fleet-filters')).toContainText('connector online');
  await expect(page.getByLabel('OpenShell machine')).not.toContainText('(offline)');
  await expect(page.getByRole('button', { name: 'Launch executor', exact: true })).toBeVisible();
  await expect(page.locator('.openshell-table')).toContainText('agent-one');

  // The reverse: the list says online, but the gateway reports the connector gone.
  await page.route('**/api/devices', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: { configured: true, publicUrl: 'ws://localhost:18090', catalog, machines: [machine] },
        })
      : route.continue(),
  );
  await page.route('**/api/openshell/os-lab/**', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'Lab OpenShell gateway is offline; its connector is not connected' },
    }),
  );
  await page.reload();
  await expect(page.locator('.fleet-filters')).toContainText('connector offline');
  await expect(page.getByRole('button', { name: 'Launch executor', exact: true })).toHaveCount(0);
  await expect(page.getByText('The connector is offline; start it on the OpenShell host')).toBeVisible();
});
