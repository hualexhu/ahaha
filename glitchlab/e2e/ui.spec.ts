import { expect, test, type Page } from '@playwright/test';
import { afterRender, exportFile, probe, upload } from './helpers';

const seed = (page: Page) => page.locator('#seed').inputValue();

test('keyboard: R rerolls the seed, Space toggles before/after, Ctrl+E exports', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['scene.png']);
  const s0 = await seed(page);
  await page.locator('body').click({ position: { x: 5, y: 790 } });
  await afterRender(page, () => page.keyboard.press('r'));
  expect(await seed(page)).not.toBe(s0);
  await expect(page.getByTestId('status')).toContainText('preset: CyberShot Green');

  await page.keyboard.press('Space');
  await expect(page.locator('.tag.l', { hasText: 'BEFORE' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator('.tag.l', { hasText: 'BEFORE' })).toHaveCount(0);

  const dl = page.waitForEvent('download');
  await page.keyboard.press('Control+e');
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/^scene_glitchlab_cybershot-green_\d+\.png$/);
});

test('before/after split view, effect reordering and crop editing', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['scene.png']);
  await page.getByRole('button', { name: '⇆ split' }).click();
  await expect(page.getByRole('slider', { name: 'Before/after split' })).toBeVisible();
  await page.screenshot({ path: 'screenshots/split.png' });
  await page.getByRole('button', { name: '⇆ split' }).click();

  // reorder: move Palette above Databend
  const titles = () => page.locator('.section[data-effect] .title').allInnerTexts();
  const before = await titles();
  const iPal = before.findIndex((t) => t.includes('Palette'));
  await afterRender(page, () => page.getByRole('button', { name: 'Move Palette / Viewfinder up' }).click());
  const after = await titles();
  expect(after[iPal - 1]).toContain('Palette');

  // geometry: 1:1 crop, edit the box, export is square
  await page.locator('[data-effect="geometry"] .title').click();
  await afterRender(page, () => page.locator('[data-enable="geometry"]').check());
  await afterRender(page, () => page.locator('#geometry-aspect').selectOption('1:1'));
  await afterRender(page, () => page.getByRole('button', { name: /Edit crop box/ }).click());
  const box = page.getByTestId('crop-box');
  await expect(box).toBeVisible();
  const b = (await box.boundingBox())!;
  await afterRender(page, async () => {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 60, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
  });
  await page.screenshot({ path: 'screenshots/crop.png' });
  await afterRender(page, () => page.getByRole('button', { name: /Done editing crop/ }).click());
  await page.getByTestId('image-format').selectOption('png');
  const { path } = await exportFile(page);
  const info = probe(path);
  expect(info.width).toBe(640);
  expect(info.height).toBe(640);
});

test('12 MP image: full pipeline export < 10 s while the UI stays responsive', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['large-12mp.png']);
  // every still effect on
  for (const t of ['geometry', 'colour', 'databend', 'pixelsort', 'eightbit', 'palette', 'ascii']) {
    const box = page.locator(`[data-enable="${t}"]`);
    if (!(await box.isChecked())) await afterRender(page, () => box.check());
  }
  await page.getByTestId('image-format').selectOption('png');
  await page.evaluate(() => {
    const w = window as unknown as { __maxGap: number };
    w.__maxGap = 0;
    let last = performance.now();
    const tick = (): void => { const n = performance.now(); w.__maxGap = Math.max(w.__maxGap, n - last); last = n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  const { path } = await exportFile(page);
  const ms = Date.now() - t0;
  console.log(`12 MP full-pipeline export: ${ms} ms`);
  expect(ms).toBeLessThan(10_000);
  const info = probe(path);
  expect([info.width, info.height]).toEqual([4000, 3000]);
  const gap = await page.evaluate(() => (window as unknown as { __maxGap: number }).__maxGap);
  expect(gap).toBeLessThan(500);
  // preview still reacts while nothing else runs
  await afterRender(page, () => page.locator('[data-enable="ascii"]').uncheck());
});

test('mobile width: parameter panel becomes a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await upload(page, ['scene.png']);
  const panel = page.locator('aside.panel');
  const handle = page.getByRole('button', { name: /effects & export/ });
  await expect(handle).toBeVisible();
  const closed = (await panel.boundingBox())!;
  expect(closed.height).toBeLessThan(80);
  expect(closed.y + closed.height).toBeGreaterThan(800);
  await page.screenshot({ path: 'screenshots/mobile-closed.png' });
  await handle.click();
  await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(400);
  await page.screenshot({ path: 'screenshots/mobile-open.png' });
  // no horizontal page scroll
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
