import { useState, type ReactNode } from 'react';
import { MAX_STACK_WINDOW, type VideoSettings } from '../core/video';
import type { FileMeta } from '../worker/protocol';
import { Segmented, Slider, Switch } from './Controls';
import { Icon } from './Icons';

interface Props {
  video: VideoSettings;
  meta: FileMeta;
  onChange: (v: VideoSettings) => void;
}

const secs = (v: number): string => `${v.toFixed(2)}s`;

export function VideoPanel({ video, meta, onChange }: Props): ReactNode {
  const [open, setOpen] = useState(true);
  const set = (patch: Partial<VideoSettings>): void => onChange({ ...video, ...patch });
  const dur = meta.duration ?? 0;
  const end = video.trimEnd > 0 ? video.trimEnd : dur;
  return (
    <section className={'card enabled video-card' + (open ? ' open' : '')} data-effect="video">
      <div className="card-head" onClick={() => setOpen(!open)}>
        <span className="fx-icon"><Icon name="film" size={17} /></span>
        <span className="title" role="button" aria-expanded={open}>
          <span className="name">Video</span>
          <span className="summary">
            {meta.width}×{meta.height} · {dur.toFixed(1)}s · {meta.fps?.toFixed(0)} fps
            {video.stackOn ? ` · ${video.stackMode} stack` : ''}
          </span>
        </span>
        <span className="chev"><Icon name="chevron" size={14} /></span>
      </div>
      {open && (
        <div className="card-body">
          <div className="subhead">Timing</div>
          <Slider id="v-trim-start" label="Trim start" value={video.trimStart} min={0} max={dur} step={0.01} format={secs}
            onChange={(v) => set({ trimStart: Math.min(v, end - 0.05) })} />
          <Slider id="v-trim-end" label="Trim end" value={end} min={0} max={dur} step={0.01} format={secs}
            onChange={(v) => set({ trimEnd: v >= dur - 0.005 ? 0 : Math.max(v, video.trimStart + 0.05) })} />
          <Slider id="v-speed" label="Speed" value={video.speed} min={0.25} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => set({ speed: v })} />
          <div className="param">
            <div className="param-label">Output frame rate</div>
            <div className="row-gap">
              <Segmented ariaLabel="Output fps" testIdPrefix="v-fps" size="sm" value={video.fpsMode}
                options={[{ value: 'original', label: 'Original' }, { value: 'half', label: 'Half' }, { value: 'custom', label: 'Custom' }]}
                onChange={(v) => set({ fpsMode: v })} />
              {video.fpsMode === 'custom' && (
                <span className="num-input">
                  <input type="number" aria-label="Custom fps" min={1} max={60} step={1} value={video.customFps} onChange={(e) => set({ customFps: parseFloat(e.target.value) || 1 })} />
                  <span>fps</span>
                </span>
              )}
            </div>
          </div>

          <div className="subhead with-switch">
            <span>Long exposure</span>
            <Switch ariaLabel="Frame stacking" dataParam="stackOn" checked={video.stackOn} onChange={(v) => set({ stackOn: v })} />
          </div>
          {video.stackOn ? (
            <>
              <div className="param">
                <div className="param-label">Blend</div>
                <Segmented ariaLabel="Stack mode" testIdPrefix="v-stack-mode" size="sm" value={video.stackMode}
                  options={[{ value: 'average', label: 'Average' }, { value: 'lighten', label: 'Lighten' }, { value: 'darken', label: 'Darken' }]}
                  onChange={(v) => set({ stackMode: v })} />
              </div>
              <div className="param">
                <div className="param-label">Output</div>
                <Segmented ariaLabel="Stack output" testIdPrefix="v-stack-out" size="sm" value={video.stackOutput}
                  options={[{ value: 'rolling', label: 'Rolling' }, { value: 'still', label: 'Single still' }]}
                  onChange={(v) => set({ stackOutput: v })} />
              </div>
              {video.stackOutput === 'rolling' && (
                <Slider id="v-stack-window" label="Window" value={video.stackWindow} min={1} max={MAX_STACK_WINDOW} step={1} format={(v) => `${v} frames`}
                  onChange={(v) => set({ stackWindow: Math.round(v) })} />
              )}
            </>
          ) : (
            <p className="desc">Combine frames into light trails, motion blur or a single long-exposure still.</p>
          )}

          <div className="subhead">Limits</div>
          <Switch label="Lift 1080p / 60 s caps" checked={video.liftLimits} onChange={(v) => set({ liftLimits: v })} />
          <p className="hint"><Icon name="diamond" size={10} /> Use the diamond next to any slider to animate it from clip start to clip end.</p>
        </div>
      )}
    </section>
  );
}
