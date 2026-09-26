// A thin, faintly glowing sheet lit by both of its lamps, denser where the view grazes it.
//
// The sheet is visible where lamp i's rays ended on this veil. That is read from the 4×4 rays around
// the point, blended with cubic B-spline weights, so its edges are smooth curves rather than the
// texel grid. Every veil is drawn from both of its lamps' maps; each copy is weighted by how squarely
// its lamp's rays meet the veil, so the copies add up to one sheet and the better-sampled one
// dominates, including along the edge where one lamp's rays graze the veil.

uniform usampler2D uTags;  // the lamp whose veil each ray ended on, plus one; 0 if none
uniform vec3 uCameraPos;
uniform float uVeilOpacity;
uniform float uVeilGain;
uniform bool uCull;          // whether to show only the veils of the cell owning the surface in view
uniform sampler2D uOwners;   // the lamp owning the surface in view at each pixel, -1 for none

flat in ivec2 vPair;
in vec3 vWorld;

out vec4 outColor;

float endsOnVeil(int i, int j, vec3 x) {
  float size = sceneParams.z;
  vec2 st = mapUV(i, x - lampOrigin[i].xyz) * size - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = st - vec2(base);
  vec4 wx = bspline(f.x);
  vec4 wy = bspline(f.y);
  ivec2 origin = atlasOrigin(i);
  ivec2 last = ivec2(MAP_SIZE - 1);
  uvec4 partner = uvec4(j + 1);
  float share = 0.0;
  for (int y = 0; y < 4; ++y) {
    ivec2 row = base + ivec2(-1, y - 1);
    uvec4 tags = uvec4(
      texelFetch(uTags, origin + clamp(row, ivec2(0), last), 0).r,
      texelFetch(uTags, origin + clamp(row + ivec2(1, 0), ivec2(0), last), 0).r,
      texelFetch(uTags, origin + clamp(row + ivec2(2, 0), ivec2(0), last), 0).r,
      texelFetch(uTags, origin + clamp(row + ivec2(3, 0), ivec2(0), last), 0).r);
    share += wy[y] * dot(wx, vec4(equal(tags, partner)));
  }
  return share;
}

void main() {
  int i = vPair.x;
  int j = vPair.y;
  if (uCull) {
    int owner = int(texelFetch(uOwners, ivec2(gl_FragCoord.xy), 0).r);
    if (i != owner && j != owner) discard;
  }
  // Off the veil, where a grid corner failed to settle onto it and stretched its triangles.
  float di = fieldDistance(i, vWorld);
  float dj = fieldDistance(j, vWorld);
  if (abs(di - dj) > 0.01 * di) discard;
  float visible = smoothstep(0.3, 0.7, endsOnVeil(i, j, vWorld));
  if (visible <= 0.0) discard;

  // The normal points from i's side of the veil into j's. Each lamp's light reaches the veil from its
  // own side; the sheet fades out where either lamp's rays graze it.
  vec3 normal = normalize(fieldDistanceGradient(i, vWorld) - fieldDistanceGradient(j, vWorld));
  float ci = dot(normal, normalize(vWorld - lampOrigin[i].xyz));
  float cj = -dot(normal, normalize(vWorld - lampOrigin[j].xyz));
  float arriving = smoothstep(0.0, 0.1, ci) * smoothstep(0.0, 0.1, cj);
  float share = max(ci, 0.0) / max(max(ci, 0.0) + max(cj, 0.0), 1e-6);
  float facing = abs(dot(normal, normalize(vWorld - uCameraPos)));
  float alpha = visible * arriving * share * (1.0 - exp(-uVeilOpacity / max(facing, 0.15)));
  vec3 tint = mix(0.5 * (lampColor[i].rgb + lampColor[j].rgb), vec3(1.0), 0.5);
  outColor = vec4(alpha * uVeilGain * field(i, vWorld) * tint, 0.0);
}
