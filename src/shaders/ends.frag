// The end distances the boundary meshes are built on (see boundary.vert), smoothed along one axis of
// the map per pass. Where a lamp's light ends against the edge of another lamp's light, it follows
// that edge as the solver sees it, through the other lamp's texels, so the end distance ripples across
// the rays; seen almost edge on, a sheet over the ripples folds into stripes. A Gaussian blur several
// texels wide removes them, but it stops at jumps in the end distance, so the walls standing on them
// stay sharp.

uniform sampler2D uState;   // the solution, for finding jumps
uniform sampler2D uValues;  // end distances to smooth: the solution itself on the first pass
uniform bool uFirstPass;
uniform ivec2 uAxis;

out float outEnd;

#define END_RADIUS 18
const float END_SIGMA = 6.0;

float value(int i, ivec2 texel) {
  if (uFirstPass) return endDistance(uState, i, texel);
  return texelFetch(uValues, atlasOrigin(i) + clamp(texel, ivec2(0), ivec2(MAP_SIZE - 1)), 0).r;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE;
  int i = (px.x < n ? 0 : 1) + (px.y < n ? 0 : 2);
  ivec2 p = px - atlasOrigin(i);
  float sum = value(i, p);
  float weights = 1.0;
  for (int direction = -1; direction <= 1; direction += 2) {
    ivec2 step = direction * uAxis;
    // The end distances just behind, at and just past the step from k - 1 to k along the walk.
    float behind = endDistance(uState, i, p - step);
    float from = endDistance(uState, i, p);
    float to = endDistance(uState, i, p + step);
    for (int k = 1; k <= END_RADIUS; ++k) {
      float ahead = endDistance(uState, i, p + (k + 1) * step);
      if (isJump(behind, from, to, ahead)) break;
      float w = exp(-0.5 * float(k * k) / (END_SIGMA * END_SIGMA));
      sum += w * (uFirstPass ? to : value(i, p + k * step));
      weights += w;
      behind = from;
      from = to;
      to = ahead;
    }
  }
  outEnd = sum / weights;
}
