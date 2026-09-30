import type { ReactNode } from 'react';
import { MAX_STACK_WINDOW, type VideoSettings } from '../core/video';
import type { FileMeta } from '../worker/protocol';

interface Props {
  video: VideoSettings;
  meta: FileMeta;
  onChange: (v: VideoSettings) => void;
}

export function VideoPanel({ video, meta, onChange }: Props): ReactNode {
  const set = (patch: Partial<VideoSettings>): void => onChange({ ...video, ...patch });
  const dur = meta.duration ?? 0;
  const end = video.trimEnd > 0 ? video.trimEnd : dur;
  return (
    <section className="section enabled" data-effect="video">
      <div className="section-head"><span className="title">▾ Video</span></div>
      <div className="section-body">
        <div className="desc">
          {meta.width}×{meta.height} · {dur.toFixed(2)} s · {meta.fps?.toFixed(2)} fps
        </div>
        <div className="subhead">Trim &amp; timing</div>
        <div className="ctl">
          <label htmlFor="v-trim-start">Start</label>
          <input id="v-trim-start" type="range" min={0} max={dur} step={0.01} value={video.trimStart} onChange={(e) => set({ trimStart: Math.min(parseFloat(e.target.value), end - 0.05) })} />
          <span className="val">{video.trimStart.toFixed(2)}s</span><span />
        </div>
        <div className="ctl">
          <label htmlFor="v-trim-end">End</label>
          <input id="v-trim-end" type="range" min={0} max={dur} step={0.01} value={end} onChange={(e) => {
            const v = parseFloat(e.target.value);
            set({ trimEnd: v >= dur - 0.005 ? 0 : Math.max(v, video.trimStart + 0.05) });
          }} />
          <span className="val">{end.toFixed(2)}s</span><span />
        </div>
        <div className="ctl wide">
          <label htmlFor="v-fps">Output fps</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <select id="v-fps" value={video.fpsMode} onChange={(e) => set({ fpsMode: e.target.value as VideoSettings['fpsMode'] })}>
              <option value="original">original</option>
              <option value="half">half</option>
              <option value="custom">custom</option>
            </select>
            {video.fpsMode === 'custom' && (
              <input type="number" aria-label="Custom fps" min={1} max={60} step={1} value={video.customFps} style={{ width: 60 }} onChange={(e) => set({ customFps: parseFloat(e.target.value) || 1 })} />
            )}
          </div>
        </div>
        <div className="ctl">
          <label htmlFor="v-speed">Speed</label>
          <input id="v-speed" type="range" min={0.25} max={4} step={0.05} value={video.speed} onChange={(e) => set({ speed: parseFloat(e.target.value) })} />
          <span className="val">{video.speed.toFixed(2)}×</span><span />
        </div>
        <div className="subhead">Long exposure / stacking</div>
        <div className="checkrow">
          <label><input type="checkbox" data-param="stackOn" checked={video.stackOn} onChange={(e) => set({ stackOn: e.target.checked })} /> Frame stacking</label>
        </div>
        {video.stackOn && (
          <>
            <div className="ctl wide">
              <label htmlFor="v-stack-mode">Mode</label>
              <select id="v-stack-mode" value={video.stackMode} onChange={(e) => set({ stackMode: e.target.value as VideoSettings['stackMode'] })}>
                <option value="average">average</option>
                <option value="lighten">lighten (light trails)</option>
                <option value="darken">darken</option>
              </select>
            </div>
            <div className="ctl wide">
              <label htmlFor="v-stack-out">Output</label>
              <select id="v-stack-out" value={video.stackOutput} onChange={(e) => set({ stackOutput: e.target.value as VideoSettings['stackOutput'] })}>
                <option value="rolling">rolling-window video</option>
                <option value="still">single still (whole clip)</option>
              </select>
            </div>
            {video.stackOutput === 'rolling' && (
              <div className="ctl">
                <label htmlFor="v-stack-window">Window</label>
                <input id="v-stack-window" type="range" min={1} max={MAX_STACK_WINDOW} step={1} value={video.stackWindow} onChange={(e) => set({ stackWindow: parseInt(e.target.value, 10) })} />
                <span className="val">{video.stackWindow}</span><span />
              </div>
            )}
          </>
        )}
        <div className="subhead">Limits</div>
        <div className="checkrow">
          <label title="By default clips are capped at 1080p and 60 s to keep memory bounded">
            <input type="checkbox" checked={video.liftLimits} onChange={(e) => set({ liftLimits: e.target.checked })} /> Lift 1080p / 60 s caps
          </label>
        </div>
        <div className="hint">Tip: the ◆ button next to any slider animates it from its value (clip start) to an end value (clip end).</div>
      </div>
    </section>
  );
}
