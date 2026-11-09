// How light is shown on screen, the same on both pages: exposed, through the ACES filmic tone curve, and
// encoded as sRGB. present.frag does the same for the 3D view.

export const EXPOSURE = 1.1;

// The tone curve, of linear light already exposed, from 0 to 1.
export function aces(x) {
  return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}

export const encodeSrgb = (c) => (c < 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export const decodeSrgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
