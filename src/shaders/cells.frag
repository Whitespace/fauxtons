// Where to put veil geometry. The veil mesh of each lamp is a coarse grid over its map; for every cell
// this finds up to two lamps whose veils with this one the rays around the cell ended on, in the order
// the rays are read, and the mean reach of the rays that ended on each. The footprint reaches a little
// past the cell so the mesh covers the whole of the smoothly reconstructed sheet.

uniform sampler2D uState;
uniform int uStride;

out vec4 outCells;  // x, z the mean reach of the rays that ended on the veil with the lamps y, w; -1 for none

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int cells = n / uStride;
  int i = atlasLamp(px, cells);
  outCells = vec4(0.0, -1.0, 0.0, -1.0);
  if (i < 0) return;
  ivec2 cell = px - atlasCell(i) * cells;
  ivec2 lo = atlasOrigin(i);
  ivec2 hi = lo + ivec2(n - 1);

  vec2 partners = vec2(-1.0);
  vec2 sum = vec2(0.0);
  vec2 count = vec2(0.0);
  for (int y = -2; y <= uStride + 2; ++y) {
    for (int x = -2; x <= uStride + 2; ++x) {
      vec2 state = texelFetch(uState, clamp(lo + cell * uStride + ivec2(x, y), lo, hi), 0).rg;
      if (state.g < 0.0) continue;
      if (partners.x < 0.0) partners.x = state.g;
      else if (partners.y < 0.0 && state.g != partners.x) partners.y = state.g;
      vec2 hit = vec2(equal(partners, vec2(state.g)));
      sum += hit * state.r;
      count += hit;
    }
  }
  vec2 reach = sum / max(count, vec2(1.0));
  outCells = vec4(reach.x, partners.x, reach.y, partners.y);
}
