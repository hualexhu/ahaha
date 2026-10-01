import { useRef, useState, type ReactNode } from 'react';
import type { ParamSpec, ParamValue, Params, RangeParam } from '../effects/types';
import { Icon } from './Icons';

const decimals = (step: number): number => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
export const fmtNum = (v: number, step: number): string => v.toFixed(decimals(step));

// ------------------------------------------------------------ primitives

interface SliderProps {
  id: string;
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  unit?: string;
  format?: (v: number) => string;
  accessory?: ReactNode;
  tone?: 'default' | 'anim';
  dataParam?: string;
  title?: string;
}

/** Label + value on one line, a thin filled track below. */
export function Slider({ id, label, value, min, max, step, onChange, unit, format, accessory, tone = 'default', dataParam, title }: SliderProps): ReactNode {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={'slider' + (tone === 'anim' ? ' slider-anim' : '')} title={title}>
      <div className="slider-head">
        <label htmlFor={id}>{label}</label>
        <span className="slider-value">
          {format ? format(value) : fmtNum(value, step)}
          {unit ? <span className="unit">{unit}</span> : null}
        </span>
        {accessory}
      </div>
      <input
        id={id}
        data-param={dataParam}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--p': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Switch({ checked, onChange, label, id, dataEnable, dataParam, ariaLabel }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  id?: string;
  dataEnable?: string;
  dataParam?: string;
  ariaLabel?: string;
}): ReactNode {
  const input = (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
      aria-label={ariaLabel}
      data-enable={dataEnable}
      data-param={dataParam}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
  if (!label) return input;
  return (
    <label className="switch-row">
      <span>{label}</span>
      {input}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel, testIdPrefix, size = 'md' }: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
  testIdPrefix?: string;
  size?: 'sm' | 'md';
}): ReactNode {
  return (
    <div className={'segmented segmented-' + size} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'active' : ''}
          disabled={o.disabled}
          title={o.title}
          data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
          onClick={() => onChange(o.value)}
        >
          {typeof o.label === 'string' ? o.label.charAt(0).toUpperCase() + o.label.slice(1) : o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, htmlFor, children }: { label: ReactNode; htmlFor?: string; children: ReactNode }): ReactNode {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

// ------------------------------------------------------------ generic param renderer

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

const shortOptions = (spec: Extract<ParamSpec, { kind: 'select' }>): boolean =>
  spec.options.length <= 4 && spec.options.every((o) => o.label.length <= 12);

export function ParamControl({ spec, value, onChange, animTo, animatable, onAnim, idPrefix }: ParamControlProps): ReactNode {
  const id = `${idPrefix}-${spec.key}`;
  switch (spec.kind) {
    case 'range': {
      const v = value as number;
      const animOn = animTo !== undefined;
      return (
        <div className={'param' + (spec.visibleIf ? ' dep' : '')}>
          <Slider
            id={id}
            dataParam={spec.key}
            label={spec.label}
            title={spec.help}
            value={v}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            unit={spec.unit && spec.unit.length <= 2 ? spec.unit : spec.unit ? ` ${spec.unit}` : undefined}
            onChange={onChange}
            accessory={
              animatable ? (
                <button
                  type="button"
                  className={'icon-btn tiny anim-toggle' + (animOn ? ' on' : '')}
                  title={animOn ? 'Stop animating' : 'Animate across the clip (start → end)'}
                  aria-label={`Animate ${spec.label}`}
                  aria-pressed={animOn}
                  onClick={() => onAnim?.(animOn ? undefined : rangeEnd(spec, v))}
                >
                  <Icon name="diamond" size={11} />
                </button>
              ) : null
            }
          />
          {animatable && animOn && (
            <Slider
              id={id + '-to'}
              tone="anim"
              label={<>End of clip</>}
              value={animTo}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              onChange={(x) => onAnim?.(x)}
            />
          )}
        </div>
      );
    }
    case 'select':
      if (shortOptions(spec)) {
        return (
          <div className={'param' + (spec.visibleIf ? ' dep' : '')}>
            <div className="param-label" id={id + '-label'}>{spec.label}</div>
            <Segmented ariaLabel={spec.label} value={value as string} options={spec.options} onChange={onChange} testIdPrefix={id} size="sm" />
          </div>
        );
      }
      return (
        <div className={'param' + (spec.visibleIf ? ' dep' : '')}>
          <Field label={spec.label} htmlFor={id}>
            <select id={id} data-param={spec.key} value={value as string} onChange={(e) => onChange(e.target.value)}>
              {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </div>
      );
    case 'toggle':
      return (
        <div className={'param param-toggle' + (spec.visibleIf ? ' dep' : '')}>
          <Switch id={id} dataParam={spec.key} label={spec.label} checked={value === true} onChange={onChange} />
        </div>
      );
    case 'color':
      return (
        <div className="param">
          <Field label={spec.label} htmlFor={id}>
            <span className="swatch-input">
              <input id={id} data-param={spec.key} type="color" value={value as string} onChange={(e) => onChange(e.target.value)} />
              <code>{String(value)}</code>
            </span>
          </Field>
        </div>
      );
    case 'text':
      return (
        <div className={'param' + (spec.visibleIf ? ' dep' : '')}>
          <Field label={spec.label} htmlFor={id}>
            <input id={id} data-param={spec.key} type="text" className="text-input mono" maxLength={spec.maxLength} value={value as string} onChange={(e) => onChange(e.target.value)} />
          </Field>
        </div>
      );
    case 'colors':
      return <ColorList id={id} label={spec.label} value={value as string} min={spec.min} max={spec.max} onChange={onChange} />;
  }
}

function rangeEnd(spec: RangeParam, v: number): number {
  return v - spec.min > spec.max - v ? spec.min : spec.max;
}

function ColorList({ id, label, value, min, max, onChange }: { id: string; label: string; value: string; min: number; max: number; onChange: (v: string) => void }): ReactNode {
  const colors = value.split(',').filter(Boolean);
  const set = (next: string[]): void => onChange(next.join(','));
  return (
    <div className="param dep">
      <div className="param-label">{label}</div>
      <div className="swatches" id={id}>
        {colors.map((c, i) => (
          <label key={i} className="swatch" style={{ background: c }} title={c}>
            <input type="color" value={c} aria-label={`colour ${i + 1}`} onChange={(e) => set(colors.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
        <button type="button" className="icon-btn" aria-label="Add colour" disabled={colors.length >= max} onClick={() => set([...colors, colors[colors.length - 1] ?? '#ffffff'])}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="icon-btn" aria-label="Remove colour" disabled={colors.length <= min} onClick={() => set(colors.slice(0, -1))}>
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}

/** HTML5 drag-and-drop reordering for a vertical list. */
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
