// Slopes of the end distances across every lamp's map, per texel, after a Gaussian blur a few texels
// wide. The boundaries of the lit volumes take their normals from these. Along a shadow edge the
// end distance jumps from one ray to the next along a staircase of texels; blurred over several
// steps, the direction of the jump turns smoothly with the edge instead of flipping at every step.

uniform sampler2D uRows;  // from slopes-rows.frag

out vec2 outSlope;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int i = (px.x < n ? 0 : 1) + (px.y < n ? 0 : 2);
  ivec2 lo = atlasOrigin(i);
  ivec2 hi = lo + ivec2(n - 1);
  vec2 slope = vec2(0.0);
  for (int k = -SLOPE_RADIUS; k <= SLOPE_RADIUS; ++k) {
    vec2 rows = texelFetch(uRows, clamp(px + ivec2(0, k), lo, hi), 0).rg;
    vec2 w = slopeWeights(k);
    slope += vec2(w.x * rows.y, w.y * rows.x);
  }
  outSlope = slope;
}
