import { DIMMEST, P_MAX, P_MIN, RANGE, beamProfile, beamSlope, createLayout } from './scene.js';
import { probePoints } from './samples.js';

// Nudges, turns and dims the lamps inside Spot so that its walls are lit as evenly as possible: every
// point lit, and lit about as brightly as every other. Each round does what one would do by hand: solve
// the lamps' cells, measure how every vertex of Spot is lit, then move each lamp to even out its patch.
//
// The lamps are in clusters (clusters.js): a cluster is a place, and each of its lamps sits some way
// out from there along its own axis. A lamp moving along its axis stays inside its own cell, so it can't
// cut into another lamp's light. A cluster moves by the push of all its lamps together, which settles
// where the pushes balance.
//
// Brightness is compared as its logarithm, so that twice too bright weighs the same as twice too dim.
// Each lamp's step is a damped Gauss-Newton step towards lighting its patch, as the solution has it, at
// the mean brightness of all of Spot. Dark vertices pull on the lamp whose cone, carried on past its
// cutoff, comes nearest to them; where a lamp's light was cut off by another's short of the wall, both
// are pushed to reverse that. Steps can't foresee other lamps' light starting or stopping, so they are
// checked after the next solve: when more of Spot is dark than the least so far, the lamps to blame go
// back, and take smaller steps from then on.

// Map texels a side while optimising, for speed; exact surface tests make up for most of it (exact.glsl).
const MEASURE_MAP_SIZE = 256;

// Lamps and cluster places keep at least this far from Spot's walls; lamps sit at least MIN_DEPTH out
// from their place.
export const CLEARANCE = 0.3;
const MIN_DEPTH = 0.15;
// A lamp sits inside another's cell when that lamp's light is present this far behind it.
const BEHIND = 0.1;

// What a dark vertex costs, in squared log brightness: as much as being ten times too dim.
const DARK_PENALTY = Math.log(10) ** 2;
// How much too dim a dark vertex counts as in the steps, in log brightness, and how fast a cone carried
// on past its cutoff fades, in radians (see extendedLight()).
const DARK_PULL = 2;
const EXTENSION = 0.1;
// Where one lamp's light cuts off another's short of Spot, the step aims for the other's field to be
// this much stronger there, in log field.
const SHADOW_MARGIN = 0.1;

// The most a lamp or cluster moves, a lamp turns (radians) and dims (log power) in one step, before its
// trust scales it.
const MAX_MOVE = 0.4;
const MAX_TURN = 0.1;
const MAX_DIM = 0.15;

// When a round leaves more than DARK_GATE of Spot's area dark beyond the least so far, the moves of
// lamps to blame for more of it than before, by DARK_TOLERANCE of area and more, are undone.
const DARK_GATE = 0.002;
const DARK_TOLERANCE = 0.05;

const LOG_MIN_POWER = Math.log(DIMMEST * P_MAX);
const LOG_MAX_POWER = Math.log(P_MAX);

export class LayoutOptimizer {
  // `samples` are Spot's vertices (samples.js), `geometry` its triangles on the CPU (geometry.js), and
  // `layout` the lamps with their clusters' places (clusterLayout() in clusters.js).
  constructor({ renderer, samples, geometry, layout }) {
    this.renderer = renderer;
    this.samples = samples;
    this.geometry = geometry;
    this.probe = renderer.createProbe(probePoints(samples));
    this.clusters = layout.centers.map((center) => ({ center: [...center], accepted: [...center], trust: 1 }));
    this.lamps = layout.lamps.map((lamp, id) => {
      const center = layout.centers[lamp.cluster];
      const depth = Math.max(MIN_DEPTH, Math.hypot(...sub(lamp.position, center)));
      return { id, cluster: lamp.cluster, depth, axis: normalize(lamp.axis), power: lamp.power, color: lamp.color, trust: 1, accepted: null };
    });
    this.damping = 1;
    this.iteration = 0;
    this.history = [];
    this.best = null;
  }

  dispose() {
    this.probe.dispose();
  }

  position(lamp) {
    const center = this.clusters[lamp.cluster].center;
    return center.map((v, k) => v + lamp.depth * lamp.axis[k]);
  }

  // The lamps as they would be saved (see saveable()), and as a layout for the renderer with its maps
  // at `mapSize`, by default as large as fit.
  get lampList() {
    return this.lamps.map((lamp) => ({ position: this.position(lamp), axis: [...lamp.axis], power: lamp.power, color: lamp.color, cluster: lamp.cluster }));
  }

  layout(mapSize) {
    return createLayout(this.lampList, this.lamps.length, mapSize);
  }

  // What is kept of a layout: its places and lamps (clusterLayout()), as the optimiser takes them.
  saveable() {
    return { centers: this.clusters.map((cluster) => [...cluster.center]), lamps: this.lampList };
  }

  // One round: solve, measure, then move the lamps. Returns the measurement.
  iterate() {
    const { renderer } = this;
    if (renderer.gl.isContextLost()) throw new Error('The WebGL context was lost.');
    const layout = this.layout(MEASURE_MAP_SIZE);
    renderer.setLayout(layout);
    renderer.solve();
    const lamps = layout.lamps;
    const lit = this.probe.run();
    const embedded = this.findEmbedded(lamps);
    const measured = measure(this.samples, lamps, lit);
    measured.embedded = embedded.filter((k) => k >= 0).length;

    const previous = this.history.at(-1);
    if (previous) this.damping = Math.min(100, Math.max(0.1, this.damping * (measured.cost > previous.cost ? 2 : 0.8)));
    if (!this.best || measured.cost < this.best.cost) this.best = { cost: measured.cost, iteration: this.iteration, layout: structuredClone(this.saveable()) };

    // Moves are undone only when they left more of Spot dark than the least so far, and then only those
    // of the lamps to blame for more of it than before.
    const darkened = measured.darkArea > (this.darkFloor ?? Infinity) + DARK_GATE * measured.totalArea;
    this.darkFloor = Math.min(this.darkFloor ?? Infinity, measured.darkArea);
    let rejected = 0;
    const steps = this.lamps.map((lamp, i) => {
      const blame = measured.blame[i];
      if (lamp.accepted && darkened && blame > lamp.accepted.blame + DARK_TOLERANCE * (1 + lamp.accepted.blame)) {
        rejected++;
        Object.assign(lamp, { depth: lamp.accepted.depth, axis: [...lamp.accepted.axis], power: lamp.accepted.power });
        lamp.trust = Math.max(0.05, lamp.trust * 0.5);
        return null;
      }
      lamp.accepted = { depth: lamp.depth, axis: [...lamp.axis], power: lamp.power, blame };
      lamp.trust = Math.min(1, lamp.trust * 1.25);
      return this.step(lamp, lamps[i], measured.systems[i]);
    });
    this.moveClusters(steps, measured.blame, darkened);
    this.normalisePowers();

    const record = {
      iteration: this.iteration,
      lamps: this.lamps.length,
      cost: measured.cost,
      dark: measured.darkArea / measured.totalArea,
      spread: measured.spread,
      range: measured.range,
      contrast: measured.contrast,
      contrastWorst: measured.contrastWorst,
      black: measured.black,
      patches: measured.patches,
      embedded: measured.embedded,
      rejected,
    };
    this.history.push(record);
    this.iteration++;
    return { ...record, measured };
  }

  // A damped Gauss-Newton step for one lamp from its patch's system, within its trust region. The lamp is
  // turned and dimmed; the move it wants is returned, for moveClusters().
  step(lamp, described, system) {
    if (!system || system.weight <= 0) return null;
    const { H, g } = system;
    const A = H.map((row, r) => row.map((v, c) => v + (r === c ? this.damping * H[r][r] + 1e-9 * (1 + H[r][r]) : 0)));
    let delta = solve(A, g.map((v) => -v));
    if (!delta) return null;
    // Power stays in the dimmer's range: at a limit, the other five parameters are solved without it.
    const q = Math.log(lamp.power);
    const bounded = Math.min(LOG_MAX_POWER, Math.max(LOG_MIN_POWER, q + delta[5])) - q;
    if (bounded !== delta[5]) {
      const rest = solve(
        A.slice(0, 5).map((row) => row.slice(0, 5)),
        g.slice(0, 5).map((v, r) => -v - A[r][5] * bounded),
      );
      if (!rest) return null;
      delta = [...rest, bounded];
    }
    const [turnA, turnB] = cap(delta.slice(3, 5), MAX_TURN * lamp.trust);
    const dim = Math.max(-MAX_DIM * lamp.trust, Math.min(MAX_DIM * lamp.trust, delta[5]));
    lamp.axis = normalize(lamp.axis.map((v, k) => v + turnA * described.right[k] + turnB * described.up[k]));
    lamp.power = Math.exp(q + dim);
    return cap(delta.slice(0, 3), MAX_MOVE * lamp.trust);
  }

  // Each cluster moves by the mean of its lamps' moves, and each lamp by what is left of its own along
  // its axis, no nearer its place than MIN_DEPTH. Everything stays inside Spot, clear of its walls. A
  // cluster whose lamps are to blame for more dark than before goes back instead.
  moveClusters(steps, blame, darkened) {
    this.clusters.forEach((cluster, c) => {
      const members = this.lamps.map((lamp, i) => i).filter((i) => this.lamps[i].cluster === c);
      const total = members.reduce((sum, i) => sum + blame[i], 0);
      if (cluster.blame !== undefined && darkened && total > cluster.blame + DARK_TOLERANCE * (1 + cluster.blame)) {
        cluster.center = [...cluster.accepted];
        cluster.trust = Math.max(0.05, cluster.trust * 0.5);
        return;
      }
      cluster.accepted = [...cluster.center];
      cluster.blame = total;
      cluster.trust = Math.min(1, cluster.trust * 1.25);
      const moving = members.filter((i) => steps[i]);
      if (!moving.length) return;
      const mean = cap(moving.reduce((sum, i) => add(sum, steps[i]), [0, 0, 0]).map((v) => v / moving.length), MAX_MOVE * cluster.trust);
      // The furthest along its move that the place stays clear.
      const clear = (f) => this.isClear(cluster.center.map((v, k) => v + f * mean[k]));
      let f = 1;
      if (!clear(1)) {
        let lo = 0;
        for (let k = 0; k < 6; k++) {
          const m = (lo + f) / 2;
          if (clear(m)) lo = m; else f = m;
        }
        f = lo;
      }
      cluster.center = cluster.center.map((v, k) => v + f * mean[k]);
      // Each lamp then moves along its axis, and in towards the place where it would be too near a wall.
      for (const i of members) {
        const lamp = this.lamps[i];
        let depth = Math.max(MIN_DEPTH, lamp.depth + (steps[i] ? dot(sub(steps[i], mean), lamp.axis) : 0));
        while (depth > MIN_DEPTH && !this.isClear(cluster.center.map((v, k) => v + depth * lamp.axis[k]))) depth = Math.max(MIN_DEPTH, 0.7 * depth);
        lamp.depth = depth;
      }
    });
  }

  isClear(p) {
    return this.geometry.inside(p) && this.geometry.nearest(p).distance >= CLEARANCE;
  }

  // Scales all powers alike so that the brightest lamp is at full power, which changes no cell, then
  // keeps every lamp in the dimmer's range.
  normalisePowers() {
    const scale = P_MAX / Math.max(...this.lamps.map((lamp) => lamp.power));
    for (const lamp of this.lamps) lamp.power = Math.max(DIMMEST * P_MAX, lamp.power * scale);
  }

  // For each lamp, the lamp whose light is present just behind it, or -1.
  findEmbedded(lamps) {
    const positions = new Float32Array(3 * lamps.length);
    lamps.forEach((lamp, i) => positions.set(lamp.position.map((v, k) => v - BEHIND * lamp.axis[k]), 3 * i));
    const probe = this.renderer.createProbe({ positions }, { air: true });
    const lit = probe.run();
    probe.dispose();
    return lamps.map((_, i) => lit[4 * i]);
  }

  // Runs `count` rounds, returning the last record.
  run(count) {
    let last = null;
    for (let k = 0; k < count; k++) last = this.iterate();
    return last;
  }
}

// How the lamps light Spot's vertices, from the probe's findings `lit` (probe.frag): the brightness at
// each lit vertex, how evenly Spot is lit, and for each lamp its patch, the dark area it is to blame
// for, and the system of its Gauss-Newton step.
export function measure(samples, lamps, lit) {
  const { count, positions, normals, areas, offsets, neighbours } = samples;
  const n = lamps.length;
  const owner = new Int32Array(count);
  const logE = new Float32Array(count);
  let litArea = 0;
  let darkArea = 0;
  let sum = 0;
  const blame = new Float64Array(n);
  const area = new Float64Array(n);
  for (let s = 0; s < count; s++) {
    const i = lit[4 * s];
    owner[s] = i;
    const a = areas[s];
    if (i < 0) {
      darkArea += a;
      // Spot in the way of the lamp with the strongest field there is that lamp's doing; so is light it
      // ran into, and that is the other lamp's too.
      for (const k of new Set([lit[4 * s + 1], lit[4 * s + 2]])) if (k >= 0) blame[k] += a;
      continue;
    }
    const e = irradiance(lamps[i], positions.subarray(3 * s, 3 * s + 3), normals.subarray(3 * s, 3 * s + 3));
    logE[s] = Math.log(Math.max(e, 1e-12));
    litArea += a;
    area[i] += a;
    sum += a * logE[s];
  }
  const mean = litArea > 0 ? sum / litArea : 0;

  // Each lamp's system: H = Σ a JJᵀ and g = Σ a (u - ū) J over its patch, and the pulls of dark
  // vertices (see LayoutOptimizer).
  const systems = Array.from({ length: n }, () => ({ H: zeros(6, 6), g: new Array(6).fill(0), weight: 0 }));
  const badness = new Float64Array(n);
  let deviation = 0;
  const row = new Array(6);
  const other = new Array(6);
  const include = (i, a, r, J, sign = 1) => {
    const { H, g } = systems[i];
    for (let p = 0; p < 6; p++) {
      g[p] += sign * a * r * J[p];
      for (let q = 0; q < 6; q++) H[p][q] += a * J[p] * J[q];
    }
    systems[i].weight += a;
  };
  for (let s = 0; s < count; s++) {
    const i = owner[s];
    const x = positions.subarray(3 * s, 3 * s + 3);
    const normal = normals.subarray(3 * s, 3 * s + 3);
    const a = areas[s];
    if (i >= 0) {
      const r = logE[s] - mean;
      deviation += a * r * r;
      badness[i] += a * r * r;
      if (jacobian(lamps[i], x, normal, row)) include(i, a, r, row);
      continue;
    }
    // Where the light of the lamp with the strongest field ran into a lamp's light that is stronger
    // there, the one is pushed to weaken there and the other to strengthen.
    const [victim, culprit, t] = [lit[4 * s + 1], lit[4 * s + 2], lit[4 * s + 3]];
    if (victim >= 0 && culprit >= 0 && t > 0) {
      const o = lamps[victim].position;
      const w = normalize(sub(x, o));
      const y = o.map((v, k) => v + t * w[k]);
      if (fieldJacobian(lamps[culprit], y, row) && fieldJacobian(lamps[victim], y, other)) {
        const r = Math.log(fieldAt(lamps[culprit], y) / fieldAt(lamps[victim], y)) + SHADOW_MARGIN;
        include(culprit, a, r, row, 1);
        include(victim, a, r, other, -1);
      }
      continue;
    }
    // Otherwise the lamp whose cone comes nearest to lighting it is pulled towards it.
    let best = -1;
    let most = 0;
    for (let k = 0; k < n; k++) {
      const light = extendedLight(lamps[k], x, normal, null);
      if (light > most) {
        best = k;
        most = light;
      }
    }
    if (best >= 0 && extendedLight(lamps[best], x, normal, row) > 0) include(best, a, -DARK_PULL, row);
  }

  // Brightness spread over the lit area: the ratio of its 95th to 5th percentiles, and of its greatest
  // to least.
  const order = Array.from({ length: count }, (_, s) => s).filter((s) => owner[s] >= 0).sort((a, b) => logE[a] - logE[b]);
  const percentile = (f) => {
    let acc = 0;
    for (const s of order) {
      acc += areas[s];
      if (acc >= f * litArea) return logE[s];
    }
    return logE[order.at(-1)] ?? 0;
  };
  const spread = Math.exp(percentile(0.95) - percentile(0.05));
  const range = order.length ? Math.exp(logE[order.at(-1)] - logE[order[0]]) : 0;

  const cells = patchesOf(samples, lit);
  const light = new Float32Array(count);
  for (let s = 0; s < count; s++) light[s] = owner[s] >= 0 ? Math.exp(logE[s]) : 0;

  // Each patch's light where its border with another crosses the mesh's edges, as its darkest points are
  // mostly there. The vertices alone would find them unevenly: a vertex where several patches meet belongs
  // to just one of them. Where the border is the two lamps' veil, it crosses an edge where their fields
  // are equal.
  const border = [];
  const point = [0, 0, 0];
  const across = [0, 0, 0];
  for (let s = 0; s < count; s++) {
    if (owner[s] < 0) continue;
    for (let k = offsets[s]; k < offsets[s + 1]; k++) {
      const t = neighbours[k];
      if (t <= s || owner[t] < 0 || owner[t] === owner[s]) continue;
      const a = lamps[owner[s]];
      const b = lamps[owner[t]];
      const lead = (f) => {
        for (let m = 0; m < 3; m++) {
          point[m] = (1 - f) * positions[3 * s + m] + f * positions[3 * t + m];
          across[m] = (1 - f) * normals[3 * s + m] + f * normals[3 * t + m];
        }
        return Math.log(fieldAt(a, point) / fieldAt(b, point));
      };
      let lo = 0;
      let hi = 1;
      if (!(lead(lo) >= 0 && lead(hi) <= 0 && lead(lo) > lead(hi))) continue;
      for (let n = 0; n < 16; n++) {
        const f = (lo + hi) / 2;
        if (lead(f) >= 0) lo = f; else hi = f;
      }
      lead(lo);
      const unit = normalize(across);
      border.push([owner[s], irradiance(a, point, unit)], [owner[t], irradiance(b, point, unit)]);
    }
  }

  const totalArea = litArea + darkArea;
  return {
    owner,
    logE,
    mean,
    area,
    blame,
    badness,
    systems,
    litArea,
    darkArea,
    totalArea,
    cost: (deviation + DARK_PENALTY * darkArea) / totalArea,
    spread,
    range,
    ...patchContrast(cells, light, border),
  };
}

// The patch every vertex is in, from the probe's findings `lit` (probe.frag): the lamp lighting it, and
// where none does, the patch of the nearest lit vertex along the mesh's edges, so that a dark spot is a
// hole in the patch around it. -1 only where no vertex is lit.
export function patchesOf({ count, offsets, neighbours }, lit) {
  const cells = new Int32Array(count);
  const queue = new Int32Array(count);
  let tail = 0;
  for (let v = 0; v < count; v++) {
    cells[v] = lit[4 * v];
    if (cells[v] >= 0) queue[tail++] = v;
  }
  for (let head = 0; head < tail; head++) {
    const v = queue[head];
    for (let k = offsets[v]; k < offsets[v + 1]; k++) {
      const u = neighbours[k];
      if (cells[u] >= 0) continue;
      cells[u] = cells[v];
      queue[tail++] = u;
    }
  }
  return cells;
}

// How evenly each patch is lit, from the patch `cells` each vertex is in (-1 for none), the `light` there
// and more points of patches as [patch, light] pairs: the ratio of the patch's brightest point to its
// darkest. The dimmers can even out whole patches against each other, but not a patch in itself. A patch
// with a point getting less than a hundredth of its brightest light has a black spot; of the others, the
// median ratio and the greatest.
export function patchContrast(cells, light, more = []) {
  const extremes = new Map();
  const include = (cell, value) => {
    if (cell < 0) return;
    const e = extremes.get(cell) ?? { brightest: 0, darkest: Infinity };
    e.brightest = Math.max(e.brightest, value);
    e.darkest = Math.min(e.darkest, value);
    extremes.set(cell, e);
  };
  cells.forEach((cell, v) => include(cell, light[v]));
  for (const [cell, value] of more) include(cell, value);
  const ratios = [];
  let black = 0;
  for (const { brightest, darkest } of extremes.values()) {
    if (darkest * 100 >= brightest) ratios.push(brightest / darkest);
    else black++;
  }
  ratios.sort((a, b) => a - b);
  return { patches: extremes.size, black, contrast: ratios[ratios.length >> 1] ?? 0, contrastWorst: ratios.at(-1) ?? 0 };
}

// Irradiance of a described lamp (createLayout() in scene.js) on the surface at x with unit normal n
// facing it: F cos, with F = P p² / r².
export function irradiance(lamp, x, n) {
  const d = [x[0] - lamp.position[0], x[1] - lamp.position[1], x[2] - lamp.position[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  if (r > RANGE) return 0;
  const ct = (lamp.axis[0] * d[0] + lamp.axis[1] * d[1] + lamp.axis[2] * d[2]) / r;
  const p = beamProfile(ct);
  const cosine = -(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / r;
  if (p < P_MIN || cosine <= 0) return 0;
  return (lamp.power * p * p * cosine) / (r * r);
}

// Derivatives of u = log(F cos) at x with respect to the lamp's position, its axis turned towards its
// map's right and up, and its log power, into `row`. False where the lamp doesn't light x.
export function jacobian(lamp, x, n, row) {
  const a = lamp.axis;
  const d = [x[0] - lamp.position[0], x[1] - lamp.position[1], x[2] - lamp.position[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  const w = d.map((v) => v / r);
  const ct = a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
  const cosine = -(n[0] * w[0] + n[1] * w[1] + n[2] * w[2]);
  if (beamProfile(ct) < P_MIN || cosine <= 0) return false;
  // u = log P + 2 log p + log cos - 2 log r, with ∂u/∂ct = 2 d log p / d ct.
  const k = 2 * beamSlope(ct);
  for (let m = 0; m < 3; m++) {
    const profile = (-k * (a[m] - ct * w[m])) / r;
    const incidence = (n[m] + cosine * w[m]) / (r * cosine);
    row[m] = profile + incidence + (2 * w[m]) / r;
  }
  row[3] = k * (w[0] * lamp.right[0] + w[1] * lamp.right[1] + w[2] * lamp.right[2]);
  row[4] = k * (w[0] * lamp.up[0] + w[1] * lamp.up[1] + w[2] * lamp.up[2]);
  row[5] = 1;
  return true;
}

// A described lamp's field F = P p² / r² at y, zero outside its cone and range.
export function fieldAt(lamp, y) {
  const d = [y[0] - lamp.position[0], y[1] - lamp.position[1], y[2] - lamp.position[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  const ct = (lamp.axis[0] * d[0] + lamp.axis[1] * d[1] + lamp.axis[2] * d[2]) / r;
  const p = beamProfile(ct);
  return r > RANGE || p < P_MIN ? 0 : (lamp.power * p * p) / (r * r);
}

// Derivatives of log F at y with respect to the lamp's parameters, as in jacobian(), into `row`. False
// outside its cone.
export function fieldJacobian(lamp, y, row) {
  const a = lamp.axis;
  const d = [y[0] - lamp.position[0], y[1] - lamp.position[1], y[2] - lamp.position[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  const w = d.map((v) => v / r);
  const ct = a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
  if (beamProfile(ct) < P_MIN) return false;
  const k = 2 * beamSlope(ct);
  for (let m = 0; m < 3; m++) row[m] = (-k * (a[m] - ct * w[m])) / r + (2 * w[m]) / r;
  row[3] = k * (w[0] * lamp.right[0] + w[1] * lamp.right[1] + w[2] * lamp.right[2]);
  row[4] = k * (w[0] * lamp.up[0] + w[1] * lamp.up[1] + w[2] * lamp.up[2]);
  row[5] = 1;
  return true;
}

// How brightly a lamp would light x, on a surface with unit normal n, if its cone were carried on past
// its cutoff with the profile falling by e every EXTENSION radians, so that where no lamp's light gets,
// the nearest cone can be turned towards it. With `row`, the derivatives of its log as in jacobian().
// Zero where the surface faces away from the lamp or the lamp is out of range.
export function extendedLight(lamp, x, n, row) {
  const a = lamp.axis;
  const d = [x[0] - lamp.position[0], x[1] - lamp.position[1], x[2] - lamp.position[2]];
  const r = Math.hypot(d[0], d[1], d[2]);
  const w = [d[0] / r, d[1] / r, d[2] / r];
  const cosine = -(n[0] * w[0] + n[1] * w[1] + n[2] * w[2]);
  if (r > RANGE || cosine <= 0) return 0;
  const ct = Math.max(-1, Math.min(1, a[0] * w[0] + a[1] * w[1] + a[2] * w[2]));
  const cutoff = Math.acos(Math.sqrt(lamp.cutoffCos2));
  const theta = Math.acos(ct);
  let profile;
  let k;  // ∂u/∂ct, for u the log of the light
  if (theta <= cutoff) {
    profile = beamProfile(ct);
    k = 2 * beamSlope(ct);
  } else {
    profile = P_MIN * Math.exp(-(theta - cutoff) / EXTENSION);
    k = 2 / (EXTENSION * Math.max(Math.sin(theta), 1e-3));
  }
  if (row) {
    for (let m = 0; m < 3; m++) {
      const incidence = (n[m] + cosine * w[m]) / (r * cosine);
      row[m] = (-k * (a[m] - ct * w[m])) / r + incidence + (2 * w[m]) / r;
    }
    row[3] = k * (w[0] * lamp.right[0] + w[1] * lamp.right[1] + w[2] * lamp.right[2]);
    row[4] = k * (w[0] * lamp.up[0] + w[1] * lamp.up[1] + w[2] * lamp.up[2]);
    row[5] = 1;
  }
  return (lamp.power * profile * profile * cosine) / (r * r);
}

// Places inside Spot, clear of its walls, on a grid `spacing` apart, as xyz triples, with how far each is
// from the nearest wall in `clearance`.
export function interiorPlaces(samples, geometry, spacing = 0.8) {
  const { min, max } = bounds(samples.positions);
  const places = [];
  const clearance = [];
  for (let x = min[0]; x <= max[0]; x += spacing) {
    for (let y = min[1]; y <= max[1]; y += spacing) {
      for (let z = min[2]; z <= max[2]; z += spacing) {
        if (!geometry.inside([x, y, z])) continue;
        const distance = geometry.nearest([x, y, z]).distance;
        if (distance < CLEARANCE) continue;
        places.push(x, y, z);
        clearance.push(distance);
      }
    }
  }
  return Object.assign(new Float32Array(places), { clearance: new Float32Array(clearance) });
}

// Gaussian elimination with partial pivoting; null if singular.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, r) => [...row, b[r]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-15) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let v = M[r][n];
    for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k];
    x[r] = v / M[r][r];
  }
  return x;
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[v + k]);
      max[k] = Math.max(max[k], positions[v + k]);
    }
  }
  return { min, max };
}

const zeros = (rows, columns) => Array.from({ length: rows }, () => new Array(columns).fill(0));
const cap = (values, limit) => {
  const size = Math.hypot(...values);
  return size > limit ? values.map((v) => (v * limit) / size) : values;
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};
