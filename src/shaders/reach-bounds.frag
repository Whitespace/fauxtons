// Bounds of the reach over blocks of every lamp's map, for following a ray through a map in large steps
// (presentAlong() in exact.glsl). A cell is the square between four neighbouring rays of a map; level L
// has one texel per block of 2^L × 2^L cells, holding the least and greatest reach of the (2^L + 1)² rays
// at their corners. The first level is made from the solution, each further one from the level below.

uniform sampler2D uSource;
uniform int uLevel;

out vec2 outBounds;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 bounds = vec2(INF, 0.0);
  if (uLevel == 1) {
    // The corners of 2 × 2 cells, clamped to this lamp's quadrant of the atlas.
    ivec2 lo = (2 * px / MAP_SIZE) * MAP_SIZE;
    ivec2 hi = lo + MAP_SIZE - 1;
    for (int k = 0; k < 9; ++k) {
      float reach = texelFetch(uSource, clamp(2 * px + ivec2(k % 3, k / 3), lo, hi), 0).r;
      bounds = vec2(min(bounds.x, reach), max(bounds.y, reach));
    }
  } else {
    // The level below is the only one the source exposes while this one is drawn.
    for (int k = 0; k < 4; ++k) {
      vec2 below = texelFetch(uSource, 2 * px + ivec2(k & 1, k >> 1), 0).rg;
      bounds = vec2(min(bounds.x, below.x), max(bounds.y, below.y));
    }
  }
  outBounds = bounds;
}
