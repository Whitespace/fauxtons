import { hueColor } from './scene.js';

// Colours for the lamps such that patches that meet differ: the lamps, busiest first, each take the hue
// furthest round the colour wheel from those of the lamps it shares the longest borders with. `owner` is
// the lamp lighting each vertex of `samples` (measure() in optimizer.js), -1 where none does.
export function contrastColors({ count, offsets, neighbours }, owner, lamps) {
  const shared = Array.from({ length: lamps }, () => new Map());
  for (let s = 0; s < count; s++) {
    const i = owner[s];
    if (i < 0) continue;
    for (let k = offsets[s]; k < offsets[s + 1]; k++) {
      const j = owner[neighbours[k]];
      if (j >= 0 && j !== i) shared[i].set(j, (shared[i].get(j) ?? 0) + 1);
    }
  }
  const hues = new Array(lamps).fill(null);
  const order = [...hues.keys()].sort((a, b) => sum(shared[b]) - sum(shared[a]));
  const candidates = Array.from({ length: 36 }, (_, k) => k / 36);
  for (const i of order) {
    let best = 0;
    let bestScore = -Infinity;
    for (const hue of candidates) {
      // The nearest hue among its neighbours counts most, weighted by how much seam they share.
      let nearest = 1;
      let spread = 0;
      for (const [j, length] of shared[i]) {
        if (hues[j] === null) continue;
        const d = Math.min(Math.abs(hue - hues[j]), 1 - Math.abs(hue - hues[j]));
        nearest = Math.min(nearest, d);
        spread += length * d;
      }
      const score = nearest * 1e6 + spread;
      if (score > bestScore) {
        best = hue;
        bestScore = score;
      }
    }
    hues[i] = best;
  }
  return hues.map((hue) => hueColor(hue));
}

const sum = (map) => [...map.values()].reduce((a, b) => a + b, 0);
