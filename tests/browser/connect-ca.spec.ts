import { test, expect } from '@playwright/test';

test('the Connect dialog builds install commands for wherever the harness CA is', async ({ page }) => {
  const base = process.env.TEST_BASE_URL ?? 'http://localhost:18088';
  const api = async (path: string, data?: unknown) => {
    const r = await page.request.fetch('/api' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: base },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  await api('/auth/login', { email: 'admin@openharness.test', password: 'Integration-test-password-42' });
  const user = {
    email: `ca-browser-${Date.now()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await api('/users', { ...user, name: 'CA admin', workspace: 'new', role: 'admin' });
  await api('/auth/login', user);
  // The server offers its CA only when one is configured (scripts/enable-tls.sh writes PUBLIC_CA_PEM_BASE64).
  const { ca } = await api('/devices');

  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Add resource', exact: true }).first().click();
  await page.getByRole('radio', { name: /Container/ }).click();
  await page.getByLabel('Resource name').fill('CA box');
  await page.getByLabel('Resource ID', { exact: true }).fill(`ca-box-${Date.now()}`);
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('Harness gateway address').fill('wss://harness.example.com:8443');
  const certificate = dialog.getByRole('radiogroup', { name: 'Harness certificate' });
  await expect(certificate).toBeVisible();

  if (ca) {
    // With a known CA the default writes it out: nothing to copy, and the hash to check against is shown.
    await expect(certificate.getByRole('radio', { name: 'Include the server’s CA' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(dialog).toContainText("cat > ca.crt <<'OPENHARNESS_CA'");
    await expect(dialog).toContainText(`Its SHA-256 is ${ca.sha256}`);
    await page.screenshot({ path: 'test-results/connect-ca-embed.png' });
    await certificate.getByRole('radio', { name: 'CA file on that machine' }).click();
  } else {
    await expect(certificate.getByRole('radio', { name: 'Include the server’s CA' })).toHaveCount(0);
    await expect(certificate.getByRole('radio', { name: 'CA file on that machine' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }

  // A file already on the machine: every command uses its path, and nothing is written out.
  await dialog.getByLabel('CA certificate path').fill('~/ca.crt');
  await expect(dialog).toContainText('-v "$HOME/ca.crt:/certs/ca.crt:ro"');
  await expect(dialog).toContainText('GATEWAY_CA_FILE=/certs/ca.crt');
  await expect(dialog).not.toContainText("<<'OPENHARNESS_CA'");
  await expect(dialog).not.toContainText('Self-signed harness certificate?');
  if (ca) await expect(dialog).toContainText(`it should print ${ca.sha256}`);
  await page.screenshot({ path: 'test-results/connect-ca-path.png' });
  await dialog.getByRole('button', { name: 'Linux service', exact: true }).click();
  await expect(dialog).toContainText('GATEWAY_CA_FILE="$HOME/ca.crt" sh connector-linux/install.sh');

  // A relative path would resolve against the wrong directory: refused before any command is shown.
  await dialog.getByLabel('CA certificate path').fill('ca.crt');
  await expect(dialog.getByRole('alert')).toContainText('absolute path');
  await expect(dialog.locator('pre')).toContainText('Correct the settings above');
  await dialog.getByLabel('CA certificate path').fill('~/ca.crt');

  // A publicly trusted certificate needs no CA at all.
  await certificate.getByRole('radio', { name: 'Publicly trusted' }).click();
  await expect(dialog.getByLabel('CA certificate path')).toHaveCount(0);
  await expect(dialog).not.toContainText('GATEWAY_CA_FILE');
  await expect(dialog).not.toContainText('ca.crt');

  // Plain ws:// has no certificate, so the choice disappears.
  await page.getByLabel('Harness gateway address').fill('ws://192.0.2.10:8090');
  await expect(dialog.getByRole('radiogroup', { name: 'Harness certificate' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();

  // An OpenShell host: the remembered path is reused, and the deployment copies it where the edge reads it.
  await page.getByRole('button', { name: 'Add resource', exact: true }).first().click();
  await page
    .getByRole('radiogroup', { name: 'Resource type' })
    .getByRole('radio', { name: /OpenShell managed machine/ })
    .click();
  await page.getByLabel('Resource name').fill('CA OpenShell');
  await page.getByLabel('Resource ID', { exact: true }).fill(`ca-os-${Date.now()}`);
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await page.getByLabel('Harness gateway address').fill('wss://harness.example.com:8443');
  await dialog
    .getByRole('radiogroup', { name: 'Harness certificate' })
    .getByRole('radio', { name: 'CA file on that machine' })
    .click();
  await expect(dialog.getByLabel('CA certificate path')).toHaveValue('~/ca.crt');
  await expect(dialog).toContainText('cp "$HOME/ca.crt" certs/ca.crt && chmod 644 certs/ca.crt');
  await expect(dialog).toContainText('OPENHARNESS_CA_FILE=/certs/ca.crt');
  await expect(dialog).toContainText('puts the CA in deploy/openshell/certs');
  await page.screenshot({ path: 'test-results/connect-ca-openshell.png' });
});
