import { expect, test } from '@playwright/test';
import { afterRender, exportFile, probe, upload } from './helpers';

/**
 * Phone-like footage: long keyframe interval, B-frames, an audio track,
 * portrait rotation. The first engine re-ran ffmpeg ~100 times per export in
 * one instance and hung / crashed ("memory access out of bounds") on clips
 * like these.
 */
test.describe('realistic video', () => {
  test.setTimeout(300_000);

  test('long-GOP clip with audio: full-length MP4 then GIF in the same session', async ({ page }) => {
    await page.goto('/');
    await upload(page, ['phone.mp4']);
    await expect(page.getByText('frame 1/120')).toBeVisible();
    await afterRender(page, () => page.getByTestId('scrubber').fill('3.5'));
    await page.getByTestId('fmt-mp4').click();
    const mp4 = await exportFile(page, 'export', 240_000);
    const v = probe(mp4.path, true);
    expect([v.codec, v.width, v.height, v.frames]).toEqual(['h264', 1280, 720, 120]);
    expect(v.duration).toBeGreaterThan(3.9);
    expect(v.duration).toBeLessThan(4.1);
    // a second export in the same session must not be affected by the first
    await page.getByTestId('fmt-gif').click();
    await page.locator('#gif-fps').fill('10');
    await page.locator('#gif-width').fill('320');
    const gif = await exportFile(page, 'export', 240_000);
    const g = probe(gif.path, true);
    expect([g.codec, g.width, g.frames]).toEqual(['gif', 320, 40]);
  });

  test('portrait clip with a rotation flag exports upright', async ({ page }) => {
    await page.goto('/');
    await upload(page, ['portrait.mov']);
    await page.getByTestId('fmt-mp4').click();
    const { path } = await exportFile(page, 'export', 240_000);
    const v = probe(path, true);
    expect([v.width, v.height, v.frames]).toEqual([360, 640, 60]);
  });
});
