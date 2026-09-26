// Where the view first meets Spot's surface, for walls.frag: x the distance, y 1 where the view goes into
// Spot there, from outside.

uniform vec3 uCameraPos;

in vec3 vWorld;
in vec3 vNormal;
flat in mat3 vCorners;

out vec2 outShell;

void main() {
  // The normals face the inside, which the lamps light (main.js).
  vec3 facet = cross(vCorners[1] - vCorners[0], vCorners[2] - vCorners[0]);
  if (dot(facet, vNormal) < 0.0) facet = -facet;
  vec3 d = vWorld - uCameraPos;
  outShell = vec2(length(d), dot(d, facet) > 0.0 ? 1.0 : 0.0);
}
