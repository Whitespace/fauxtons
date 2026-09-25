// For each of a list of places inside Spot, how much of a list of points of its walls a lamp there could
// light well: points facing it at least as squarely as uMinCosine, between uMinDistance and uMaxDistance
// away, with none of Spot in between. For choosing where to put lamps (see clusters.js).

uniform sampler2D uPlaces;         // xyz
uniform sampler2D uTargets;        // xyz position, w area
uniform sampler2D uTargetNormals;  // xyz unit normal, facing the side the lamps light
uniform int uTargetCount;
uniform float uMinCosine;
uniform float uMinDistance;
uniform float uMaxDistance;

out vec4 outSeen;                  // x the area seen

void main() {
  vec3 place = texelFetch(uPlaces, ivec2(gl_FragCoord.xy), 0).xyz;
  int width = textureSize(uTargets, 0).x;
  float seen = 0.0;
  for (int k = 0; k < uTargetCount; ++k) {
    ivec2 texel = ivec2(k % width, k / width);
    vec4 target = texelFetch(uTargets, texel, 0);
    vec3 d = target.xyz - place;
    float r = length(d);
    if (r < uMinDistance || r > uMaxDistance || -dot(texelFetch(uTargetNormals, texel, 0).xyz, d) < uMinCosine * r) continue;
    if (!spotBlocks(place, d / r, r * (1.0 - 1e-3))) seen += target.w;
  }
  outSeen = vec4(seen, 0.0, 0.0, 0.0);
}
