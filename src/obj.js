// Minimal Wavefront OBJ reader: positions and faces only, with smooth area-weighted normals.

export function parseObj(text) {
  const positions = [];
  const indices = [];

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v') {
      positions.push(+parts[1], +parts[2], +parts[3]);
    } else if (parts[0] === 'f') {
      const face = parts.slice(1).map((vertex) => parseInt(vertex, 10) - 1);
      for (let k = 1; k + 1 < face.length; k++) indices.push(face[0], face[k], face[k + 1]);
    }
  }

  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const e1 = [0, 1, 2].map((k) => positions[b + k] - positions[a + k]);
    const e2 = [0, 1, 2].map((k) => positions[c + k] - positions[a + k]);
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v + k] += n[k];
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    for (let k = 0; k < 3; k++) normals[v + k] /= l;
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[v + k]);
      max[k] = Math.max(max[k], positions[v + k]);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals,
    indices: new Uint32Array(indices),
    bounds: { min, max },
  };
}
