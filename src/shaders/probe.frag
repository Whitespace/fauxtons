// Which lamp lights each of a list of points on the surfaces, by litBy() and by the maps alone as the
// renderer used to decide it, for checking both against the README's recursive definition (see
// Renderer.checkSurfaces).

uniform sampler2D uPoints;   // xyz position on a flat facet
uniform sampler2D uFacets;   // xyz unit normal of the facet, w how far it strays from the smooth surface
uniform sampler2D uLifted;   // xyz point of the smooth surface over it (smoothPoint() in surface.frag)
uniform sampler2D uNormals;  // xyz unit normal of the smooth surface

out vec4 outLit;             // x by litBy(), y by the maps, -1 for none; z 1 where the maps' rays disagree

// Share of lamp i's light at the point `lifted` just off the surface, from the 4×4 rays around it
// blended with B-spline weights; `mixed` says whether those rays disagree.
float mapShare(int i, vec3 lifted, out bool mixed) {
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
  float reached = 0.0;
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      float reach = texelFetch(uReach, origin + clamp(base + ivec2(x - 1, y - 1), ivec2(0), last), 0).r;
      share += wx[x] * wy[y] * step(dist, reach);
      reached += step(dist, reach);
    }
  }
  mixed = reached > 0.0 && reached < 16.0;
  return smoothstep(0.35, 0.65, share);
}

// The lamp that lights x by the maps alone: the strongest whose share there is at least a half.
int mapLitBy(vec3 x, vec3 normal, out bool mixed) {
  float strength[LAMP_COUNT];
  float lift = 0.0;
  for (int i = 0; i < LAMP_COUNT; ++i) {
    vec3 d = x - lampOrigin[i].xyz;
    float r = length(d);
    float cosine = -dot(normal, d) / r;
    strength[i] = cosine > 0.0 ? field(i, x) : 0.0;
    if (strength[i] > 0.0) {
      float footprint = 2.0 * lampRight[i].w * r / sceneParams.z;
      lift = max(lift, footprint * (1.5 + 3.0 * (1.0 - cosine)));
    }
  }
  mixed = false;
  int lamp = -1;
  for (int i = 0; i < LAMP_COUNT; ++i) {
    if (strength[i] <= 0.0) continue;
    bool m;
    float share = mapShare(i, x + lift * normal, m);
    mixed = mixed || m;
    if (share >= 0.5 && (lamp < 0 || strength[i] > strength[lamp])) lamp = i;
  }
  return lamp;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec3 x = texelFetch(uPoints, px, 0).xyz;
  vec4 facet = texelFetch(uFacets, px, 0);
  vec3 lifted = texelFetch(uLifted, px, 0).xyz;
  vec3 normal = texelFetch(uNormals, px, 0).xyz;
  bool mixed;
  int byMaps = mapLitBy(x, normal, mixed);
  outLit = vec4(float(litBy(x, facet.xyz, lifted, normal, facet.w)), float(byMaps), mixed ? 1.0 : 0.0, 0.0);
}
