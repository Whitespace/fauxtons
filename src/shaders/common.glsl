precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

// LAMP_COUNT and ATLAS_SIDE, the maps along each side of the atlas, are defined for the scene before this
// (renderer.js).

const float INF = 1e30;

// Packed by packLamps() in scene.js.
layout(std140) uniform Lamps {
  vec4 lampOrigin[LAMP_COUNT];    // xyz position, w sqrt(P)
  vec4 lampAxis[LAMP_COUNT];      // xyz unit axis, w c = cos²α
  vec4 lampRight[LAMP_COUNT];     // xyz map right, w tan of the cutoff angle
  vec4 lampUp[LAMP_COUNT];        // xyz map up, w cos² of the cutoff angle
  vec4 lampColor[LAMP_COUNT];     // rgb colour, w P
  vec4 lampPartners[LAMP_COUNT];  // xyz the lamps whose veils with this one are drawn, -1 for none
  vec4 sceneParams;               // x R, y p_min, z map size in texels, w SURFACE_GAP (scene.js)
};

#define RANGE sceneParams.x
#define P_MIN sceneParams.y
#define MAP_SIZE int(sceneParams.z)

// How far past the reach interpolated from the rays around a point another lamp's light still counts
// as present there, at most, relative to the point's distance from that lamp: a few texels' worth, as
// the spread it stands in for scales with the texel size (see present() in sweep.frag).
#define REACH_TOLERANCE (5.0 / sceneParams.z)

// Cone profile of lamp i along a unit direction; negative behind the lamp.
float profile(int i, vec3 dir) {
  float ct = dot(lampAxis[i].xyz, dir);
  float c = lampAxis[i].w;
  return ct > 0.0 ? (ct * ct - c) / (1.0 - c) : -1.0;
}

// Field-distance d_i(x) = 1 / sqrt(F_i(x)), INF where the field is zero.
float fieldDistance(int i, vec3 x) {
  vec3 d = x - lampOrigin[i].xyz;
  float r = length(d);
  if (r > RANGE) return INF;
  float p = profile(i, d / max(r, 1e-12));
  return p >= P_MIN ? r / (lampOrigin[i].w * p) : INF;
}

float field(int i, vec3 x) {
  float d = fieldDistance(i, x);
  return d < INF ? 1.0 / (d * d) : 0.0;
}

// ∇d_i at a point inside lamp i's cone.
vec3 fieldDistanceGradient(int i, vec3 x) {
  vec3 w = normalize(x - lampOrigin[i].xyz);
  vec3 a = lampAxis[i].xyz;
  float c = lampAxis[i].w;
  float ct = dot(a, w);
  float p = (ct * ct - c) / (1.0 - c);
  return (w - 2.0 * ct * (a - ct * w) / (p * (1.0 - c))) / (lampOrigin[i].w * p);
}

// Interval of the ray ro + t rd, t in [0, tMax], inside lamp i's cutoff cone and range ball.
vec2 coneSpan(int i, vec3 ro, vec3 rd, float tMax) {
  const vec2 EMPTY = vec2(INF, -INF);
  vec3 a = lampAxis[i].xyz;
  vec3 D = ro - lampOrigin[i].xyz;
  float k = lampUp[i].w;
  float av = dot(a, rd), aD = dot(a, D), vD = dot(rd, D), DD = dot(D, D);

  float disc = vD * vD - DD + RANGE * RANGE;
  if (disc <= 0.0) return EMPTY;
  float t0 = max(0.0, -vD - sqrt(disc));
  float t1 = min(tMax, -vD + sqrt(disc));

  // (a·Δ)² ≥ k|Δ|² bounds both nappes of the cone; keep the one in front of the lamp.
  float A = av * av - k;
  float B = av * aD - k * vD;
  float C = aD * aD - k * DD;
  if (abs(A) < 1e-7) A = 1e-7;
  float h = B * B - A * C;
  if (h < 0.0 && A < 0.0) return EMPTY;
  float s = sqrt(max(h, 0.0));
  float lo = min((-B - s) / A, (-B + s) / A);
  float hi = max((-B - s) / A, (-B + s) / A);
  if (A < 0.0) {
    if (aD + 0.5 * (lo + hi) * av < 0.0) return EMPTY;
    t0 = max(t0, lo);
    t1 = min(t1, hi);
  } else if (av > 0.0) {
    t0 = max(t0, hi);
  } else {
    t1 = min(t1, lo);
  }
  return vec2(t0, t1);
}

// Each lamp's emission directions are mapped perspectively onto [0,1]², the square circumscribing
// its cutoff cone. The maps share one square atlas, lamp i in cell atlasCell(i); spare cells are unused.
vec2 mapUV(int i, vec3 d) {
  vec2 s = vec2(dot(d, lampRight[i].xyz), dot(d, lampUp[i].xyz));
  return 0.5 * s / (dot(d, lampAxis[i].xyz) * lampRight[i].w) + 0.5;
}

vec3 mapDirection(int i, vec2 uv) {
  vec2 s = (2.0 * uv - 1.0) * lampRight[i].w;
  return normalize(lampAxis[i].xyz + s.x * lampRight[i].xyz + s.y * lampUp[i].xyz);
}

ivec2 atlasCell(int i) {
  return ivec2(i % ATLAS_SIDE, i / ATLAS_SIDE);
}

ivec2 atlasOrigin(int i) {
  return atlasCell(i) * MAP_SIZE;
}

// The lamp whose map holds texel px of an atlas with `size` texels to a map, or -1 in a spare cell.
int atlasLamp(ivec2 px, int size) {
  ivec2 cell = px / size;
  int i = cell.y * ATLAS_SIDE + cell.x;
  return i < LAMP_COUNT ? i : -1;
}

// Uniform cubic B-spline weights of the texels at offsets -1, 0, 1 and 2 from the one below f.
vec4 bspline(float f) {
  float g = 1.0 - f;
  return vec4(g * g * g, 3.0 * f * f * f - 6.0 * f * f + 4.0, 3.0 * g * g * g - 6.0 * g * g + 4.0, f * f * f) / 6.0;
}

// Where the light of lamp i's ray at `texel` ended, for drawing the boundaries of the lit volumes.
// Light that reached the ground or Spot ends on it; that end point moves just past the surface, so the
// depth test hides the part of a boundary lying on the surface and keeps the walls standing on it.
float endDistance(sampler2D state, int i, ivec2 texel) {
  vec2 s = texelFetch(state, atlasOrigin(i) + clamp(texel, ivec2(0), ivec2(MAP_SIZE - 1)), 0).rg;
  return s.g < -1.5 ? s.r + max(0.02, 0.005 * s.r) : s.r;
}

// Whether the end distance jumps from a to b between neighbouring rays rather than changing steeply but
// smoothly: the step is large, and large beside the steps to the rays just before a and after b on the
// same line.
bool isJump(float before, float a, float b, float after) {
  float step = abs(b - a);
  float lo = min(abs(a - before), abs(after - b));
  float hi = max(abs(a - before), abs(after - b));
  return step > 0.01 * max(a, b) && step > 4.0 * lo && step > 2.0 * hi;
}

bool jumps(sampler2D state, int i, ivec2 a, ivec2 b) {
  ivec2 d = b - a;
  return isJump(endDistance(state, i, a - d), endDistance(state, i, a), endDistance(state, i, b), endDistance(state, i, b + d));
}

// Grid points of the boundary meshes sit every `stride` texels of each lamp's map, and their own
// textures are an atlas of those grids.
ivec2 gridOrigin(int i, int stride) {
  return atlasCell(i) * (MAP_SIZE / stride);
}

// Grid point `grid` of lamp i's boundary mesh: the smoothed end point of the ray there (ends.frag),
// turned onto the direction it was moved to in the map (snap.frag).
vec3 boundaryPoint(sampler2D ends, sampler2D offsets, int i, ivec2 grid, int stride) {
  grid = clamp(grid, ivec2(0), ivec2(MAP_SIZE / stride - 1));
  vec2 offset = texelFetch(offsets, gridOrigin(i, stride) + grid, 0).rg;
  ivec2 texel = grid * stride;
  vec3 dir = mapDirection(i, (vec2(texel) + offset + 0.5) / float(MAP_SIZE));
  return lampOrigin[i].xyz + texelFetch(ends, atlasOrigin(i) + texel, 0).r * dir;
}

#define SLOPE_RADIUS 24
const float SLOPE_SIGMA = 8.0;

// Weights at offset k of a Gaussian blur (x) and of its derivative (y), normalised so that a constant
// passes unchanged and a linear ramp comes out with its exact slope.
vec2 slopeWeights(int k) {
  float sum = 0.0;
  float moment = 0.0;
  for (int j = -SLOPE_RADIUS; j <= SLOPE_RADIUS; ++j) {
    float g = exp(-0.5 * float(j * j) / (SLOPE_SIGMA * SLOPE_SIGMA));
    sum += g;
    moment += float(j * j) * g;
  }
  float g = exp(-0.5 * float(k * k) / (SLOPE_SIGMA * SLOPE_SIGMA));
  return vec2(g / sum, float(k) * g / moment);
}
