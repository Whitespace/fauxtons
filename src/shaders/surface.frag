// Ground and Spot. A surface is lit by the one lamp whose light reaches it (litBy() in exact.glsl).

uniform vec3 uCameraPos;
uniform vec3 uAlbedo;
uniform float uAmbient;

in vec3 vWorld;
in vec3 vNormal;
in vec3 vBarycentric;
flat in mat3 vCorners;
flat in mat3 vCornerNormals;

layout(location = 0) out vec4 outColor;
layout(location = 1) out float outDistance;

// Spot's triangles are flat, but it is shaded as the smooth surface its vertex normals describe. Light
// is tested at the point of that surface over x, found by lifting x towards the tangent planes at the
// triangle's corners (Hanika, "Hacking the Shadow Terminator", 2021), so that the neighbouring facets
// don't cut jagged shadows into it where it turns away from a lamp. On the ground the lift is zero.
vec3 smoothPoint(vec3 x) {
  vec3 lift = vec3(0.0);
  for (int k = 0; k < 3; ++k) {
    lift -= vBarycentric[k] * min(0.0, dot(x - vCorners[k], vCornerNormals[k])) * vCornerNormals[k];
  }
  return x + lift;
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 facet = normal;
  float rough = 0.0;
  if (dot(vBarycentric, vec3(1.0)) > 0.0) {
    facet = normalize(cross(vCorners[1] - vCorners[0], vCorners[2] - vCorners[0]));
    if (dot(facet, normal) < 0.0) facet = -facet;
    // How far the facets stray from the smooth surface, for litBy(): a tenth of the triangle's size.
    rough = 0.1 * max(max(distance(vCorners[0], vCorners[1]), distance(vCorners[1], vCorners[2])), distance(vCorners[2], vCorners[0]));
  }
  int lamp = litBy(vWorld, facet, smoothPoint(vWorld), normal, rough);
  vec3 light = vec3(0.0);
  if (lamp >= 0) {
    vec3 d = vWorld - lampOrigin[lamp].xyz;
    light = lampColor[lamp].rgb * field(lamp, vWorld) * -dot(normal, d) / length(d);
  }
  outColor = vec4(uAlbedo * (light + uAmbient), 1.0);
  outDistance = length(vWorld - uCameraPos);
}
