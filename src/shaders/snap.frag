// Where the grid points of the boundary meshes go (see boundary.vert). Across the edge of a shadow the
// end distance of a lamp's rays jumps from one ray to the next, and a side wall of the lamp's lit
// volume stands on that edge: a surface made of the lamp's own rays. The grid points on both sides of
// the jump move onto one smooth curve through the map between them, so the wall runs along that curve
// instead of zig-zagging along the grid. Grid points stay on their own rays' end distances.
//
// The curve is the half-way contour of a Gaussian blur of which side of the jump each ray of the full
// map is on, and each grid point next to the jump steps onto it by Newton's method.

uniform sampler2D uState;
uniform int uStride;  // map texels between grid points

out vec2 outOffset;  // in map texels

const float CONTOUR_SIGMA = 2.0;
#define CONTOUR_RADIUS 7

// Whether the end distance jumps from one side to the other between grid points p and p + stride × axis.
bool jumpsBetween(int i, ivec2 p, ivec2 axis) {
  float ep = endDistance(uState, i, p);
  float eq = endDistance(uState, i, p + uStride * axis);
  if (abs(eq - ep) <= 0.01 * max(ep, eq)) return false;
  for (int k = 0; k < uStride; ++k) {
    if (jumps(uState, i, p + k * axis, p + (k + 1) * axis)) return true;
  }
  return false;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE / uStride;
  int i = (px.x < n ? 0 : 1) + (px.y < n ? 0 : 2);
  ivec2 p = (px - gridOrigin(i, uStride)) * uStride;
  float ep = endDistance(uState, i, p);
  outOffset = vec2(0.0);

  // The neighbouring grid points across a jump. Where they lie on both sides of this one, it sits on
  // a sliver narrower than the grid and stays put.
  const ivec2 AXES[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  float across = 0.0;
  int count = 0;
  float above = 0.0;
  for (int k = 0; k < 4; ++k) {
    if (!jumpsBetween(i, p, AXES[k])) continue;
    float eq = endDistance(uState, i, p + uStride * AXES[k]);
    if (count > 0 && sign(eq - ep) != above) return;
    above = sign(eq - ep);
    across += eq;
    count++;
  }
  if (count == 0) return;
  float level = 0.5 * (ep + across / float(count));
  float side = sign(ep - level);

  // Newton's method on I(x) = Σ w(k - x) s(k) / Σ w(k - x), where s(k) is 1 for rays on this grid
  // point's side of the jump and w is Gaussian.
  vec2 x = vec2(p);
  for (int iteration = 0; iteration < 3; ++iteration) {
    float weights = 0.0;
    float share = 0.0;
    vec2 dWeights = vec2(0.0);
    vec2 dShare = vec2(0.0);
    for (int dy = -CONTOUR_RADIUS; dy <= CONTOUR_RADIUS; ++dy) {
      for (int dx = -CONTOUR_RADIUS; dx <= CONTOUR_RADIUS; ++dx) {
        ivec2 k = p + ivec2(dx, dy);
        vec2 offset = vec2(k) - x;
        float w = exp(-0.5 * dot(offset, offset) / (CONTOUR_SIGMA * CONTOUR_SIGMA));
        vec2 dw = w * offset / (CONTOUR_SIGMA * CONTOUR_SIGMA);
        float s = (endDistance(uState, i, k) - level) * side > 0.0 ? 1.0 : 0.0;
        weights += w;
        share += w * s;
        dWeights += dw;
        dShare += dw * s;
      }
    }
    float indicator = share / weights;
    vec2 gradient = (dShare - indicator * dWeights) / weights;
    float g2 = dot(gradient, gradient);
    if (g2 < 1e-8) break;
    x += (0.5 - indicator) * gradient / g2;
    x = vec2(p) + clamp(x - vec2(p), vec2(-float(uStride)), vec2(float(uStride)));
  }
  outOffset = x - vec2(p);
}
