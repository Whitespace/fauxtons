// A thin sheet over the surface of each lamp's lit volume, in the lamp's colour and with its field
// strength, denser where the view grazes it.
//
// The walls of a volume are made of the lamp's own rays, so the mesh spans them with needles a few
// texels across. Their normals come from the smoothed slopes of the end distances at the point
// itself rather than from the needles' corners, which would shade every needle differently.

uniform sampler2D uSlopes;  // per texel: slope of the smoothed end distance across the map (slopes-columns.frag)
uniform vec3 uCameraPos;
uniform float uOpacity;
uniform float uGain;

flat in int vLamp;
in vec3 vWorld;

out vec4 outColor;

// Normal of the surface x = o + t ω over lamp i's map: the cross product of its tangents along the map's
// two axes, each the change of t along the ray plus the turn of ω, per texel.
vec3 boundaryNormal(int i, vec3 x) {
  float n = sceneParams.z;
  vec3 d = x - lampOrigin[i].xyz;
  float t = length(d);
  vec3 dir = d / t;
  vec2 uv = clamp(mapUV(i, d), 0.5 / n, 1.0 - 0.5 / n);
  vec2 slope = texture(uSlopes, (vec2(atlasOrigin(i)) + uv * n) / (2.0 * n)).rg;
  vec3 right = lampRight[i].xyz;
  vec3 up = lampUp[i].xyz;
  // |v| for v = axis + s.x right + s.y up, and the change of s per texel.
  float len = 1.0 / dot(dir, lampAxis[i].xyz);
  float ds = 2.0 * lampRight[i].w / n;
  vec3 du = slope.x * dir + t * ds * (right - dot(dir, right) * dir) / len;
  vec3 dv = slope.y * dir + t * ds * (up - dot(dir, up) * dir) / len;
  return cross(du, dv);
}

void main() {
  int i = vLamp;
  vec3 normal = boundaryNormal(i, vWorld);
  float n2 = dot(normal, normal);
  float facing = n2 > 0.0 ? abs(dot(normal, normalize(vWorld - uCameraPos))) * inversesqrt(n2) : 1.0;
  float alpha = 1.0 - exp(-uOpacity / max(facing, 0.15));
  outColor = vec4(alpha * uGain * field(i, vWorld) * lampColor[i].rgb, 0.0);
}
