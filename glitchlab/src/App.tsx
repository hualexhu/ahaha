import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { outputName } from './core/filename';
import { hasEnabled, normalizePipeline, type Pipeline } from './core/pipeline';
import { BUILTIN_PRESETS, exportPresetsJson, loadUserPresets, parsePresets, saveUserPresets, type Preset } from './core/presets';
import { randomSeed } from './core/rng';
import { DEFAULT_VIDEO, normalizeVideo, planVideo, type VideoSettings } from './core/video';
import type { Params } from './effects/types';
import { CancelledError, SupersededError, WorkerClient } from './worker/client';
import type { ExportOptions, ExportResult, FileMeta, ImageExportFormat, PreviewResult, Progress, VideoExportFormat } from './worker/protocol';
import { EffectPanel } from './ui/EffectPanel';
import { FileStrip, classify, type LoadedFile } from './ui/FileStrip';
import { Preview } from './ui/Preview';
import { VideoPanel } from './ui/VideoPanel';

const previewWorker = new WorkerClient('glitchlab-preview');
const exportWorker = new WorkerClient('glitchlab-export');

let fileSeq = 0;

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const clonePipeline = (p: Pipeline): Pipeline => normalizePipeline(JSON.parse(JSON.stringify(p)) as Pipeline);

type StillFmt = Exclude<ImageExportFormat, 'jpeg-raw'>;

interface ExportJob {
  label: string;
  progress: Progress | null;
  started: number;
}

export default function App(): ReactNode {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pipeline, setPipelineRaw] = useState<Pipeline>(() => clonePipeline(BUILTIN_PRESETS[0].pipeline));
  const [presetName, setPresetName] = useState<string | null>(BUILTIN_PRESETS[0].name);
  const [video, setVideoRaw] = useState<VideoSettings>(DEFAULT_VIDEO);
  const [userPresets, setUserPresets] = useState<Preset[]>(() => loadUserPresets());
  const [time, setTime] = useState(0);
  const [split, setSplit] = useState(0);
  const [showBefore, setShowBefore] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [renders, setRenders] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [cropEditing, setCropEditing] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [message, setMessage] = useState<{ text: string; kind?: 'warn' | 'err' } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [opts, setOpts] = useState<ExportOptions>({ imageFormat: 'png', videoFormat: 'mp4', quality: 0.9, gifFps: 12, gifWidth: 480 });
  const [videoTarget, setVideoTarget] = useState<'video' | StillFmt>('video');
  const importRef = useRef<HTMLInputElement>(null);

  const active = files.find((f) => f.id === activeId) ?? null;
  const isVideo = active?.kind === 'video';
  const allPresets = useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets]);

  // any manual edit turns the pipeline into "custom"
  const setPipeline = useCallback((p: Pipeline) => {
    setPipelineRaw(p);
    setPresetName(null);
  }, []);
  const setVideo = useCallback((v: VideoSettings) => {
    setVideoRaw(v);
    setPresetName(null);
  }, []);

  // ------------------------------------------------------------ files
  const addFiles = useCallback((list: File[]) => {
    const skipped: string[] = [];
    const added: LoadedFile[] = [];
    for (const file of list) {
      const kind = classify(file);
      if (kind === 'heic') { skipped.push(`${file.name} (HEIC is not supported — convert to JPEG first)`); continue; }
      if (!kind) { skipped.push(`${file.name} (unsupported type)`); continue; }
      added.push({ id: `f${++fileSeq}`, name: file.name, file, kind });
    }
    if (skipped.length) setMessage({ text: 'Skipped: ' + skipped.join(', '), kind: 'warn' });
    if (!added.length) return;
    setFiles((fs) => [...fs, ...added]);
    setActiveId((cur) => cur ?? added[0].id);
    for (const f of added) {
      previewWorker
        .request<{ meta: FileMeta; thumb: ImageBitmap }>({ type: 'open', fileId: f.id, file: f.file, kind: f.kind })
        .then(({ meta, thumb }) => {
          setFiles((fs) => fs.map((x) => (x.id === f.id ? { ...x, meta, thumb } : x)));
          if (meta.warnings.length) setMessage({ text: meta.warnings.join(' '), kind: 'warn' });
        })
        .catch((e: Error) => {
          setFiles((fs) => fs.map((x) => (x.id === f.id ? { ...x, error: e.message } : x)));
          setMessage({ text: `${f.name}: ${e.message}`, kind: 'err' });
        });
    }
  }, []);

  const removeFile = (id: string): void => {
    void previewWorker.request({ type: 'close', fileId: id }).catch(() => undefined);
    setFiles((fs) => fs.filter((f) => f.id !== id));
    if (activeId === id) {
      const rest = files.filter((f) => f.id !== id);
      setActiveId(rest[0]?.id ?? null);
      setPreview(null);
    }
  };

  useEffect(() => {
    setTime(0);
    setCropEditing(false);
  }, [activeId]);

  // ------------------------------------------------------------ preview (debounced, latest wins)
  const ready = !!active?.meta;
  useEffect(() => {
    if (!active || !ready) return;
    const handle = setTimeout(() => {
      setPreviewBusy(true);
      previewWorker
        .request<PreviewResult>({ type: 'preview', fileId: active.id, pipeline, video, time, mode: cropEditing ? 'crop' : 'normal' })
        .then((r) => {
          setPreview(r);
          setRenders((n) => n + 1);
          setPreviewError(null);
          setPreviewBusy(false);
        })
        .catch((e: Error) => {
          if (e instanceof SupersededError) return;
          setPreviewError(e.message);
          setPreviewBusy(false);
        });
    }, 90);
    return () => clearTimeout(handle);
  }, [active, ready, pipeline, video, time, cropEditing]);

  // ------------------------------------------------------------ presets
  const applyPreset = (name: string): void => {
    const p = allPresets.find((x) => x.name === name);
    if (!p) return;
    setPipelineRaw(clonePipeline(p.pipeline));
    setVideoRaw((v) => normalizeVideo({ ...v, stackOn: false, ...(p.video ?? {}) }));
    setPresetName(p.name);
  };
  const savePreset = (): void => {
    const name = newPresetName.trim();
    if (!name) return;
    if (BUILTIN_PRESETS.some((b) => b.name === name)) {
      setMessage({ text: 'That name belongs to a built-in preset.', kind: 'warn' });
      return;
    }
    const next = [...userPresets.filter((p) => p.name !== name), { name, pipeline: clonePipeline(pipeline), video }];
    setUserPresets(next);
    saveUserPresets(next);
    setPresetName(name);
    setNewPresetName('');
    setMessage({ text: `Saved preset “${name}”.` });
  };
  const deletePreset = (): void => {
    if (!presetName || BUILTIN_PRESETS.some((b) => b.name === presetName)) return;
    const next = userPresets.filter((p) => p.name !== presetName);
    setUserPresets(next);
    saveUserPresets(next);
    setMessage({ text: `Deleted preset “${presetName}”.` });
    setPresetName(null);
  };
  const exportPresets = (): void => {
    const list = userPresets.length ? userPresets : [{ name: presetName ?? 'custom', pipeline, video }];
    download(new Blob([exportPresetsJson(list)], { type: 'application/json' }), 'glitchlab-presets.json');
  };
  const importPresets = async (file: File): Promise<void> => {
    try {
      const list = parsePresets(JSON.parse(await file.text()));
      if (!list.length) throw new Error('no presets found');
      const names = new Set(list.map((p) => p.name));
      const next = [...userPresets.filter((p) => !names.has(p.name)), ...list.filter((p) => !BUILTIN_PRESETS.some((b) => b.name === p.name))];
      setUserPresets(next);
      saveUserPresets(next);
      setMessage({ text: `Imported ${list.length} preset(s).` });
    } catch (e) {
      setMessage({ text: `Import failed: ${(e as Error).message}`, kind: 'err' });
    }
  };

  // ------------------------------------------------------------ export
  const runJob = async (label: string, fn: (onProgress: (p: Progress) => void) => Promise<ExportResult>, name: (ext: string) => string): Promise<void> => {
    setJob({ label, progress: null, started: performance.now() });
    try {
      const res = await fn((p) => setJob((j) => (j ? { ...j, progress: p } : j)));
      download(res.blob, name(res.ext));
      const size = res.blob.size > 1e6 ? `${(res.blob.size / 1e6).toFixed(1)} MB` : `${Math.ceil(res.blob.size / 1024)} KB`;
      const extra = res.notes.length ? ' · ' + [...new Set(res.notes)].slice(0, 3).join(' · ') : '';
      setMessage({ text: `Exported ${name(res.ext)} (${size})${extra}` });
    } catch (e) {
      if (e instanceof CancelledError) setMessage({ text: 'Export cancelled.', kind: 'warn' });
      else setMessage({ text: `Export failed: ${(e as Error).message}`, kind: 'err' });
    } finally {
      setJob(null);
    }
  };

  const stillOnly = isVideo && video.stackOn && video.stackOutput === 'still';
  const exportCurrent = (): void => {
    if (!active || job) return;
    const nameFor = (ext: string): string => outputName(active.name, presetName, pipeline.seed, ext);
    if (active.kind === 'image' || stillOnly || videoTarget !== 'video') {
      const fmt: ImageExportFormat = active.kind === 'image' ? opts.imageFormat : videoTarget === 'video' ? 'png' : videoTarget;
      void runJob('Rendering image', (onP) => exportWorker.request<ExportResult>({ type: 'exportImage', file: active.file, kind: active.kind, pipeline, video, time, options: { ...opts, imageFormat: fmt } }, onP), nameFor);
    } else {
      void runJob(`Encoding ${opts.videoFormat.toUpperCase()}`, (onP) => exportWorker.request<ExportResult>({ type: 'exportVideo', file: active.file, name: active.name, pipeline, video, options: opts }, onP), nameFor);
    }
  };
  const exportText = (): void => {
    if (!active || job) return;
    void runJob('Rendering ASCII text', () => exportWorker.request<ExportResult>({ type: 'exportText', file: active.file, kind: active.kind, pipeline, video, time }), (ext) => outputName(active.name, presetName, pipeline.seed, ext));
  };
  const exportBatch = (): void => {
    const ready = files.filter((f) => f.meta);
    if (!ready.length || job) return;
    void runJob(`Batch: ${ready.length} files`, (onP) => exportWorker.request<ExportResult>({
      type: 'exportBatch',
      items: ready.map((f) => ({ file: f.file, name: f.name, kind: f.kind })),
      pipeline, video, options: opts, presetName,
    }, onP), () => `glitchlab_batch_${presetName ? presetName.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'custom'}_${pipeline.seed}.zip`);
  };
  const cancelExport = (): void => exportWorker.cancelAll();

  const reroll = useCallback(() => {
    setPipelineRaw((p) => ({ ...p, seed: randomSeed() }));
  }, []);

  // ------------------------------------------------------------ keyboard
  const exportRef = useRef(exportCurrent);
  exportRef.current = exportCurrent;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      const typing = t instanceof HTMLInputElement ? !['range', 'checkbox', 'color', 'button'].includes(t.type) : t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        exportRef.current();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setShowBefore((s) => !s);
      } else if (e.key === 'r' || e.key === 'R') {
        reroll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reroll]);

  // ------------------------------------------------------------ crop editing
  const geomIndex = pipeline.effects.findIndex((e) => e.type === 'geometry');
  const geom = pipeline.effects[geomIndex];
  const cropProps = cropEditing && geom?.enabled && geom.params.aspect !== 'original'
    ? {
        params: geom.params,
        onChange: (patch: Partial<Params>) => {
          const effects = pipeline.effects.slice();
          effects[geomIndex] = { ...geom, params: { ...geom.params, ...(patch as Params) } };
          setPipeline({ ...pipeline, effects });
        },
      }
    : null;

  const plan = isVideo && active?.meta ? planVideo({ width: active.meta.width, height: active.meta.height, duration: active.meta.duration ?? 0, fps: active.meta.fps ?? 30 }, video) : null;
  const pct = job?.progress && job.progress.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : 0;

  const emptyView = (
    <div className="empty">
      <div style={{ fontSize: 28, color: 'var(--accent)', textShadow: '0 0 12px #33ff66' }}>▚▞ GLITCHLAB</div>
      <div>Drop images (JPEG · PNG · WebP) or videos (MP4 · WebM · MOV) anywhere,<br />or use the <b>⊕</b> box on the left. Files never leave your browser.</div>
      <div className="hint"><kbd>Space</kbd> before/after · <kbd>R</kbd> reroll seed · <kbd>Ctrl/⌘ E</kbd> export</div>
    </div>
  );

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="topbar">
        <span className="logo">▚ GLITCHLAB<small>photo &amp; video databender</small></span>
        <div className="presets">
          <select aria-label="Preset" data-testid="preset-select" value={presetName ?? ''} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">— custom —</option>
            <optgroup label="Built-in">
              {BUILTIN_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </optgroup>
            {userPresets.length > 0 && (
              <optgroup label="Saved">
                {userPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </optgroup>
            )}
          </select>
          <input type="text" placeholder="preset name" aria-label="New preset name" value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && savePreset()} />
          <button onClick={savePreset} disabled={!newPresetName.trim()}>Save</button>
          <button onClick={deletePreset} disabled={!presetName || BUILTIN_PRESETS.some((b) => b.name === presetName)}>Delete</button>
          <button onClick={exportPresets} title="Download presets as JSON">JSON ↓</button>
          <button onClick={() => importRef.current?.click()} title="Import presets from JSON">JSON ↑</button>
          <input ref={importRef} type="file" accept="application/json,.json" style={{ display: 'none' }} data-testid="preset-import"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPresets(f); e.target.value = ''; }} />
        </div>
        <span className="spacer" />
        <div className="seed">
          <label htmlFor="seed">seed</label>
          <input id="seed" type="number" value={pipeline.seed} onChange={(e) => setPipeline({ ...pipeline, seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
          <button onClick={reroll} title="Reroll seed (R)" aria-label="Reroll seed">⟳</button>
        </div>
        <button className={split > 0 ? 'on' : ''} onClick={() => setSplit(split > 0 ? 0 : 0.5)} title="Before/after split view">⇆ split</button>
        <button className={showBefore ? 'on' : ''} onClick={() => setShowBefore(!showBefore)} title="Show original (Space)">◐ before</button>
      </header>

      <FileStrip files={files} activeId={activeId} onSelect={setActiveId} onAdd={addFiles} onRemove={removeFile} />

      <main className="stage" data-testid="stage" data-renders={renders} data-busy={previewBusy ? 'true' : 'false'}>
        <Preview
          before={active ? preview?.before ?? null : null}
          after={active ? preview?.after ?? null : null}
          split={split}
          onSplit={setSplit}
          showBefore={showBefore}
          busy={previewBusy}
          crop={cropProps}
          empty={active ? <div className="empty">{active.error ? `⚠ ${active.error}` : 'decoding…'}</div> : emptyView}
        />
        {isVideo && active?.meta && plan && !stillOnly && (
          <div className="scrubber">
            <span>▶</span>
            <input
              type="range"
              aria-label="Scrub video"
              data-testid="scrubber"
              min={plan.start}
              max={Math.max(plan.start, plan.end - 0.001)}
              step={0.01}
              value={Math.min(Math.max(time, plan.start), plan.end)}
              onChange={(e) => setTime(parseFloat(e.target.value))}
            />
            <span>{time.toFixed(2)}s · frame {(preview?.frameIndex ?? 0) + 1}/{plan.frames}</span>
          </div>
        )}
        {job && (
          <div className="progress" data-testid="progress">
            <span>{job.label}</span>
            <div className="bar"><i style={{ width: `${pct}%` }} /></div>
            <span>{job.progress?.label ?? 'starting…'}</span>
            <button onClick={cancelExport} data-testid="cancel-export">✕ Cancel</button>
          </div>
        )}
        <div className="statusbar" data-testid="status">
          {active && preview && (
            <span>
              {active.meta?.width}×{active.meta?.height} → {preview.outWidth}×{preview.outHeight} · preview {preview.after.width}×{preview.after.height} in {Math.round(preview.ms)} ms
            </span>
          )}
          <span>preset: {presetName ?? 'custom'} · seed {pipeline.seed}</span>
          {preview?.notes.length ? <span className="warn">{[...new Set(preview.notes)].join(' · ')}</span> : null}
          {previewError && <span className="err">preview: {previewError}</span>}
          {message && <span className={message.kind ?? ''} data-testid="message">{message.text}</span>}
        </div>
      </main>

      <aside className={'panel' + (sheetOpen ? ' open' : '')} aria-label="Parameters">
        <button className="sheet-handle" onClick={() => setSheetOpen(!sheetOpen)}>{sheetOpen ? '▾ hide controls' : '▴ effects & export'}</button>
        <div className="export">
          <div className="row">
            <label>Export</label>
            {!isVideo ? (
              <select aria-label="Image format" data-testid="image-format" value={opts.imageFormat} onChange={(e) => setOpts({ ...opts, imageFormat: e.target.value as ImageExportFormat })}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
                <option value="jpeg-raw" disabled={!hasEnabled(pipeline, 'databend')}>Glitched JPEG (raw bytes)</option>
              </select>
            ) : (
              <select aria-label="Video format" data-testid="video-format"
                value={stillOnly ? (videoTarget === 'video' ? 'png' : videoTarget) : videoTarget === 'video' ? opts.videoFormat : videoTarget}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'mp4' || v === 'webm' || v === 'gif') { setVideoTarget('video'); setOpts({ ...opts, videoFormat: v as VideoExportFormat }); }
                  else setVideoTarget(v as StillFmt);
                }}>
                {!stillOnly && <option value="mp4">MP4 (H.264)</option>}
                {!stillOnly && <option value="webm">WebM (VP8)</option>}
                {!stillOnly && <option value="gif">Animated GIF</option>}
                <option value="png">{stillOnly ? 'PNG still' : 'PNG (current frame)'}</option>
                <option value="jpeg">{stillOnly ? 'JPEG still' : 'JPEG (current frame)'}</option>
                <option value="webp">{stillOnly ? 'WebP still' : 'WebP (current frame)'}</option>
              </select>
            )}
            <button className="primary" data-testid="export" disabled={!active?.meta || !!job} onClick={exportCurrent} title="Ctrl/⌘+E">⤓ Export</button>
          </div>
          {((!isVideo && (opts.imageFormat === 'jpeg' || opts.imageFormat === 'webp')) || (isVideo && (videoTarget === 'jpeg' || videoTarget === 'webp'))) && (
            <div className="row">
              <label htmlFor="quality">Quality</label>
              <input id="quality" type="range" min={0.1} max={1} step={0.01} value={opts.quality} style={{ flex: 1 }} onChange={(e) => setOpts({ ...opts, quality: parseFloat(e.target.value) })} />
              <span>{Math.round(opts.quality * 100)}</span>
            </div>
          )}
          {isVideo && !stillOnly && videoTarget === 'video' && opts.videoFormat === 'gif' && (
            <div className="row">
              <label htmlFor="gif-fps">GIF fps</label>
              <input id="gif-fps" type="number" min={1} max={30} value={opts.gifFps} style={{ width: 56 }} onChange={(e) => setOpts({ ...opts, gifFps: Math.max(1, Math.min(30, Number(e.target.value) || 10)) })} />
              <label htmlFor="gif-width">width</label>
              <input id="gif-width" type="number" min={64} max={1920} step={16} value={opts.gifWidth} style={{ width: 70 }} onChange={(e) => setOpts({ ...opts, gifWidth: Math.max(64, Math.min(1920, Number(e.target.value) || 480)) })} />
            </div>
          )}
          <div className="row">
            <button onClick={exportBatch} disabled={files.filter((f) => f.meta).length < 1 || !!job} data-testid="export-batch" title="Apply the pipeline to every loaded file and download a ZIP">⤓ Batch ZIP ({files.filter((f) => f.meta).length})</button>
            <button onClick={exportText} disabled={!active?.meta || !hasEnabled(pipeline, 'ascii') || !!job} data-testid="export-txt">⤓ ASCII .txt</button>
          </div>
          <div className="hint">Name: {active ? outputName(active.name, presetName, pipeline.seed, '…') : '—'}</div>
        </div>
        {isVideo && active?.meta && <VideoPanel video={video} meta={active.meta} onChange={setVideo} />}
        <EffectPanel pipeline={pipeline} isVideo={isVideo} onChange={setPipeline} cropEditing={cropEditing} onCropEdit={setCropEditing} />
        <div className="hint" style={{ padding: 10 }}>
          Inspired by the <a href="https://github.com/cebola4444/cybershot-cam" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>CyberShot Cam</a> project. Everything runs locally in your browser.
        </div>
      </aside>
    </div>
  );
}
