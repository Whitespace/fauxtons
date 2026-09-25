layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
// On Spot, the vertex's barycentric coordinates in its triangle and the triangle's corners and unit
// normals, one per column (see smoothPoint() in surface.frag). The ground leaves them zero.
layout(location = 2) in vec3 aBarycentric;
layout(location = 3) in mat3 aCorners;
layout(location = 6) in mat3 aCornerNormals;

uniform mat4 uModel;
uniform mat4 uViewProj;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vBarycentric;
flat out mat3 vCorners;
flat out mat3 vCornerNormals;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vBarycentric = aBarycentric;
  for (int k = 0; k < 3; ++k) vCorners[k] = (uModel * vec4(aCorners[k], 1.0)).xyz;
  // The model matrix only scales uniformly and translates, which leaves directions alone.
  vCornerNormals = aCornerNormals;
  gl_Position = uViewProj * world;
}
