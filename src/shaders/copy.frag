// Compact copies of the published solution for the passes that read it most: the reach distances as
// half floats (they filter much faster, for the fog) and the veil partners as bytes (for the veils).

uniform sampler2D uState;

layout(location = 0) out float outReach;
layout(location = 1) out uint outPartner;  // the lamp whose veil the ray ended on, plus one; 0 if none

void main() {
  vec2 state = texelFetch(uState, ivec2(gl_FragCoord.xy), 0).rg;
  outReach = state.r;
  outPartner = uint(state.g + 1.0);
}
