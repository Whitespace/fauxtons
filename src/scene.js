import { cross, multiply, normalize, perspective, sub, viewFromBasis } from './mat4.js';

// Model constants from the README.
export const RANGE = 18;
export const P_MIN = 0.01;

// How far short of a surface the renderer last tests whether a lamp's light gets there, relative to
// the distance from the lamp (see exact.glsl): enough to clear the surface itself.
export const SURFACE_GAP = 1e-4;

export const SPOT_HEIGHT = 24;
// Spot's triangles are several centimetres across, which shows in its outline and its shadows, so each
// is split into SPOT_REFINEMENT² smaller ones on the smooth surface its normals describe (see mesh.js).
export const SPOT_REFINEMENT = 4;
export const SPOT_ALBEDO = [0.72, 0.7, 0.66];
export const GROUND_ALBEDO = [0.36, 0.36, 0.37];

// The lamps are alike but for where they are, where they point and how bright they are: a dimmer turns
// each down from P_MAX to as little as DIMMEST of it. Scaling every power alike scales every field alike
// and changes no cell, so only the ratios between powers matter.
export const HALF_ANGLE = 40;
export const P_MAX = 100;
export const DIMMEST = 0.5;

// Lamps the shaders have room for: the Lamps uniform block of common.glsl holds five vectors per lamp in
// its 16 KB.
export const LAMP_CAPACITY = 128;

// Each lamp's map is the largest power of two, up to MAP_LIMIT texels a side, whose square atlas of maps
// fits in ATLAS_LIMIT texels a side.
const MAP_LIMIT = 1024;
const ATLAS_LIMIT = 5120;

// The lamps of a scene and the atlas of maps that holds their solution. The atlas has room for `capacity`
// lamps, so lamps can be added up to that without a new atlas (see atlasCell() in common.glsl), and its
// maps are `mapSize` texels a side, by default as large as fit. A lamp is given by its position, axis
// and power; its colour defaults to one picked by its index.
export function createLayout(lamps, capacity = lamps.length, mapSize = undefined) {
  capacity = Math.max(capacity, lamps.length);
  if (capacity > LAMP_CAPACITY) throw new Error(`At most ${LAMP_CAPACITY} lamps fit in the shaders.`);
  const atlasSide = Math.ceil(Math.sqrt(capacity));
  mapSize ??= Math.min(MAP_LIMIT, 2 ** Math.floor(Math.log2(ATLAS_LIMIT / atlasSide)));
  return { lamps: lamps.map((lamp, i) => describeLamp({ ...lamp, color: lamp.color ?? indexColor(i) })), capacity, atlasSide, mapSize };
}

// Hues spread by the golden ratio, so that lamps with neighbouring indices differ.
export const indexColor = (index) => hueColor((index * 0.618034) % 1);

// A saturated colour of the given hue, in [0, 1), in linear RGB.
export function hueColor(hue) {
  const channel = (n) => {
    const k = (n + 6 * hue) % 6;
    return 1 - 0.85 * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [channel(5), channel(3), channel(1)];
}

// Twenty lamps on the faces of a small icosahedron of the given circumradius, each facing out along its
// face's normal.
export function icosahedronLamps(center, radius) {
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
  return faces.map((face) => {
    const middle = [0, 1, 2].map((k) => face.reduce((sum, v) => sum + vertices[v][k], 0) / 3);
    return { position: middle.map((v, k) => center[k] + scale * v), axis: normalize(middle), power: P_MAX };
  });
}

// `count` lamps on a small sphere of the given radius, each facing out from its middle, spread evenly
// by a Fibonacci spiral: the icosahedron's twenty lamps generalised to any number.
export function sphereLamps(center, radius, count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, k) => {
    const y = 1 - (2 * (k + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const axis = [r * Math.cos(golden * k), y, r * Math.sin(golden * k)];
    return { position: axis.map((v, m) => center[m] + radius * v), axis, power: P_MAX };
  });
}

function describeLamp({ position, axis, power, color }) {
  axis = normalize(axis);
  const right = normalize(cross(axis, Math.abs(axis[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
  const up = cross(right, axis);
  const c = Math.cos((HALF_ANGLE * Math.PI) / 180) ** 2;
  // Directions with p < p_min emit nothing, so each lamp's map only has to cover the cutoff cone.
  const cutoffCos2 = c + P_MIN * (1 - c);
  const cutoffTan = Math.sqrt(1 / cutoffCos2 - 1);
  return { position: [...position], axis, power, color, right, up, c, cutoffCos2, cutoffTan, sqrtPower: Math.sqrt(power) };
}

// std140 layout of the `Lamps` uniform block in common.glsl.
export function packLamps({ lamps, atlasSide, mapSize }) {
  const n = LAMP_CAPACITY;
  const data = new Float32Array(4 * (5 * n + 2));
  lamps.forEach((lamp, i) => {
    data.set([...lamp.position, lamp.sqrtPower], 4 * i);
    data.set([...lamp.axis, lamp.c], 4 * (n + i));
    data.set([...lamp.right, lamp.cutoffTan], 4 * (2 * n + i));
    data.set([...lamp.up, lamp.cutoffCos2], 4 * (3 * n + i));
    data.set([...lamp.color, lamp.power], 4 * (4 * n + i));
  });
  data.set([RANGE, P_MIN, mapSize, SURFACE_GAP], 20 * n);
  data.set([lamps.length, atlasSide, 0, 0], 20 * n + 4);
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
