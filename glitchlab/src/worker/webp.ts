/// <reference lib="webworker" />
import type { Img } from '../core/image';
import { FFInstance } from './ffmpeg';

/** Encode a still to WebP with ffmpeg.wasm's libwebp (for browsers whose canvas can't encode WebP). */
export async function encodeWebp(img: Img, quality: number): Promise<Blob> {
  const ff = await FFInstance.create();
  ff.writeOwned('/in.rgba', new Uint8Array(img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength)));
  const q = Math.round(Math.max(0, Math.min(1, quality)) * 100);
  const { code, log } = ff.run([
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.width}x${img.height}`, '-i', '/in.rgba',
    '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-quality', String(q), '/out.webp',
  ]);
  if (code !== 0 || !ff.exists('/out.webp')) throw new Error(`WebP encoding failed: ${log.slice(-2).join(' ')}`);
  const data = ff.readAndRemove('/out.webp');
  return new Blob([data.slice().buffer as ArrayBuffer], { type: 'image/webp' });
}
