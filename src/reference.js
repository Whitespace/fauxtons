// The README's recursive definition, evaluated directly: j's light reaches x if x is in j's cone and
// range, nothing occludes the segment, and at no point of j's ray before x is another lamp both
// brighter and reached by its own light. Slow, but it makes an independent check of the sweep.

import { transformPoint } from './mat4.js';
import { P_MIN, RANGE, SURFACE_GAP, beamProfile } from './scene.js';

// Light is tested at points this far apart along each ray, so stretches of other light shorter than
// that can slip through.
const STEP = 0.01;

export function createReference(lamps, triangles, step = STEP) {
  const bvh = triangles ? buildBvh(triangles) : null;

  function profile(lamp, wx, wy, wz) {
    return beamProfile(lamp.axis[0] * wx + lamp.axis[1] * wy + lamp.axis[2] * wz);
  }

  function fieldDistance(k, x, y, z) {
    const lamp = lamps[k];
    const dx = x - lamp.position[0], dy = y - lamp.position[1], dz = z - lamp.position[2];
    const r = Math.hypot(dx, dy, dz);
    if (r > RANGE || r === 0) return Infinity;
    const p = profile(lamp, dx / r, dy / r, dz / r);
    return p >= P_MIN ? r / (lamp.sqrtPower * p) : Infinity;
  }

  // Spot is looked for up to `clear` short of the point (see litBy() in exact.glsl).
  function reaches(j, x, y, z, clear = 0) {
    const lamp = lamps[j];
    const [ox, oy, oz] = lamp.position;
    const r = Math.hypot(x - ox, y - oy, z - oz);
    if (r > RANGE || y < 0) return false;
    const wx = (x - ox) / r, wy = (y - oy) / r, wz = (z - oz) / r;
    const p = profile(lamp, wx, wy, wz);
    if (p < P_MIN) return false;
    if (bvh?.occludes(ox, oy, oz, wx, wy, wz, r - clear)) return false;

    const speed = lamp.sqrtPower * p;
    const n = Math.max(16, Math.ceil(r / step));
    const extinguishedAt = (t) => {
      const px = ox + t * wx, py = oy + t * wy, pz = oz + t * wz;
      for (let k = 0; k < lamps.length; k++) {
        if (k !== j && fieldDistance(k, px, py, pz) < t / speed && reaches(k, px, py, pz)) return true;
      }
      return false;
    };
    for (let s = 1; s < n; s++) {
      if (extinguishedAt((r * s) / n)) return false;
    }
    // Closer to x than the last step, halving the distance each time: light can be extinguished just
    // before a surface, by light that passes over it.
    for (let gap = r / n / 2; gap > 1e-6 * r; gap /= 2) {
      if (extinguishedAt(r - gap)) return false;
    }
    return true;
  }

  // The lamp whose light reaches the surface point x with unit normal n, or -1: of the lamps the surface
  // faces, the strongest whose light gets as close to x as the renderer tests it (SURFACE_GAP), with the
  // renderer's allowance `rough` for the facets straying from the smooth surface (litBy() in exact.glsl).
  function litBy(x, n, rough = 0) {
    const candidates = [];
    lamps.forEach((lamp, i) => {
      const d = [0, 1, 2].map((k) => x[k] - lamp.position[k]);
      const r = Math.hypot(...d);
      const cosine = -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / r;
      const distance = fieldDistance(i, ...x);
      if (distance < Infinity && cosine > 0) candidates.push({ i, distance, d, skip: Math.min(rough / Math.max(cosine, 1e-3), 30 * rough) });
    });
    candidates.sort((a, b) => a.distance - b.distance);
    for (const { i, d, skip } of candidates) {
      const p = [0, 1, 2].map((k) => lamps[i].position[k] + (1 - SURFACE_GAP) * d[k]);
      const clear = Math.max(0, skip - SURFACE_GAP * Math.hypot(...d));
      if (reaches(i, ...p, clear)) return i;
    }
    return -1;
  }

  return { fieldDistance, reaches, litBy };
}

// Random points on Spot and, `withGround`, as many on the ground within a few units of it, as the
// surface pass sees them (litBy() in exact.glsl): the point on a flat facet, the facet's normal and how
// far it strays from the smooth surface, the point of the smooth surface over it where light is tested
// (smoothPoint() in surface.frag) and that surface's normal, interpolated from the mesh's. Points on Spot
// are spread by area.
export function sampleSurfaces({ mesh, model, withGround = true, count, seed = 1 }) {
  const random = mulberry32(seed);
  const positions = new Float32Array(3 * count);
  const facets = new Float32Array(3 * count);
  const roughness = new Float32Array(count);
  const lifted = new Float32Array(3 * count);
  const normals = new Float32Array(3 * count);
  const { indices } = mesh;
  const corner = (data, v) => data.subarray(3 * v, 3 * v + 3);
  const world = (v) => transformPoint(model, corner(mesh.positions, v));
  const areas = [];
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [world(indices[t]), world(indices[t + 1]), world(indices[t + 2])];
    const e1 = [0, 1, 2].map((k) => b[k] - a[k]);
    const e2 = [0, 1, 2].map((k) => c[k] - a[k]);
    total += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    areas.push(total);
  }

  for (let s = 0; s < count; s++) {
    if (withGround && s % 2 === 0) {
      const radius = 3 * Math.sqrt(random());
      const angle = 2 * Math.PI * random();
      const x = [radius * Math.cos(angle), 0, radius * Math.sin(angle)];
      positions.set(x, 3 * s);
      lifted.set(x, 3 * s);
      for (const data of [facets, normals]) data.set([0, 1, 0], 3 * s);
      continue;
    }
    const target = random() * total;
    let lo = 0;
    let hi = areas.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (areas[mid] < target) lo = mid + 1; else hi = mid;
    }
    let u = random();
    let v = random();
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    const vertices = [0, 1, 2].map((k) => indices[3 * lo + k]);
    const corners = vertices.map(world);
    // The model matrix is a uniform scale and a translation, so it leaves directions alone.
    const cornerNormals = vertices.map((vertex) => corner(mesh.normals, vertex));
    const weights = [1 - u - v, u, v];
    const blend = (values) => [0, 1, 2].map((k) => weights.reduce((sum, w, m) => sum + w * values[m][k], 0));
    const x = blend(corners);
    const up = [...x];
    corners.forEach((c, m) => {
      const n = cornerNormals[m];
      const height = Math.min(0, (x[0] - c[0]) * n[0] + (x[1] - c[1]) * n[1] + (x[2] - c[2]) * n[2]);
      for (let k = 0; k < 3; k++) up[k] -= weights[m] * height * n[k];
    });
    const n = normalized(blend(cornerNormals));
    const e1 = [0, 1, 2].map((k) => corners[1][k] - corners[0][k]);
    const e2 = [0, 1, 2].map((k) => corners[2][k] - corners[0][k]);
    let facet = normalized([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
    if (facet[0] * n[0] + facet[1] * n[1] + facet[2] * n[2] < 0) facet = facet.map((value) => -value);
    positions.set(x, 3 * s);
    facets.set(facet, 3 * s);
    roughness[s] = 0.1 * Math.max(...[0, 1, 2].map((m) => Math.hypot(...[0, 1, 2].map((k) => corners[(m + 1) % 3][k] - corners[m][k]))));
    lifted.set(up, 3 * s);
    normals.set(n, 3 * s);
  }
  return { positions, facets, roughness, lifted, normals };
}

function normalized(v) {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
}

// Compares which lamp lights surface points, by the renderer (`lit`, from Renderer.probe) and by the
// maps alone, with the reference. Points where the maps' rays disagree or the two methods differ are
// the ones near an edge; up to `limit` of them are checked.
export function compareSurfacesWithReference({ reference, points, lit, limit }) {
  const count = points.positions.length / 3;
  const nearEdges = [];
  let differ = 0;
  for (let s = 0; s < count; s++) {
    const [exact, maps, mixed] = lit.subarray(4 * s, 4 * s + 3);
    if (exact !== maps) differ++;
    if (mixed || exact !== maps) nearEdges.push(s);
  }
  const checked = nearEdges.slice(0, limit);
  const wrong = { exact: [], maps: [] };
  for (const s of checked) {
    const x = Array.from(points.lifted.subarray(3 * s, 3 * s + 3));
    const n = Array.from(points.normals.subarray(3 * s, 3 * s + 3));
    const truth = reference.litBy(x, n, points.roughness[s]);
    const [exact, maps] = lit.subarray(4 * s, 4 * s + 2);
    if (exact !== truth) wrong.exact.push({ point: x, normal: n, truth, got: exact, maps });
    if (maps !== truth) wrong.maps.push({ point: x, truth, got: maps });
  }
  return {
    candidates: count,
    nearEdges: nearEdges.length,
    differ,
    checked: checked.length,
    exactAgreement: 1 - wrong.exact.length / checked.length,
    mapsAgreement: 1 - wrong.maps.length / checked.length,
    exactWrong: wrong.exact.slice(0, 8),
  };
}

// Compares the solver's published solution with the reference at random points in the air, in the box
// `bounds`. `reachAt` gives the distance at which the ray at an atlas texel ended.
export function compareWithReference({ lamps, layout, reference, reachAt, samples, bounds, seed = 1 }) {
  const { atlasSide, mapSize } = layout;
  const { min, max } = bounds ?? { min: [-6, 0.02, -6], max: [6, 6, 6] };
  const random = mulberry32(seed);
  let pairs = 0;
  const disagreements = [];

  for (let s = 0; s < samples; s++) {
    const x = [0, 1, 2].map((k) => min[k] + (max[k] - min[k]) * random());
    lamps.forEach((lamp, i) => {
      if (reference.fieldDistance(i, ...x) === Infinity) return;
      pairs++;
      const d = [0, 1, 2].map((k) => x[k] - lamp.position[k]);
      const r = Math.hypot(...d);
      // As mapUV() in common.glsl.
      const z = d[0] * lamp.axis[0] + d[1] * lamp.axis[1] + d[2] * lamp.axis[2];
      const u = (0.5 * Math.atan2(d[0] * lamp.right[0] + d[1] * lamp.right[1] + d[2] * lamp.right[2], z)) / lamp.mapAngle + 0.5;
      const v = (0.5 * Math.atan2(d[0] * lamp.up[0] + d[1] * lamp.up[1] + d[2] * lamp.up[2], z)) / lamp.mapAngle + 0.5;
      const tx = Math.min(mapSize - 1, Math.max(0, Math.floor(u * mapSize))) + (i % atlasSide) * mapSize;
      const ty = Math.min(mapSize - 1, Math.max(0, Math.floor(v * mapSize))) + Math.floor(i / atlasSide) * mapSize;
      const reach = reachAt(tx, ty);
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
