// How many rays of a block of uBlock × uBlock texels of the maps changed between two solutions, for telling
// when a solve from sight has settled (solver.js): r those whose light ends anywhere else, however little,
// and g those whose light ends elsewhere by more than a thousandth of its distance, or for another reason.

uniform sampler2D uBefore;
uniform sampler2D uAfter;
uniform int uBlock;

out vec2 outChanged;

void main() {
  ivec2 origin = ivec2(gl_FragCoord.xy) * uBlock;
  vec2 changed = vec2(0.0);
  for (int y = 0; y < uBlock; ++y) {
    for (int x = 0; x < uBlock; ++x) {
      vec2 a = texelFetch(uBefore, origin + ivec2(x, y), 0).rg;
      vec2 b = texelFetch(uAfter, origin + ivec2(x, y), 0).rg;
      changed += vec2(a != b, a.g != b.g || abs(a.r - b.r) > 1e-3 * max(a.r, b.r));
    }
  }
  outChanged = changed;
}
