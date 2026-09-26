import { irradiance, patchesOf } from './optimizer.js';
import { MM_PER_UNIT } from './scene.js';

// How the milky resin of the shell spreads the light that reaches it, at each vertex of the surface
// (samples.js), for viewing only: nothing is measured with it, as no amount of spreading should be relied
// on to light what no lamp can see.
//
// Light scatters sideways through the shell as it crosses it, and leaks out of both faces as it goes. In a
// thin sheet that is diffusion with loss, the screened Poisson equation M - ℓ² ΔM = E for the light E
// arriving and M leaving, where ℓ is how far light spreads before it leaves: most of it comes out within
// 2ℓ of where it went in, which a laser pointer shone through a piece of the shell would show. The
// subsurface scattering of physically based rendering (Burley's normalised diffusion, for one) models the
// same spreading in thick material. Light stays in its cell, as the walls between cells stop it and send
// it back, so a cell gives out just what it takes in.
//
// ΔM is the mesh's cotangent Laplacian, with each vertex standing for its area.
export function createDiffusion(samples, indices) {
  const { count, areas, offsets, neighbours } = samples;
  const weights = cotangentWeights(samples, indices);

  return {
    // The light leaving every vertex, from the light E arriving there and the cell `owner` it is in, with
    // `spread` (ℓ) in millimetres. Vertices in no cell (-1) keep what arrives.
    apply(owner, E, spread) {
      const ell = spread / MM_PER_UNIT;
      return ell > 0 ? solveScreened(E, owner, ell * ell) : Float32Array.from(E);
    },
  };

  // (A + s L) M = A E by conjugate gradients with a Jacobi preconditioner, where A holds the vertices'
  // areas and L the Laplacian without the edges between cells.
  function solveScreened(E, owner, s) {
    const diagonal = new Float64Array(count);
    for (let v = 0; v < count; v++) {
      let sum = 0;
      if (owner[v] >= 0) {
        for (let k = offsets[v]; k < offsets[v + 1]; k++) if (owner[neighbours[k]] === owner[v]) sum += weights[k];
      }
      diagonal[v] = areas[v] + s * sum;
    }
    const multiply = (x, out) => {
      for (let v = 0; v < count; v++) {
        let y = areas[v] * x[v];
        if (owner[v] >= 0) {
          for (let k = offsets[v]; k < offsets[v + 1]; k++) {
            const u = neighbours[k];
            if (owner[u] === owner[v]) y += s * weights[k] * (x[v] - x[u]);
          }
        }
        out[v] = y;
      }
    };
    const x = Float64Array.from(E);
    const r = new Float64Array(count);
    const z = new Float64Array(count);
    const p = new Float64Array(count);
    const q = new Float64Array(count);
    multiply(x, q);
    let norm = 0;
    for (let v = 0; v < count; v++) {
      r[v] = areas[v] * E[v] - q[v];
      norm += (areas[v] * E[v]) ** 2;
    }
    const tolerance = 1e-12 * norm;
    let rz = 0;
    for (let v = 0; v < count; v++) {
      z[v] = r[v] / diagonal[v];
      p[v] = z[v];
      rz += r[v] * z[v];
    }
    for (let iteration = 0; iteration < 1000; iteration++) {
      multiply(p, q);
      let pq = 0;
      for (let v = 0; v < count; v++) pq += p[v] * q[v];
      const alpha = rz / pq;
      let rr = 0;
      for (let v = 0; v < count; v++) {
        x[v] += alpha * p[v];
        r[v] -= alpha * q[v];
        rr += r[v] * r[v];
      }
      if (rr <= tolerance) break;
      let next = 0;
      for (let v = 0; v < count; v++) {
        z[v] = r[v] / diagonal[v];
        next += r[v] * z[v];
      }
      const beta = next / rz;
      rz = next;
      for (let v = 0; v < count; v++) p[v] = z[v] + beta * p[v];
    }
    return Float32Array.from(x);
  }
}

// The cotangent weight of every edge, (cot α + cot β) / 2 for the angles facing it, aligned with the
// samples' neighbour lists. Weights of edges facing obtuse angles, which can come out negative, are kept
// at zero, so that light only ever flows from brighter to dimmer.
function cotangentWeights({ positions, offsets, neighbours }, indices) {
  const weights = new Float64Array(neighbours.length);
  const slot = (a, b) => {
    for (let k = offsets[a]; k < offsets[a + 1]; k++) if (neighbours[k] === b) return k;
    return -1;
  };
  const at = (v, k) => positions[3 * v + k];
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e];
      const b = indices[t + ((e + 1) % 3)];
      const o = indices[t + ((e + 2) % 3)];
      const u = [0, 1, 2].map((k) => at(a, k) - at(o, k));
      const w = [0, 1, 2].map((k) => at(b, k) - at(o, k));
      const crossed = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
      if (crossed === 0) continue;
      const cot = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / crossed;
      const ab = slot(a, b);
      const ba = slot(b, a);
      if (ab >= 0) weights[ab] += cot / 2;
      if (ba >= 0) weights[ba] += cot / 2;
    }
  }
  for (let k = 0; k < weights.length; k++) weights[k] = Math.max(0, weights[k]);
  return weights;
}

// The cell of every vertex, its lamp's patch (patchesOf() in optimizer.js), and the light arriving there,
// from the probe's findings (probe.frag).
export function cellsOf(samples, lamps, lit) {
  const { count, positions, normals } = samples;
  const owner = patchesOf(samples, lit);
  const E = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    const i = lit[4 * v];
    if (i >= 0) E[v] = irradiance(lamps[i], positions.subarray(3 * v, 3 * v + 3), normals.subarray(3 * v, 3 * v + 3));
  }
  return { owner, E };
}
