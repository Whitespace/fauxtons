// Fauxton light on a square grid of cells (2d.html), spread a tick at a time by one of four algorithms.
// The beam and the field are the README's, F = P p² / r², with distances in cells, measured between the
// middles of cells. A cell is lit by at most one lamp, its owner.
//
// - The flood fill: each tick, the lamps take turns, the most powerful first. In its turn, a lamp's light
//   spreads into every cell next to it that the lamp has a straight line of sight to and that is unlit or
//   lit by a lamp weaker there, as the lamps before it left the grid. The line of sight is blocked by any
//   cell on it lit by a lamp at least as strong there. A cell keeps its light until a stronger lamp takes
//   it.
// - JFA, the jump flood algorithm: the same, but a lamp's light spreads into the cells `step` cells away
//   from it along the rows, columns and diagonals rather than next to it. With a step of 1 it is the flood
//   fill.
// - Fill and kill: the flood fill's rule, carried by creatures to the cells where something may change,
//   rather than tried on every cell. A fill creature tries to spread its lamp's light into its cell. When it
//   does, fill creatures of that lamp hatch on the cell's neighbours, and kill creatures on the neighbours
//   behind the cell lit by lamps it now cuts off: lamps no stronger there than the lamp that lit it. A kill
//   creature puts out its lamp's light in its cell if the lamp can no longer see it; then kill creatures of
//   that lamp hatch on the neighbours it lights, and fill creatures on the cell for the lamps lighting the
//   other neighbours, to light it again. While any kill creature is alive, only kill creatures move; fill
//   creatures move once all have died, those of the most powerful lamp first. A tick moves one generation.
// - Shells: the order the README's model decides light in. A lamp's light moves straight out from it, along
//   each ray at its own speed, √P p cells per unit of field-distance, so it reaches each cell at the lamp's
//   field-distance there, 1 / √F. Each tick moves every lamp's light out by the same step of field-distance,
//   one shell, and decides the cells the light reaches in that step in order of field-distance, whichever
//   lamps they are for. A cell goes to the first lamp to reach it that can see it and keeps it, as any lamp
//   reaching it later is weaker there, so nothing is taken back. So each cell waits only for its brightest
//   lamp, and for the next brightest only if that one can't see it.
//
// In a lamp's turn of the first two, every cell is decided from the grid as the turn found it; creatures
// and shells act on the grid as the moves before them left it. All note for every lamp A and every other
// lamp B the brightest cell B took from A: A's field there, when A had it. Shells never takes a cell.
//
// An additional pass runs either again from no light, but judges the line of sight against the grid as the
// last pass left it (`sightFrom`) rather than as this pass goes.
//
// A line of sight passes over blocks of BLOCK × BLOCK cells that no other lamp lights, as nothing in them
// can block it, rather than looking at their cells one by one (`skipBlocks`).
//
// `work` counts the comparisons a pass makes, one for each time it looks at a cell of the grid: deciding a
// cell in a lamp's turn or a creature's move, looking at one of the eight cells around it, and following a
// line of sight, one for each cell on the line it looks at and one for each block it looks up. Shells also
// counts one for each cell it takes in turn, one for each lamp it looks at to find a cell's next brightest,
// RADIX_LOOKS for each cell it sorts, and one for each comparison in its heap of cells waiting.

import { P_MIN, beamProfile } from '../scene.js';

export const SIZE = 256;
const BLOCK_BITS = 5;
const BLOCK = 1 << BLOCK_BITS;

// How fast a lamp's light moves along the ray at cos θ off its axis, in cells per unit of field-distance:
// √P p, which on the axis is the length of the lamp's arrow. 0 where the beam is cut off.
export function lightSpeed(lamp, cos) {
  const p = beamProfile(cos);
  return p >= P_MIN ? lamp.reach * p : 0;
}

// A radix sort takes RADIX_BITS of each key at a time, lowest first, in RADIX_PASSES passes, and looks at
// each key RADIX_LOOKS times: once to count its digits, then once a pass to move it.
const RADIX_BITS = 11;
const RADIX_PASSES = Math.ceil(32 / RADIX_BITS);
const RADIX_LOOKS = 1 + RADIX_PASSES;

// Sorts 32-bit `keys`, with `values` alongside, by their digits of RADIX_BITS bits, lowest first. Each pass
// is stable, so equal keys keep their order. Returns the sorted keys and values, in new arrays or the ones
// given.
function radixSort(keys, values) {
  const n = keys.length;
  const digits = 1 << RADIX_BITS;
  const mask = digits - 1;
  const counts = new Uint32Array(RADIX_PASSES * digits);
  for (let k = 0; k < n; k++) {
    const key = keys[k];
    for (let pass = 0; pass < RADIX_PASSES; pass++) counts[pass * digits + ((key >>> (pass * RADIX_BITS)) & mask)]++;
  }
  let [fromKeys, fromValues, toKeys, toValues] = [keys, values, new Uint32Array(n), new Uint32Array(n)];
  for (let pass = 0; pass < RADIX_PASSES; pass++) {
    // Where each digit's keys go: after those of all the smaller digits.
    const from = pass * digits;
    for (let d = 0, start = 0; d < digits; d++) {
      const count = counts[from + d];
      counts[from + d] = start;
      start += count;
    }
    const shift = pass * RADIX_BITS;
    for (let k = 0; k < n; k++) {
      const key = fromKeys[k];
      const at = counts[from + ((key >>> shift) & mask)]++;
      toKeys[at] = key;
      toValues[at] = fromValues[k];
    }
    [fromKeys, fromValues, toKeys, toValues] = [toKeys, toValues, fromKeys, fromValues];
  }
  return [fromKeys, fromValues];
}

// Cells waiting for their next light, for shells: a binary heap of field-distances, as 32-bit floats, with
// lamps and cells as lamp × cells + cell. The least field-distance is at the top, and of those as far off,
// the lamp and cell that come first. Counts its comparisons in the grid's work.
class Arrivals {
  constructor(grid) {
    this.grid = grid;
    this.size = 0;
    this.distance = new Float32Array(1024);
    this.pair = new Uint32Array(1024);
  }

  push(d, p) {
    if (this.size === this.pair.length) {
      const distance = new Float32Array(2 * this.size);
      const pair = new Uint32Array(2 * this.size);
      distance.set(this.distance);
      pair.set(this.pair);
      Object.assign(this, { distance, pair });
    }
    const { distance, pair, grid } = this;
    // Up from the bottom, moving each entry that should come after it down a level.
    let k = this.size++;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      grid.work++;
      if (!(d < distance[parent] || (d === distance[parent] && p < pair[parent]))) break;
      distance[k] = distance[parent];
      pair[k] = pair[parent];
      k = parent;
    }
    distance[k] = d;
    pair[k] = p;
  }

  // Takes away the entry at the top, distance[0] and pair[0].
  pop() {
    const { distance, pair, grid } = this;
    const n = --this.size;
    const d = distance[n];
    const p = pair[n];
    // The last entry, down from the top, moving each entry that should come before it up a level.
    let k = 0;
    while (2 * k + 1 < n) {
      let child = 2 * k + 1;
      if (child + 1 < n) {
        grid.work++;
        if (distance[child + 1] < distance[child] || (distance[child + 1] === distance[child] && pair[child + 1] < pair[child])) child++;
      }
      grid.work++;
      if (!(distance[child] < d || (distance[child] === d && pair[child] < p))) break;
      distance[k] = distance[child];
      pair[k] = pair[child];
      k = child;
    }
    distance[k] = d;
    pair[k] = p;
  }
}

// How many of the edges a line crosses at (2k + 1) / 2m of its way, for k = 0, 1, …, come before the edge it
// crosses at odd / 2n of its way: those with (2k + 1) n < odd m.
function crossed(odd, m, n) {
  const before = odd * m;
  return before <= n ? 0 : Math.floor((before - 1 - n) / (2 * n)) + 1;
}

// A lamp in cell (x, y) aimed at the point `aim` cells from its middle, rounded to hundredths of a cell so
// that a link to the page gives it back exactly, with the power that makes its field on its axis there 1.
export function aimedLamp(x, y, aim, color) {
  const [dx, dy] = aim.map((v) => Math.round(v * 100) / 100);
  const reach = Math.hypot(dx, dy);
  return { x, y, aim: [dx, dy], axis: [dx / reach, dy / reach], power: reach * reach, reach, color };
}

// The lamps of a link to 2d.html, as its `lamps` parameter lists them: x,y,aimX,aimY,colour for each, with
// `;` between them. Lamps that don't fit the grid, or share a cell, are left out.
export function lampsOfLink(text) {
  const lamps = [];
  const taken = new Set();
  for (const item of text.split(';')) {
    const [x, y, dx, dy, color] = item.split(',');
    const cell = [Number(x), Number(y)];
    const aim = [Number(dx), Number(dy)];
    if (!cell.every((v) => Number.isInteger(v) && v >= 0 && v < SIZE) || !aim.every(Number.isFinite)) continue;
    if (taken.has(cell[1] * SIZE + cell[0])) continue;
    const rgb = /^[0-9a-f]{6}$/i.test(color ?? '') ? [0, 2, 4].map((k) => parseInt(color.slice(k, k + 2), 16)) : null;
    const lamp = aimedLamp(...cell, aim, rgb);
    if (lamp.reach <= 0.5) continue;
    taken.add(cell[1] * SIZE + cell[0]);
    lamps.push(lamp);
  }
  return lamps;
}

export class Grid {
  constructor(size = SIZE) {
    this.size = size;
    const cells = size * size;
    this.lamps = [];
    // Per cell, the lamp standing in it, else -1.
    this.lampAt = new Int16Array(cells).fill(-1);
    // Per lamp and cell, the lamp's field at the cell: 0 outside its cone, and infinite in its own cell.
    this.fields = [];
    // Per cell, the lamp lighting it, else -1: now, after the turn being taken, and as the tick began.
    this.owner = new Int16Array(cells);
    this.next = new Int16Array(cells);
    this.start = new Int16Array(cells);
    // For an additional pass, the grid its line of sight is judged against, set before reset(); null for the
    // first pass.
    this.sightFrom = null;
    // Whether lines of sight pass over blocks that no other lamp lights.
    this.skipBlocks = true;
    // How far, in cells, the most powerful lamp's light moves along its axis in a tick of shells.
    this.shellCells = 2;
    // Per block, how many of its cells are lit in the grid lines of sight are judged against, and per lamp
    // and block, how many the lamp lights (`blockOwn`, made by reset()). `changes` holds the cells a lamp's
    // turn of the flood fill or JFA changed.
    this.blocksWide = Math.ceil(size / BLOCK);
    this.blockLit = new Int32Array(this.blocksWide ** 2);
    this.changes = new Int32Array(cells);
    this.reset();
  }

  // The brightest cell, in lamp a's field, that lamp b took from lamp a, 0 if it took none.
  lost(a, b) {
    return this.losses[a * this.lamps.length + b];
  }

  // A lamp in cell (x, y), facing along the unit vector `axis`, with power `power`; anything else the
  // lamp carries, such as its colour, is kept with it.
  addLamp(lamp) {
    const { x, y, axis, power } = lamp;
    const { size } = this;
    const index = this.lamps.length;
    const field = new Float32Array(size * size);
    for (let cy = 0; cy < size; cy++) {
      for (let cx = 0; cx < size; cx++) {
        const dx = cx - x;
        const dy = cy - y;
        const r = Math.hypot(dx, dy);
        const p = r > 0 ? beamProfile((axis[0] * dx + axis[1] * dy) / r) : 1;
        field[cy * size + cx] = r === 0 ? Infinity : p >= P_MIN ? (power * p * p) / (r * r) : 0;
      }
    }
    this.lamps.push(lamp);
    this.fields.push(field);
    this.lampAt[y * size + x] = index;
    this.reset();
  }

  clearLamps() {
    this.lamps = [];
    this.fields = [];
    this.lampAt.fill(-1);
    this.reset();
  }

  // Back to no light but the lamps' own cells, no cells lost and no work done. The lamps take their turns in
  // order of power, the most powerful first.
  reset() {
    this.owner.set(this.lampAt);
    this.losses = new Float32Array(this.lamps.length ** 2);
    this.order = this.lamps.map((_, i) => i).sort((a, b) => this.lamps[b].power - this.lamps[a].power || a - b);
    this.tick = 0;
    this.work = 0;
    // Fill and kill's creatures, hatched on its first tick, and how many of each kind are alive.
    this.creatures = null;
    this.alive = { fill: 0, kill: 0 };
    // Shells' cells in order of their first light, made on its first tick, and the next to take; the cells
    // waiting for a later light; how many cells are left waiting; and the field-distance its light has
    // reached.
    this.first = null;
    this.cursor = 0;
    this.later = null;
    this.shellsLeft = null;
    this.clock = 0;
    this.countBlocks();
  }

  // The blocks' counts of lit cells, afresh, for the grid lines of sight are judged against.
  countBlocks() {
    const { size, blocksWide, blockLit } = this;
    const grid = this.sightFrom ?? this.owner;
    const blocks = blocksWide * blocksWide;
    blockLit.fill(0);
    this.blockOwn = new Int32Array(this.lamps.length * blocks);
    for (let c = 0; c < grid.length; c++) {
      const j = grid[c];
      if (j < 0) continue;
      const x = c % size;
      const b = (((c - x) / size) >> BLOCK_BITS) * blocksWide + (x >> BLOCK_BITS);
      blockLit[b]++;
      this.blockOwn[j * blocks + b]++;
    }
  }

  // Cell c going from lamp `from` to lamp `to`, either -1 for none, in the blocks' counts, unless lines of
  // sight are judged against another pass's grid.
  recount(c, from, to) {
    if (this.sightFrom) return;
    const { size, blocksWide, blockLit, blockOwn } = this;
    const x = c % size;
    const b = (((c - x) / size) >> BLOCK_BITS) * blocksWide + (x >> BLOCK_BITS);
    if (from >= 0) {
      blockLit[b]--;
      blockOwn[from * blocksWide * blocksWide + b]--;
    }
    if (to >= 0) {
      blockLit[b]++;
      blockOwn[to * blocksWide * blocksWide + b]++;
    }
  }

  // One tick of the flood fill. Returns how many cells changed.
  flood() {
    return this.jump(1);
  }

  // One tick of JFA with `step` cells between a lamp's light and the cells it spreads into, the lamps taking
  // turns. Returns how many cells the tick changed.
  jump(step) {
    const { size, fields, lampAt, losses, start } = this;
    const count = this.lamps.length;
    start.set(this.owner);
    for (const i of this.order) {
      const { owner, next, changes } = this;
      const field = fields[i];
      let taken = 0;
      this.work += size * size;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const c = y * size + x;
          const had = owner[c];
          next[c] = had;
          if (lampAt[c] >= 0 || had === i || field[c] <= (had >= 0 ? fields[had][c] : 0)) continue;
          if (!this.near(i, x, y, step) || !this.inSight(i, x, y)) continue;
          next[c] = i;
          changes[taken++] = c;
          if (had >= 0 && fields[had][c] > losses[had * count + i]) losses[had * count + i] = fields[had][c];
        }
      }
      [this.owner, this.next] = [this.next, this.owner];
      for (let k = 0; k < taken; k++) this.recount(changes[k], this.next[changes[k]], i);
    }
    let changed = 0;
    for (let c = 0; c < start.length; c++) if (this.owner[c] !== start[c]) changed++;
    this.tick++;
    return changed;
  }

  // One tick of fill and kill: a generation of kill creatures if any are alive, else of fill creatures.
  // Returns how many cells the tick changed, or with `tally` false, for timing without the page's
  // bookkeeping, nothing.
  life(tally = true) {
    const { size, fields, lampAt, losses, start } = this;
    const count = this.lamps.length;
    const cells = size * size;
    if (!this.creatures) this.hatch();
    const creatures = this.creatures;
    const owner = this.owner;
    if (tally) start.set(owner);
    const killing = this.alive.kill > 0;
    const moving = killing ? creatures.kill : creatures.fill;
    if (killing) creatures.kill = this.lamps.map(() => []);
    else creatures.fill = this.lamps.map(() => []);
    for (const i of this.order) {
      const field = fields[i];
      for (const c of moving[i]) {
        (killing ? creatures.killing : creatures.filling)[i * cells + c] = 0;
        this.work++;
        const x = c % size;
        const y = (c - x) / size;
        const had = owner[c];
        if (killing) {
          if (had !== i || this.inSight(i, x, y)) continue;
          owner[c] = -1;
          this.recount(c, i, -1);
          this.neighbours(c, (n) => {
            const j = owner[n];
            if (j === i) this.queue('kill', i, n);
            else if (j >= 0) this.queue('fill', j, c);
          });
          continue;
        }
        if (lampAt[c] >= 0 || had === i || field[c] <= (had >= 0 ? fields[had][c] : 0)) continue;
        if (!this.near(i, x, y, 1) || !this.inSight(i, x, y)) continue;
        owner[c] = i;
        this.recount(c, had, i);
        if (had >= 0 && fields[had][c] > losses[had * count + i]) losses[had * count + i] = fields[had][c];
        this.neighbours(c, (n) => {
          const j = owner[n];
          if (j === i) return;
          if (field[n] > (j >= 0 ? fields[j][n] : 0)) this.queue('fill', i, n);
          if (j >= 0 && lampAt[n] < 0 && fields[j][c] <= field[c] && this.behind(j, c, n)) this.queue('kill', j, n);
        });
      }
    }
    this.alive = { fill: creatures.fill.reduce((n, list) => n + list.length, 0), kill: creatures.kill.reduce((n, list) => n + list.length, 0) };
    this.tick++;
    if (!tally) return null;
    let changed = 0;
    for (let c = 0; c < cells; c++) if (owner[c] !== start[c]) changed++;
    return changed;
  }

  // One tick of shells: every lamp's light moves out by the same step of field-distance, and each cell whose
  // next light arrives in that step, in order of field-distance, goes to that light's lamp if the lamp can
  // see it. If it can't, the cell waits for the next brightest lamp there, in `later`. Steps that light
  // nothing are passed over, so each tick lights something until no cell is left waiting. Returns how many
  // cells the tick lit, keeping the grid as it was in `start` unless `tally` is false.
  shells(tally = true) {
    if (!this.first) this.scheduleCells();
    const { size, owner, first, later } = this;
    const cells = size * size;
    const step = this.shellCells / Math.max(...this.lamps.map((lamp) => lamp.reach));
    if (tally) this.start.set(owner);
    // Whether the next cell comes from `first` rather than `later`: the one with less field-distance, or
    // as far, the lamp and cell that come first by lamp × cells + cell.
    const fromFirst = () =>
      this.cursor < first.pair.length &&
      (!later.size || first.distance[this.cursor] < later.distance[0] || (first.distance[this.cursor] === later.distance[0] && first.pair[this.cursor] < later.pair[0]));
    let lit = 0;
    while (lit === 0 && this.shellsLeft > 0) {
      const next = fromFirst() ? first.distance[this.cursor] : later.distance[0];
      this.clock = Math.max(this.clock + step, Math.ceil(next / step) * step);
      for (;;) {
        let distance;
        let pair;
        if (fromFirst()) {
          distance = first.distance[this.cursor];
          pair = first.pair[this.cursor];
          if (distance > this.clock) break;
          this.cursor++;
        } else {
          if (!later.size || later.distance[0] > this.clock) break;
          distance = later.distance[0];
          pair = later.pair[0];
          later.pop();
        }
        const i = Math.floor(pair / cells);
        const c = pair - i * cells;
        const x = c % size;
        this.work++;
        if (this.inSight(i, x, (c - x) / size)) {
          owner[c] = i;
          this.recount(c, -1, i);
          lit++;
        } else {
          const j = this.nextLamp(c, i, distance);
          if (j >= 0) later.push(this.nextDistance, j * cells + c);
        }
      }
      this.shellsLeft = first.pair.length - this.cursor + later.size;
    }
    this.tick++;
    return lit;
  }

  // For shells, every cell some lamp's light could reach but the lamps' own, in order of when the first
  // light gets there: the field-distance of the lamp brightest there, and that lamp and the cell as
  // lamp × cells + cell. Cells as far off come by lamp and then cell.
  scheduleCells() {
    const { size, lampAt, lamps } = this;
    const cells = size * size;
    const lampOf = new Int16Array(cells).fill(-1);
    const distanceOf = new Float32Array(cells);
    const starts = new Uint32Array(lamps.length + 1);
    for (let c = 0; c < cells; c++) {
      if (lampAt[c] >= 0) continue;
      const i = this.nextLamp(c, -1, -Infinity);
      if (i < 0) continue;
      lampOf[c] = i;
      distanceOf[c] = this.nextDistance;
      starts[i + 1]++;
    }
    // Lamp by lamp and cell by cell, then sorted by the field-distances' bits as 32-bit floats, which order
    // as the numbers do when positive; the sort keeps the order of cells as far off.
    for (let i = 0; i < lamps.length; i++) starts[i + 1] += starts[i];
    const count = starts[lamps.length];
    const distance = new Float32Array(count);
    const pair = new Uint32Array(count);
    for (let c = 0; c < cells; c++) {
      const i = lampOf[c];
      if (i < 0) continue;
      const at = starts[i]++;
      distance[at] = distanceOf[c];
      pair[at] = i * cells + c;
    }
    const [keys, pairs] = radixSort(new Uint32Array(distance.buffer), pair);
    this.work += RADIX_LOOKS * count;
    this.first = { distance: new Float32Array(keys.buffer), pair: pairs };
    this.later = new Arrivals(this);
    this.shellsLeft = count;
  }

  // The lamp whose light reaches cell c next after lamp `after`'s, whose field-distance there is `than`:
  // the next brightest there, with the least field-distance above it, or as far off with a higher index.
  // -1 if there is none. Its field-distance, as a 32-bit float, is left in `nextDistance`. Counts one
  // comparison for each lamp looked at.
  nextLamp(c, after, than) {
    const { fields } = this;
    let next = -1;
    let nextDistance = Infinity;
    for (let j = 0; j < fields.length; j++) {
      const field = fields[j][c];
      if (!(field > 0)) continue;
      const distance = Math.fround(1 / Math.sqrt(field));
      if (distance < than || (distance === than && j <= after) || distance >= nextDistance) continue;
      next = j;
      nextDistance = distance;
    }
    this.work += fields.length;
    this.nextDistance = nextDistance;
    return next;
  }

  // Fill creatures for every lamp on the cells around it, and room for the creatures to come: per lamp, the
  // cells its creatures of each kind are on, and whether one is on a cell already.
  hatch() {
    const cells = this.size * this.size;
    const count = this.lamps.length;
    this.creatures = {
      fill: this.lamps.map(() => []),
      kill: this.lamps.map(() => []),
      filling: new Uint8Array(count * cells),
      killing: new Uint8Array(count * cells),
    };
    this.lamps.forEach(({ x, y }, i) => this.neighbours(y * this.size + x, (n) => this.queue('fill', i, n)));
    this.alive = { fill: this.creatures.fill.reduce((n, list) => n + list.length, 0), kill: 0 };
  }

  // A creature of `kind` for lamp i on cell c, unless one is there already.
  queue(kind, i, c) {
    const { creatures } = this;
    const on = kind === 'kill' ? creatures.killing : creatures.filling;
    const k = i * this.size * this.size + c;
    if (on[k]) return;
    on[k] = 1;
    creatures[kind][i].push(c);
  }

  // Calls `visit` with each of the up to eight cells around cell c, counting each as a comparison.
  neighbours(c, visit) {
    const { size } = this;
    const x = c % size;
    const y = (c - x) / size;
    for (let ny = Math.max(0, y - 1); ny <= Math.min(size - 1, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(size - 1, x + 1); nx++) {
        if (nx === x && ny === y) continue;
        this.work++;
        visit(ny * size + nx);
      }
    }
  }

  // Whether cell n lies behind its neighbour c as seen from lamp j: further from the lamp, so that the line
  // from the lamp to n can pass through c.
  behind(j, c, n) {
    const { size } = this;
    const { x, y } = this.lamps[j];
    return Math.hypot((n % size) - x, Math.floor(n / size) - y) > Math.hypot((c % size) - x, Math.floor(c / size) - y);
  }

  // Whether lamp i lights any of the eight cells `step` cells away from cell (x, y) along the rows, columns
  // and diagonals.
  near(i, x, y, step) {
    const { size, owner } = this;
    for (let sy = y - step; sy <= y + step; sy += step) {
      if (sy < 0 || sy >= size) continue;
      for (let sx = x - step; sx <= x + step; sx += step) {
        if (sx < 0 || sx >= size || (sx === x && sy === y)) continue;
        this.work++;
        if (owner[sy * size + sx] === i) return true;
      }
    }
    return false;
  }

  // Whether lamp i has a straight line of sight to cell (x, y), through the grid as it is or, in an
  // additional pass, as the last pass left it: no cell the line between the two cells' middles passes
  // through, short of (x, y), is lit by another lamp whose field there is at least as strong. Where the line
  // passes exactly through a corner, both cells beside the corner count.
  //
  // With `skipBlocks`, the line passes over the cells it has in a block that no other lamp lights, straight
  // to its last cell there, found from where it leaves the block: through the far column, the far row, or
  // the far corner.
  inSight(i, x, y) {
    const { size, fields, skipBlocks, blocksWide, blockLit } = this;
    const owner = this.sightFrom ?? this.owner;
    const field = fields[i];
    const blocks = (cx, cy) => {
      const c = cy * size + cx;
      const j = owner[c];
      this.work++;
      return j >= 0 && j !== i && fields[j][c] >= field[c];
    };
    const own = this.blockOwn;
    const ownFrom = i * blocksWide * blocksWide;
    const { x: lx, y: ly } = this.lamps[i];
    let cx = lx;
    let cy = ly;
    const nx = Math.abs(x - cx);
    const ny = Math.abs(y - cy);
    const sx = Math.sign(x - cx);
    const sy = Math.sign(y - cy);
    // The block last looked up, and whether cell (cx, cy) is yet to be looked at.
    let block = -1;
    let unchecked = false;
    for (let ix = 0, iy = 0; ix < nx || iy < ny; ) {
      if (skipBlocks) {
        const bx = cx >> BLOCK_BITS;
        const by = cy >> BLOCK_BITS;
        const b = by * blocksWide + bx;
        if (b !== block) {
          block = b;
          this.work++;
          if (blockLit[b] === own[ownFrom + b]) {
            if (x >> BLOCK_BITS === bx && y >> BLOCK_BITS === by) return true;
            // How many columns and rows the line has from the lamp to the block's far column and row.
            const farX = sx > 0 ? ((bx + 1) << BLOCK_BITS) - 1 - lx : lx - (bx << BLOCK_BITS);
            const farY = sy > 0 ? ((by + 1) << BLOCK_BITS) - 1 - ly : ly - (by << BLOCK_BITS);
            if (farX < nx && (farY >= ny || (2 * farX + 1) * ny <= (2 * farY + 1) * nx)) {
              iy = crossed(2 * farX + 1, ny, nx);
              ix = farX;
            } else {
              ix = crossed(2 * farY + 1, nx, ny);
              iy = farY;
            }
            cx = lx + sx * ix;
            cy = ly + sy * iy;
            unchecked = false;
          }
        }
      }
      if (unchecked && blocks(cx, cy)) return false;
      // Which the line crosses next: a column's edge, a row's, or both at a corner.
      const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (decision === 0) {
        if (blocks(cx + sx, cy) || blocks(cx, cy + sy)) return false;
        cx += sx;
        cy += sy;
        ix++;
        iy++;
      } else if (decision < 0) {
        cx += sx;
        ix++;
      } else {
        cy += sy;
        iy++;
      }
      unchecked = cx !== x || cy !== y;
    }
    return true;
  }
}
