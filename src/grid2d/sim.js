// Fauxton light on a square grid of cells (2d.html), spread a tick at a time by one of two algorithms.
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
//
// In a lamp's turn of the first two, every cell is decided from the grid as the turn found it; creatures
// act on the grid as the creatures before them left it. All three note for every lamp A and every other lamp
// B the brightest cell B took from A: A's field there, when A had it.
//
// An additional pass runs either again from no light, but judges the line of sight against the grid as the
// last pass left it (`sightFrom`) rather than as this pass goes.
//
// `work` counts the comparisons a pass makes, one for each time it looks at a cell of the grid: deciding a
// cell in a lamp's turn or a creature's move, looking at one of the eight cells around it, and following a
// line of sight, one for each cell on the line.

import { P_MIN, beamProfile } from '../scene.js';

export const SIZE = 256;

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
    // For an additional pass, the grid its line of sight is judged against; null for the first pass.
    this.sightFrom = null;
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
      const { owner, next } = this;
      const field = fields[i];
      this.work += size * size;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const c = y * size + x;
          const had = owner[c];
          next[c] = had;
          if (lampAt[c] >= 0 || had === i || field[c] <= (had >= 0 ? fields[had][c] : 0)) continue;
          if (!this.near(i, x, y, step) || !this.inSight(i, x, y)) continue;
          next[c] = i;
          if (had >= 0 && fields[had][c] > losses[had * count + i]) losses[had * count + i] = fields[had][c];
        }
      }
      [this.owner, this.next] = [this.next, this.owner];
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
  inSight(i, x, y) {
    const { size, fields } = this;
    const owner = this.sightFrom ?? this.owner;
    const field = fields[i];
    const blocks = (cx, cy) => {
      const c = cy * size + cx;
      const j = owner[c];
      this.work++;
      return j >= 0 && j !== i && fields[j][c] >= field[c];
    };
    let cx = this.lamps[i].x;
    let cy = this.lamps[i].y;
    const nx = Math.abs(x - cx);
    const ny = Math.abs(y - cy);
    const sx = Math.sign(x - cx);
    const sy = Math.sign(y - cy);
    for (let ix = 0, iy = 0; ix < nx || iy < ny; ) {
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
      if ((cx !== x || cy !== y) && blocks(cx, cy)) return false;
    }
    return true;
  }
}
