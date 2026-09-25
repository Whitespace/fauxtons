import { cross, multiply, normalize, perspective, sub, viewFromBasis } from './mat4.js';

// Model constants from the README.
export const RANGE = 18;
export const P_MIN = 0.01;

// Texels per side of each lamp's direction map.
export const MAP_SIZE = 2048;

// How far short of a surface the renderer last tests whether a lamp's light gets there, relative to
// the distance from the lamp (see exact.glsl): enough to clear the surface itself.
export const SURFACE_GAP = 1e-4;

export const SPOT_HEIGHT = 2.4;
// Spot's triangles are several centimetres across, which shows in its outline and its shadows, so each
// is split into SPOT_REFINEMENT² smaller ones on the smooth surface its normals describe (see mesh.js).
export const SPOT_REFINEMENT = 4;
export const SPOT_ALBEDO = [0.72, 0.7, 0.66];
export const GROUND_ALBEDO = [0.36, 0.36, 0.37];

// Colours are linear RGB, roughly 90° apart in hue.
export const LAMPS = [
  { position: [1.8, 4.8, 3.1], target: [0.0, 1.0, 0.3], power: 26, halfAngle: 40, color: [1.0, 0.32, 0.12] },
  { position: [3.1, 4.2, -2.2], target: [0.0, 1.2, -0.2], power: 22, halfAngle: 38, color: [0.45, 1.0, 0.15] },
  { position: [-1.9, 5.4, -2.8], target: [0.1, 1.0, 0.0], power: 30, halfAngle: 36, color: [0.1, 0.6, 1.0] },
  { position: [-3.4, 3.6, 2.0], target: [0.0, 1.1, 0.2], power: 18, halfAngle: 44, color: [0.75, 0.2, 1.0] },
].map(describeLamp);

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
  const data = new Float32Array(84);
  lamps.forEach((lamp, i) => {
    data.set([...lamp.position, lamp.sqrtPower], 4 * i);
    data.set([...lamp.axis, lamp.c], 16 + 4 * i);
    data.set([...lamp.right, lamp.cutoffTan], 32 + 4 * i);
    data.set([...lamp.up, lamp.cutoffCos2], 48 + 4 * i);
    data.set([...lamp.color, lamp.power], 64 + 4 * i);
  });
  data.set([RANGE, P_MIN, MAP_SIZE, SURFACE_GAP], 80);
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
