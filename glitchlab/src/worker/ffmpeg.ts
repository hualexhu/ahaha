/// <reference lib="webworker" />
/**
 * Thin wrapper around the single-threaded ffmpeg.wasm core, loaded directly
 * inside our processing worker (no nested worker, no SharedArrayBuffer, so
 * no COOP/COEP headers are needed).
 */
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import type { VideoMeta } from '../core/video';

interface FFmpegCore {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    readdir(path: string): string[];
    stat(path: string): { size: number };
  };
  exec(...args: string[]): number;
  ret: number;
  reset(): void;
  setLogger(fn: (e: { type: string; message: string }) => void): void;
  setProgress(fn: (e: { progress: number; time: number }) => void): void;
  setTimeout(ms: number): void;
}

let corePromise: Promise<FFmpegCore> | null = null;
let logSink: ((line: string) => void) | null = null;

export function loadFFmpeg(): Promise<FFmpegCore> {
  if (!corePromise) {
    corePromise = (async () => {
      const abs = (u: string): string => new URL(u, self.location.href).href;
      const core = abs(coreURL);
      const mod = (await import(/* @vite-ignore */ core)) as { default: (o: object) => Promise<FFmpegCore> };
      const ff = await mod.default({
        mainScriptUrlOrBlob: `${core}#${btoa(JSON.stringify({ wasmURL: abs(wasmURL), workerURL: '' }))}`,
      });
      ff.setLogger((e) => logSink?.(e.message));
      return ff;
    })();
    corePromise.catch(() => { corePromise = null; });
  }
  return corePromise;
}

/** Run ffmpeg with the given args; returns exit code and the captured log. */
export async function run(args: string[]): Promise<{ code: number; log: string[] }> {
  const ff = await loadFFmpeg();
  const log: string[] = [];
  logSink = (l) => log.push(l);
  try {
    ff.setTimeout(-1);
    ff.exec('-nostdin', '-hide_banner', '-y', ...args);
    const code = ff.ret;
    ff.reset();
    return { code, log };
  } finally {
    logSink = null;
  }
}

export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  (await loadFFmpeg()).FS.writeFile(path, data);
}

export async function readFile(path: string): Promise<Uint8Array> {
  return (await loadFFmpeg()).FS.readFile(path);
}

export async function removeFile(path: string): Promise<void> {
  try {
    (await loadFFmpeg()).FS.unlink(path);
  } catch {
    /* already gone */
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    (await loadFFmpeg()).FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parse duration / size / fps / rotation from `ffmpeg -i` output. */
export function parseProbe(log: string[]): VideoMeta | null {
  const text = log.join('\n');
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const vid = /Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(text);
  if (!vid) return null;
  let width = parseInt(vid[1], 10);
  let height = parseInt(vid[2], 10);
  const line = vid[0];
  const fpsM = /([\d.]+)\s*fps/.exec(line) ?? /([\d.]+)\s*tbr/.exec(line);
  const fps = fpsM ? parseFloat(fpsM[1]) : 30;
  const rot = /rotate\s*:\s*(-?\d+)/.exec(text) ?? /rotation of (-?[\d.]+) degrees/.exec(text);
  if (rot && Math.abs(Math.round(parseFloat(rot[1]))) % 180 === 90) [width, height] = [height, width];
  const duration = dur ? parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + parseFloat(dur[3]) : 0;
  return { width, height, duration, fps: fps > 0 && fps < 1000 ? fps : 30 };
}

export async function probe(path: string): Promise<VideoMeta | null> {
  const { log } = await run(['-i', path]);
  return parseProbe(log);
}
