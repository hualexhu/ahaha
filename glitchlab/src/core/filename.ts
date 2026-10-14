export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'custom';
}

/** <original>_glitchlab_<preset-or-custom>_<seed>.<ext> */
export function outputName(original: string, preset: string | null, seed: number, ext: string): string {
  const base = baseName(original).replace(/[\\/:*?"<>|]+/g, '_') || 'image';
  return `${base}_glitchlab_${preset ? slug(preset) : 'custom'}_${seed}.${ext}`;
}
