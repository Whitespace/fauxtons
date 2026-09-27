// The 2D grid page (2d.html): place lamps by clicking, then spread their light a tick at a time by the flood
// fill, JFA, or fill and kill (sim.js). The page draws only when something changes, or while Show changed
// has cells blinking.

import { CUTOFF_ANGLE } from '../scene.js';
import { Grid, SIZE } from './sim.js';

const EMPTY = [30, 30, 34];
const LINES = 'rgb(0 0 0 / 0.5)';
const SPEEDS = [2, 5, 10, 30, 60];
// With Show changed, how long the changed cells stay white and then their own colour, in milliseconds.
const BLINK = 400;

const grid = new Grid();
const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const cells = document.createElement('canvas');
cells.width = SIZE;
cells.height = SIZE;
const cellContext = cells.getContext('2d');
const image = cellContext.createImageData(SIZE, SIZE);

const control = (name) => document.querySelector(`[data-control="${name}"]`);
const action = (name) => document.querySelector(`[data-action="${name}"]`);
const status = document.querySelector('.status');
const hint = document.querySelector('.hint');
const lostList = document.querySelector('.lost');
control('speed').replaceChildren(...SPEEDS.map((fps) => new Option(`${fps} fps`, fps)));

// A lamp placed but not yet aimed: its cell and colour. The pointer, in cells, for aiming it.
let pending = null;
let pointer = null;
// JFA's step for the next tick, and the one a reset goes back to: the last typed.
let firstStep = Number(control('step').value);
let step = firstStep;
// The pass under way, 1 for the first; whether its ticks have stopped changing anything; once an additional
// pass has settled, how many cells it changed from the pass before; and the comparisons made by the passes
// before this one (Grid.work in sim.js).
let pass = 1;
let settled = false;
let changedCells = null;
let earlierWork = 0;
let timer = null;
// The cells Show changed makes blink: once an additional pass has settled, those it changed from the pass
// before, and otherwise those the last tick changed. Whether they are showing white just now.
let changedNow = [];
let blinkOn = false;
let blinkTimer = null;

// CSS pixels, and device pixels, to a cell.
let pixels = 3;
let scale = 3;

const jfa = () => control('algorithm').value === 'jfa';
const life = () => control('algorithm').value === 'life';

function randomColor() {
  const hue = Math.random() * 360;
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (0.58 - 0.8 * 0.42 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

// Cells lit more weakly than a lamp's light at the tip of its arrow are drawn darker, by the log of the
// field, down to a quarter as bright.
const shadeOf = (field) => Math.min(1, Math.max(0.25, 1 + 0.12 * Math.log2(field)));

// The grid as large as fits, whole device pixels to a cell, leaving room below for the status and two lines
// of cells lost.
function fit() {
  const top = canvas.getBoundingClientRect().top;
  const room = Math.min(window.innerWidth - 32, window.innerHeight - top - 84);
  const ratio = window.devicePixelRatio || 1;
  scale = Math.max(2, Math.floor((room * ratio) / SIZE));
  pixels = scale / ratio;
  canvas.style.width = `${SIZE * pixels}px`;
  canvas.style.height = `${SIZE * pixels}px`;
  canvas.width = SIZE * scale;
  canvas.height = SIZE * scale;
  draw();
}

function draw() {
  const { data } = image;
  const { owner, lampAt, lamps, fields } = grid;
  const shade = control('shade').checked;
  for (let c = 0; c < SIZE * SIZE; c++) {
    const i = owner[c];
    const rgb = i >= 0 ? lamps[i].color : EMPTY;
    const s = i >= 0 && shade && lampAt[c] < 0 ? shadeOf(fields[i][c]) : 1;
    data[4 * c] = rgb[0] * s;
    data[4 * c + 1] = rgb[1] * s;
    data[4 * c + 2] = rgb[2] * s;
    data[4 * c + 3] = 255;
  }
  if (pending) data.set([...pending.color, 255], 4 * (pending.y * SIZE + pending.x));
  const blinking = control('changed').checked && blinkOn;
  if (blinking) for (const c of changedNow) data.set([255, 255, 255, 255], 4 * c);
  cellContext.putImageData(image, 0, 0);
  context.imageSmoothingEnabled = false;
  context.drawImage(cells, 0, 0, canvas.width, canvas.height);

  // The lines between cells, where cells are big enough to show them.
  if (scale >= 3) {
    context.fillStyle = LINES;
    for (let k = 0; k <= SIZE; k++) {
      context.fillRect(k * scale, 0, 1, canvas.height);
      context.fillRect(0, k * scale, canvas.width, 1);
    }
  }

  // Each lamp's cell outlined, and an arrow along its axis as long as the click that aimed it was far.
  for (const lamp of lamps) {
    outline(lamp.x, lamp.y);
    arrow(lamp.x, lamp.y, lamp.axis, lamp.reach);
  }
  if (pending) {
    outline(pending.x, pending.y);
    if (pointer) {
      const dx = pointer[0] - (pending.x + 0.5);
      const dy = pointer[1] - (pending.y + 0.5);
      const reach = Math.hypot(dx, dy);
      if (reach > 0.5) {
        const axis = [dx / reach, dy / reach];
        cone(pending.x, pending.y, axis, reach);
        arrow(pending.x, pending.y, axis, reach);
      }
    }
  }
}

// From the middle of cell (x, y), in device pixels.
const middle = (x, y) => [(x + 0.5) * scale, (y + 0.5) * scale];

function outline(x, y) {
  const width = Math.max(1, scale / 4);
  context.lineWidth = width;
  context.strokeStyle = 'white';
  context.strokeRect(x * scale - width / 2, y * scale - width / 2, scale + width, scale + width);
}

function arrow(x, y, axis, reach) {
  const [x0, y0] = middle(x, y);
  const length = reach * scale;
  const x1 = x0 + axis[0] * length;
  const y1 = y0 + axis[1] * length;
  const head = Math.min(0.4 * length, 5 * scale);
  const back = (angle) => [
    x1 - head * (axis[0] * Math.cos(angle) - axis[1] * Math.sin(angle)),
    y1 - head * (axis[1] * Math.cos(angle) + axis[0] * Math.sin(angle)),
  ];
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.moveTo(...back(0.45));
  context.lineTo(x1, y1);
  context.lineTo(...back(-0.45));
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const width = Math.max(1.5, scale / 2);
  context.lineWidth = 2.5 * width;
  context.strokeStyle = 'rgb(0 0 0 / 0.6)';
  context.stroke();
  context.lineWidth = width;
  context.strokeStyle = 'white';
  context.stroke();
}

// The edges of the lamp's cone, where its light is cut off, as far out as its arrow.
function cone(x, y, axis, reach) {
  const [x0, y0] = middle(x, y);
  const angle = (CUTOFF_ANGLE * Math.PI) / 180;
  context.beginPath();
  for (const side of [-1, 1]) {
    const c = Math.cos(side * angle);
    const s = Math.sin(side * angle);
    context.moveTo(x0, y0);
    context.lineTo(x0 + reach * scale * (axis[0] * c - axis[1] * s), y0 + reach * scale * (axis[1] * c + axis[0] * s));
  }
  context.setLineDash([2 * scale, 2 * scale]);
  context.lineWidth = Math.max(1, scale / 3);
  context.strokeStyle = 'rgb(255 255 255 / 0.5)';
  context.stroke();
  context.setLineDash([]);
}

// The pass and tick, JFA's next step while running, once an additional pass settles what it changed, and the
// comparisons made in this pass and, after the first, in all of them.
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
function report() {
  const parts = [`pass ${pass}`, `tick ${grid.tick}`];
  if (jfa() && !settled) parts.push(`step ${step}`);
  if (life() && !settled && grid.tick > 0) parts.push(`${grid.alive.fill.toLocaleString()} fill`, `${grid.alive.kill.toLocaleString()} kill`);
  if (settled) parts.push(changedCells === null ? 'settled' : changedCells ? `${changedCells.toLocaleString()} changed` : 'no change');
  parts.push(`${compact.format(grid.work)} comparisons`);
  if (pass > 1) parts.push(`${compact.format(earlierWork + grid.work)} in all`);
  status.textContent = parts.join(' · ');
  hint.textContent = pending
    ? 'Click where the lamp should face: the further from the lamp, the brighter. Esc cancels.'
    : 'Click a cell to place a lamp.';
  action('pass').disabled = !settled;
  listLost();
}

// For each lamp and each other lamp that took cells from it this pass, the brightest of those cells in its
// own field, brightest first.
function listLost() {
  const { lamps } = grid;
  const swatch = (i) => `<span class="swatch" style="background: rgb(${lamps[i].color.join(' ')})"></span>`;
  const number = (value) => Number(value.toPrecision(3)).toLocaleString();
  const pairs = [];
  lamps.forEach((_, a) => lamps.forEach((_, b) => grid.lost(a, b) > 0 && pairs.push({ a, b, value: grid.lost(a, b) })));
  pairs.sort((p, q) => q.value - p.value);
  lostList.innerHTML = pairs.length
    ? `lost ${pairs.map(({ a, b, value }) => `<span class="pair">${swatch(a)} to ${swatch(b)} ${number(value)}</span>`).join('')}`
    : '';
}

// One tick of the chosen algorithm. The pass has settled once a tick changes nothing, for JFA with its step
// halving at a step of 1, and for fill and kill once no creature is left alive.
function tick() {
  const halving = control('halve').checked;
  const used = step;
  const changed = jfa() ? grid.jump(used) : life() ? grid.life() : grid.flood();
  if (jfa() && halving) step = Math.max(1, Math.floor(step / 2));
  control('step').value = step;
  settled = life() ? grid.alive.fill + grid.alive.kill === 0 : changed === 0 && (!jfa() || !halving || used === 1);
  const before = settled && grid.sightFrom ? grid.sightFrom : grid.start;
  changedNow = [];
  grid.owner.forEach((v, c) => v !== before[c] && changedNow.push(c));
  if (settled && grid.sightFrom) changedCells = changedNow.length;
  blink();
  draw();
  report();
}

// With Show changed on and cells to show, the changed cells blink; otherwise nothing is drawn for it.
function blink() {
  const wanted = control('changed').checked && changedNow.length > 0;
  if (wanted && blinkTimer === null) {
    blinkTimer = setInterval(() => {
      blinkOn = !blinkOn;
      draw();
    }, BLINK);
  } else if (!wanted && blinkTimer !== null) {
    clearInterval(blinkTimer);
    blinkTimer = null;
    blinkOn = false;
  }
}

function run() {
  if (timer !== null || settled) return;
  action('run').textContent = 'Pause';
  action('run').setAttribute('aria-pressed', 'true');
  const next = () => {
    tick();
    if (settled) {
      stop();
      return;
    }
    timer = setTimeout(next, 1000 / Number(control('speed').value));
  };
  next();
}

function stop() {
  clearTimeout(timer);
  timer = null;
  action('run').textContent = 'Run';
  action('run').setAttribute('aria-pressed', 'false');
}

// Back to no light and the first pass, or with `sightFrom`, to no light for an additional pass that judges
// the line of sight against that grid.
function reset(sightFrom = null) {
  stop();
  earlierWork = sightFrom ? earlierWork + grid.work : 0;
  grid.sightFrom = sightFrom;
  grid.reset();
  pass = sightFrom ? pass + 1 : 1;
  step = firstStep;
  control('step').value = step;
  settled = false;
  changedCells = null;
  changedNow = [];
  blink();
  draw();
  report();
}

const cellOf = (event) => {
  const rect = canvas.getBoundingClientRect();
  return [(event.clientX - rect.left) / pixels, (event.clientY - rect.top) / pixels];
};

canvas.addEventListener('pointermove', (event) => {
  pointer = cellOf(event);
  if (pending) draw();
});
canvas.addEventListener('pointerleave', () => {
  pointer = null;
  if (pending) draw();
});
// A lamp in cell (x, y) aimed at the point `aim` cells from its middle, rounded to hundredths of a cell so
// that a link to the page gives it back exactly, with the power that makes its field on its axis there 1.
function aimedLamp(x, y, aim, color) {
  const [dx, dy] = aim.map((v) => Math.round(v * 100) / 100);
  const reach = Math.hypot(dx, dy);
  return { x, y, aim: [dx, dy], axis: [dx / reach, dy / reach], power: reach * reach, reach, color };
}

// The first click places a lamp in a free cell; the second aims it at the point clicked, so the further the
// click, the brighter the lamp.
canvas.addEventListener('click', (event) => {
  const [px, py] = cellOf(event);
  const x = Math.floor(px);
  const y = Math.floor(py);
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  if (!pending) {
    if (grid.lampAt[y * SIZE + x] >= 0) return;
    pending = { x, y, color: randomColor() };
  } else {
    const lamp = aimedLamp(pending.x, pending.y, [px - (pending.x + 0.5), py - (pending.y + 0.5)], pending.color);
    if (lamp.reach <= 0.5) return;
    grid.addLamp(lamp);
    pending = null;
    reset();
    return;
  }
  draw();
  report();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !pending) return;
  pending = null;
  draw();
  report();
});

action('tick').addEventListener('click', () => {
  stop();
  if (!settled) tick();
});
action('run').addEventListener('click', () => (timer !== null ? stop() : run()));
action('reset').addEventListener('click', () => reset());
// An additional pass starts from no light, judging the line of sight against the grid as it is now, and runs.
action('pass').addEventListener('click', () => {
  if (!settled) return;
  reset(Int16Array.from(grid.owner));
  run();
});
action('clear').addEventListener('click', () => {
  pending = null;
  grid.clearLamps();
  reset();
});
// JFA's own controls can wrap the bar onto another row, so the grid is fitted again.
control('algorithm').addEventListener('change', () => {
  for (const element of document.querySelectorAll('.jfa')) element.hidden = !jfa();
  reset();
  fit();
});
// A step typed in is used from the next tick, and a reset goes back to it. Either that or halving differently
// can give a settled pass more to do.
const resume = () => {
  settled = false;
  changedCells = null;
  report();
};
control('step').addEventListener('change', () => {
  const value = Math.round(Number(control('step').value));
  firstStep = step = Math.min(SIZE, Math.max(1, Number.isFinite(value) ? value : 1));
  control('step').value = step;
  resume();
});
control('halve').addEventListener('change', resume);
control('shade').addEventListener('change', draw);
control('changed').addEventListener('change', () => {
  blink();
  draw();
});
window.addEventListener('resize', fit);

// The lamps and settings as the page's address, e.g.
// #algorithm=jfa&step=128&halve=1&shade=1&changed=0&fps=60&lamps=64,128,71,0.43,8bea3e;206,135,-0.67,-21.9,3eddea
// with each lamp as its cell, where it was aimed from its middle in cells, and its colour. Opening one gives
// back the lamps and settings, with no light yet; anything missing is left as it is.
function stateHash() {
  const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  const lamps = grid.lamps.map(({ x, y, aim, color }) => [x, y, ...aim, hex(color)].join(',')).join(';');
  const flag = (name) => (control(name).checked ? 1 : 0);
  return `#algorithm=${control('algorithm').value}&step=${firstStep}&halve=${flag('halve')}&shade=${flag('shade')}&changed=${flag('changed')}&fps=${control('speed').value}&lamps=${lamps}`;
}

function applyHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (![...params.keys()].length) return;
  stop();
  pending = null;
  if (['flood', 'jfa', 'life'].includes(params.get('algorithm'))) control('algorithm').value = params.get('algorithm');
  for (const element of document.querySelectorAll('.jfa')) element.hidden = !jfa();
  const first = Math.round(Number(params.get('step')));
  if (first >= 1 && first <= SIZE) firstStep = first;
  for (const name of ['halve', 'shade', 'changed']) if (params.has(name)) control(name).checked = params.get(name) !== '0';
  if (SPEEDS.includes(Number(params.get('fps')))) control('speed').value = params.get('fps');
  if (params.has('lamps')) {
    grid.clearLamps();
    for (const text of params.get('lamps').split(';')) {
      const [x, y, dx, dy, color] = text.split(',');
      const cell = [Number(x), Number(y)];
      const aim = [Number(dx), Number(dy)];
      if (!cell.every((v) => Number.isInteger(v) && v >= 0 && v < SIZE) || !aim.every(Number.isFinite)) continue;
      if (grid.lampAt[cell[1] * SIZE + cell[0]] >= 0) continue;
      const rgb = /^[0-9a-f]{6}$/i.test(color ?? '') ? [0, 2, 4].map((k) => parseInt(color.slice(k, k + 2), 16)) : randomColor();
      const lamp = aimedLamp(...cell, aim, rgb);
      if (lamp.reach > 0.5) grid.addLamp(lamp);
    }
  }
  reset();
  fit();
}

// Copy URL puts the state in the address bar too, so that reloading keeps it.
const copyButton = action('copy');
copyButton.addEventListener('click', async () => {
  const url = new URL(location.href);
  url.hash = stateHash();
  history.replaceState(null, '', url);
  let label = 'Copied';
  try {
    await navigator.clipboard.writeText(url.href);
  } catch {
    label = 'Copy failed';
  }
  copyButton.textContent = label;
  clearTimeout(copyButton.reset);
  copyButton.reset = setTimeout(() => (copyButton.textContent = 'Copy URL'), 1200);
});
window.addEventListener('hashchange', () => applyHash(location.hash));

fit();
applyHash(location.hash);
report();
