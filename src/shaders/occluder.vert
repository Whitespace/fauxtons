// The distance to Spot along every ray of lamp uLamp's map. The map doesn't take straight lines to straight
// lines (mapUV() in common.glsl), so Spot's triangles can't be drawn into it as they are. But each edge of
// a triangle runs one way on each axis of the map, so the triangle's image lies in the box of its corners'
// images, and instance t draws triangle t over that box, for occluder.frag to test each ray there against
// the triangle itself. The part of the triangle outside the map is cut off first: the map reaches only so
// far off the lamp's axis, and nothing behind the lamp has an image in it.

uniform sampler2D uTriangles;  // three texels per triangle: a corner and the edges from it to the others (bvh.js)
uniform int uLamp;

flat out vec3 vCorner;
flat out vec3 vEdge1;
flat out vec3 vEdge2;

const ivec2 CORNERS[6] = ivec2[6](ivec2(0, 0), ivec2(1, 0), ivec2(1, 1), ivec2(0, 0), ivec2(1, 1), ivec2(0, 1));

vec3 triangleData(int index) {
  int width = textureSize(uTriangles, 0).x;
  return texelFetch(uTriangles, ivec2(index % width, index / width), 0).xyz;
}

// How far inside the side k of the map's pyramid, the four planes through the lamp at the map's edges, a
// point is, in the lamp's frame (right, up, axis): negative outside.
float inside(int k, vec3 p, float slope) {
  float side = k < 2 ? p.x : p.y;
  return slope * p.z - ((k & 1) == 0 ? side : -side);
}

void main() {
  int i = uLamp;
  int t = gl_InstanceID;
  vCorner = triangleData(3 * t);
  vEdge1 = triangleData(3 * t + 1);
  vEdge2 = triangleData(3 * t + 2);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  // The triangle in the lamp's frame, cut down to the map's pyramid (Sutherland–Hodgman).
  vec3 o = lampOrigin[i].xyz;
  mat3 frame = transpose(mat3(lampRight[i].xyz, lampUp[i].xyz, lampAxis[i].xyz));
  vec3 polygon[8];
  polygon[0] = frame * (vCorner - o);
  polygon[1] = frame * (vCorner + vEdge1 - o);
  polygon[2] = frame * (vCorner + vEdge2 - o);
  int count = 3;
  float slope = tan(lampRight[i].w);
  for (int k = 0; k < 4 && count > 0; ++k) {
    vec3 cut[8];
    int kept = 0;
    for (int n = 0; n < 8; ++n) {
      if (n >= count) break;
      vec3 a = polygon[n];
      vec3 b = polygon[(n + 1) % count];
      float fa = inside(k, a, slope);
      float fb = inside(k, b, slope);
      if (fa >= 0.0) cut[kept++] = a;
      if ((fa >= 0.0) != (fb >= 0.0)) cut[kept++] = mix(a, b, fa / (fa - fb));
    }
    polygon = cut;
    count = kept;
  }
  if (count == 0) return;

  // The box of the cut polygon's image in the map, half a texel wider all round so that every ray whose
  // texel centre is inside it is drawn.
  vec2 lo = vec2(INF);
  vec2 hi = vec2(-INF);
  for (int n = 0; n < 8; ++n) {
    if (n >= count) break;
    vec2 uv = 0.5 * atan(polygon[n].xy, vec2(polygon[n].z)) / lampRight[i].w + 0.5;
    lo = min(lo, uv);
    hi = max(hi, uv);
  }
  float pad = 0.5 / sceneParams.z;
  vec2 uv = mix(clamp(lo - pad, 0.0, 1.0), clamp(hi + pad, 0.0, 1.0), vec2(CORNERS[gl_VertexID]));
  gl_Position = vec4(2.0 * uv - 1.0, 0.0, 1.0);
}
