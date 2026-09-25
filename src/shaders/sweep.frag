// One pass of the field-distance sweep. Every ray whose light is still travelling advances from
// field-distance uTimePrev to uTime. It reads the other lamps' rays only as they stood at uTimePrev,
// so no decision at field-distance d depends on one made at a larger field-distance.

uniform sampler2D uState;     // r: distance at which each ray's light ended (ALIVE while it travels)
                              // g: the lamp whose veil it ended on, -2 if it ended on a surface, else -1
uniform sampler2D uOccluder;  // distance to the first occluder along each ray
uniform float uTimePrev;
uniform float uTime;

out vec2 outState;

const float ALIVE = 1e30;
const float SURFACE_GAP = 0.002; // how far short of an occluder, relatively, a ray last checks its light

// Whether lamp j's light has reached y, which has field-distance dj for j. The reach of the 2×2 rays
// around y is interpolated bilinearly, with a tolerance of its spread across them: where j's rays
// meet a surface obliquely their reach changes quickly from ray to ray, and without it a surface
// lit by j would read as unlit in places (shadow acne). The cap keeps the edges of j's light from
// dilating.
bool present(int j, vec3 y, float dj) {
  vec3 d = y - lampOrigin[j].xyz;
  float dist = length(d);
  vec2 st = mapUV(j, d) * float(MAP_SIZE) - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = st - vec2(base);
  ivec2 origin = atlasOrigin(j);
  ivec2 last = ivec2(MAP_SIZE - 1);
  vec4 reach = vec4(
    texelFetch(uState, origin + clamp(base, ivec2(0), last), 0).r,
    texelFetch(uState, origin + clamp(base + ivec2(1, 0), ivec2(0), last), 0).r,
    texelFetch(uState, origin + clamp(base + ivec2(0, 1), ivec2(0), last), 0).r,
    texelFetch(uState, origin + clamp(base + ivec2(1, 1), ivec2(0), last), 0).r);
  // Rays still travelling have carried their light at least as far as the current front.
  reach = min(reach, vec4(uTime * dist / dj));
  float spread = max(max(reach.x, reach.y), max(reach.z, reach.w)) - min(min(reach.x, reach.y), min(reach.z, reach.w));
  float interpolated = mix(mix(reach.x, reach.y, f.x), mix(reach.z, reach.w, f.x), f.y);
  return dist < interpolated + min(spread, REACH_TOLERANCE * dist);
}

// True when some other lamp's field is strictly stronger at y and its light has reached y.
bool extinguished(int i, vec3 y, float di) {
  for (int j = 0; j < LAMP_COUNT; ++j) {
    if (j == i) continue;
    float dj = fieldDistance(j, y);
    if (dj < di && present(j, y, dj)) return true;
  }
  return false;
}

// Light that meets another lamp's light head on is extinguished just past their isolux veil, where
// the two fields are still all but equal. Anywhere else it ran into light that was already stronger.
float veilPartner(int i, vec3 y, float di) {
  for (int j = 0; j < LAMP_COUNT; ++j) {
    if (j == i) continue;
    float dj = fieldDistance(j, y);
    if (dj < di && dj > (1.0 - 2e-3) * di && present(j, y, dj)) return float(j);
  }
  return -1.0;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int i = atlasLamp(px, n);

  vec2 state = texelFetch(uState, px, 0).rg;
  if (i < 0) {
    outState = vec2(0.0, -1.0);
    return;
  }
  if (state.r < 0.5 * ALIVE) {
    outState = state;
    return;
  }

  vec3 dir = mapDirection(i, (vec2(px - atlasOrigin(i)) + 0.5) / float(n));
  float p = profile(i, dir);
  if (p < P_MIN) {
    outState = vec2(0.0, -1.0);
    return;
  }

  // Along this ray d = t / speed, so field-distance T is reached at t = T * speed.
  vec3 o = lampOrigin[i].xyz;
  float speed = lampOrigin[i].w * p;
  float stop = min(RANGE, texelFetch(uOccluder, px, 0).r);
  if (dir.y < 0.0) stop = min(stop, -o.y / dir.y);

  // Short of an occluder, the light is checked in the air just above it: where two lamps both reach
  // a surface, the weaker one was extinguished just before it.
  float a = uTimePrev * speed;
  float b = min(uTime * speed, (1.0 - SURFACE_GAP) * stop);
  if (a < b && extinguished(i, o + b * dir, b / speed)) {
    for (int k = 0; k < 12; ++k) {
      float m = 0.5 * (a + b);
      if (extinguished(i, o + m * dir, m / speed)) b = m; else a = m;
    }
    outState = vec2(0.5 * (a + b), veilPartner(i, o + b * dir, b / speed));
  } else if (uTime * speed >= stop) {
    outState = vec2(stop, stop < RANGE ? -2.0 : -1.0);
  } else {
    outState = vec2(ALIVE, -1.0);
  }
}
