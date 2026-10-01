/// <reference lib="webworker" />
import type { Img } from '../core/image';
import { readFile, removeFile, run, writeFile } from './ffmpeg';

let seq = 0;

/** Encode a still to WebP with ffmpeg.wasm's libwebp (for browsers whose canvas can't encode WebP). */
export async function encodeWebp(img: Img, quality: number): Promise<Blob> {
  const id = ++seq;
  const input = `webp_in_${id}.rgba`;
  const output = `webp_out_${id}.webp`;
  await writeFile(input, new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
  try {
    const q = Math.round(Math.max(0, Math.min(1, quality)) * 100);
    const { code, log } = await run([
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.width}x${img.height}`, '-i', input,
      '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-quality', String(q), output,
    ]);
    if (code !== 0) throw new Error(`WebP encoding failed: ${log.slice(-2).join(' ')}`);
    const data = await readFile(output);
    return new Blob([data.slice().buffer as ArrayBuffer], { type: 'image/webp' });
  } finally {
    await removeFile(input);
    await removeFile(output);
  }
}
