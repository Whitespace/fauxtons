// A thin sheet over the surface of each lamp's lit volume, in the lamp's colour and with its field
// strength, denser where the view grazes it. With uSolid (Opaque v2) it is a solid wall instead, flat
// shaded: in the lamp's colour, darker the further its triangle turns from the view.
//
// The walls of a volume are made of the lamp's own rays, so the mesh spans them with needles a few
// texels across. The sheets' normals come from the smoothed slopes of the end distances at the point
// itself rather than from the needles' corners, which would shade every needle differently.

uniform sampler2D uSlopes;  // per texel: slope of the smoothed end distance across the map (slopes-columns.frag)
uniform usampler2D uTags;   // the lamp whose veil each ray ended on, plus one; 0 if none
uniform vec3 uCameraPos;
uniform float uOpacity;
uniform float uGain;
uniform bool uCull;          // whether to show only the cell owning the surface in view
uniform sampler2D uOwners;   // the lamp owning the surface in view at each pixel, -1 for none
uniform bool uSolid;         // whether to draw solid walls rather than sheets
uniform bool uVeilsOnly;     // with uSolid, whether to draw only the walls on veils

flat in int vLamp;
in vec3 vWorld;

layout(location = 0) out vec4 outColor;
layout(location = 1) out float outDistance;  // with uSolid, the distance from the camera

// Normal of the surface x = o + t ω over lamp i's map: the cross product of its tangents along the map's
// two axes, each the change of t along the ray plus the turn of ω, per texel.
vec3 boundaryNormal(int i, vec3 x) {
  float n = sceneParams.z;
  vec3 d = x - lampOrigin[i].xyz;
  float t = length(d);
  vec3 dir = d / t;
  vec2 uv = clamp(mapUV(i, d), 0.5 / n, 1.0 - 0.5 / n);
  vec2 slope = texture(uSlopes, (vec2(atlasOrigin(i)) + uv * n) / (float(ATLAS_SIDE) * n)).rg;
  vec3 right = lampRight[i].xyz;
  vec3 up = lampUp[i].xyz;
  // |v| for v = axis + s.x right + s.y up, and the change of s per texel: s is the tangent of an angle
  // that changes by 2 lampRight.w / n per texel (mapUV() in common.glsl).
  float len = 1.0 / dot(dir, lampAxis[i].xyz);
  vec2 s = len * vec2(dot(dir, right), dot(dir, up));
  vec2 ds = 2.0 * lampRight[i].w / n * (1.0 + s * s);
  vec3 du = slope.x * dir + t * ds.x * (right - dot(dir, right) * dir) / len;
  vec3 dv = slope.y * dir + t * ds.y * (up - dot(dir, up) * dir) / len;
  return cross(du, dv);
}

// Whether x, on lamp i's boundary, is on a veil: on that of a lamp whose veil one of the 2×2 rays
// around x ended on, where the two fields are equal.
bool onVeil(int i, vec3 x) {
  ivec2 base = ivec2(floor(mapUV(i, x - lampOrigin[i].xyz) * sceneParams.z - 0.5));
  ivec2 last = ivec2(MAP_SIZE - 1);
  float di = fieldDistance(i, x);
  for (int k = 0; k < 4; ++k) {
    int j = int(texelFetch(uTags, atlasOrigin(i) + clamp(base + ivec2(k & 1, k >> 1), ivec2(0), last), 0).r) - 1;
    if (j >= 0 && abs(fieldDistance(j, x) - di) <= 0.01 * di) return true;
  }
  return false;
}

void main() {
  int i = vLamp;
  // The normal of the triangle itself, taken before any of its fragments is discarded.
  vec3 facet = cross(dFdx(vWorld), dFdy(vWorld));
  if (uCull && i != int(texelFetch(uOwners, ivec2(gl_FragCoord.xy), 0).r)) discard;
  vec3 view = normalize(vWorld - uCameraPos);
  if (uSolid) {
    if (uVeilsOnly && !onVeil(i, vWorld)) discard;
    float f2 = dot(facet, facet);
    float square = f2 > 0.0 ? abs(dot(facet, view)) * inversesqrt(f2) : 1.0;
    outColor = vec4(lampColor[i].rgb * (0.2 + 0.8 * square), 1.0);
    outDistance = length(vWorld - uCameraPos);
    return;
  }
  vec3 normal = boundaryNormal(i, vWorld);
  float n2 = dot(normal, normal);
  float facing = n2 > 0.0 ? abs(dot(normal, view)) * inversesqrt(n2) : 1.0;
  float alpha = 1.0 - exp(-uOpacity / max(facing, 0.15));
  outColor = vec4(alpha * uGain * field(i, vWorld) * lampColor[i].rgb, 0.0);
}
