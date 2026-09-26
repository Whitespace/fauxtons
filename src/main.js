import { TurntableCamera } from './camera.js';
import { clusterLayout } from './clusters.js';
import { contrastColors } from './colors.js';
import { cellsOf, createDiffusion } from './diffusion.js';
import { createGeometry } from './geometry.js';
import { phongTessellate, sphereMesh } from './mesh.js';
import { parseObj } from './obj.js';
import { LayoutOptimizer, interiorPlaces, measure } from './optimizer.js';
import { Renderer, SHADER_FILES } from './renderer.js';
import { probePoints, vertexSamples } from './samples.js';
import {
  CUTOFF_ANGLE,
  DARK_ANGLE,
  HALF_BRIGHT_ANGLE,
  ORB_DIAMETER,
  ORB_REFINEMENT,
  P_MAX,
  SPOT_HEIGHT,
  SPOT_REFINEMENT,
  createLayout,
  icosahedronLamps,
  orbLamps,
  standingModel,
} from './scene.js';
import { decodeView, encodeView } from './view-state.js';

const deg = Math.PI / 180;

// Lamp counts on offer in Spot, and the one shown first.
const COUNTS = [20, 32, 48, 64, 96, 128];
const DEFAULT_COUNT = 64;

// How far light spreads sideways in the shell, in millimetres, for viewing (diffusion.js).
const SPREADS = [0, 1, 2, 4, 8, 16];

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}`);
  return response.text();
}

async function main() {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available.');
  canvas.addEventListener('webglcontextlost', () => (document.body.dataset.error = 'The GPU reset the page’s WebGL context. Reload to carry on.'));

  // The scene is Spot, whose lamps can be placed and optimised, or the orb, whose lamps are as built.
  const orb = decodeView(location.hash).options.scene === 'orb';
  const [obj, ...sources] = await Promise.all([
    orb ? null : fetchText('spot_triangulated.obj'),
    ...SHADER_FILES.map((name) => fetchText(`src/shaders/${name}`)),
  ]);
  const shaders = Object.fromEntries(SHADER_FILES.map((name, k) => [name, sources[k]]));
  // The lamps are inside, so the sides of the walls that they light face inwards.
  const mesh = orb ? sphereMesh(ORB_REFINEMENT) : phongTessellate(parseObj(obj), SPOT_REFINEMENT);
  mesh.normals.forEach((value, k) => (mesh.normals[k] = -value));
  const model = standingModel(mesh.bounds, orb ? ORB_DIAMETER : SPOT_HEIGHT);
  const renderer = new Renderer(gl, shaders, mesh, model, createLayout(orb ? orbLamps() : icosahedronLamps([0, 10.31, -0.03], 0.5)));

  // The surface's vertices, where the lighting is measured, and its triangles on the CPU for placing lamps.
  const samples = vertexSamples(mesh, model);
  const geometry = createGeometry(renderer.spotTriangles);
  const probe = renderer.createProbe(probePoints(samples));
  const diffusion = createDiffusion(samples, mesh.indices);
  let places = null;

  // Right round the scene, short of straight above or below, where the turntable's up direction is lost.
  const camera = new TurntableCamera(canvas, {
    target: orb ? [0, ORB_DIAMETER / 2, 0] : [0, 10.3, 0],
    azimuth: 202 * deg,
    elevation: 15 * deg,
    distance: orb ? 60 : 55,
    fovy: 40 * deg,
    minElevation: -89 * deg,
    maxElevation: 89 * deg,
    minDistance: 3,
    maxDistance: 150,
  });

  // spot: show the surface (its walls stop the light either way). bounds: draw the boundaries of the lit
  // volumes instead of the light in the air. opaque: draw the veils and boundaries as solid sheets, and
  // opaque2: the same from the boundary meshes. cull: show only the cell each pixel's view meets first.
  const options = { spot: true, veil: true, bounds: false, opaque: false, opaque2: false, cull: false, count: DEFAULT_COUNT, scene: orb ? 'orb' : 'spot', spread: 0 };
  const toggles = new Map([...document.querySelectorAll('[data-toggle]')].map((button) => [button.dataset.toggle, button]));
  const setOption = (key, value) => {
    options[key] = value;
    toggles.get(key).setAttribute('aria-pressed', String(value));
  };
  // The two opaque modes draw the same walls two ways, so turning one on turns the other off.
  const rival = { opaque: 'opaque2', opaque2: 'opaque' };
  for (const [key, button] of toggles) {
    button.addEventListener('click', () => {
      setOption(key, !options[key]);
      if (options[key] && rival[key]) setOption(rival[key], false);
    });
  }

  const control = (name) => document.querySelector(`[data-control="${name}"]`);
  const readout = document.querySelector('.readout');
  const countPicker = control('count');
  const spreadPicker = control('spread');
  const scenePicker = control('scene');
  const optimizeButton = document.querySelector('[data-action="optimize"]');
  countPicker.replaceChildren(...COUNTS.map((n) => new Option(`${n} lamps`, n)));
  spreadPicker.replaceChildren(...SPREADS.map((mm) => new Option(mm ? `Spread ${mm} mm` : 'No spread', mm)));
  scenePicker.value = options.scene;
  // The orb's lamps are where they were built.
  for (const element of [countPicker, optimizeButton, ...document.querySelectorAll('[data-action="reset"], [data-action="save-layout"]')]) element.hidden = orb;

  // The layout shown, as the optimiser keeps it (LayoutOptimizer.saveable()), how well it lights the
  // surface, and what the probe found for it, for diffusing its light.
  let layout = null;
  let optimizer = null;
  let loading = null;
  let found = null;

  // How much of the surface is dark, and how evenly each patch is lit: its brightest point over its
  // darkest (patchContrast() in optimizer.js), always from the light arriving.
  const pct = (v) => `${(100 * v).toFixed(v < 0.1 ? 1 : 0)}%`;
  const times = (v) => `${v.toFixed(v < 10 ? 1 : 0)}×`;
  const describe = (m, prefix = '') =>
    `${prefix}${pct(m.dark)} dark · black spots in ${m.black}/${m.patches} patches · brightest/darkest ${times(m.contrast)} median, ${times(m.contrastWorst)} worst`;
  const metricsOf = (m) => ({ dark: m.darkArea / m.totalArea, patches: m.patches, black: m.black, contrast: m.contrast, contrastWorst: m.contrastWorst, cost: m.cost });

  // Shows the light leaving the shell with the spread chosen, or with none the light arriving.
  const diffuse = () => {
    if (!found || !layout?.metrics) return;
    readout.textContent = describe(layout.metrics);
    if (!options.spread) {
      renderer.setDiffusion(null);
      return;
    }
    const { owner, E } = cellsOf(samples, found.lamps, found.lit);
    renderer.setDiffusion({ owner, light: diffusion.apply(owner, E, options.spread) });
  };

  // Shows a layout at full resolution and measures it. Lamps without colours, and all of them with
  // `recolor`, get colours that differ between patches that meet.
  const show = (next, { recolor = false } = {}) => {
    layout = next;
    const described = createLayout(next.lamps);
    renderer.setLayout(described);
    renderer.solve();
    const lit = Float32Array.from(probe.run());
    found = { lamps: described.lamps, lit };
    const measured = measure(samples, described.lamps, lit);
    layout.metrics = metricsOf(measured);
    if (recolor || next.lamps.some((lamp) => !lamp.color)) {
      const colors = contrastColors(samples, measured.owner, next.lamps.length);
      next.lamps.forEach((lamp, i) => (lamp.color = colors[i]));
      renderer.setColors(colors);
    }
    diffuse();
    return measured;
  };

  // Places `count` lamps afresh, in clusters where they can see most of Spot (clusters.js).
  const placeLamps = (count) => {
    places ??= interiorPlaces(samples, geometry);
    show(clusterLayout({ renderer, samples, geometry, places, count }));
  };

  // The saved layout for `count` lamps if there is one, else lamps placed afresh in clusters.
  const useCount = async (count) => {
    stopOptimizing(false);
    options.count = count;
    countPicker.value = String(count);
    readout.textContent = `Placing ${count} lamps…`;
    const request = (loading = count);
    let next = null;
    try {
      const response = await fetch(`layouts/${count}.json`);
      if (response.ok) next = await response.json();
    } catch {
      next = null;
    }
    // Let the readout paint before the work.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    if (request !== loading) return;
    if (next) show(next);
    else placeLamps(count);
  };

  // While optimising, the surface shows the light arriving, as the diffusion is of the layout last shown.
  const startOptimizing = () => {
    if (!layout) return;
    optimizer = new LayoutOptimizer({ renderer, samples, geometry, layout });
    optimizeButton.setAttribute('aria-pressed', 'true');
    found = null;
    renderer.setDiffusion(null);
  };
  // Stops, keeping the best layout found, shown at full resolution.
  function stopOptimizing(keep = true) {
    if (!optimizer) return;
    const best = optimizer.best?.layout;
    optimizer.dispose();
    optimizer = null;
    optimizeButton.setAttribute('aria-pressed', 'false');
    if (keep && best) show(best, { recolor: true });
  }
  optimizeButton.addEventListener('click', () => (optimizer ? stopOptimizing() : startOptimizing()));
  countPicker.addEventListener('change', () => useCount(Number(countPicker.value)));
  document.querySelector('[data-action="reset"]').addEventListener('click', () => {
    stopOptimizing(false);
    placeLamps(options.count);
  });
  // The picker offers SPREADS; a link can ask for any other.
  const setSpread = (spread) => {
    options.spread = spread >= 0 ? spread : options.spread;
    spreadPicker.value = String(options.spread);
    diffuse();
  };
  spreadPicker.addEventListener('change', () => setSpread(Number(spreadPicker.value)));
  // A scene is built for its surface, so another one starts the page afresh.
  scenePicker.addEventListener('change', () => {
    location.hash = `scene=${scenePicker.value}`;
    location.reload();
  });

  const flash = (button, label, rest) => {
    button.textContent = label;
    clearTimeout(button.reset);
    button.reset = setTimeout(() => (button.textContent = rest), 1200);
  };
  const copy = async (button, text, rest) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(button, 'Copied', rest);
    } catch {
      flash(button, 'Copy failed', rest);
    }
  };
  const copyLink = document.querySelector('[data-action="copy-link"]');
  copyLink.addEventListener('click', () => {
    const url = new URL(location.href);
    url.hash = encodeView(camera, options);
    history.replaceState(null, '', url);
    copy(copyLink, url.href, 'Copy link');
  });
  const copyLayout = document.querySelector('[data-action="copy-layout"]');
  copyLayout.addEventListener('click', () => copy(copyLayout, formatLayout(exportLayout(layout)), 'Copy layout'));
  // Saves the layout shown as the one for its number of lamps, through the development server.
  const saveLayout = document.querySelector('[data-action="save-layout"]');
  saveLayout.addEventListener('click', async () => {
    if (!layout) return;
    let label = 'Saved';
    try {
      const response = await fetch(`layouts/${layout.lamps.length}.json`, { method: 'PUT', body: formatLayout(exportLayout(layout)) });
      if (!response.ok) label = 'Save failed';
    } catch {
      label = 'Save failed';
    }
    flash(saveLayout, label, 'Save');
  });

  const applyView = (hash) => {
    const view = decodeView(hash);
    if ((view.options.scene ?? options.scene) !== options.scene) {
      location.reload();
      return;
    }
    camera.jumpTo({ ...camera.goal, ...view.camera });
    for (const [key, value] of Object.entries(view.options)) if (value !== undefined && toggles.has(key)) setOption(key, value);
    if (orb) {
      if (!layout) show({ lamps: orbLamps(), centers: [] });
    } else {
      const count = COUNTS.includes(view.options.count) ? view.options.count : options.count;
      if (count !== options.count || !layout) useCount(count);
    }
    setSpread(view.options.spread ?? options.spread);
  };
  applyView(location.hash);
  window.addEventListener('hashchange', () => applyView(location.hash));

  const fps = document.querySelector('.fps');
  let frames = 0;
  let windowStart = performance.now();
  let last = windowStart;

  function frame(now) {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // While optimising, one round per frame; each is a solve at low resolution and a measurement.
    if (optimizer) {
      try {
        const record = optimizer.iterate();
        readout.textContent = describe(record, `Round ${record.iteration + 1}: `);
      } catch (error) {
        console.error(error);
        stopOptimizing(false);
        readout.textContent = error.message;
      }
    }

    const moved = camera.update(Math.min((now - last) / 1000, 0.1));
    last = now;
    // Frames stop being drawn once a still view has settled (Renderer.render).
    if (renderer.render(camera, options, moved || !!optimizer)) frames++;

    if (now - windowStart >= 500) {
      fps.textContent = frames ? `${Math.round((frames * 1000) / (now - windowStart))} fps` : 'idle';
      frames = 0;
      windowStart = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Console hooks: fauxton.check() compares the solution in the air with the README's recursive
  // definition and fauxton.checkSurfaces() which lamp lights the surface. fauxton.place(settings) places
  // the lamps afresh, with settings for clusterLayout() such as maxClusters. fauxton.optimize(rounds) runs
  // the optimiser without drawing, carrying on from where the last call stopped; keep each call to a few
  // seconds, as the GPU drops the page's context when kept busy too long. fauxton.finish() shows the best
  // layout found, and fauxton.layout() gives the layout shown as saved in layouts/.
  let batch = null;
  window.fauxton = {
    check: (count, bounds) => renderer.check(count, bounds),
    checkSurfaces: (candidates, limit, step) => renderer.checkSurfaces(candidates, limit, step),
    place: (settings = {}) => {
      stopOptimizing(false);
      places ??= interiorPlaces(samples, geometry);
      show(clusterLayout({ renderer, samples, geometry, places, count: options.count, ...settings }));
      return { clusters: layout.centers.length, ...layout.metrics };
    },
    optimize: (rounds, settings = {}) => {
      stopOptimizing(false);
      if (batch && batch.base !== layout) {
        batch.dispose();
        batch = null;
      }
      if (!batch) {
        batch = new LayoutOptimizer({ renderer, samples, geometry, layout });
        batch.base = layout;
      }
      Object.assign(batch, settings);
      let record = null;
      for (let k = 0; k < rounds; k++) record = batch.iterate();
      const { measured, ...rest } = record;
      return { ...rest, best: batch.best.cost };
    },
    finish: () => {
      if (!batch) return layout.metrics;
      const best = batch.best.layout;
      batch.dispose();
      batch = null;
      show(best, { recolor: true });
      return layout.metrics;
    },
    layout: () => exportLayout(layout),
  };
}

// A layout as saved in layouts/: its measurements, its clusters' places, and per lamp where it is, where
// it points, its power and that as a dimmer setting, the share of full power, and its colour here.
function exportLayout({ metrics, centers, lamps }) {
  const round = (v) => Math.round(v * 1e4) / 1e4;
  return {
    count: lamps.length,
    beam: { halfBright: HALF_BRIGHT_ANGLE, dark: DARK_ANGLE, cutoff: CUTOFF_ANGLE },
    metrics: Object.fromEntries(Object.entries(metrics ?? {}).map(([key, value]) => [key, round(value)])),
    centers: centers.map((center) => center.map(round)),
    lamps: lamps.map(({ position, axis, power, cluster, color }) => ({
      position: position.map(round),
      axis: axis.map(round),
      power: round(power),
      dimmer: round(power / P_MAX),
      cluster,
      ...(color ? { color: color.map(round) } : {}),
    })),
  };
}

// JSON with one lamp to a line.
function formatLayout({ lamps, centers, ...rest }) {
  const list = (items) => items.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
  const head = Object.entries(rest).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  return ['{', ...head, '  "centers": [', list(centers), '  ],', '  "lamps": [', list(lamps), '  ]', '}', ''].join('\n');
}

main().catch((error) => {
  console.error(error);
  document.body.dataset.error = error.message;
});
