// Ground and Spot. A surface is lit by the one lamp whose light reaches it (litBy() in exact.glsl).

uniform vec3 uCameraPos;
uniform vec3 uAlbedo;
uniform float uAmbient;
// With uDiffuse, Spot shows the light leaving its shell (diffusion.js), known at its vertices: per
// vertex, x its cell's lamp, -1 for none, and y that light.
uniform bool uDiffuse;
uniform sampler2D uDiffused;
// With uOwner, the lamp whose cell the point is in, -1 for none, is written instead of its colour, for
// Backface culling (renderer.js). That is decided by the maps alone, which is good to about a texel: the
// strongest lamp facing the point whose map's rays around it don't all end short of it.
uniform bool uOwner;

in vec3 vWorld;
in vec3 vNormal;
in vec3 vBarycentric;
flat in mat3 vCorners;
flat in mat3 vCornerNormals;
flat in vec3 vCornerIds;

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

// The light leaving the shell here, for a point of the cell of lamp `cell`: interpolated from the
// triangle's corners in that cell, so that it stops where the cell does. -1 if no corner is in it.
float diffusedLight(int cell) {
  float sum = 0.0;
  float weights = 0.0;
  for (int k = 0; k < 3; ++k) {
    vec4 corner = dataAt(uDiffused, int(vCornerIds[k]));
    if (int(corner.x) == cell) {
      sum += vBarycentric[k] * corner.y;
      weights += vBarycentric[k];
    }
  }
  return weights > 0.0 ? sum / weights : -1.0;
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 facet = normal;
  float rough = 0.0;
  bool onSpot = dot(vBarycentric, vec3(1.0)) > 0.0;
  if (onSpot) {
    facet = normalize(cross(vCorners[1] - vCorners[0], vCorners[2] - vCorners[0]));
    if (dot(facet, normal) < 0.0) facet = -facet;
    // How far the facets stray from the smooth surface, for litBy(): a tenth of the triangle's size.
    rough = 0.1 * max(max(distance(vCorners[0], vCorners[1]), distance(vCorners[1], vCorners[2])), distance(vCorners[2], vCorners[0]));
  }
  if (uOwner) {
    float bound = INF;
    int owner = -1;
    for (int n = 0; n < LAMP_COUNT; ++n) {
      float strength;
      owner = nextStrongest(vWorld, normal, true, bound, owner, strength);
      if (owner < 0 || litFromMaps(owner, vWorld, facet) != 0) break;
      bound = strength;
    }
    outColor = vec4(float(owner));
    return;
  }
  int lamp = litBy(vWorld, facet, smoothPoint(vWorld), normal, rough);
  float arriving = 0.0;
  if (lamp >= 0) {
    vec3 d = vWorld - lampOrigin[lamp].xyz;
    arriving = field(lamp, vWorld) * -dot(normal, d) / length(d);
  }
  vec3 light = lamp >= 0 ? lampColor[lamp].rgb * arriving : vec3(0.0);
  if (uDiffuse && onSpot) {
    // Where no lamp's light arrives, the point is in the cell of its nearest corner that has one.
    int cell = lamp;
    float nearest = -1.0;
    for (int k = 0; k < 3 && lamp < 0; ++k) {
      int owner = int(dataAt(uDiffused, int(vCornerIds[k])).x);
      if (owner >= 0 && vBarycentric[k] > nearest) {
        nearest = vBarycentric[k];
        cell = owner;
      }
    }
    float leaving = cell >= 0 ? diffusedLight(cell) : -1.0;
    if (leaving >= 0.0) light = lampColor[cell].rgb * leaving;
  }
  outColor = vec4(uAlbedo * (light + uAmbient), 1.0);
  outDistance = length(vWorld - uCameraPos);
}
