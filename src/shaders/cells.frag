// Where to put veil geometry. The veil mesh of each lamp is a coarse grid over its map; for every
// cell and each of the lamp's three partners (xyz, see lampPartners), this finds the mean reach of the
// rays around the cell that ended on the veil with that lamp, or 0 if none did. The footprint reaches a
// little past the cell so the mesh covers the whole of the smoothly reconstructed sheet.

uniform sampler2D uState;
uniform int uStride;

out vec4 outCells;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int cells = n / uStride;
  int i = atlasLamp(px, cells);
  outCells = vec4(0.0);
  if (i < 0) return;
  ivec2 cell = px - atlasCell(i) * cells;
  ivec2 lo = atlasOrigin(i);
  ivec2 hi = lo + ivec2(n - 1);

  vec3 sum = vec3(0.0);
  vec3 count = vec3(0.0);
  for (int y = -2; y <= uStride + 2; ++y) {
    for (int x = -2; x <= uStride + 2; ++x) {
      vec2 state = texelFetch(uState, clamp(lo + cell * uStride + ivec2(x, y), lo, hi), 0).rg;
      if (state.g < 0.0) continue;
      vec3 hit = vec3(equal(ivec3(lampPartners[i].xyz), ivec3(int(state.g))));
      sum += hit * state.r;
      count += hit;
    }
  }
  outCells = vec4(sum / max(count, vec3(1.0)), 0.0);
}
