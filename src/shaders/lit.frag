// For every ray of the maps that ends on a surface, whether its lamp's light gets there, by the exact
// test (reachesExact() in exact.glsl). Surfaces then need the test only near the edges of the light,
// where the rays around a point disagree (litFromMaps()).

out float outLit;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int i = (px.x < n ? 0 : 1) + (px.y < n ? 0 : 2);
  vec3 o = lampOrigin[i].xyz;
  vec3 dir = mapDirection(i, (vec2(px - atlasOrigin(i)) + 0.5) / float(n));
  float surface = min(texelFetch(uOccluder, px, 0).r, dir.y < 0.0 ? -o.y / dir.y : INF);
  bool lit = profile(i, dir) >= P_MIN && surface < RANGE && reachesExact(i, o + surface * dir, 0.0);
  outLit = lit ? 1.0 : 0.0;
}
