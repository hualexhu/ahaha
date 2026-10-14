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

/**
 * Files that used to leave the stage spinning on "Decoding…": each must end
 * in either a preview or a readable error with a way out.
 */
test.describe('problem files', () => {
  test.setTimeout(180_000);

  test('a WebM without a duration (MediaRecorder-style) gets its real length', async ({ page }) => {
    await page.goto('/');
    await upload(page, ['live.webm']);
    // 2 s at 15 fps: the length is measured from the packets, not taken as 0
    await expect(page.getByText(/frame 1\/(29|30)\b/)).toBeVisible();
    await page.getByTestId('fmt-mp4').click();
    const { path } = await exportFile(page, 'export', 120_000);
    expect(probe(path, true).frames).toBeGreaterThanOrEqual(29);
  });

  for (const [file, reason] of [
    ['av1.mp4', /AV1/],
    ['truncated.mp4', /damaged or incomplete/],
  ] as const) {
    test(`${file}: explains the problem instead of spinning, and the app keeps working`, async ({ page }) => {
      await page.goto('/');
      await page.getByTestId('file-input').setInputFiles([`fixtures/${file}`]);
      const err = page.getByTestId('stage-error');
      await expect(err).toBeVisible({ timeout: 60_000 });
      await expect(err).toContainText(reason);
      await expect(page.getByTestId('stage-loading')).toHaveCount(0);
      // Retry gives the same answer (not a hang); Remove clears it; a good file still previews
      await page.getByTestId('retry').click();
      await expect(page.getByTestId('stage-error')).toContainText(reason, { timeout: 60_000 });
      await err.getByRole('button', { name: 'Remove file' }).click();
      await upload(page, ['testsrc.mp4']);
      await expect(page.getByTestId('stage-error')).toHaveCount(0);
    });
  }
});
