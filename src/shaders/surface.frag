// Ground and Spot. A surface is lit only by a lamp whose light reaches it.

uniform sampler2D uReach;
uniform vec3 uCameraPos;
uniform vec3 uAlbedo;
uniform float uAmbient;

in vec3 vWorld;
in vec3 vNormal;

layout(location = 0) out vec4 outColor;
layout(location = 1) out float outDistance;

// Share of lamp i's light reaching x, looked up at the point `lifted` just off the surface. Whether
// each of the 4×4 rays around it reaches it is blended with B-spline weights; the half-way contour
// of that blend follows light and shadow boundaries as a smooth curve rather than the texel
// staircase, and the narrow ramp about it keeps the edge sharp.
float surfaceShare(int i, vec3 lifted) {
  float size = sceneParams.z;
  vec3 d = lifted - lampOrigin[i].xyz;
  float dist = length(d) * (1.0 - 1e-3);
  vec2 st = mapUV(i, d) * size - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = st - vec2(base);
  vec4 wx = bspline(f.x);
  vec4 wy = bspline(f.y);
  ivec2 origin = atlasOrigin(i);
  ivec2 last = ivec2(MAP_SIZE - 1);
  float share = 0.0;
  for (int y = 0; y < 4; ++y) {
    ivec2 row = base + ivec2(-1, y - 1);
    vec4 reach = vec4(
      texelFetch(uReach, origin + clamp(row, ivec2(0), last), 0).r,
      texelFetch(uReach, origin + clamp(row + ivec2(1, 0), ivec2(0), last), 0).r,
      texelFetch(uReach, origin + clamp(row + ivec2(2, 0), ivec2(0), last), 0).r,
      texelFetch(uReach, origin + clamp(row + ivec2(3, 0), ivec2(0), last), 0).r);
    share += wy[y] * dot(wx, step(vec4(dist), reach));
  }
  return smoothstep(0.35, 0.65, share);
}

void main() {
  vec3 normal = normalize(vNormal);

  float strength[LAMP_COUNT];
  vec3 radiance[LAMP_COUNT];
  float lift = 0.0;
  for (int i = 0; i < LAMP_COUNT; ++i) {
    strength[i] = 0.0;
    radiance[i] = vec3(0.0);
    vec3 d = vWorld - lampOrigin[i].xyz;
    float r = length(d);
    float F = field(i, vWorld);
    float cosine = -dot(normal, d) / r;
    if (F <= 0.0 || cosine <= 0.0) continue;
    strength[i] = F;
    radiance[i] = lampColor[i].rgb * F * cosine;
    // A slope-scaled offset clears the surface's own reach for this lamp (shadow acne).
    float footprint = 2.0 * lampRight[i].w * r / sceneParams.z;
    lift = max(lift, footprint * (1.5 + 3.0 * (1.0 - cosine)));
  }

  // Every lamp is looked up at the same point off the surface. With a separate offset per lamp,
  // a veil meeting the surface at a shallow angle would cross each lamp's offset at a different
  // place, leaving a dark seam (or an overlap) where two lamps' light meets.
  float share[LAMP_COUNT];
  for (int i = 0; i < LAMP_COUNT; ++i) {
    share[i] = strength[i] > 0.0 ? surfaceShare(i, vWorld + lift * normal) : 0.0;
  }

  // Fauxtons don't mix. Where filtering leaves more than one lamp partly present, the stronger
  // field takes precedence, so the shares never add up to more than one lamp's worth of light.
  vec3 light = vec3(0.0);
  float remaining = 1.0;
  for (int k = 0; k < LAMP_COUNT; ++k) {
    int best = -1;
    for (int i = 0; i < LAMP_COUNT; ++i) {
      if (share[i] > 0.0 && (best < 0 || strength[i] > strength[best])) best = i;
    }
    if (best < 0) break;
    float w = min(share[best], remaining);
    light += w * radiance[best];
    remaining -= w;
    share[best] = 0.0;
  }
  // Each lamp's edge is reconstructed separately, so where two lamps' light meets on a surface their
  // shares can fall short of one; close that seam, and keep edges into darkness crisp.
  float lit = 1.0 - remaining;
  light *= lit > 0.0 ? smoothstep(0.0, 0.5, lit) / lit : 0.0;

  outColor = vec4(uAlbedo * (light + uAmbient), 1.0);
  outDistance = length(vWorld - uCameraPos);
}
