import { useState, type ReactNode } from 'react';
import type { EffectInstance, Pipeline } from '../core/pipeline';
import { EFFECTS } from '../effects';
import type { EffectType, ParamValue, Params } from '../effects/types';
import { ParamControl, Switch, useDragReorder } from './Controls';
import { Icon } from './Icons';

interface Props {
  pipeline: Pipeline;
  isVideo: boolean;
  onChange: (p: Pipeline) => void;
  cropEditing: boolean;
  onCropEdit: (on: boolean) => void;
}

const pct = (v: ParamValue): string => `${Math.round(Number(v) * 100)}%`;

/** One-line summary of an effect's current settings, shown on collapsed cards. */
function summarize(type: EffectType, p: Params): string {
  switch (type) {
    case 'databend': {
      const parts = (['dqt', 'dht', 'scan', 'chroma', 'zigzag'] as const).filter((k) => p[k + 'On']).map((k) => (k === 'dqt' || k === 'dht' ? k.toUpperCase() : k));
      return `Quality ${p.quality} · ${parts.length ? parts.join(', ') : 'no corruption'}`;
    }
    case 'palette':
      return `${p.preset} · ${p.tones} tones${p.dither !== 'none' ? ` · ${p.dither === 'bayer' ? 'Bayer' : 'Floyd–Steinberg'}` : ''}`;
    case 'eightbit':
      return `${p.block}px blocks · ${p.palette === 'median' ? `${p.colors} colours` : String(p.palette).toUpperCase()}`;
    case 'pixelsort':
      return `${p.direction === 'v' ? 'Vertical' : 'Horizontal'} · ${p.key} ${pct(p.low)}–${pct(p.high)}`;
    case 'ascii':
      return `${p.charset} · ${p.cell}px · ${p.colorMode}`;
    case 'colour': {
      const looks = ['grayscale', 'sepia', 'noir', 'invert'].filter((k) => p[k]);
      const adj = [p.exposure ? `${Number(p.exposure) > 0 ? '+' : ''}${p.exposure} EV` : '', p.contrast ? `contrast ${pct(p.contrast)}` : '', p.hue ? `hue ${p.hue}°` : ''].filter(Boolean);
      return [...adj, ...looks].join(' · ') || 'Neutral';
    }
    case 'geometry': {
      const bits = [p.aspect !== 'original' ? `crop ${p.aspect}` : '', p.rotate !== '0' ? `${p.rotate}°` : '', p.flipH ? 'flip H' : '', p.flipV ? 'flip V' : '', p.scale !== '1' ? `×${p.scale}` : ''].filter(Boolean);
      return bits.join(' · ') || 'Original';
    }
    case 'datamosh':
      return `keyframe every ${p.hold} · strength ${p.strength}`;
  }
}

export function EffectPanel({ pipeline, isVideo, onChange, cropEditing, onCropEdit }: Props): ReactNode {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const update = (i: number, fn: (e: EffectInstance) => EffectInstance): void => {
    const effects = pipeline.effects.slice();
    effects[i] = fn(effects[i]);
    onChange({ ...pipeline, effects });
  };
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= pipeline.effects.length) return;
    const effects = pipeline.effects.slice();
    const [e] = effects.splice(from, 1);
    effects.splice(to, 0, e);
    onChange({ ...pipeline, effects });
  };
  const drag = useDragReorder(move);
  const enabled = pipeline.effects.filter((e) => e.enabled && (isVideo || !EFFECTS[e.type].videoOnly)).length;

  return (
    <div className="effects" aria-label="Effect pipeline">
      <div className="group-title">
        <span>Pipeline</span>
        <span className="count">{enabled} active · top to bottom</span>
      </div>
      {pipeline.effects.map((inst, i) => {
        const def = EFFECTS[inst.type];
        const isOpen = !!open[inst.type];
        const unavailable = def.videoOnly && !isVideo;
        const animated = Object.keys(inst.anim).length;
        return (
          <section
            key={inst.type}
            className={['card', inst.enabled ? 'enabled' : '', isOpen ? 'open' : '', unavailable ? 'unavailable' : '', drag.over === i ? 'dragover' : ''].join(' ')}
            data-effect={inst.type}
            {...drag.props(i)}
          >
            <div className="card-head" onClick={() => setOpen({ ...open, [inst.type]: !isOpen })}>
              <span className="grip" title="Drag to reorder" {...drag.gripProps(i)} onClick={(e) => e.stopPropagation()}>
                <Icon name="grip" size={14} />
              </span>
              <span className="fx-icon"><Icon name={inst.type} size={17} /></span>
              <span className="title" role="button" aria-expanded={isOpen}>
                <span className="name">{def.label}</span>
                <span className="summary">
                  {unavailable ? 'Video only' : summarize(inst.type, inst.params)}
                  {animated ? <span className="anim-badge" title="Animated parameters"><Icon name="diamond" size={9} /> {animated}</span> : null}
                </span>
              </span>
              <span className="reorder" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="icon-btn tiny" aria-label={`Move ${def.label} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="up" size={13} /></button>
                <button type="button" className="icon-btn tiny" aria-label={`Move ${def.label} down`} disabled={i === pipeline.effects.length - 1} onClick={() => move(i, i + 1)}><Icon name="down" size={13} /></button>
              </span>
              <Switch ariaLabel={`Enable ${def.label}`} dataEnable={inst.type} checked={inst.enabled} onChange={(v) => update(i, (x) => ({ ...x, enabled: v }))} />
              <span className="chev"><Icon name="chevron" size={14} /></span>
            </div>
            {isOpen && (
              <div className="card-body">
                <p className="desc">{def.description}</p>
                {inst.type === 'geometry' && inst.params.aspect !== 'original' && (
                  <button type="button" className={'btn btn-outline' + (cropEditing ? ' on' : '')} onClick={() => onCropEdit(!cropEditing)}>
                    <Icon name={cropEditing ? 'check' : 'crop'} size={14} />
                    {cropEditing ? 'Done editing crop' : 'Edit crop box on preview'}
                  </button>
                )}
                {def.params
                  .filter((s) => !s.visibleIf || s.visibleIf(inst.params))
                  .map((spec) => (
                    <ParamControl
                      key={spec.key}
                      idPrefix={inst.type}
                      spec={spec}
                      value={inst.params[spec.key]}
                      params={inst.params}
                      onChange={(v: ParamValue) => update(i, (x) => ({ ...x, params: { ...x.params, [spec.key]: v } }))}
                      animatable={isVideo && spec.kind === 'range'}
                      animTo={inst.anim[spec.key]}
                      onAnim={(to) =>
                        update(i, (x) => {
                          const anim = { ...x.anim };
                          if (to === undefined) delete anim[spec.key];
                          else anim[spec.key] = to;
                          return { ...x, anim };
                        })
                      }
                    />
                  ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
