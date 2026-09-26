import { ICOSAHEDRON } from './scene.js';

// Refinement of a triangle mesh by Phong tessellation (Boubekeur and Alexa, 2008). Every triangle is
// split into n² smaller ones, and the new vertices are placed on the smooth surface that the vertex
// normals describe, so that the outline and the shadows of the mesh follow the surface its shading
// shows. The original vertices stay where they are.

// How far new vertices move from the flat triangles onto the smooth surface; 3/4 as in the paper.
const SHAPE = 0.75;

export function phongTessellate({ positions, normals, indices }, n) {
  const outPositions = Array.from(positions);
  const outNormals = Array.from(normals);
  const at = (data, v) => [data[3 * v], data[3 * v + 1], data[3 * v + 2]];

  // The point of the smooth surface over the triangle `corners` at barycentric coordinates `weights`,
  // and its normal, interpolated.
  const add = (corners, weights) => {
    const q = [0, 1, 2].map((k) => weights.reduce((sum, w, m) => sum + w * at(positions, corners[m])[k], 0));
    const p = [0, 0, 0];
    const normal = [0, 0, 0];
    corners.forEach((v, m) => {
      const x = at(positions, v);
      const nx = at(normals, v);
      const height = (q[0] - x[0]) * nx[0] + (q[1] - x[1]) * nx[1] + (q[2] - x[2]) * nx[2];
      for (let k = 0; k < 3; k++) {
        p[k] += weights[m] * (q[k] - height * nx[k]);
        normal[k] += weights[m] * nx[k];
      }
    });
    const length = Math.hypot(...normal);
    outPositions.push(...p.map((value, k) => (1 - SHAPE) * q[k] + SHAPE * value));
    outNormals.push(...normal.map((value) => value / length));
    return outPositions.length / 3 - 1;
  };

  // New vertices along each edge, shared by the two triangles on it, listed from its lower vertex.
  const edges = new Map();
  const edge = (a, b) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo},${hi}`;
    if (!edges.has(key)) {
      edges.set(key, Array.from({ length: n - 1 }, (_, k) => add([lo, hi], [1 - (k + 1) / n, (k + 1) / n])));
    }
    const points = edges.get(key);
    return a < b ? points : [...points].reverse();
  };

  const outIndices = [];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const [ab, bc, ca] = [edge(a, b), edge(b, c), edge(c, a)];
    // grid[i][j] is the vertex at barycentric coordinates ((n - i - j) / n, i / n, j / n).
    const grid = Array.from({ length: n + 1 }, (_, i) => new Array(n + 1 - i));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        let v;
        if (i === 0 && j === 0) v = a;
        else if (i === n) v = b;
        else if (j === n) v = c;
        else if (j === 0) v = ab[i - 1];
        else if (i + j === n) v = bc[j - 1];
        else if (i === 0) v = ca[n - j - 1];
        else v = add([a, b, c], [(n - i - j) / n, i / n, j / n]);
        grid[i][j] = v;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        outIndices.push(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
        if (i + j < n - 1) outIndices.push(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
    }
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < outPositions.length; v += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], outPositions[v + k]);
      max[k] = Math.max(max[k], outPositions[v + k]);
    }
  }
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    indices: new Uint32Array(outIndices),
    bounds: { min, max },
  };
}

// A sphere of unit radius: an icosahedron with each triangle split n² ways and pushed out onto it.
export function sphereMesh(n) {
  const { vertices, faces } = ICOSAHEDRON;
  const unit = new Float32Array(vertices.flatMap((v) => v.map((x) => x / Math.hypot(...v))));
  const mesh = phongTessellate({ positions: unit, normals: unit, indices: new Uint32Array(faces.flat()) }, n);
  for (let v = 0; v < mesh.positions.length; v += 3) {
    const length = Math.hypot(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]);
    for (let k = 0; k < 3; k++) mesh.normals[v + k] = mesh.positions[v + k] /= length;
  }
  return { ...mesh, bounds: { min: [-1, -1, -1], max: [1, 1, 1] } };
}
