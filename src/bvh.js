// Bounding volume hierarchy over world-space triangles (9 floats each), flattened for the GPU (see
// spotBlocks() in exact.glsl). Nodes are stored depth first, each with the index of the node after its
// subtree, so a walk that misses a node's box jumps there and needs no stack.
//
// Per node, two RGBA texels: (min, next) and (max, leaf), where leaf is -1 for an inner node and
// first * 8 + count for a leaf of `count` triangles from `first`. Per triangle, three RGBA texels: a
// corner and the two edges from it.

const LEAF_SIZE = 4;

export function buildBvh(triangles) {
  const count = triangles.length / 9;
  const centroids = new Float32Array(3 * count);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      centroids[3 * t + k] = (triangles[9 * t + k] + triangles[9 * t + 3 + k] + triangles[9 * t + 6 + k]) / 3;
    }
  }

  const nodes = [];
  const order = [];
  const build = (ids) => {
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], next: 0, leaf: -1 };
    nodes.push(node);
    for (const t of ids) {
      for (let k = 0; k < 9; k++) {
        node.min[k % 3] = Math.min(node.min[k % 3], triangles[9 * t + k]);
        node.max[k % 3] = Math.max(node.max[k % 3], triangles[9 * t + k]);
      }
    }
    if (ids.length <= LEAF_SIZE) {
      node.leaf = order.length * 8 + ids.length;
      order.push(...ids);
    } else {
      // Split at the median along the axis on which the triangles' centroids spread most.
      const spread = [0, 1, 2].map((k) => {
        const values = ids.map((t) => centroids[3 * t + k]);
        return Math.max(...values) - Math.min(...values);
      });
      const axis = spread.indexOf(Math.max(...spread));
      ids.sort((a, b) => centroids[3 * a + axis] - centroids[3 * b + axis]);
      const mid = ids.length >> 1;
      build(ids.slice(0, mid));
      build(ids.slice(mid));
    }
    node.next = nodes.length;
  };
  build(Array.from({ length: count }, (_, t) => t));

  const nodeData = new Float32Array(8 * nodes.length);
  nodes.forEach((node, i) => nodeData.set([...node.min, node.next, ...node.max, node.leaf], 8 * i));
  const triangleData = new Float32Array(12 * count);
  order.forEach((t, i) => {
    const corner = (v, k) => triangles[9 * t + 3 * v + k];
    const edge = (v) => [0, 1, 2].map((k) => corner(v, k) - corner(0, k));
    triangleData.set([corner(0, 0), corner(0, 1), corner(0, 2), 0, ...edge(1), 0, ...edge(2), 0], 12 * i);
  });
  return { nodes: nodeData, triangles: triangleData };
}
