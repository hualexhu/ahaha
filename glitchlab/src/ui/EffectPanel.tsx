import { useState, type ReactNode } from 'react';
import type { EffectInstance, Pipeline } from '../core/pipeline';
import { EFFECTS } from '../effects';
import type { ParamValue } from '../effects/types';
import { ParamControl, useDragReorder } from './Controls';

interface Props {
  pipeline: Pipeline;
  isVideo: boolean;
  onChange: (p: Pipeline) => void;
  cropEditing: boolean;
  onCropEdit: (on: boolean) => void;
}

export function EffectPanel({ pipeline, isVideo, onChange, cropEditing, onCropEdit }: Props): ReactNode {
  const [open, setOpen] = useState<Record<string, boolean>>({ databend: true });

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

  return (
    <div className="effects" aria-label="Effect pipeline">
      {pipeline.effects.map((inst, i) => {
        const def = EFFECTS[inst.type];
        const isOpen = !!open[inst.type];
        const disabledHere = def.videoOnly && !isVideo;
        return (
          <section
            key={inst.type}
            className={'section' + (inst.enabled ? ' enabled' : '') + (drag.over === i ? ' dragover' : '')}
            data-effect={inst.type}
            {...drag.props(i)}
          >
            <div className="section-head">
              <span className="grip" title="Drag to reorder" {...drag.gripProps(i)}>⋮⋮</span>
              <input
                type="checkbox"
                aria-label={`Enable ${def.label}`}
                data-enable={inst.type}
                checked={inst.enabled}
                onChange={(e) => update(i, (x) => ({ ...x, enabled: e.target.checked }))}
              />
              <span className="title" onClick={() => setOpen({ ...open, [inst.type]: !isOpen })} role="button" aria-expanded={isOpen}>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
                {i + 1}. {def.label}
                {disabledHere ? <span className="hint"> (video only)</span> : null}
              </span>
              <button className="small" aria-label={`Move ${def.label} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
              <button className="small" aria-label={`Move ${def.label} down`} disabled={i === pipeline.effects.length - 1} onClick={() => move(i, i + 1)}>↓</button>
            </div>
            {isOpen && (
              <div className="section-body">
                <div className="desc">{def.description}</div>
                {inst.type === 'geometry' && inst.params.aspect !== 'original' && (
                  <button className={cropEditing ? 'on' : ''} onClick={() => onCropEdit(!cropEditing)}>
                    {cropEditing ? '✓ Done editing crop' : '⬚ Edit crop box on preview'}
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
