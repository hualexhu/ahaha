import { test } from '@playwright/test';
import { afterRender, upload } from './helpers';

/** Captures design screenshots (empty state, open cards, mobile sheet) into screenshots/. */
test('design screenshots', async ({ page }) => {
  await page.goto('/');
  await page.screenshot({ path: 'screenshots/empty.png' });
  await upload(page, ['scene.png']);
  await afterRender(page, () => page.getByTestId('preset-select').selectOption('Heavy Glitch'));
  await page.locator('[data-effect="databend"] .card-head').click();
  await page.mouse.move(640, 400);
  await page.screenshot({ path: 'screenshots/databend-open.png' });
  await page.locator('[data-effect="databend"] .card-head').click();
  await afterRender(page, () => page.getByTestId('preset-select').selectOption('CyberShot Green'));
  await page.locator('[data-effect="palette"] .card-head').click();
  await page.locator('[data-effect="palette"]').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Split view' }).click();
  await page.screenshot({ path: 'screenshots/palette-split.png' });
  await page.getByRole('button', { name: 'Preset options' }).click();
  await page.screenshot({ path: 'screenshots/preset-menu.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await upload(page, ['scene.png']);
  await page.screenshot({ path: 'screenshots/mobile-closed.png' });
  await page.getByRole('button', { name: /Edit & export/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'screenshots/mobile-open.png' });
});
