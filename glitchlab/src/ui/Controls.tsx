import { useRef, useState, type ReactNode } from 'react';
import type { ParamSpec, ParamValue, Params, RangeParam } from '../effects/types';

const fmt = (v: number, step: number): string => {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toFixed(d);
};

interface ParamControlProps {
  spec: ParamSpec;
  value: ParamValue;
  params: Params;
  onChange: (v: ParamValue) => void;
  /** Animation end value for range params (videos only). */
  animTo?: number;
  animatable?: boolean;
  onAnim?: (to: number | undefined) => void;
  idPrefix: string;
}

export function ParamControl({ spec, value, onChange, animTo, animatable, onAnim, idPrefix }: ParamControlProps): ReactNode {
  const id = `${idPrefix}-${spec.key}`;
  switch (spec.kind) {
    case 'range': {
      const v = value as number;
      return (
        <>
          <div className="ctl" title={spec.help}>
            <label htmlFor={id}>{spec.label}</label>
            <input
              id={id}
              data-param={spec.key}
              type="range"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={v}
              onChange={(e) => onChange(parseFloat(e.target.value))}
            />
            <span className="val">{fmt(v, spec.step)}{spec.unit && spec.unit.length <= 2 ? spec.unit : ''}</span>
            {animatable ? (
              <button
                className={'anim small' + (animTo !== undefined ? ' on' : '')}
                title="Animate across the clip (start → end)"
                aria-label={`Animate ${spec.label}`}
                onClick={() => onAnim?.(animTo === undefined ? rangeEnd(spec, v) : undefined)}
              >
                ◆
              </button>
            ) : (
              <span />
            )}
          </div>
          {animatable && animTo !== undefined && (
            <div className="ctl anim-row">
              <label htmlFor={id + '-to'}>↳ end value</label>
              <input id={id + '-to'} type="range" min={spec.min} max={spec.max} step={spec.step} value={animTo} onChange={(e) => onAnim?.(parseFloat(e.target.value))} />
              <span className="val">{fmt(animTo, spec.step)}</span>
              <span />
            </div>
          )}
        </>
      );
    }
    case 'select':
      return (
        <div className="ctl wide">
          <label htmlFor={id}>{spec.label}</label>
          <select id={id} data-param={spec.key} value={value as string} onChange={(e) => onChange(e.target.value)}>
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      );
    case 'toggle':
      return (
        <div className="checkrow">
          <label>
            <input id={id} data-param={spec.key} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            {spec.label}
          </label>
        </div>
      );
    case 'color':
      return (
        <div className="ctl wide">
          <label htmlFor={id}>{spec.label}</label>
          <input id={id} data-param={spec.key} type="color" value={value as string} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'text':
      return (
        <div className="ctl wide">
          <label htmlFor={id}>{spec.label}</label>
          <input id={id} data-param={spec.key} type="text" maxLength={spec.maxLength} value={value as string} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case 'colors':
      return <ColorList id={id} label={spec.label} value={value as string} min={spec.min} max={spec.max} onChange={onChange} />;
  }
}

function rangeEnd(spec: RangeParam, v: number): number {
  // a sensible default end value: the other end of the range
  return v - spec.min > spec.max - v ? spec.min : spec.max;
}

function ColorList({ id, label, value, min, max, onChange }: { id: string; label: string; value: string; min: number; max: number; onChange: (v: string) => void }): ReactNode {
  const colors = value.split(',').filter(Boolean);
  const set = (next: string[]): void => onChange(next.join(','));
  return (
    <div className="ctl wide">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }} id={id}>
        {colors.map((c, i) => (
          <input
            key={i}
            type="color"
            value={c}
            aria-label={`colour ${i + 1}`}
            onChange={(e) => set(colors.map((x, j) => (j === i ? e.target.value : x)))}
          />
        ))}
        <button className="small" disabled={colors.length >= max} onClick={() => set([...colors, colors[colors.length - 1] ?? '#ffffff'])}>+</button>
        <button className="small" disabled={colors.length <= min} onClick={() => set(colors.slice(0, -1))}>−</button>
      </div>
    </div>
  );
}

/** Collapsible section with a drag grip, used for each effect. */
export function useDragReorder(onMove: (from: number, to: number) => void) {
  const dragFrom = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  return {
    over,
    props: (index: number) => ({
      onDragOver: (e: React.DragEvent) => {
        if (dragFrom.current === null) return;
        e.preventDefault();
        setOver(index);
      },
      onDragLeave: () => setOver((o) => (o === index ? null : o)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragFrom.current !== null && dragFrom.current !== index) onMove(dragFrom.current, index);
        dragFrom.current = null;
        setOver(null);
      },
    }),
    gripProps: (index: number) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        dragFrom.current = index;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
      },
      onDragEnd: () => {
        dragFrom.current = null;
        setOver(null);
      },
    }),
  };
}
