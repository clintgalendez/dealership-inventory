import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'Inventory-Demo-2026';

export async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('table', { name: 'Vehicles' })).toBeVisible();
}
