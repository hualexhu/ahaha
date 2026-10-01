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
import { ACCEPT, FileStrip, classify, type LoadedFile } from './ui/FileStrip';
import { Segmented, Slider } from './ui/Controls';
import { Icon } from './ui/Icons';
import { browserGaps, SUPPORTED_BROWSERS } from './ui/support';

const GAPS = browserGaps();
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [presetMenu, setPresetMenu] = useState(false);
  const [dragging, setDragging] = useState(0);

  // toasts fade away on their own
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), message.kind === 'err' ? 12_000 : 8_000);
    return () => clearTimeout(t);
  }, [message]);

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
    setPresetMenu(false);
    setMessage({ text: `Saved preset “${name}”.` });
  };
  const deletePreset = (): void => {
    if (!presetName || BUILTIN_PRESETS.some((b) => b.name === presetName)) return;
    const next = userPresets.filter((p) => p.name !== presetName);
    setUserPresets(next);
    saveUserPresets(next);
    setMessage({ text: `Deleted preset “${presetName}”.` });
    setPresetMenu(false);
    setPresetName(null);
  };
  const exportPresets = (): void => {
    const list = userPresets.length ? userPresets : [{ name: presetName ?? 'custom', pipeline, video }];
    download(new Blob([exportPresetsJson(list)], { type: 'application/json' }), 'glitchlab-presets.json');
    setPresetMenu(false);
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
      if (e.key === 'Escape') { setPresetMenu(false); return; }
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

  const imgFormats: { value: ImageExportFormat; label: string; disabled?: boolean; title?: string }[] = [
    { value: 'png', label: 'PNG' },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP' },
    { value: 'jpeg-raw', label: 'Raw JPG', disabled: !hasEnabled(pipeline, 'databend'), title: 'The corrupted JPEG bytes exactly as produced by the databend stage' },
  ];
  const videoMain = stillOnly ? 'still' : videoTarget === 'video' ? opts.videoFormat : 'still';
  const stillFmt: StillFmt = videoTarget === 'video' ? 'png' : videoTarget;
  const exportLabel = !isVideo
    ? opts.imageFormat === 'jpeg-raw' ? 'raw JPEG' : opts.imageFormat === 'jpeg' ? 'JPEG' : opts.imageFormat === 'webp' ? 'WebP' : 'PNG'
    : videoMain === 'still'
      ? `${stillOnly ? 'still' : 'frame'} · ${stillFmt === 'jpeg' ? 'JPEG' : stillFmt === 'webp' ? 'WebP' : 'PNG'}`
      : opts.videoFormat.toUpperCase();
  const showQuality = (!isVideo && (opts.imageFormat === 'jpeg' || opts.imageFormat === 'webp')) || (isVideo && videoMain === 'still' && (stillFmt === 'jpeg' || stillFmt === 'webp'));
  const readyCount = files.filter((f) => f.meta).length;
  const fmtTime = (t: number): string => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;

  const emptyView = (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-mark" aria-hidden="true"><span /><span /><span /></div>
        <h1>Drop photos or videos</h1>
        <p>JPEG, PNG and WebP images. MP4, WebM and MOV clips.<br />Nothing is uploaded: every pixel is processed on this device.</p>
        {GAPS.blocking.length > 0 && (
          <div className="notice notice-err" data-testid="unsupported">
            <Icon name="warn" size={15} />
            <span>This browser is missing {GAPS.blocking.join(', ')}, which GlitchLab needs to process images. Please use {SUPPORTED_BROWSERS}.</span>
          </div>
        )}
        {GAPS.blocking.length === 0 && GAPS.video.length > 0 && (
          <div className="notice">
            <Icon name="warn" size={15} />
            <span>Video needs {GAPS.video.join(', ')}, which this browser doesn't provide. Photos work normally.</span>
          </div>
        )}
        <button type="button" className="btn btn-primary btn-lg" disabled={GAPS.blocking.length > 0} onClick={() => fileInputRef.current?.click()}>
          <Icon name="upload" size={16} /> Choose files
        </button>
        <div className="shortcuts">
          <span><kbd>Space</kbd> before / after</span>
          <span><kbd>R</kbd> new seed</span>
          <span><kbd>⌘</kbd><kbd>E</kbd> export</span>
        </div>
      </div>
    </div>
  );

  const stageOverlay = active ? (
    <>
      <div className="chips">
        {active && preview && (
          <div className="chip" data-testid="status">
            <span className="chip-strong">{active.name}</span>
            <span className="mono">{active.meta?.width}×{active.meta?.height}{preview.outWidth !== active.meta?.width || preview.outHeight !== active.meta?.height ? ` → ${preview.outWidth}×${preview.outHeight}` : ''}</span>
            <span className="mono dim">{Math.round(preview.ms)} ms</span>
          </div>
        )}
        {preview?.notes.length ? <div className="chip chip-warn"><Icon name="warn" size={12} /> {[...new Set(preview.notes)].join(' · ')}</div> : null}
        {previewError && <div className="chip chip-err"><Icon name="warn" size={12} /> {previewError}</div>}
      </div>
      <div className={'render-state' + (previewBusy ? ' on' : '')} aria-live="polite">
        <span className="spinner" /> Rendering
      </div>
      {cropEditing && <div className="crop-hint">Drag the box to move it · drag the corner to resize</div>}
      <div className="toolbar" role="toolbar" aria-label="View">
        <button type="button" className={'tool' + (split > 0 ? ' on' : '')} aria-pressed={split > 0} aria-label="Split view" title="Before / after split" onClick={() => setSplit(split > 0 ? 0 : 0.5)}>
          <Icon name="split" size={16} /><span>Compare</span>
        </button>
        <button type="button" className={'tool' + (showBefore ? ' on' : '')} aria-pressed={showBefore} aria-label="Show original" title="Show original (Space)" onClick={() => setShowBefore(!showBefore)}>
          <Icon name="eye" size={16} /><span>Original</span>
        </button>
        <span className="tool-sep" />
        <button type="button" className="tool" aria-label="Reroll seed (toolbar)" title="New seed (R)" onClick={reroll}>
          <Icon name="dice" size={16} /><span>Reroll</span>
        </button>
      </div>
      {job && (
        <div className="progress-card" data-testid="progress" role="status">
          <div className="progress-top">
            <span className="progress-label">{job.label}</span>
            <span className="mono dim">{Math.round(pct)}%</span>
          </div>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
          <div className="progress-bottom">
            <span className="dim">{job.progress?.label ?? 'Starting…'}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelExport} data-testid="cancel-export">Cancel</button>
          </div>
        </div>
      )}
    </>
  ) : null;

  return (
    <div
      className={'app' + (dragging > 0 ? ' dragging' : '')}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) setDragging((d) => d + 1); }}
      onDragLeave={(e) => { if (e.dataTransfer.types.includes('Files')) setDragging((d) => Math.max(0, d - 1)); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(0);
        if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        data-testid="file-input"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
      />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-name">GlitchLab</span>
        </div>
        <div className="preset-picker">
          <label htmlFor="preset" className="eyebrow">Preset</label>
          <select id="preset" aria-label="Preset" data-testid="preset-select" value={presetName ?? ''} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">Custom</option>
            <optgroup label="Built-in">
              {BUILTIN_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </optgroup>
            {userPresets.length > 0 && (
              <optgroup label="Saved">
                {userPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </optgroup>
            )}
          </select>
          <div className="popover-anchor">
            <button type="button" className={'icon-btn' + (presetMenu ? ' on' : '')} aria-label="Preset options" aria-expanded={presetMenu} onClick={() => setPresetMenu(!presetMenu)}>
              <Icon name="more" size={16} />
            </button>
            {presetMenu && (
              <>
                <div className="popover-backdrop" onClick={() => setPresetMenu(false)} />
                <div className="popover" role="dialog" aria-label="Preset options">
                  <div className="popover-title">Save current settings</div>
                  <div className="row-gap">
                    <input type="text" className="text-input" placeholder="Preset name" aria-label="New preset name" value={newPresetName}
                      onChange={(e) => setNewPresetName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && savePreset()} />
                    <button type="button" className="btn btn-primary btn-sm" onClick={savePreset} disabled={!newPresetName.trim()}>Save</button>
                  </div>
                  <div className="menu">
                    <button type="button" className="menu-item" onClick={deletePreset} disabled={!presetName || BUILTIN_PRESETS.some((b) => b.name === presetName)}>
                      <Icon name="trash" size={14} /> Delete
                      <span className="dim">{presetName && !BUILTIN_PRESETS.some((b) => b.name === presetName) ? presetName : 'saved presets only'}</span>
                    </button>
                    <button type="button" className="menu-item" onClick={() => { importRef.current?.click(); setPresetMenu(false); }}>
                      <Icon name="upload" size={14} /> Import JSON
                    </button>
                    <button type="button" className="menu-item" onClick={exportPresets}>
                      <Icon name="download" size={14} /> Export JSON
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <input ref={importRef} type="file" accept="application/json,.json" hidden data-testid="preset-import"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPresets(f); e.target.value = ''; }} />
        </div>
        <span className="spacer" />
        <div className="seed-pill" title="Same seed + same settings = identical output">
          <label htmlFor="seed" className="eyebrow">Seed</label>
          <input id="seed" type="number" className="mono" value={pipeline.seed} onChange={(e) => setPipeline({ ...pipeline, seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
          <button type="button" className="icon-btn" onClick={reroll} title="Reroll seed (R)" aria-label="Reroll seed"><Icon name="dice" size={16} /></button>
        </div>
      </header>

      <FileStrip files={files} activeId={activeId} onSelect={setActiveId} onPick={() => fileInputRef.current?.click()} onRemove={removeFile} />

      <main className="stage" data-testid="stage" data-renders={renders} data-busy={previewBusy ? 'true' : 'false'}>
        <Preview
          before={active ? preview?.before ?? null : null}
          after={active ? preview?.after ?? null : null}
          split={split}
          onSplit={setSplit}
          showBefore={showBefore}
          crop={cropProps}
          overlay={stageOverlay}
          empty={active ? <div className="empty"><div className="loading-state">{active.error ? <><Icon name="warn" size={18} /> {active.error}</> : <><span className="spinner" /> Decoding {active.name}…</>}</div></div> : emptyView}
        />
        {isVideo && active?.meta && plan && !stillOnly && (
          <div className="timeline">
            <span className="tl-icon"><Icon name="film" size={15} /></span>
            <input
              type="range"
              aria-label="Scrub video"
              data-testid="scrubber"
              min={plan.start}
              max={Math.max(plan.start, plan.end - 0.001)}
              step={0.01}
              value={Math.min(Math.max(time, plan.start), plan.end)}
              style={{ '--p': `${plan.end > plan.start ? ((Math.min(Math.max(time, plan.start), plan.end) - plan.start) / (plan.end - plan.start)) * 100 : 0}%` } as React.CSSProperties}
              onChange={(e) => setTime(parseFloat(e.target.value))}
            />
            <span className="timecode mono">{fmtTime(time)}</span>
            <span className="frame-count mono">frame {(preview?.frameIndex ?? 0) + 1}/{plan.frames}</span>
          </div>
        )}
        {message && (
          <div className={'toast ' + (message.kind ?? 'ok')} data-testid="message" role="status">
            <Icon name={message.kind ? 'warn' : 'check'} size={14} />
            <span>{message.text}</span>
            <button type="button" className="icon-btn tiny" aria-label="Dismiss" onClick={() => setMessage(null)}><Icon name="close" size={11} /></button>
          </div>
        )}
      </main>

      <aside className={'inspector panel' + (sheetOpen ? ' open' : '')} aria-label="Parameters">
        <button type="button" className="sheet-handle" onClick={() => setSheetOpen(!sheetOpen)}>
          <span className="sheet-grabber" />
          {sheetOpen ? 'Hide controls' : 'Edit & export'}
        </button>
        <div className="inspector-scroll">
          {isVideo && active?.meta && <VideoPanel video={video} meta={active.meta} onChange={setVideo} />}
          <EffectPanel pipeline={pipeline} isVideo={isVideo} onChange={setPipeline} cropEditing={cropEditing} onCropEdit={setCropEditing} />
          <p className="credit">
            Inspired by <a href="https://github.com/cebola4444/cybershot-cam" target="_blank" rel="noreferrer">CyberShot Cam</a>. Runs entirely in your browser.
          </p>
        </div>
        <div className="dock">
          <div className="dock-title">
            <span>Export</span>
            <span className="dim mono filename" title={active ? outputName(active.name, presetName, pipeline.seed, '…') : ''}>{active ? outputName(active.name, presetName, pipeline.seed, '…') : 'No file selected'}</span>
          </div>
          {!isVideo ? (
            <Segmented ariaLabel="Image format" testIdPrefix="fmt" value={opts.imageFormat} options={imgFormats} onChange={(v) => setOpts({ ...opts, imageFormat: v })} />
          ) : (
            <>
              <Segmented ariaLabel="Video format" testIdPrefix="fmt" value={videoMain}
                options={[
                  { value: 'mp4', label: 'MP4', disabled: stillOnly },
                  { value: 'webm', label: 'WebM', disabled: stillOnly },
                  { value: 'gif', label: 'GIF', disabled: stillOnly },
                  { value: 'still', label: stillOnly ? 'Still' : 'Frame' },
                ]}
                onChange={(v) => {
                  if (v === 'still') setVideoTarget(videoTarget === 'video' ? 'png' : videoTarget);
                  else { setVideoTarget('video'); setOpts({ ...opts, videoFormat: v as VideoExportFormat }); }
                }} />
              {videoMain === 'still' && (
                <Segmented ariaLabel="Still format" testIdPrefix="still" size="sm" value={stillFmt}
                  options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }]}
                  onChange={(v) => setVideoTarget(v)} />
              )}
              {videoMain === 'gif' && (
                <div className="row-gap">
                  <span className="num-input"><input id="gif-fps" type="number" aria-label="GIF fps" min={1} max={30} value={opts.gifFps} onChange={(e) => setOpts({ ...opts, gifFps: Math.max(1, Math.min(30, Number(e.target.value) || 10)) })} /><span>fps</span></span>
                  <span className="num-input"><input id="gif-width" type="number" aria-label="GIF width" min={64} max={1920} step={16} value={opts.gifWidth} onChange={(e) => setOpts({ ...opts, gifWidth: Math.max(64, Math.min(1920, Number(e.target.value) || 480)) })} /><span>px wide</span></span>
                </div>
              )}
            </>
          )}
          {showQuality && (
            <Slider id="quality" label="Quality" value={opts.quality} min={0.1} max={1} step={0.01} format={(v) => String(Math.round(v * 100))} onChange={(v) => setOpts({ ...opts, quality: v })} />
          )}
          <button type="button" className="btn btn-primary btn-block" data-testid="export" disabled={!active?.meta || !!job} onClick={exportCurrent}>
            <Icon name="download" size={16} /> Export {exportLabel}
            <span className="kbd-hint">⌘E</span>
          </button>
          <div className="dock-secondary">
            <button type="button" className="btn btn-ghost btn-sm" onClick={exportBatch} disabled={readyCount < 1 || !!job} data-testid="export-batch" title="Apply the pipeline to every loaded file and download a ZIP">
              <Icon name="archive" size={14} /> Batch ZIP ({readyCount})
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={exportText} disabled={!active?.meta || !hasEnabled(pipeline, 'ascii') || !!job} data-testid="export-txt" title="Export the ASCII effect as text">
              <Icon name="text" size={14} /> ASCII .txt
            </button>
          </div>
        </div>
      </aside>
      <div className="drop-overlay" aria-hidden="true"><div><Icon name="upload" size={28} /><span>Drop to add files</span></div></div>
    </div>
  );
}
