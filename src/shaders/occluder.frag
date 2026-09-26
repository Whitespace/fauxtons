// Distance from lamp uLamp to one of Spot's triangles along the map's ray through this texel, where the
// ray meets it (see occluder.vert). The nearest triangle is kept by the depth test.

uniform int uLamp;

flat in vec3 vCorner;
flat in vec3 vEdge1;
flat in vec3 vEdge2;

out float outDistance;

// How far past its edges a triangle still counts as hit, in its own barycentric coordinates, so that a ray
// through an edge two triangles share can't slip between them in rounding.
const float EDGE_MARGIN = 1e-5;

void main() {
  int i = uLamp;
  vec2 uv = (gl_FragCoord.xy - vec2(atlasOrigin(i))) / sceneParams.z;
  vec3 w = mapDirection(i, uv);
  vec3 o = lampOrigin[i].xyz;
  // Möller–Trumbore.
  vec3 p = cross(w, vEdge2);
  float det = dot(vEdge1, p);
  if (det == 0.0) discard;
  vec3 s = (o - vCorner) / det;
  float u = dot(s, p);
  vec3 q = cross(s, vEdge1);
  float v = dot(w, q);
  float t = dot(vEdge2, q);
  if (u < -EDGE_MARGIN || v < -EDGE_MARGIN || u + v > 1.0 + EDGE_MARGIN || t <= 0.0) discard;
  outDistance = t;
  gl_FragDepth = min(t / (RANGE + 1.0), 1.0);
}
