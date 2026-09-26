import { DIMMEST, P_MAX } from './scene.js';

// A first layout of lamps in clusters, each cluster a few lamps back to back at one place, facing out.
// Lamps that share a place never cut into each other's light, and where their patches meet, both fields
// and angles of incidence agree, so the brightness carries on across the seam. So the lamps go where as
// few places as possible can see all of Spot's walls:
// - Places inside Spot are picked one at a time, each the one that lights well the most of the walls
//   not yet lit well from those picked before: facing it squarely enough, near enough, and with nothing
//   of Spot in between (visibility.frag).
// - Each piece of wall is given to the place that would light it most brightly.
// - Each place gets lamps in proportion to the solid angle its wall fills as seen from there, and its
//   lamps share out that solid angle evenly between them, as a lamp's patch is lit evenly only as far
//   as it spans few enough degrees of its cone. Each lamp's power is set so that its share of the wall
//   is lit about as brightly as every other.
// The fauxton solution then decides where each lamp's light actually goes, and the optimiser refines it.

// A piece of wall is lit well from a place that it faces at least this squarely, and that is at least
// MIN_DISTANCE away, so that the patches there each span few degrees of a lamp's cone, and at most
// MAX_DISTANCE.
const MIN_COSINE = 0.4;
const MIN_DISTANCE = 1.2;
const MAX_DISTANCE = 12;
// A place nearer a wall than this counts for its share of it.
const NEAR_WALL = 1;
// Places stop being added once this share of the wall is lit well, or they would add less than
// MIN_GAIN of it each, or there would be fewer than LAMPS_PER_PLACE lamps to a place, though there are
// always MIN_PLACES if they add enough. Every place added makes borders between its patches and the
// others', where the brightness steps, and leaves fewer lamps to share out the wall at each place: with
// 64 lamps, a fourth place makes the lighting worse all round, while 128 lamps light Spot best from 7.
const COVERED = 0.995;
const MIN_GAIN = 0.005;
const LAMPS_PER_PLACE = 18;
const MIN_PLACES = 3;
// Wall points judged, and how far out from its place each lamp sits.
const TARGETS = 2048;
const OFFSET = 0.2;

export function clusterLayout({ renderer, samples, geometry, places, count, maxClusters = Math.max(MIN_PLACES, Math.floor(count / LAMPS_PER_PLACE)), minCosine = MIN_COSINE, minGain = MIN_GAIN }) {
  const targets = subsample(samples, TARGETS);
  const total = targets.areas.reduce((sum, a) => sum + a, 0);
  const covered = new Uint8Array(targets.count);
  const centers = [];
  // How brightly a lamp at `center` could light wall point k, if well enough to count.
  const lights = (center, k) => {
    const x = targets.positions.subarray(3 * k, 3 * k + 3);
    const n = targets.normals.subarray(3 * k, 3 * k + 3);
    const d = [x[0] - center[0], x[1] - center[1], x[2] - center[2]];
    const r = Math.hypot(...d);
    const cosine = -(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / r;
    if (r < MIN_DISTANCE || r > MAX_DISTANCE || cosine < minCosine) return 0;
    if (geometry.raycast(center, d.map((v) => v / r), r * (1 - 1e-3)).distance < Infinity) return 0;
    return cosine / (r * r);
  };
  const limit = Math.max(1, maxClusters);
  let litArea = 0;
  const gains = [];
  while (centers.length < limit && litArea < COVERED * total) {
    const open = [...covered.keys()].filter((k) => !covered[k]);
    const seen = renderer.visibility(places, pick(targets, open), { minCosine, minDistance: MIN_DISTANCE, maxDistance: MAX_DISTANCE });
    // Places near a wall count for less: their lamps would light that wall unevenly.
    seen.forEach((area, k) => (seen[k] = area * Math.min(1, places.clearance[k] / NEAR_WALL)));
    let best = 0;
    for (let k = 1; k < seen.length; k++) if (seen[k] > seen[best]) best = k;
    if (seen[best] < minGain * total) break;
    const center = Array.from(places.subarray(3 * best, 3 * best + 3));
    centers.push(center);
    const before = litArea;
    for (const k of open) {
      if (lights(center, k) > 0) {
        covered[k] = 1;
        litArea += targets.areas[k];
      }
    }
    gains.push((litArea - before) / total);
  }

  // Each wall point goes to the place that lights it most brightly.
  const members = centers.map(() => []);
  for (let k = 0; k < targets.count; k++) {
    let best = -1;
    let most = 0;
    centers.forEach((center, c) => {
      const q = lights(center, k);
      if (q > most) {
        best = c;
        most = q;
      }
    });
    if (best >= 0) members[best].push(k);
  }
  // Directions from each place to its wall points, each with the solid angle it fills and the power
  // it needs to be lit as brightly as the others.
  const directions = centers.map((center, c) =>
    members[c].map((k) => {
      const x = targets.positions.subarray(3 * k, 3 * k + 3);
      const d = [x[0] - center[0], x[1] - center[1], x[2] - center[2]];
      const r = Math.hypot(...d);
      const n = targets.normals.subarray(3 * k, 3 * k + 3);
      const cosine = -(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / r;
      return { w: d.map((v) => v / r), area: (targets.areas[k] * cosine) / (r * r), need: (r * r) / cosine };
    }),
  );
  const shares = apportion(directions.map((list) => list.reduce((sum, d) => sum + d.area, 0)), count);

  const lamps = [];
  centers.forEach((center, c) => {
    if (!shares[c]) return;
    for (const group of sphericalMeans(directions[c], shares[c])) {
      lamps.push({ position: center.map((v, k) => v + OFFSET * group.axis[k]), axis: group.axis, power: group.need, cluster: c });
    }
  });
  // Powers in proportion to what each lamp's share of the wall needs, within the dimmer's range.
  const most = Math.max(...lamps.map((lamp) => lamp.power));
  for (const lamp of lamps) lamp.power = Math.max(DIMMEST * P_MAX, (P_MAX * lamp.power) / most);
  return { lamps, centers, litArea: litArea / total, gains };
}

// Every `every`-th vertex, standing for the area of those skipped, so that at most `limit` remain.
function subsample(samples, limit) {
  const every = Math.ceil(samples.count / limit);
  const chosen = [];
  for (let s = 0; s < samples.count; s += every) chosen.push(s);
  const take = (data) => new Float32Array(chosen.flatMap((s) => Array.from(data.subarray(3 * s, 3 * s + 3))));
  return {
    count: chosen.length,
    positions: take(samples.positions),
    normals: take(samples.normals),
    areas: new Float32Array(chosen.map((s) => {
      let area = 0;
      for (let v = s; v < Math.min(s + every, samples.count); v++) area += samples.areas[v];
      return area;
    })),
  };
}

function pick({ positions, normals, areas }, list) {
  const three = (data) => new Float32Array(list.flatMap((k) => Array.from(data.subarray(3 * k, 3 * k + 3))));
  return { positions: three(positions), normals: three(normals), areas: new Float32Array(list.map((k) => areas[k])) };
}

// Whole numbers in proportion to `weights` adding up to `total`, by largest remainders, at least one
// for every weight that isn't zero while there are enough.
function apportion(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (sum > 0 ? (w / sum) * total : 0));
  const shares = exact.map((v, k) => (weights[k] > 0 ? Math.max(1, Math.floor(v)) : 0));
  let left = total - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((v, k) => [v - Math.floor(v), k]).sort((a, b) => b[0] - a[0]);
  for (let n = 0; left > 0 && order.length; n++, left--) shares[order[n % order.length][1]]++;
  while (left < 0) {
    const k = shares.indexOf(Math.max(...shares));
    shares[k]--;
    left++;
  }
  return shares;
}

// `count` groups of the unit directions (with solid angles, as `area`, and needs) by spherical
// k-means, started from directions spread as far apart as possible. Each group's axis is its weighted
// mean direction and its need the weighted mean need of its directions.
function sphericalMeans(directions, count) {
  if (!directions.length) return [];
  const axes = [directions[0].w];
  const nearest = directions.map((d) => 1 - dot(d.w, axes[0]));
  while (axes.length < Math.min(count, directions.length)) {
    let far = 0;
    for (let k = 1; k < directions.length; k++) if (nearest[k] > nearest[far]) far = k;
    axes.push(directions[far].w);
    directions.forEach((d, k) => (nearest[k] = Math.min(nearest[k], 1 - dot(d.w, axes.at(-1)))));
  }
  let groups = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    groups = axes.map(() => ({ sum: [0, 0, 0], area: 0, need: 0 }));
    for (const d of directions) {
      let best = 0;
      for (let g = 1; g < axes.length; g++) if (dot(d.w, axes[g]) > dot(d.w, axes[best])) best = g;
      const group = groups[best];
      for (let k = 0; k < 3; k++) group.sum[k] += d.area * d.w[k];
      group.area += d.area;
      group.need += d.area * d.need;
    }
    groups.forEach((group, g) => {
      if (group.area > 0) axes[g] = normalize(group.sum);
    });
  }
  return groups.map((group, g) => ({ axis: axes[g], need: group.area > 0 ? group.need / group.area : 1 })).filter((_, g) => groups[g].area > 0);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};
