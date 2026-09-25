import { transformPoint } from './mat4.js';

// The vertices of Spot's refined mesh, as the points at which the optimiser measures how Spot is lit
// (see optimizer.js): in the world, with the unit normals of the side the lamps light, the area each
// stands for, how far the facets around it stray from the smooth surface (see litBy() in exact.glsl),
// and its neighbours along the mesh's edges, listed from offsets[v] to offsets[v + 1].
export function vertexSamples({ positions, normals, indices }, model) {
  const count = positions.length / 3;
  const world = new Float32Array(3 * count);
  for (let v = 0; v < count; v++) world.set(transformPoint(model, positions.subarray(3 * v, 3 * v + 3)), 3 * v);

  const areas = new Float32Array(count);
  const roughness = new Float32Array(count);
  const adjacent = Array.from({ length: count }, () => new Set());
  const at = (v) => world.subarray(3 * v, 3 * v + 3);
  const span = (a, b) => Math.hypot(at(a)[0] - at(b)[0], at(a)[1] - at(b)[1], at(a)[2] - at(b)[2]);
  for (let t = 0; t < indices.length; t += 3) {
    const corners = [indices[t], indices[t + 1], indices[t + 2]];
    const [a, b, c] = corners.map(at);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    const longest = Math.max(span(corners[0], corners[1]), span(corners[1], corners[2]), span(corners[2], corners[0]));
    corners.forEach((v, k) => {
      areas[v] += area / 3;
      roughness[v] = Math.max(roughness[v], 0.1 * longest);
      adjacent[v].add(corners[(k + 1) % 3]);
      adjacent[v].add(corners[(k + 2) % 3]);
    });
  }

  const offsets = new Int32Array(count + 1);
  adjacent.forEach((set, v) => (offsets[v + 1] = offsets[v] + set.size));
  const neighbours = new Int32Array(offsets[count]);
  adjacent.forEach((set, v) => neighbours.set([...set], offsets[v]));

  return {
    count,
    positions: world,
    normals: Float32Array.from(normals),
    areas,
    roughness,
    offsets,
    neighbours,
    totalArea: areas.reduce((sum, a) => sum + a, 0),
  };
}

// The samples as points of Renderer.createProbe(): each vertex is its own point on a facet, with its
// normal for the facet's, and its own point of the smooth surface.
export function probePoints({ positions, normals, roughness }) {
  return { positions, facets: normals, roughness, lifted: positions, normals };
}
