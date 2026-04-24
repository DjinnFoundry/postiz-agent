export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX6 = /^[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): Rgb {
  if (typeof hex !== 'string' || hex.length === 0) {
    throw new Error(`hexToRgb: invalid hex "${hex}"`);
  }
  const stripped = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!HEX6.test(stripped)) {
    throw new Error(`hexToRgb: expected 6-digit hex, got "${hex}"`);
  }
  const n = parseInt(stripped, 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

function srgbChannelToLinear(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const rgbA = typeof a === 'string' ? hexToRgb(a) : a;
  const rgbB = typeof b === 'string' ? hexToRgb(b) : b;
  const la = relativeLuminance(rgbA);
  const lb = relativeLuminance(rgbB);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}
