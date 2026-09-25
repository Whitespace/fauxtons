import { cross, multiply, normalize, perspective, sub, viewFromBasis } from './mat4.js';

// Model constants from the README.
export const RANGE = 18;
export const P_MIN = 0.01;

// Texels per side of each lamp's direction map.
export const MAP_SIZE = 1024;

// How far short of a surface the renderer last tests whether a lamp's light gets there, relative to
// the distance from the lamp (see exact.glsl): enough to clear the surface itself.
export const SURFACE_GAP = 1e-4;

export const SPOT_HEIGHT = 24;
// Spot's triangles are several centimetres across, which shows in its outline and its shadows, so each
// is split into SPOT_REFINEMENT² smaller ones on the smooth surface its normals describe (see mesh.js).
export const SPOT_REFINEMENT = 4;
export const SPOT_ALBEDO = [0.72, 0.7, 0.66];
export const GROUND_ALBEDO = [0.36, 0.36, 0.37];

// Twenty lamps inside Spot, on the faces of a small icosahedron around the middle of its body (its
// centroid at this size), each facing out along its face's normal. A lamp's veils are drawn with the
// three lamps on the faces that share its edges.
export const LAMPS = icosahedronLamps([0, 10.31, -0.03], 0.5).map(describeLamp);

// The maps along each side of the square atlas that holds them all (see atlasCell() in common.glsl).
export const ATLAS_SIDE = Math.ceil(Math.sqrt(LAMPS.length));

// One lamp per face of an icosahedron of the given circumradius, with hues spread by the golden ratio so
// that neighbours differ. Colours are linear RGB.
function icosahedronLamps(center, radius) {
  const t = (1 + Math.sqrt(5)) / 2;
  const vertices = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  // The faces are the triples of vertices an edge, 2, from each other.
  const edge = (a, b) => Math.abs(Math.hypot(...vertices[a].map((v, k) => v - vertices[b][k])) - 2) < 1e-9;
  const faces = [];
  for (let a = 0; a < 12; a++) {
    for (let b = a + 1; b < 12; b++) {
      for (let c = b + 1; c < 12; c++) {
        if (edge(a, b) && edge(b, c) && edge(a, c)) faces.push([a, b, c]);
      }
    }
  }
  const scale = radius / Math.hypot(1, t);
  return faces.map((face, f) => {
    const middle = [0, 1, 2].map((k) => face.reduce((sum, v) => sum + vertices[v][k], 0) / 3);
    const position = middle.map((v, k) => center[k] + scale * v);
    const partners = faces.flatMap((other, g) => (other.filter((v) => face.includes(v)).length === 2 ? [g] : []));
    const hue = (f * 0.618034) % 1;
    const channel = (n) => {
      const k = (n + 6 * hue) % 6;
      return 1 - 0.85 * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return {
      position,
      target: position.map((v, k) => v + normalize(middle)[k]),
      power: 100,
      halfAngle: 40,
      color: [channel(5), channel(3), channel(1)],
      partners,
    };
  });
}

function describeLamp(lamp) {
  const axis = normalize(sub(lamp.target, lamp.position));
  const right = normalize(cross(axis, Math.abs(axis[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
  const up = cross(right, axis);
  const c = Math.cos((lamp.halfAngle * Math.PI) / 180) ** 2;
  // Directions with p < p_min emit nothing, so each lamp's map only has to cover the cutoff cone.
  const cutoffCos2 = c + P_MIN * (1 - c);
  const cutoffTan = Math.sqrt(1 / cutoffCos2 - 1);
  return { ...lamp, axis, right, up, c, cutoffCos2, cutoffTan, sqrtPower: Math.sqrt(lamp.power) };
}

// std140 layout of the `Lamps` uniform block in common.glsl.
export function packLamps(lamps) {
  const n = lamps.length;
  const data = new Float32Array(4 * (6 * n + 1));
  lamps.forEach((lamp, i) => {
    data.set([...lamp.position, lamp.sqrtPower], 4 * i);
    data.set([...lamp.axis, lamp.c], 4 * (n + i));
    data.set([...lamp.right, lamp.cutoffTan], 4 * (2 * n + i));
    data.set([...lamp.up, lamp.cutoffCos2], 4 * (3 * n + i));
    data.set([...lamp.color, lamp.power], 4 * (4 * n + i));
    data.set([0, 1, 2].map((k) => lamp.partners[k] ?? -1), 4 * (5 * n + i));
  });
  data.set([RANGE, P_MIN, MAP_SIZE, SURFACE_GAP], 24 * n);
  return data;
}

// Projection of the world onto lamp i's direction map, matching mapUV() in common.glsl.
export function lampViewProjection(lamp) {
  const view = viewFromBasis(lamp.position, lamp.right, lamp.up, lamp.axis);
  const proj = perspective(2 * Math.atan(lamp.cutoffTan), 1, 0.01, RANGE + 1);
  return multiply(proj, view);
}

// Stands Spot on the ground at the origin, SPOT_HEIGHT tall.
export function spotModel({ min, max }) {
  const s = SPOT_HEIGHT / (max[1] - min[1]);
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -cx * s, -min[1] * s, -cz * s, 1]);
}
