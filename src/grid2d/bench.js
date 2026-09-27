// Times fill and kill on the CPU (sim.js) and on the GPU (gpu.js), headless, for the lamps of a link to
// 2d.html. In that page's console:
//
//   (await import('/src/grid2d/bench.js')).benchmark()
//
// Each is warmed up once, then timed `runs` times, alternating, keeping the fastest. A pass runs from no
// light until every creature has died; the second is an additional pass, judging the line of sight against
// the first pass's grid, as the page runs it. Setting up (the lamps' fields, and on the GPU compiling and
// uploading) is timed apart.

import { GpuLife } from './gpu.js';
import { Grid, lampsOfLink } from './sim.js';

function cpuPass(lamps, sightFrom) {
  const grid = new Grid();
  lamps.forEach((lamp) => grid.addLamp(lamp));
  grid.sightFrom = sightFrom;
  grid.reset();
  const start = performance.now();
  do grid.life(false);
  while (grid.alive.fill + grid.alive.kill > 0);
  return { ms: performance.now() - start, ticks: grid.tick, comparisons: grid.work, owner: Int32Array.from(grid.owner) };
}

function gpuPass(gpu, sightFrom) {
  const start = performance.now();
  const generations = gpu.run(sightFrom);
  return { ms: performance.now() - start, ticks: generations, owner: gpu.readOwners() };
}

export function benchmark(hash = location.hash, runs = 5) {
  const lamps = lampsOfLink(new URLSearchParams(hash.replace(/^#/, '')).get('lamps') ?? '');
  if (!lamps.length) throw new Error('No lamps in the link.');
  const differing = (a, b) => a.reduce((n, v, c) => n + (v !== b[c]), 0);

  let start = performance.now();
  const grid = new Grid();
  lamps.forEach((lamp) => grid.addLamp(lamp));
  const fieldsMs = performance.now() - start;
  start = performance.now();
  const gpu = new GpuLife(grid);
  gpu.run();
  const gpuSetupMs = performance.now() - start;

  const best = (a, b) => (!a || b.ms < a.ms ? b : a);
  let cpu1, cpu2, gpu1, gpu2;
  cpuPass(lamps, null);
  for (let k = 0; k < runs; k++) {
    cpu1 = best(cpu1, cpuPass(lamps, null));
    gpu1 = best(gpu1, gpuPass(gpu, null));
    cpu2 = best(cpu2, cpuPass(lamps, cpu1.owner));
    gpu2 = best(gpu2, gpuPass(gpu, gpu1.owner));
  }
  const round = (ms) => Math.round(ms * 10) / 10;
  return {
    lamps: lamps.length,
    setup: { fieldsMs: round(fieldsMs), gpuCompileAndFirstRunMs: round(gpuSetupMs) },
    cpu: { pass1: { ms: round(cpu1.ms), ticks: cpu1.ticks }, pass2: { ms: round(cpu2.ms), ticks: cpu2.ticks, changed: differing(cpu2.owner, cpu1.owner) } },
    gpu: { pass1: { ms: round(gpu1.ms), generations: gpu1.ticks }, pass2: { ms: round(gpu2.ms), generations: gpu2.ticks, changed: differing(gpu2.owner, gpu1.owner) } },
    cellsDifferingCpuFromGpu: { pass1: differing(cpu1.owner, gpu1.owner), pass2: differing(cpu2.owner, gpu2.owner) },
  };
}
