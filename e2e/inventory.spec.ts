import { expect, request, test } from '@playwright/test';
import { PASSWORD, signIn } from './support';

test('admin signs in, sees only their dealership, updates a vehicle and the change survives a reload', async ({
  page,
}) => {
  await signIn(page, 'alex.admin@northside.example');

  await expect(page.getByText('Northside Motors')).toBeVisible();
  const table = page.getByRole('table', { name: 'Vehicles' });
  await expect(table.getByRole('row')).toHaveCount(4); // header + 3 vehicles
  await expect(table).toContainText('Camry');
  await expect(table).not.toContainText('Outback'); // Lakeside Auto inventory

  await page.getByRole('button', { name: 'Edit 2023 Ford F-150' }).click();
  await page.getByLabel('Model').fill('F-150 Lightning');
  await page.getByLabel('Status').selectOption('sold');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Saved 2023 Ford F-150 Lightning (now version v2).',
  );

  await page.reload();
  const row = table.getByRole('row', { name: /F-150 Lightning/ });
  await expect(row).toContainText('sold');
  await expect(row).toContainText('v2');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('status')).toHaveText('You have signed out.');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('invalid credentials show a clear error', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('alex.admin@northside.example');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('viewer sees their inventory without edit controls', async ({ page }) => {
  await signIn(page, 'finley.viewer@lakeside.example');

  await expect(page.getByText('Lakeside Auto')).toBeVisible();
  await expect(page.getByText('You have read-only access.')).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Outback');
  await expect(page.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
});

test('a session invalidated elsewhere sends the user back to login', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(page, 'dana.admin@lakeside.example');

  // End the same session from outside the page (as logout in another tab would),
  // while the browser keeps its now-useless cookie.
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === '__Host-session')!;
  const outside = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL!, Cookie: `${session.name}=${session.value}` },
  });
  expect((await outside.post('/api/auth/logout')).status()).toBe(204);
  await outside.dispose();

  await page.getByRole('button', { name: 'Edit 2020 Subaru Outback' }).click();

  await expect(page.getByRole('status')).toHaveText(
    'Your session is no longer valid. Sign in again.',
  );
  await page.getByLabel('Email').fill('dana.admin@lakeside.example');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('table', { name: 'Vehicles' })).toBeVisible();
});
