import { cross, dot, normalize, sub } from './mat4.js';

// Model constants from the README.
export const RANGE = 18;

// The lamps are LEDs of one type, so their beam is fixed: brightness falls to half HALF_BRIGHT_ANGLE off
// the axis, and would fade to nothing at DARK_ANGLE. That is the profile p = ((cos θ - c) / (1 - c))^m of
// the field F = P p² / r² (README), with c = cos DARK_ANGLE and m the exponent that halves p² at
// HALF_BRIGHT_ANGLE. The lamps' maps end short of 90° (mapUV() in common.glsl), so the light is cut off at
// CUTOFF_ANGLE, where the beam is down to about 2%: a little narrower than the LED, on the side of
// caution. The cutoff p_min is the profile there.
export const HALF_BRIGHT_ANGLE = 40;
export const DARK_ANGLE = 100;
export const CUTOFF_ANGLE = 80;
const radians = (degrees) => (degrees * Math.PI) / 180;
const BEAM_C = Math.cos(radians(DARK_ANGLE));
export const BEAM_EXPONENT = Math.log(Math.SQRT1_2) / Math.log((Math.cos(radians(HALF_BRIGHT_ANGLE)) - BEAM_C) / (1 - BEAM_C));
export const P_MIN = beamProfile(Math.cos(radians(CUTOFF_ANGLE)));

// The profile along a direction at cos θ = ct from the axis, negative where the beam has no light at all,
// and its log's derivative d log p / d ct.
export function beamProfile(ct) {
  return ct > BEAM_C ? ((ct - BEAM_C) / (1 - BEAM_C)) ** BEAM_EXPONENT : -1;
}
export const beamSlope = (ct) => BEAM_EXPONENT / (ct - BEAM_C);

// How far short of a surface the renderer last tests whether a lamp's light gets there, relative to
// the distance from the lamp (see exact.glsl): enough to clear the surface itself.
export const SURFACE_GAP = 1e-4;

// Millimetres to a scene unit, for the resin's diffusion (diffusion.js): Spot stands 240 mm tall.
export const MM_PER_UNIT = 10;

export const SPOT_HEIGHT = 24;
// Spot's triangles are most of a centimetre across, which shows in its outline and its shadows, so each
// is split into SPOT_REFINEMENT² smaller ones on the smooth surface its normals describe (see mesh.js).
export const SPOT_REFINEMENT = 4;
export const SPOT_ALBEDO = [0.72, 0.7, 0.66];
export const GROUND_ALBEDO = [0.36, 0.36, 0.37];

// The user's orb, for comparing the model with a sculpture that has been built: 250 mm across, a shell
// split into the 60 pentagons of a pentagonal hexecontahedron, and an LED about 50 mm under the middle of
// each, facing out. Its sphere is an icosahedron with each triangle split ORB_REFINEMENT² ways.
export const ORB_DIAMETER = 25;
export const ORB_DEPTH = 5;
export const ORB_REFINEMENT = 64;

// The lamps are alike but for where they are, where they point and how bright they are: a dimmer turns
// each down from P_MAX to as little as DIMMEST of it. Scaling every power alike scales every field alike
// and changes no cell, so only the ratios between powers matter.
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

// An icosahedron of edge 2: its twelve vertices, and its twenty faces as the triples of vertices an edge
// from each other.
const GOLDEN = (1 + Math.sqrt(5)) / 2;
export const ICOSAHEDRON = (() => {
  const t = GOLDEN;
  const vertices = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const edge = (a, b) => Math.abs(Math.hypot(...vertices[a].map((v, k) => v - vertices[b][k])) - 2) < 1e-9;
  const faces = [];
  for (let a = 0; a < 12; a++) {
    for (let b = a + 1; b < 12; b++) {
      for (let c = b + 1; c < 12; c++) {
        if (edge(a, b) && edge(b, c) && edge(a, c)) faces.push([a, b, c]);
      }
    }
  }
  return { vertices, faces };
})();

// Twenty lamps on the faces of a small icosahedron of the given circumradius, each facing out along its
// face's normal.
export function icosahedronLamps(center, radius) {
  const { vertices, faces } = ICOSAHEDRON;
  const scale = radius / Math.hypot(1, GOLDEN);
  return faces.map((face) => {
    const middle = [0, 1, 2].map((k) => face.reduce((sum, v) => sum + vertices[v][k], 0) / 3);
    return { position: middle.map((v, k) => center[k] + scale * v), axis: normalize(middle), power: P_MAX };
  });
}

// The icosahedron's 60 rotations, as rows of 3×3 matrices: each takes one vertex and a neighbour of it
// to a vertex and any of that vertex's five neighbours.
function icosahedronRotations() {
  const vertices = ICOSAHEDRON.vertices.map(normalize);
  const frame = (a, b) => {
    const u = normalize(sub(b, a.map((v) => v * dot(a, b))));
    return [a, u, cross(a, u)];
  };
  const neighbour = dot(vertices[0], vertices[1]);
  const from = frame(vertices[0], vertices[1]);
  const rotations = [];
  for (const a of vertices) {
    for (const b of vertices) {
      if (Math.abs(dot(a, b) - neighbour) > 1e-9) continue;
      const to = frame(a, b);
      rotations.push([0, 1, 2].map((r) => [0, 1, 2].map((s) => to.reduce((sum, v, k) => sum + v[r] * from[k][s], 0))));
    }
  }
  return rotations;
}

// The middles of the pentagonal hexecontahedron's 60 faces, as unit directions: the vertices of a snub
// dodecahedron. They are the images under the icosahedron's rotations of one point, the one whose
// distances to its images under the rotations about the nearest five-, three- and two-fold axes are all
// equal (found numerically); each face's far corner is then 23.24° from its middle, seen from the centre.
export function snubDirections() {
  const point = [-0.173863605131373, 0.972732850565596, 0.153499994271179];
  return icosahedronRotations().map((rows) => rows.map((row) => dot(row, point)));
}

// The orb's 60 lamps, one ORB_DEPTH under the middle of each pentagon, facing out, for an orb standing on
// the ground.
export function orbLamps() {
  const radius = ORB_DIAMETER / 2;
  return snubDirections().map((axis) => ({
    position: [(radius - ORB_DEPTH) * axis[0], radius + (radius - ORB_DEPTH) * axis[1], (radius - ORB_DEPTH) * axis[2]],
    axis,
    power: P_MAX,
  }));
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

// Directions with p < p_min emit nothing, so each lamp's map (mapUV() in common.glsl) only has to cover
// the cutoff cone, but it reaches this much further, relative to the cone's half-angle, so that the cone's
// edge lies inside the map all the way round. Were the map to end at the cone, the edge would touch it at
// the ends of the map's axes, and there the side wall a lamp's lit volume stands on at its cone's edge,
// between the rays that have light and those that don't, would have gaps.
const MAP_MARGIN = 1 / 32;

function describeLamp({ position, axis, power, color }) {
  axis = normalize(axis);
  const right = normalize(cross(axis, Math.abs(axis[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
  const up = cross(right, axis);
  const cutoffCos2 = Math.cos(radians(CUTOFF_ANGLE)) ** 2;
  // The angle off the lamp's axis the map reaches along each of its own axes, in radians.
  const mapAngle = radians(CUTOFF_ANGLE) * (1 + MAP_MARGIN);
  return { position: [...position], axis, power, color, right, up, c: BEAM_C, cutoffCos2, mapAngle, sqrtPower: Math.sqrt(power) };
}

// std140 layout of the `Lamps` uniform block in common.glsl.
export function packLamps({ lamps, atlasSide, mapSize }) {
  const n = LAMP_CAPACITY;
  const data = new Float32Array(4 * (5 * n + 2));
  lamps.forEach((lamp, i) => {
    data.set([...lamp.position, lamp.sqrtPower], 4 * i);
    data.set([...lamp.axis, lamp.c], 4 * (n + i));
    data.set([...lamp.right, lamp.mapAngle], 4 * (2 * n + i));
    data.set([...lamp.up, lamp.cutoffCos2], 4 * (3 * n + i));
    data.set([...lamp.color, lamp.power], 4 * (4 * n + i));
  });
  data.set([RANGE, P_MIN, mapSize, SURFACE_GAP], 20 * n);
  data.set([lamps.length, atlasSide, BEAM_EXPONENT, 0], 20 * n + 4);
  return data;
}

// Stands a mesh with the given bounds on the ground at the origin, `height` tall.
export function standingModel({ min, max }, height) {
  const s = height / (max[1] - min[1]);
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, -cx * s, -min[1] * s, -cz * s, 1]);
}
