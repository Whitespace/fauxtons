// The README's recursive definition, evaluated directly: j's light reaches x if x is in j's cone and
// range, nothing occludes the segment, and at no point of j's ray before x is another lamp both
// brighter and reached by its own light. Slow, but it makes an independent check of the sweep.

import { MAP_SIZE, P_MIN, RANGE } from './scene.js';

const STEP = 0.01;

export function createReference(lamps, triangles) {
  const bvh = triangles ? buildBvh(triangles) : null;

  function profile(lamp, wx, wy, wz) {
    const ct = lamp.axis[0] * wx + lamp.axis[1] * wy + lamp.axis[2] * wz;
    return ct > 0 ? (ct * ct - lamp.c) / (1 - lamp.c) : -1;
  }

  function fieldDistance(k, x, y, z) {
    const lamp = lamps[k];
    const dx = x - lamp.position[0], dy = y - lamp.position[1], dz = z - lamp.position[2];
    const r = Math.hypot(dx, dy, dz);
    if (r > RANGE || r === 0) return Infinity;
    const p = profile(lamp, dx / r, dy / r, dz / r);
    return p >= P_MIN ? r / (lamp.sqrtPower * p) : Infinity;
  }

  function reaches(j, x, y, z) {
    const lamp = lamps[j];
    const [ox, oy, oz] = lamp.position;
    const r = Math.hypot(x - ox, y - oy, z - oz);
    if (r > RANGE || y < 0) return false;
    const wx = (x - ox) / r, wy = (y - oy) / r, wz = (z - oz) / r;
    const p = profile(lamp, wx, wy, wz);
    if (p < P_MIN) return false;
    if (bvh?.occludes(ox, oy, oz, wx, wy, wz, r)) return false;

    const speed = lamp.sqrtPower * p;
    const n = Math.max(16, Math.ceil(r / STEP));
    for (let s = 1; s < n; s++) {
      const t = (r * s) / n;
      const px = ox + t * wx, py = oy + t * wy, pz = oz + t * wz;
      for (let k = 0; k < lamps.length; k++) {
        if (k !== j && fieldDistance(k, px, py, pz) < t / speed && reaches(k, px, py, pz)) return false;
      }
    }
    return true;
  }

  return { fieldDistance, reaches };
}

// Compares the solver's published atlas with the reference at random points in the air.
export function compareWithReference({ lamps, reference, atlas, samples, seed = 1 }) {
  const random = mulberry32(seed);
  const size = 2 * MAP_SIZE;
  let pairs = 0;
  const disagreements = [];

  for (let s = 0; s < samples; s++) {
    const x = [12 * random() - 6, 0.02 + 6 * random(), 12 * random() - 6];
    lamps.forEach((lamp, i) => {
      if (reference.fieldDistance(i, ...x) === Infinity) return;
      pairs++;
      const d = [0, 1, 2].map((k) => x[k] - lamp.position[k]);
      const r = Math.hypot(...d);
      const z = d[0] * lamp.axis[0] + d[1] * lamp.axis[1] + d[2] * lamp.axis[2];
      const u = 0.5 * (d[0] * lamp.right[0] + d[1] * lamp.right[1] + d[2] * lamp.right[2]) / (z * lamp.cutoffTan) + 0.5;
      const v = 0.5 * (d[0] * lamp.up[0] + d[1] * lamp.up[1] + d[2] * lamp.up[2]) / (z * lamp.cutoffTan) + 0.5;
      const tx = Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(u * MAP_SIZE))) + (i & 1) * MAP_SIZE;
      const ty = Math.min(MAP_SIZE - 1, Math.max(0, Math.floor(v * MAP_SIZE))) + (i >> 1) * MAP_SIZE;
      const reach = atlas[4 * (ty * size + tx)];
      const solver = r < reach;
      const exact = reference.reaches(i, ...x);
      if (solver !== exact) disagreements.push({ lamp: i, point: x, solver, exact, margin: Math.abs(r - reach) });
    });
  }

  const margins = disagreements.map((d) => d.margin).sort((a, b) => a - b);
  return {
    pairs,
    agreement: 1 - disagreements.length / pairs,
    disagreements: disagreements.length,
    medianMargin: margins[margins.length >> 1] ?? 0,
    maxMargin: margins.at(-1) ?? 0,
    worst: disagreements.sort((a, b) => b.margin - a.margin).slice(0, 5),
  };
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bounding volume hierarchy over world-space triangles (9 floats each) for segment occlusion.
function buildBvh(triangles) {
  const count = triangles.length / 9;
  const centroid = (t, k) => (triangles[9 * t + k] + triangles[9 * t + 3 + k] + triangles[9 * t + 6 + k]) / 3;

  function bounds(ids) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const t of ids) {
      for (let v = 0; v < 3; v++) {
        for (let k = 0; k < 3; k++) {
          const c = triangles[9 * t + 3 * v + k];
          min[k] = Math.min(min[k], c);
          max[k] = Math.max(max[k], c);
        }
      }
    }
    return { min, max };
  }

  function build(ids) {
    const node = bounds(ids);
    if (ids.length <= 4) return { ...node, ids };
    const extent = [0, 1, 2].map((k) => node.max[k] - node.min[k]);
    const axis = extent.indexOf(Math.max(...extent));
    ids.sort((a, b) => centroid(a, axis) - centroid(b, axis));
    const mid = ids.length >> 1;
    return { ...node, left: build(ids.slice(0, mid)), right: build(ids.slice(mid)) };
  }

  const root = build(Array.from({ length: count }, (_, t) => t));

  function slab(node, o, inv, tMax) {
    let t0 = 0, t1 = tMax;
    for (let k = 0; k < 3; k++) {
      let a = (node.min[k] - o[k]) * inv[k];
      let b = (node.max[k] - o[k]) * inv[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
    return true;
  }

  // Möller–Trumbore, accepting hits strictly inside (0, tMax).
  function hitsTriangle(t, o, w, tMax) {
    const i = 9 * t;
    const e1 = [triangles[i + 3] - triangles[i], triangles[i + 4] - triangles[i + 1], triangles[i + 5] - triangles[i + 2]];
    const e2 = [triangles[i + 6] - triangles[i], triangles[i + 7] - triangles[i + 1], triangles[i + 8] - triangles[i + 2]];
    const p = [w[1] * e2[2] - w[2] * e2[1], w[2] * e2[0] - w[0] * e2[2], w[0] * e2[1] - w[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) return false;
    const s = [o[0] - triangles[i], o[1] - triangles[i + 1], o[2] - triangles[i + 2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1) return false;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (w[0] * q[0] + w[1] * q[1] + w[2] * q[2]) / det;
    if (v < 0 || u + v > 1) return false;
    const d = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    return d > 1e-6 && d < tMax - 1e-6;
  }

  return {
    occludes(ox, oy, oz, wx, wy, wz, tMax) {
      const o = [ox, oy, oz];
      const w = [wx, wy, wz];
      const inv = w.map((c) => 1 / c);
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!slab(node, o, inv, tMax)) continue;
        if (node.ids) {
          if (node.ids.some((t) => hitsTriangle(t, o, w, tMax))) return true;
        } else {
          stack.push(node.left, node.right);
        }
      }
      return false;
    },
  };
}
