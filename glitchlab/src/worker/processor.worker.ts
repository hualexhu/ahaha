/// <reference lib="webworker" />
/**
 * The processing worker. Two instances run: one for interactive previews
 * (latest request wins) and one for exports (terminated to cancel). All
 * pixel work and all ffmpeg work happens here, never on the UI thread.
 */
import { zipSync } from 'fflate';
import { fitLongEdge, resizeArea, resizeNearest, type Img } from '../core/image';
import { outputName } from '../core/filename';
import { hasEnabled, runPipeline, type Pipeline, type RunOptions } from '../core/pipeline';
import { normalizeVideo, planVideo, type VideoMeta, type VideoPlan, type VideoSettings } from '../core/video';
import { RollingStack, StillStack } from '../effects/stack';
import { num } from '../effects/types';
import { FFInstance, isEngineCrash } from './ffmpeg';
import { canvasGlyphs, decodeImageFile, encodeImage, imgToBitmap, type ImageFormat } from './imageio';
import type { ExportOptions, ExportResult, FileKind, FileMeta, PreviewResult, Progress, Request, Response } from './protocol';
import { decodeFrames, evenize, finishVideo, probeVideo, SegmentEncoder, streamFrames } from './video';

declare const self: DedicatedWorkerGlobalScope;

export const PREVIEW_EDGE = 720;

const post = (msg: Response, transfer: Transferable[] = []): void => self.postMessage(msg, transfer);

// ---------------------------------------------------------------- state
interface OpenFile {
  kind: FileKind;
  meta: FileMeta;
  videoMeta?: VideoMeta;
  /** Preview-size source for stills. */
  preview?: Img;
  /** The video file (mounted into the preview engine on demand, never copied). */
  blob?: Blob;
}
const files = new Map<string, OpenFile>();
let frameCache: { key: string; frames: Img[] } | null = null;

const glyphs = canvasGlyphs;

function extOf(file: Blob): string {
  const t = file.type;
  if (t.includes('webm')) return 'webm';
  if (t.includes('quicktime')) return 'mov';
  if (t.includes('matroska')) return 'mkv';
  return 'mp4';
}

/**
 * The preview worker keeps one ffmpeg instance for responsiveness, but
 * replaces it after a crash (and retries once) or after 40 runs, before it
 * can degrade. Videos are mounted into it with WORKERFS (no copy).
 */
class PreviewEngine {
  private inst: FFInstance | null = null;
  private creating: Promise<FFInstance> | null = null;

  private async get(): Promise<FFInstance> {
    if (this.inst && this.inst.runCount < 40) return this.inst;
    this.inst = null;
    this.creating ??= FFInstance.create().finally(() => { this.creating = null; });
    this.inst = await this.creating;
    return this.inst;
  }

  /** Run `fn` with the engine and the mounted video; on an engine crash, start a fresh engine and try once more. */
  async use<T>(fileId: string, fn: (ff: FFInstance, path: string) => T): Promise<T> {
    const f = files.get(fileId);
    if (!f?.blob) throw new Error('file not open');
    for (let attempt = 1; ; attempt++) {
      const ff = await this.get();
      try {
        return fn(ff, ff.mount(fileId, f.blob, extOf(f.blob)));
      } catch (e) {
        this.inst = null; // never reuse an instance that threw
        if (!isEngineCrash(e) || attempt >= 2) throw e;
      }
    }
  }

  unmount(fileId: string): void {
    this.inst?.unmount(fileId);
  }
}
const engine = new PreviewEngine();

/** Run an export step with fresh engines; if the engine crashes, retry once with new ones. */
async function withFreshEngines<T>(fn: () => Promise<T>, onRetry?: () => void): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isEngineCrash(e)) throw e;
    onRetry?.();
    try {
      return await fn();
    } catch (e2) {
      if (!isEngineCrash(e2)) throw e2;
      throw new Error(`The video engine ran out of memory on this clip (${errMsg(e2)}). Try a shorter trim, Output scale 1/2 in Geometry, or a GIF.`, { cause: e2 });
    }
  }
}

// ---------------------------------------------------------------- open
async function handleOpen(fileId: string, file: Blob, kind: FileKind): Promise<{ meta: FileMeta; thumb: ImageBitmap }> {
  if (kind === 'image') {
    const { img: preview, sourceWidth, sourceHeight } = await decodeImageFile(file, PREVIEW_EDGE);
    const meta: FileMeta = { kind, width: sourceWidth, height: sourceHeight, warnings: [] };
    const t = fitLongEdge(preview.width, preview.height, 160);
    files.set(fileId, { kind, meta, preview });
    return { meta, thumb: imgToBitmap(resizeArea(preview, t.width, t.height)) };
  }
  files.set(fileId, { kind, meta: { kind, width: 0, height: 0, warnings: [] }, blob: file });
  try {
    const { vm, first } = await engine.use(fileId, (ff, path) => {
      const vm = probeVideo(ff, path);
      const plan = planVideo(vm, normalizeVideo(undefined));
      const t = fitLongEdge(plan.width, plan.height, 160);
      const [first] = decodeFrames(ff, path, { start: 0, count: 1, fps: vm.fps, speed: 1, width: even(t.width), height: even(t.height) });
      return { vm, first };
    });
    const plan = planVideo(vm, normalizeVideo(undefined));
    const meta: FileMeta = { kind, width: vm.width, height: vm.height, duration: vm.duration, fps: vm.fps, warnings: plan.warnings };
    files.set(fileId, { kind, meta, videoMeta: vm, blob: file });
    const thumbImg = first ?? { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    return { meta, thumb: imgToBitmap(thumbImg) };
  } catch (e) {
    files.delete(fileId);
    throw e;
  }
}

const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2);

// ---------------------------------------------------------------- video helpers
function frameTime(plan: VideoPlan, v: VideoSettings, k: number): number {
  return plan.start + (k * v.speed) / plan.outFps;
}

/** How many earlier frames a temporal preview needs, capped. */
function historyNeeded(pipeline: Pipeline, v: VideoSettings, k: number): { stack: number; mosh: number } {
  const stack = v.stackOn && v.stackOutput === 'rolling' ? v.stackWindow - 1 : 0;
  let mosh = 0;
  const m = pipeline.effects.find((e) => e.type === 'datamosh' && e.enabled);
  if (m) {
    const hold = Math.max(1, Math.round(num(m.params, 'hold', 30)));
    mosh = k % hold;
  }
  return { stack: Math.min(stack, 29), mosh: Math.min(mosh, 40) };
}

/** Long exposure over the whole (trimmed) clip in one sequential decode; `maxFrames` samples evenly. */
function stillStack(ff: FFInstance, path: string, plan: VideoPlan, v: VideoSettings, width: number, height: number, maxFrames: number, onFrame?: (i: number, n: number) => void): Img | null {
  const stack = new StillStack(v.stackMode);
  const n = Math.min(maxFrames, plan.frames);
  const span = plan.end - plan.start;
  const fps = n < plan.frames ? Math.max(0.01, n / (span / v.speed)) : plan.outFps;
  streamFrames(ff, path, { start: plan.start, duration: span, count: n, fps, speed: v.speed, width, height }, (img, i) => {
    stack.add(img);
    onFrame?.(i + 1, n);
  });
  return stack.result();
}

// ---------------------------------------------------------------- preview
async function handlePreview(req: Extract<Request, { type: 'preview' }>): Promise<PreviewResult> {
  const t0 = performance.now();
  const f = files.get(req.fileId);
  if (!f) throw new Error('file not open');
  const opts: RunOptions = { glyphs, skip: req.mode === 'crop' ? ['geometry'] : undefined };
  if (f.kind === 'image') {
    const src = f.preview!;
    const scale = src.width / f.meta.width;
    const res = runPipeline(src, req.pipeline, { ...opts, scale });
    return {
      before: imgToBitmap(src),
      after: imgToBitmap(res.img),
      outWidth: Math.round(res.img.width / scale),
      outHeight: Math.round(res.img.height / scale),
      notes: res.side.notes,
      ms: performance.now() - t0,
      frameIndex: 0,
      frames: 1,
    };
  }
  // video
  const vm = f.videoMeta!;
  const v = normalizeVideo(req.video);
  const plan = planVideo(vm, v);
  const size = fitLongEdge(plan.width, plan.height, PREVIEW_EDGE);
  const w = even(size.width), h = even(size.height);
  const scale = w / vm.width;
  const k = Math.max(0, Math.min(plan.frames - 1, Math.round(((req.time - plan.start) / v.speed) * plan.outFps)));
  const t = plan.frames > 1 ? k / (plan.frames - 1) : 0;
  const base: RunOptions = { ...opts, scale, isVideo: true, t };

  if (v.stackOn && v.stackOutput === 'still') {
    const key = `still:${req.fileId}:${plan.start}:${plan.end}:${v.speed}:${v.stackMode}:${w}x${h}`;
    let still: Img | null;
    if (frameCache?.key === key) still = frameCache.frames[0];
    else {
      still = await engine.use(req.fileId, (ff, path) => stillStack(ff, path, plan, v, w, h, 48));
      if (still) frameCache = { key, frames: [still] };
    }
    if (!still) throw new Error('could not decode video');
    const res = runPipeline(still, req.pipeline, { ...base, frameIndex: 0, t: 0 });
    return { before: imgToBitmap(still), after: imgToBitmap(res.img), outWidth: Math.round(res.img.width / scale), outHeight: Math.round(res.img.height / scale), notes: res.side.notes, ms: performance.now() - t0, frameIndex: 0, frames: 1 };
  }

  const hist = historyNeeded(req.pipeline, v, k);
  const s = Math.max(0, k - hist.stack - hist.mosh);
  const count = k - s + 1;
  const key = `${req.fileId}:${s}:${count}:${w}x${h}:${plan.outFps}:${v.speed}:${plan.start}`;
  let frames: Img[];
  if (frameCache?.key === key) frames = frameCache.frames;
  else {
    frames = await engine.use(req.fileId, (ff, path) => decodeFrames(ff, path, { start: frameTime(plan, v, s), count, fps: plan.outFps, speed: v.speed, width: w, height: h }));
    if (!frames.length) throw new Error('could not decode this frame');
    frameCache = { key, frames };
  }
  const states: RunOptions['states'] = {};
  const rolling = v.stackOn ? new RollingStack(v.stackMode, v.stackWindow) : null;
  const moshOn = hasEnabled(req.pipeline, 'datamosh');
  let result: ReturnType<typeof runPipeline> | null = null;
  let before: Img = frames[frames.length - 1];
  for (let i = 0; i < frames.length; i++) {
    const idx = s + i;
    const stacked = rolling ? rolling.push(frames[i]) : frames[i];
    const last = i === frames.length - 1;
    if (last) {
      before = frames[i];
      result = runPipeline(stacked, req.pipeline, { ...base, frameIndex: idx, states });
    } else if (moshOn && idx >= k - hist.mosh) {
      runPipeline(stacked, req.pipeline, { ...base, frameIndex: idx, t: plan.frames > 1 ? idx / (plan.frames - 1) : 0, states, stopAfter: 'datamosh' });
    }
  }
  const res = result!;
  return {
    before: imgToBitmap(before),
    after: imgToBitmap(res.img),
    outWidth: Math.round(res.img.width / scale),
    outHeight: Math.round(res.img.height / scale),
    notes: [...plan.warnings, ...res.side.notes],
    ms: performance.now() - t0,
    frameIndex: k,
    frames: plan.frames,
  };
}

// ---------------------------------------------------------------- exports
/** A fresh engine with the video mounted (no copy) and probed. */
async function openForExport(file: Blob): Promise<{ ff: FFInstance; path: string; meta: VideoMeta }> {
  const ff = await FFInstance.create();
  const path = ff.mount('export', file, extOf(file));
  return { ff, path, meta: probeVideo(ff, path) };
}

/** Full-resolution source for a still export (image, or one video frame / still stack). */
async function fullResSource(file: Blob, kind: FileKind, video: VideoSettings, time: number, onProgress?: (p: Progress) => void): Promise<{ img: Img; isVideo: boolean; note?: string }> {
  if (kind === 'image') {
    const d = await decodeImageFile(file);
    return { img: d.img, isVideo: false, note: d.note };
  }
  const v = normalizeVideo(video);
  return withFreshEngines(async () => {
    const { ff, path, meta } = await openForExport(file);
    const plan = planVideo(meta, v);
    if (v.stackOn && v.stackOutput === 'still') {
      const img = stillStack(ff, path, plan, v, plan.width, plan.height, plan.frames, (d, n) => onProgress?.({ done: d, total: n, label: `stacking frame ${d}/${n}` }));
      if (!img) throw new Error('Could not decode this video.');
      return { img, isVideo: true };
    }
    const k = Math.max(0, Math.round(((time - plan.start) / v.speed) * plan.outFps));
    const [img] = decodeFrames(ff, path, { start: frameTime(plan, v, Math.min(k, plan.frames - 1)), count: 1, fps: plan.outFps, speed: v.speed, width: plan.width, height: plan.height });
    if (!img) throw new Error('Could not decode this frame.');
    return { img, isVideo: true };
  });
}

async function exportImage(req: Extract<Request, { type: 'exportImage' }>, id: number): Promise<ExportResult> {
  const { img, note } = await fullResSource(req.file, req.kind, req.video, req.time, (p) => post({ id, kind: 'progress', progress: p }));
  post({ id, kind: 'progress', progress: { done: 0, total: 1, label: 'rendering' } });
  // a still exported from a video is rendered as a still (temporal effects are no-ops)
  const res = runPipeline(img, req.pipeline, { glyphs, scale: 1, isVideo: false });
  if (note) res.side.notes.unshift(note);
  const fmt = req.options.imageFormat;
  if (fmt === 'jpeg-raw') {
    if (!res.side.jpegBytes) throw new Error('Enable the JPEG Databend effect to export the raw glitched JPEG.');
    const bytes = res.side.jpegBytes;
    return { blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/jpeg' }), ext: 'jpg', notes: res.side.notes };
  }
  const blob = await encodeImage(res.img, fmt as ImageFormat, req.options.quality);
  return { blob, ext: fmt === 'jpeg' ? 'jpg' : fmt, notes: res.side.notes };
}

async function exportText(req: Extract<Request, { type: 'exportText' }>): Promise<ExportResult> {
  const { img } = await fullResSource(req.file, req.kind, req.video, req.time);
  const res = runPipeline(img, req.pipeline, { glyphs, scale: 1 });
  if (res.side.asciiText === undefined) throw new Error('Enable the ASCII effect to export text.');
  return { blob: new Blob([res.side.asciiText + '\n'], { type: 'text/plain' }), ext: 'txt', notes: [] };
}

/**
 * Video export, streaming: one ffmpeg instance decodes the whole range in a
 * single sequential pass and hands every frame to the effect pipeline as it
 * is produced; processed frames are batched (~1 s, ≤ 96 MB as YUV) and
 * encoded by a second instance into segments; a third joins them. Memory
 * stays bounded and time is linear in clip length, whatever the source's
 * keyframe interval.
 */
async function exportVideo(file: Blob, pipeline: Pipeline, video: VideoSettings, options: ExportOptions, onProgress: (p: Progress) => void): Promise<ExportResult> {
  const v = normalizeVideo(video);
  const format = options.videoFormat;
  return withFreshEngines(async () => {
    const { ff: dec, path, meta } = await openForExport(file);
    const enc = await FFInstance.create();
    const plan = planVideo(meta, v, format === 'gif' ? options.gifFps : undefined);
    let w = plan.width, h = plan.height;
    if (format === 'gif' && options.gifWidth > 0 && options.gifWidth < w) {
      // process straight at GIF size: faster and pixel params scale along
      h = even((h * options.gifWidth) / w);
      w = even(options.gifWidth);
    }
    const scale = w / meta.width;
    const states: RunOptions['states'] = {};
    const rolling = v.stackOn ? new RollingStack(v.stackMode, v.stackWindow) : null;
    const notes = new Set<string>(plan.warnings);
    const total = plan.frames;
    let encoder: SegmentEncoder | null = null;
    let last: Img | null = null;
    let lastPost = 0;
    const t0 = performance.now();
    const eta = (done: number): string => (done > 0 ? ` · ETA ${Math.max(0, Math.round(((performance.now() - t0) / done) * (total - done) / 1000))}s` : '');

    const handle = (frame: Img, k: number): void => {
      if (k >= total) return;
      last = frame;
      const stacked = rolling ? rolling.push(frame) : frame;
      const res = runPipeline(stacked, pipeline, { glyphs, scale, isVideo: true, frameIndex: k, t: total > 1 ? k / (total - 1) : 0, states });
      res.side.notes.forEach((n) => notes.add(n));
      let out = res.img;
      if (!encoder) {
        const e = evenize(out);
        encoder = new SegmentEncoder(enc, e.width, e.height, plan.outFps, format, options.videoQuality ?? 0.75);
      }
      const ew = encoder.width, eh = encoder.height;
      out = out.width === ew && out.height === eh ? out : evenize(resizeNearest(out, ew, eh));
      const done = k + 1;
      encoder.add(out, () => onProgress({ done, total, label: `encoding frames ${done - encoder!.batchFrames + 1}–${done}${eta(done)}` }));
      const now = performance.now();
      if (now - lastPost > 150 || done === total) {
        lastPost = now;
        onProgress({ done, total, label: `frame ${done}/${total}${eta(done)}` });
      }
    };

    onProgress({ done: 0, total, label: 'decoding' });
    const got = streamFrames(dec, path, { start: plan.start, duration: plan.end - plan.start, count: total, fps: plan.outFps, speed: v.speed, width: w, height: h }, handle);
    // the decoder can come up a frame or two short at the very end: repeat the last frame
    for (let k = got; k < total && last; k++) handle(last, k);
    const finalEncoder = encoder as SegmentEncoder | null;
    if (!finalEncoder) throw new Error('Could not decode any frames from this video.');
    onProgress({ done: total, total, label: 'encoding the last frames' });
    finalEncoder.flush();
    onProgress({ done: total, total, label: format === 'gif' ? 'building the GIF palette' : 'joining segments' });
    const data = finishVideo(await FFInstance.create(), finalEncoder.segments, format, plan.outFps);
    const type = format === 'gif' ? 'image/gif' : format === 'webm' ? 'video/webm' : 'video/mp4';
    return { blob: new Blob([data.slice().buffer as ArrayBuffer], { type }), ext: format, notes: [...notes], frames: total };
  }, () => onProgress({ done: 0, total: 1, label: 'the video engine crashed, retrying with a fresh one' }));
}

async function exportBatch(req: Extract<Request, { type: 'exportBatch' }>, id: number): Promise<ExportResult> {
  const entries: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const notes: string[] = [];
  let i = 0;
  for (const item of req.items) {
    const progress = (p: Progress): void => post({ id, kind: 'progress', progress: { done: i + (p.total ? p.done / p.total : 0), total: req.items.length, label: `${item.name}: ${p.label}` } });
    progress({ done: 0, total: 1, label: 'starting' });
    let res: ExportResult;
    if (item.kind === 'video') {
      res = await exportVideo(item.file, req.pipeline, req.video, req.options, progress);
    } else {
      res = await exportImage({ type: 'exportImage', file: item.file, kind: 'image', pipeline: req.pipeline, video: req.video, time: 0, options: req.options }, -1);
    }
    let name = outputName(item.name, req.presetName, req.pipeline.seed, res.ext);
    for (let n = 2; used.has(name); n++) name = name.replace(/(\.\w+)$/, `-${n}$1`);
    used.add(name);
    entries[name] = new Uint8Array(await res.blob.arrayBuffer());
    notes.push(...res.notes.map((x) => `${item.name}: ${x}`));
    i++;
  }
  post({ id, kind: 'progress', progress: { done: req.items.length, total: req.items.length, label: 'zipping' } });
  const zip = zipSync(entries, { level: 0 });
  return { blob: new Blob([zip.slice().buffer as ArrayBuffer], { type: 'application/zip' }), ext: 'zip', notes };
}

// ---------------------------------------------------------------- dispatch
let latestPreview: { id: number; req: Extract<Request, { type: 'preview' }> } | null = null;
let previewBusy = false;

async function pumpPreviews(): Promise<void> {
  if (previewBusy) return;
  previewBusy = true;
  try {
    while (latestPreview) {
      const job = latestPreview;
      latestPreview = null;
      try {
        const r = await handlePreview(job.req);
        post({ id: job.id, kind: 'result', result: r }, [r.before, r.after]);
      } catch (e) {
        post({ id: job.id, kind: 'error', error: errMsg(e) });
      }
    }
  } finally {
    previewBusy = false;
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

self.onmessage = async (ev: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = ev.data;
  if (req.type === 'preview') {
    if (latestPreview) post({ id: latestPreview.id, kind: 'superseded' });
    latestPreview = { id, req };
    // yield so that a burst of messages collapses into the newest one
    setTimeout(() => void pumpPreviews(), 0);
    return;
  }
  try {
    let result: unknown;
    switch (req.type) {
      case 'open': {
        const r = await handleOpen(req.fileId, req.file, req.kind);
        post({ id, kind: 'result', result: r }, [r.thumb]);
        return;
      }
      case 'close': {
        engine.unmount(req.fileId);
        files.delete(req.fileId);
        if (frameCache?.key.includes(req.fileId)) frameCache = null;
        result = true;
        break;
      }
      case 'exportImage':
        result = await exportImage(req, id);
        break;
      case 'exportText':
        result = await exportText(req);
        break;
      case 'exportVideo':
        result = await exportVideo(req.file, req.pipeline, req.video, req.options, (p) => post({ id, kind: 'progress', progress: p }));
        break;
      case 'exportBatch':
        result = await exportBatch(req, id);
        break;
    }
    post({ id, kind: 'result', result });
  } catch (e) {
    post({ id, kind: 'error', error: errMsg(e) });
  }
};
