// Where to put veil geometry. The veil mesh of each lamp is a coarse grid over its map; for every
// cell and each of the other three lamps (xyz), this finds the mean reach of the rays around the cell
// that ended on the veil with that lamp, or 0 if none did. The footprint reaches a little past the
// cell so the mesh covers the whole of the smoothly reconstructed sheet.

uniform sampler2D uState;
uniform int uStride;

out vec4 outCells;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int cells = n / uStride;
  int i = (px.x < cells ? 0 : 1) + (px.y < cells ? 0 : 2);
  ivec2 cell = px - ivec2(i & 1, i >> 1) * cells;
  ivec2 lo = atlasOrigin(i);
  ivec2 hi = lo + ivec2(n - 1);

  vec3 sum = vec3(0.0);
  vec3 count = vec3(0.0);
  for (int y = -2; y <= uStride + 2; ++y) {
    for (int x = -2; x <= uStride + 2; ++x) {
      vec2 state = texelFetch(uState, clamp(lo + cell * uStride + ivec2(x, y), lo, hi), 0).rg;
      if (state.g < 0.0) continue;
      int j = int(state.g);
      int slot = j < i ? j : j - 1;
      vec3 hit = vec3(equal(ivec3(slot), ivec3(0, 1, 2)));
      sum += hit * state.r;
      count += hit;
    }
  }
  outCells = vec4(sum / max(count, vec3(1.0)), 0.0);
}
