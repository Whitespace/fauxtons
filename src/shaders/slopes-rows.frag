// First half of the slopes of the smoothed end distances (see slopes-columns.frag): along each row of
// every lamp's map, the Gaussian blur of the end distances and their Gaussian derivative.

uniform sampler2D uEnds;  // smoothed end distances (ends.frag)

out vec2 outRows;  // x blurred along the row, y its slope along the row per texel

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int i = (px.x < n ? 0 : 1) + (px.y < n ? 0 : 2);
  ivec2 lo = atlasOrigin(i);
  ivec2 hi = lo + ivec2(n - 1);
  vec2 sum = vec2(0.0);
  for (int k = -SLOPE_RADIUS; k <= SLOPE_RADIUS; ++k) {
    sum += slopeWeights(k) * texelFetch(uEnds, clamp(px + ivec2(k, 0), lo, hi), 0).r;
  }
  outRows = sum;
}
