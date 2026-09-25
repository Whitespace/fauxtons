precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

#define LAMP_COUNT 4

const float INF = 1e30;

// Packed by packLamps() in scene.js.
layout(std140) uniform Lamps {
  vec4 lampOrigin[LAMP_COUNT];  // xyz position, w sqrt(P)
  vec4 lampAxis[LAMP_COUNT];    // xyz unit axis, w c = cos²α
  vec4 lampRight[LAMP_COUNT];   // xyz map right, w tan of the cutoff angle
  vec4 lampUp[LAMP_COUNT];      // xyz map up, w cos² of the cutoff angle
  vec4 lampColor[LAMP_COUNT];   // rgb colour, w P
  vec4 sceneParams;             // x R, y p_min, z map size in texels
};

#define RANGE sceneParams.x
#define P_MIN sceneParams.y
#define MAP_SIZE int(sceneParams.z)

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

// Each lamp's emission directions are mapped perspectively onto [0,1]², the square circumscribing
// its cutoff cone. The four maps share one atlas, lamp i in quadrant (i & 1, i >> 1).
vec2 mapUV(int i, vec3 d) {
  vec2 s = vec2(dot(d, lampRight[i].xyz), dot(d, lampUp[i].xyz));
  return 0.5 * s / (dot(d, lampAxis[i].xyz) * lampRight[i].w) + 0.5;
}

vec3 mapDirection(int i, vec2 uv) {
  vec2 s = (2.0 * uv - 1.0) * lampRight[i].w;
  return normalize(lampAxis[i].xyz + s.x * lampRight[i].xyz + s.y * lampUp[i].xyz);
}

ivec2 atlasOrigin(int i) {
  return ivec2(i & 1, i >> 1) * MAP_SIZE;
}

// Uniform cubic B-spline weights of the texels at offsets -1, 0, 1 and 2 from the one below f.
vec4 bspline(float f) {
  float g = 1.0 - f;
  return vec4(g * g * g, 3.0 * f * f * f - 6.0 * f * f + 4.0, 3.0 * g * g * g - 6.0 * g * g + 4.0, f * f * f) / 6.0;
}
