import { expect, test, type Page } from '@playwright/test';
import { afterRender, exportFile, magic, probe, upload } from './helpers';

async function startFrameMonitor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __maxGap: number; __frames: number };
    w.__maxGap = 0;
    w.__frames = 0;
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      w.__maxGap = Math.max(w.__maxGap, now - last);
      w.__frames++;
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const frameStats = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __maxGap: number; __frames: number };
  return { maxGap: w.__maxGap, frames: w.__frames };
});

test('video: glitch + stacking → MP4 and GIF with the right duration / frame count', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['testsrc.mp4']);
  await expect(page.getByTestId('scrubber')).toBeVisible();
  await expect(page.getByText('frame 1/30')).toBeVisible();

  // glitch preset + frame stacking (rolling lighten window)
  await afterRender(page, () => page.getByTestId('preset-select').selectOption('Heavy Glitch'));
  await afterRender(page, () => page.locator('input[data-param="stackOn"]').check());
  await page.locator('#v-stack-mode').selectOption('lighten');
  await afterRender(page, () => page.locator('#v-stack-window').fill('4'));
  // scrub to the middle: preview follows
  await afterRender(page, () => page.getByTestId('scrubber').fill('1'));
  await expect(page.getByText(/frame 16\/30/)).toBeVisible();
  await page.screenshot({ path: 'screenshots/video-glitch-stack.png' });

  // MP4, while checking that the UI thread keeps painting
  await page.getByTestId('video-format').selectOption('mp4');
  await startFrameMonitor(page);
  const mp4 = await exportFile(page);
  const stats = await frameStats(page);
  expect(mp4.name).toBe('testsrc_glitchlab_custom_9001.mp4');
  expect(magic(mp4.path).slice(8, 16)).toBe('66747970'); // 'ftyp'
  const v = probe(mp4.path, true);
  expect(v.codec).toBe('h264');
  expect([v.width, v.height]).toEqual([320, 240]);
  expect(v.frames).toBe(30);
  expect(v.duration).toBeGreaterThan(1.9);
  expect(v.duration).toBeLessThan(2.1);
  expect(stats.frames).toBeGreaterThan(10);
  expect(stats.maxGap).toBeLessThan(500);

  // GIF at 10 fps, 160 px wide → 20 frames
  await page.getByTestId('video-format').selectOption('gif');
  await page.locator('#gif-fps').fill('10');
  await page.locator('#gif-width').fill('160');
  const gif = await exportFile(page);
  expect(gif.name).toMatch(/\.gif$/);
  expect(magic(gif.path).startsWith('474946383961')).toBe(true); // GIF89a
  const g = probe(gif.path, true);
  expect(g.codec).toBe('gif');
  expect(g.width).toBe(160);
  expect(g.frames).toBe(20);

  // WebM
  await page.getByTestId('video-format').selectOption('webm');
  const webm = await exportFile(page);
  const w = probe(webm.path, true);
  expect(w.codec).toBe('vp8');
  expect(w.frames).toBe(30);
});

test('video: trim, fps, speed and parameter animation', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['testsrc.webm']);
  await afterRender(page, () => page.getByTestId('preset-select').selectOption('8-bit Arcade'));
  await afterRender(page, () => page.locator('#v-trim-start').fill('0.5'));
  await afterRender(page, () => page.locator('#v-fps').selectOption('half'));
  await afterRender(page, () => page.locator('#v-speed').fill('0.5'));
  // animate the 8-bit block size from 8 to 1 across the clip
  await page.locator('[data-effect="eightbit"] .title').click();
  await page.getByRole('button', { name: 'Animate Block size' }).click();
  await afterRender(page, () => page.locator('#eightbit-block-to').fill('1'));
  await page.getByTestId('video-format').selectOption('mp4');
  const { path } = await exportFile(page);
  const v = probe(path, true);
  // 1.5 s of source at half speed = 3 s, at 7.5 fps = 22 frames
  expect(v.frames).toBe(22);
  expect(v.duration).toBeGreaterThan(2.8);
  expect(v.duration).toBeLessThan(3.2);
});

test('video: long-exposure single still from the whole clip', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['testsrc.mov']);
  await afterRender(page, () => page.locator('input[data-param="stackOn"]').check());
  await afterRender(page, () => page.locator('#v-stack-out').selectOption('still'));
  await page.locator('#v-stack-mode').selectOption('average');
  await page.getByTestId('video-format').selectOption('png');
  const { path, name } = await exportFile(page);
  expect(name).toMatch(/\.png$/);
  const s = probe(path);
  expect([s.codec, s.width, s.height]).toEqual(['png', 320, 240]);
});

test('video: cancelling an export stops it and the next export still works', async ({ page }) => {
  await page.goto('/');
  await upload(page, ['testsrc.mp4']);
  await afterRender(page, () => page.getByTestId('preset-select').selectOption('Heavy Glitch'));
  await afterRender(page, () => page.locator('#v-speed').fill('0.25')); // 120 frames
  await page.getByTestId('video-format').selectOption('mp4');
  await page.getByTestId('export').click();
  await expect(page.getByTestId('progress')).toBeVisible();
  await expect(page.getByTestId('progress')).toContainText(/frame \d+\/120/, { timeout: 60_000 });
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByTestId('cancel-export').click();
  await expect(page.getByTestId('progress')).toHaveCount(0);
  await expect(page.getByTestId('message')).toContainText('Export cancelled');
  await expect(page.getByTestId('export')).toBeEnabled();
  // preview worker is unaffected
  await afterRender(page, () => page.getByTestId('scrubber').fill('1'));
  await page.waitForTimeout(500);
  expect(downloaded).toBe(false);
  // a new export works after the cancel (worker is recreated)
  await afterRender(page, () => page.locator('#v-speed').fill('2'));
  const { path } = await exportFile(page);
  expect(probe(path, true).frames).toBe(15);
});
