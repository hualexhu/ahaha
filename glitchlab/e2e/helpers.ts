import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
export const FFPROBE: string = require('@ffprobe-installer/ffprobe').path;

export const fixture = (n: string): string => join(process.cwd(), 'fixtures', n);

export async function renders(page: Page): Promise<number> {
  return Number(await page.getByTestId('stage').getAttribute('data-renders'));
}

/** Run an action and wait until a new preview has been rendered and nothing is pending. */
export async function afterRender(page: Page, action: () => Promise<unknown>, timeout = 60_000): Promise<void> {
  const before = await renders(page);
  await action();
  await expect.poll(() => renders(page), { timeout }).toBeGreaterThan(before);
  await expect(page.getByTestId('stage')).toHaveAttribute('data-busy', 'false', { timeout });
}

export async function upload(page: Page, files: string[]): Promise<void> {
  const before = await renders(page);
  await page.getByTestId('file-input').setInputFiles(files.map(fixture));
  await expect.poll(() => renders(page), { timeout: 60_000 }).toBeGreaterThan(before);
}

/** Click export and return the downloaded file's path + suggested name. */
export async function exportFile(page: Page, button = 'export', timeout = 120_000): Promise<{ path: string; name: string }> {
  const dl = page.waitForEvent('download', { timeout });
  await page.getByTestId(button).click();
  const d = await dl;
  const path = await d.path();
  return { path, name: d.suggestedFilename() };
}

export interface ProbeInfo { width: number; height: number; codec: string; duration: number; frames: number }

export function probe(path: string, countFrames = false): ProbeInfo {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_frames,nb_read_frames,duration:format=duration', '-of', 'json'];
  if (countFrames) args.push('-count_frames');
  const out = JSON.parse(execFileSync(FFPROBE, [...args, path]).toString());
  const s = out.streams[0];
  return {
    codec: s.codec_name,
    width: s.width,
    height: s.height,
    duration: parseFloat(s.duration ?? out.format?.duration ?? '0'),
    frames: parseInt(s.nb_read_frames ?? s.nb_frames ?? '0', 10),
  };
}

export function magic(path: string): string {
  return readFileSync(path).subarray(0, 12).toString('hex');
}
