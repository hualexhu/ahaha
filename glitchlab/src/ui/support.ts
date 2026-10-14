/** Browser features GlitchLab relies on. Returns human-readable gaps (empty = fully supported). */
export function browserGaps(): { blocking: string[]; video: string[] } {
  const blocking: string[] = [];
  const video: string[] = [];
  if (typeof Worker === 'undefined') blocking.push('Web Workers');
  if (typeof createImageBitmap !== 'function') blocking.push('createImageBitmap');
  if (!hasOffscreen2d()) blocking.push('OffscreenCanvas 2D');
  if (typeof WebAssembly !== 'object') video.push('WebAssembly');
  return { blocking, video };
}

function hasOffscreen2d(): boolean {
  try {
    return typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype && !!new OffscreenCanvas(1, 1).getContext('2d');
  } catch {
    return false;
  }
}

export const SUPPORTED_BROWSERS = 'Chrome or Edge 99+, Firefox 105+, or Safari 16.4+';
