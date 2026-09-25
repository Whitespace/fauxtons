// The visible isolux veils, taken from the solution: where lamp i's light ended on its veil with lamp
// j, the end points of i's rays lie on the part of that veil both lights reach. Instance (i, slot)
// meshes lamp i's veil with its partner j in that slot (lampPartners) over a coarse grid of i's map;
// slots without a partner, and cells without any such
// rays nearby collapse. Grid corners are placed on the veil itself by solving d_i = d_j along their
// rays, and the fragment shader decides which parts of the sheet are visible.

uniform sampler2D uReach;  // reach distance of every ray
uniform usampler2D uTags;  // the lamp whose veil each ray ended on, plus one; 0 if none
uniform sampler2D uCells;  // per cell and partner slot: mean reach of the rays ending on that veil
uniform mat4 uViewProj;
uniform int uStride;       // map texels between neighbouring grid points

flat out ivec2 vPair;
out vec3 vWorld;

const ivec2 CORNERS[6] = ivec2[6](ivec2(0, 0), ivec2(1, 0), ivec2(1, 1), ivec2(0, 0), ivec2(1, 1), ivec2(0, 1));

// Distance along lamp i's ray `dir` at which d_i = d_j, by Newton's method from `guess` and kept
// near it. Along the ray d_i grows linearly, as t / speed.
float veilCrossing(int i, int j, vec3 dir, float guess) {
  vec3 o = lampOrigin[i].xyz;
  float speed = lampOrigin[i].w * max(profile(i, dir), P_MIN);
  float t = guess;
  for (int k = 0; k < 5; ++k) {
    vec3 x = o + t * dir;
    float dj = fieldDistance(j, x);
    if (dj >= INF) break;
    float slope = 1.0 / speed - dot(fieldDistanceGradient(j, x), dir);
    if (abs(slope) < 1e-6) break;
    t = clamp(t - (t / speed - dj) / slope, 0.8 * guess, 1.25 * guess);
  }
  return t;
}

void main() {
  int i = gl_InstanceID / 3;
  int slot = gl_InstanceID % 3;
  int j = int(lampPartners[i][slot]);
  int cells = MAP_SIZE / uStride;
  int quad = gl_VertexID / 6;
  ivec2 cell = ivec2(quad % (cells - 1), quad / (cells - 1));

  float reach = j < 0 ? 0.0 : texelFetch(uCells, atlasCell(i) * cells + cell, 0)[slot];
  if (reach <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vPair = ivec2(0);
    vWorld = vec3(0.0);
    return;
  }

  ivec2 origin = atlasOrigin(i);
  ivec2 texel = origin + (cell + CORNERS[gl_VertexID % 6]) * uStride;
  vec3 dir = mapDirection(i, (vec2(texel - origin) + 0.5) / float(MAP_SIZE));
  bool onVeil = texelFetch(uTags, texel, 0).r == uint(j + 1);
  float t = onVeil ? texelFetch(uReach, texel, 0).r : veilCrossing(i, j, dir, reach);
  vWorld = lampOrigin[i].xyz + t * dir;
  vPair = ivec2(i, j);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
