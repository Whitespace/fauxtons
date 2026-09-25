// One pass of refining the solution ray by ray. The sweep decides whether a ray's light has ended only at
// the points it steps to, a few percent of the distance apart, so it can step over a thin layer of
// stronger light, for instance just above a surface. Here each ray's light is followed as the surfaces
// test it (extinction() in exact.glsl), against the other lamps' light as the previous pass left it.
// The end of every ray's light is written as the sweep writes it (sweep.frag).

out vec2 outState;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int i = atlasLamp(px, n);
  if (i < 0) {
    outState = vec2(0.0, -1.0);
    return;
  }
  vec3 dir = mapDirection(i, (vec2(px - atlasOrigin(i)) + 0.5) / float(n));
  if (profile(i, dir) < P_MIN) {
    outState = vec2(0.0, -1.0);
    return;
  }
  vec3 o = lampOrigin[i].xyz;
  float stop = min(RANGE, texelFetch(uOccluder, px, 0).r);
  if (dir.y < 0.0) stop = min(stop, -o.y / dir.y);
  int partner;
  float end = extinction(i, dir, (1.0 - SURFACE_GAP) * stop, true, partner);
  outState = end < INF ? vec2(end, float(partner)) : vec2(stop, stop < RANGE ? -2.0 : -1.0);
}
