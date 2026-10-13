import { expect, test } from '@playwright/test';
import { signIn } from './support';

// Frontend side of the concurrent-edit scenario: two Northside admins open the same vehicle
// at the same version in separate browser sessions and both save.
test('a stale save shows a conflict and requires a refresh before retrying', async ({
  browser,
}) => {
  const alex = await (await browser.newContext()).newPage();
  const blair = await (await browser.newContext()).newPage();
  await signIn(alex, 'alex.admin@northside.example');
  await signIn(blair, 'blair.admin@northside.example');

  for (const page of [alex, blair]) {
    await page.getByRole('button', { name: 'Edit 2022 Toyota Camry' }).click();
    await expect(page.getByRole('heading', { name: /editing version v1/ })).toBeVisible();
  }

  await alex.getByLabel('Model').fill('Camry Hybrid');
  await alex.getByRole('button', { name: 'Save changes' }).click();
  await expect(alex.getByRole('status')).toContainText('now version v2');

  // Blair still holds version 1.
  await blair.getByLabel('Status').selectOption('sold');
  await blair.getByRole('button', { name: 'Save changes' }).click();
  const alert = blair.getByRole('alert');
  await expect(alert).toContainText('Someone else changed this vehicle after you opened it.');
  await expect(alert).toContainText('were not saved');
  await expect(blair.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  await blair.getByRole('button', { name: 'Refresh' }).click();
  await expect(blair.getByRole('heading', { name: /editing version v2/ })).toBeVisible();
  await expect(blair.getByLabel('Model')).toHaveValue('Camry Hybrid');

  await blair.getByLabel('Status').selectOption('sold');
  await blair.getByRole('button', { name: 'Save changes' }).click();
  await expect(blair.getByRole('status')).toContainText('now version v3');

  // Both changes are kept: Alex's model and Blair's status.
  await alex.reload();
  const row = alex.getByRole('row', { name: /Camry Hybrid/ });
  await expect(row).toContainText('sold');
  await expect(row).toContainText('v3');
});
