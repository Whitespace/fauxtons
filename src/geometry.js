// Queries of Spot's triangles on the CPU, for placing lamps: where a ray first meets the surface, the
// nearest point of the surface, and whether a point is inside. Triangles are in the world, 9 floats each.

const LEAF_SIZE = 8;

export function createGeometry(triangles) {
  const count = triangles.length / 9;
  const ids = new Uint32Array(count).map((_, t) => t);
  const centroid = (t, k) => (triangles[9 * t + k] + triangles[9 * t + 3 + k] + triangles[9 * t + 6 + k]) / 3;

  // Nodes as flat arrays: box, then either two children or a range of `ids`.
  const lo = [];
  const hi = [];
  const left = [];
  const right = [];
  const first = [];
  const size = [];
  const build = (start, end) => {
    const node = lo.length;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let n = start; n < end; n++) {
      for (let k = 0; k < 9; k++) {
        const v = triangles[9 * ids[n] + k];
        min[k % 3] = Math.min(min[k % 3], v);
        max[k % 3] = Math.max(max[k % 3], v);
      }
    }
    lo.push(min);
    hi.push(max);
    left.push(-1);
    right.push(-1);
    first.push(start);
    size.push(end - start);
    if (end - start > LEAF_SIZE) {
      const extent = [0, 1, 2].map((k) => max[k] - min[k]);
      const axis = extent.indexOf(Math.max(...extent));
      const part = Array.from(ids.subarray(start, end)).sort((a, b) => centroid(a, axis) - centroid(b, axis));
      ids.set(part, start);
      const mid = (start + end) >> 1;
      left[node] = build(start, mid);
      right[node] = build(mid, end);
    }
    return node;
  };
  build(0, count);

  const corner = (t, v, k) => triangles[9 * t + 3 * v + k];

  // Distance along the unit direction d from o to the triangle, or Infinity.
  function hit(t, o, d) {
    const e1 = [0, 1, 2].map((k) => corner(t, 1, k) - corner(t, 0, k));
    const e2 = [0, 1, 2].map((k) => corner(t, 2, k) - corner(t, 0, k));
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) return Infinity;
    const s = [0, 1, 2].map((k) => o[k] - corner(t, 0, k));
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1) return Infinity;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < 0 || u + v > 1) return Infinity;
    const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    return distance > 0 ? distance : Infinity;
  }

  function boxEntry(node, o, inv, tMax) {
    let t0 = 0;
    let t1 = tMax;
    for (let k = 0; k < 3; k++) {
      let a = (lo[node][k] - o[k]) * inv[k];
      let b = (hi[node][k] - o[k]) * inv[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) return Infinity;
    }
    return t0;
  }

  // The first hit of the ray from o along the unit direction d: its distance and triangle, or Infinity.
  function raycast(o, d, tMax = Infinity) {
    const inv = d.map((c) => 1 / c);
    let best = tMax;
    let triangle = -1;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop();
      if (boxEntry(node, o, inv, best) === Infinity) continue;
      if (left[node] < 0) {
        for (let n = first[node]; n < first[node] + size[node]; n++) {
          const t = hit(ids[n], o, d);
          if (t < best) {
            best = t;
            triangle = ids[n];
          }
        }
      } else {
        stack.push(left[node], right[node]);
      }
    }
    return { distance: triangle < 0 ? Infinity : best, triangle };
  }

  // Parity of the surface crossings along a ray in a direction no triangle edge lines up with.
  function inside(p) {
    const d = [0.5773, 0.5774, 0.5775];
    const length = Math.hypot(...d);
    const dir = d.map((c) => c / length);
    let crossings = 0;
    const inv = dir.map((c) => 1 / c);
    const stack = [0];
    while (stack.length) {
      const node = stack.pop();
      if (boxEntry(node, p, inv, Infinity) === Infinity) continue;
      if (left[node] < 0) {
        for (let n = first[node]; n < first[node] + size[node]; n++) {
          if (hit(ids[n], p, dir) < Infinity) crossings++;
        }
      } else {
        stack.push(left[node], right[node]);
      }
    }
    return crossings % 2 === 1;
  }

  // Closest point of triangle t to p (Ericson, Real-Time Collision Detection, 5.1.5).
  function closestOnTriangle(t, p) {
    const a = [corner(t, 0, 0), corner(t, 0, 1), corner(t, 0, 2)];
    const b = [corner(t, 1, 0), corner(t, 1, 1), corner(t, 1, 2)];
    const c = [corner(t, 2, 0), corner(t, 2, 1), corner(t, 2, 2)];
    const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const along = (u, v, s) => [u[0] + s * v[0], u[1] + s * v[1], u[2] + s * v[2]];
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p, a);
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
    const denom = 1 / (va + vb + vc);
    return along(along(a, ab, vb * denom), ac, vc * denom);
  }

  function boxDistance(node, p) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const e = Math.max(lo[node][k] - p[k], 0, p[k] - hi[node][k]);
      sum += e * e;
    }
    return Math.sqrt(sum);
  }

  // The nearest point of the surface to p, and its distance.
  function nearest(p) {
    let best = Infinity;
    let point = null;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop();
      if (boxDistance(node, p) >= best) continue;
      if (left[node] < 0) {
        for (let n = first[node]; n < first[node] + size[node]; n++) {
          const q = closestOnTriangle(ids[n], p);
          const distance = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          if (distance < best) {
            best = distance;
            point = q;
          }
        }
      } else {
        // The nearer child first, so the other is more often skipped.
        const [a, b] = [left[node], right[node]];
        if (boxDistance(a, p) < boxDistance(b, p)) stack.push(b, a);
        else stack.push(a, b);
      }
    }
    return { distance: best, point };
  }

  return { raycast, inside, nearest };
}
