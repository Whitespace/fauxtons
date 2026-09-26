// Solid walls between the cells, found for every pixel rather than drawn from meshes (Opaque). The view ray
// is followed from cell to cell: in each, from where the ray is in its lamp's light to where that light
// ends, until the ray comes to a wall to draw. With uVeils that is the first isolux veil, where two lamps'
// light meets head on; with uBounds, the first place where the light of any cell ends, whatever ends it. A
// wall is in the colour of the cell the view is in, shaded by how squarely it faces the view.
//
// A lamp's map tells roughly where its light ends along the ray, to about a texel, and the wall is then
// placed exactly: a veil where the two fields are equal, d_i = d_j, and Spot's surface where the ray meets
// its triangles. The light is followed there only as far as the ray's next meeting with Spot's surface,
// where it goes out of Spot, and comes back in where the ray next meets it.
//
// The first cell is the one lighting the inside of Spot's surface where the view goes in (shell.frag), or
// the one the camera is in, from inside (camera-light.frag).

uniform sampler2D uSceneDistance;  // distance to the surfaces drawn, where the search ends
uniform sampler2D uShell;          // x distance to Spot's surface, y 1 where the view goes into Spot there
uniform sampler2D uCameraLight;    // x the lamp whose light is present at the camera, -1 if none
uniform sampler2D uBvhNormals;     // unit normals at the corners of Spot's triangles (bvh.js)
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec2 uResolution;
uniform float uPixelAngle;         // the angle a pixel spans
uniform bool uVeils;
uniform bool uBounds;

layout(location = 0) out vec4 outColor;
layout(location = 1) out float outDistance;

#define FAR 1000.0
#define CELLS 16  // cells followed along a ray at most

// The rays round the 2×2 of a map around a point.
const ivec2 RING[12] = ivec2[12](
  ivec2(-1, -1), ivec2(0, -1), ivec2(1, -1), ivec2(2, -1), ivec2(-1, 0), ivec2(2, 0),
  ivec2(-1, 1), ivec2(2, 1), ivec2(-1, 2), ivec2(0, 2), ivec2(1, 2), ivec2(2, 2));

// How far past its edges a triangle still counts as hit, in its own barycentric coordinates, so that a ray
// through an edge two triangles share can't slip between them in rounding.
const float EDGE_MARGIN = 1e-5;

// Whether lamp k's light is present at y as the four rays of its map around it tell, as mapLight() in
// exact.glsl judges it but with the rays that end on Spot counted like any other: where the light ends on
// Spot, their ends are Spot's surface. That is as good as a map gets, and it spares following the view
// ray through Spot's triangles at every step just inside its surface, where the rays around all end on it.
bool mapPresent(int k, vec3 y) {
  if (y.y < 0.0 || fieldDistance(k, y) >= INF) return false;
  vec3 d = y - lampOrigin[k].xyz;
  float dist = length(d);
  vec2 st = mapUV(k, d) * sceneParams.z - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = st - vec2(base);
  ivec2 origin = atlasOrigin(k);
  ivec2 last = ivec2(MAP_SIZE - 1);
  vec4 reach = vec4(
    texelFetch(uReach, origin + clamp(base, ivec2(0), last), 0).r,
    texelFetch(uReach, origin + clamp(base + ivec2(1, 0), ivec2(0), last), 0).r,
    texelFetch(uReach, origin + clamp(base + ivec2(0, 1), ivec2(0), last), 0).r,
    texelFetch(uReach, origin + clamp(base + ivec2(1, 1), ivec2(0), last), 0).r);
  float spread = max(max(reach.x, reach.y), max(reach.z, reach.w)) - min(min(reach.x, reach.y), min(reach.z, reach.w));
  float interpolated = mix(mix(reach.x, reach.y, f.x), mix(reach.z, reach.w, f.x), f.y);
  return dist < interpolated + min(spread, REACH_TOLERANCE * dist);
}

// The first point of the ray o + t w with ta < t < tb where lamp k's light is absent, as mapPresent() judges
// it, for a ray on which it is present at ta; tb if it is present all the way. The ray is followed through
// k's map a block at a time, as in presentFrom() in exact.glsl.
float absentFrom(int k, vec3 o, vec3 w, float ta, float tb) {
  vec3 lamp = lampOrigin[k].xyz;
  float size = sceneParams.z;
  vec3 D = o - lamp;
  vec2 s0 = vec2(dot(D, lampRight[k].xyz), dot(D, lampUp[k].xyz));
  vec2 s1 = vec2(dot(w, lampRight[k].xyz), dot(w, lampUp[k].xyz));
  float z0 = dot(D, lampAxis[k].xyz);
  float z1 = dot(w, lampAxis[k].xyz);
  float scale = 0.5 * size / lampRight[k].w;
  float shift = 0.5 * size - 0.5;
  vec2 motion = sign(s1 * z0 - s0 * z1);
  float closest = dot(lamp - o, w);
  int top = int(round(log2(size)));
  int level = 4;
  float t = ta;
  for (int step = 0; step < 1024 && t < tb; ++step) {
    float cells = exp2(float(level));
    vec2 st = scale * atan(s0 + t * s1, vec2(z0 + t * z1)) + shift;
    vec2 block = clamp(floor((st + 0.01 * motion) / cells), vec2(0.0), vec2(size / cells - 1.0));
    vec2 edge = tan(((block + max(motion, 0.0)) * cells - shift) / scale);
    vec2 exits = (edge * z0 - s0) / (s1 - edge * z1);
    float exit = tb;
    if (motion.x != 0.0 && exits.x > t) exit = min(exit, exits.x);
    if (motion.y != 0.0 && exits.y > t) exit = min(exit, exits.y);
    float enter = distance(o + t * w, lamp);
    float leave = distance(o + exit * w, lamp);
    float nearest = closest > t && closest < exit ? distance(o + closest * w, lamp) : min(enter, leave);
    vec2 bounds = reachBounds(k, ivec2(block), level);
    if (max(enter, leave) < bounds.x) {
      t = exit;
      level = min(level + 1, top);
    } else if (nearest * (1.0 - REACH_TOLERANCE) > bounds.y) {
      return t;
    } else if (level > 0) {
      level--;
    } else {
      if (!mapPresent(k, o + exit * w)) {
        float lo = t;
        float hi = exit;
        for (int n = 0; n < 16; ++n) {
          float m = 0.5 * (lo + hi);
          if (mapPresent(k, o + m * w)) lo = m; else hi = m;
        }
        return hi;
      }
      t = exit;
      level = 1;
    }
  }
  return tb;
}

// The first point of the ray o + t w with ta < t < tb where lamp k's light is present as mapPresent() judges
// it, or INF; as presentFrom() in exact.glsl, which follows Spot's triangles instead where the rays around
// meet Spot. Where the view ray goes into a lamp's light isn't drawn, so the map is enough.
float mapPresentFrom(int k, vec3 o, vec3 w, float ta, float tb) {
  vec3 lamp = lampOrigin[k].xyz;
  float size = sceneParams.z;
  vec3 D = o - lamp;
  vec2 s0 = vec2(dot(D, lampRight[k].xyz), dot(D, lampUp[k].xyz));
  vec2 s1 = vec2(dot(w, lampRight[k].xyz), dot(w, lampUp[k].xyz));
  float z0 = dot(D, lampAxis[k].xyz);
  float z1 = dot(w, lampAxis[k].xyz);
  float scale = 0.5 * size / lampRight[k].w;
  float shift = 0.5 * size - 0.5;
  vec2 motion = sign(s1 * z0 - s0 * z1);
  float closest = dot(lamp - o, w);
  int top = int(round(log2(size)));
  int level = 4;
  float t = ta;
  bool decided = false;
  for (int step = 0; step < 1024 && t < tb; ++step) {
    float cells = exp2(float(level));
    vec2 st = scale * atan(s0 + t * s1, vec2(z0 + t * z1)) + shift;
    vec2 block = clamp(floor((st + 0.01 * motion) / cells), vec2(0.0), vec2(size / cells - 1.0));
    vec2 edge = tan(((block + max(motion, 0.0)) * cells - shift) / scale);
    vec2 exits = (edge * z0 - s0) / (s1 - edge * z1);
    float exit = tb;
    if (motion.x != 0.0 && exits.x > t) exit = min(exit, exits.x);
    if (motion.y != 0.0 && exits.y > t) exit = min(exit, exits.y);
    float enter = distance(o + t * w, lamp);
    float leave = distance(o + exit * w, lamp);
    float nearest = closest > t && closest < exit ? distance(o + closest * w, lamp) : min(enter, leave);
    vec2 bounds = reachBounds(k, ivec2(block), level);
    if (nearest * (1.0 - REACH_TOLERANCE) > bounds.y) {
      t = exit;
      level = min(level + 1, top);
      decided = false;
    } else if (max(enter, leave) < bounds.x) {
      return t;
    } else if (level > 0) {
      level--;
    } else {
      if (!decided && mapPresent(k, o + t * w)) return t;
      if (mapPresent(k, o + exit * w)) {
        float lo = t;
        float hi = exit;
        for (int n = 0; n < 12; ++n) {
          float m = 0.5 * (lo + hi);
          if (mapPresent(k, o + m * w)) hi = m; else lo = m;
        }
        return hi;
      }
      t = exit;
      decided = true;
      level = 1;
    }
  }
  return INF;
}

// The first point of the ray o + t d with tMin < t < tMax on Spot's surface, or tMax, with the triangle
// there and the point's barycentric coordinates in it; the hierarchy is walked as in spotBlocks().
float spotHit(vec3 o, vec3 d, float tMin, float tMax, out int triangle, out vec2 uv) {
  triangle = -1;
  uv = vec2(0.0);
  float best = tMax;
  if (!uSpot) return best;
  vec3 inv = 1.0 / d;
  int end = int(dataAt(uBvhNodes, 0).w);
  for (int node = 0, step = 0; node < end && step < 16384; ++step) {
    vec4 lo = dataAt(uBvhNodes, 2 * node);
    vec4 hi = dataAt(uBvhNodes, 2 * node + 1);
    vec3 t0 = (lo.xyz - o) * inv;
    vec3 t1 = (hi.xyz - o) * inv;
    vec3 enter = min(t0, t1);
    vec3 exit = max(t0, t1);
    if (max(max(enter.x, enter.y), max(enter.z, tMin)) > min(min(exit.x, exit.y), min(exit.z, best))) {
      node = int(lo.w);
    } else if (hi.w < 0.0) {
      node++;
    } else {
      int leaf = int(hi.w);
      for (int k = 0; k < (leaf & 7); ++k) {
        int index = (leaf >> 3) + k;
        vec3 a = dataAt(uBvhTriangles, 3 * index).xyz;
        vec3 e1 = dataAt(uBvhTriangles, 3 * index + 1).xyz;
        vec3 e2 = dataAt(uBvhTriangles, 3 * index + 2).xyz;
        vec3 p = cross(d, e2);
        float det = dot(e1, p);
        if (det == 0.0) continue;
        vec3 s = (o - a) / det;
        float u = dot(s, p);
        vec3 q = cross(s, e1);
        float v = dot(d, q);
        float t = dot(e2, q);
        if (u >= -EDGE_MARGIN && v >= -EDGE_MARGIN && u + v <= 1.0 + EDGE_MARGIN && t > tMin && t < best) {
          best = t;
          triangle = index;
          uv = vec2(u, v);
        }
      }
      node = int(lo.w);
    }
  }
  return best;
}

// The lamp whose light is present at y as the maps tell it, -1 where it is dark: the strongest found there.
int strongestPresent(vec3 y) {
  float bound = INF;
  int best = -1;
  for (int n = 0; n < LAMP_COUNT; ++n) {
    float strength;
    best = nextStrongest(y, vec3(0.0), false, bound, best, strength);
    if (best < 0) break;
    bound = strength;
    if (presentAt(best, y)) return best;
  }
  return -1;
}

// Up to four lamps whose veils with lamp c the rays of c's map around x ended on, nearest rays first, -1
// for none.
ivec4 partnersAround(int c, vec3 x) {
  float size = sceneParams.z;
  ivec2 base = ivec2(floor(mapUV(c, x - lampOrigin[c].xyz) * size - 0.5));
  ivec2 origin = atlasOrigin(c);
  ivec2 last = ivec2(MAP_SIZE - 1);
  ivec4 found = ivec4(-1);
  int count = 0;
  for (int k = 0; k < 16 && count < 4; ++k) {
    ivec2 offset = k < 4 ? ivec2(k & 1, k >> 1) : RING[k - 4];
    int tag = int(texelFetch(uReach, origin + clamp(base + offset, ivec2(0), last), 0).g);
    if (tag < 0 || any(equal(found, ivec4(tag)))) continue;
    found[count++] = tag;
  }
  return found;
}

// d_c - d_p at x: negative where c's field is the stronger, and where only one lamp has a field, it wins.
float veilLead(int c, int p, vec3 x) {
  float dc = fieldDistance(c, x);
  float dp = fieldDistance(p, x);
  if (dc >= INF) return dp >= INF ? 0.0 : 1.0;
  return dp >= INF ? -1.0 : dc - dp;
}

// Where the view ray ro + t rd crosses the veil of lamps c and p going from c's side to p's, looking out
// from t, at most `reach` either way and back no further than `from`; -1 if it doesn't.
float veilCrossing(int c, int p, vec3 ro, vec3 rd, float t, float from, float reach) {
  float a = t;
  float b = t;
  float la = veilLead(c, p, ro + t * rd);
  float lb = la;
  float h = reach / 64.0;
  for (int k = 0; k < 7 && !(la < 0.0 && lb > 0.0); ++k) {
    if (!(la < 0.0)) {
      a = max(t - h, from);
      la = veilLead(c, p, ro + a * rd);
    }
    if (!(lb > 0.0)) {
      b = t + h;
      lb = veilLead(c, p, ro + b * rd);
    }
    h *= 2.0;
  }
  if (!(la < 0.0 && lb > 0.0)) return -1.0;
  for (int k = 0; k < 24; ++k) {
    float m = 0.5 * (a + b);
    if (veilLead(c, p, ro + m * rd) < 0.0) a = m; else b = m;
  }
  return 0.5 * (a + b);
}

// Whether the 4×4 rays of lamp k's map around x all ended on its veil with lamp p.
bool allOnVeil(int k, int p, vec3 x) {
  float size = sceneParams.z;
  ivec2 base = ivec2(floor(mapUV(k, x - lampOrigin[k].xyz) * size - 0.5));
  ivec2 origin = atlasOrigin(k);
  ivec2 last = ivec2(MAP_SIZE - 1);
  for (int n = 0; n < 16; ++n) {
    ivec2 texel = origin + clamp(base + ivec2(n % 4 - 1, n / 4 - 1), ivec2(0), last);
    if (int(texelFetch(uReach, texel, 0).g) != p) return false;
  }
  return true;
}

// Whether the light of lamps c and p meets at x on their veil: the two fields are equal there and both
// lights get there. Where the rays of both maps around x all ended on this veil, they do; near an edge of
// the veil, each lamp's own ray is followed (exact.glsl), to a point just off the veil on that lamp's own
// side. At x itself the answer would turn on rounding where a lamp's rays graze the veil, as the rays of
// lamps back to back do: there the point on the ray where the other field takes over moves a long way
// for a small error in x.
bool meets(int c, int p, vec3 x) {
  float d = fieldDistance(c, x);
  if (abs(d - fieldDistance(p, x)) > 1e-3 * d) return false;
  if (allOnVeil(c, p, x) && allOnVeil(p, c, x)) return true;
  vec3 across = 1e-4 * distance(x, lampOrigin[c].xyz) * normalize(fieldDistanceGradient(c, x) - fieldDistanceGradient(p, x));
  return reachesExact(c, x - across, 0.0) && reachesExact(p, x + across, 0.0);
}

// What keeps lamp k's light from y, following k's own ray there (exact.glsl): OUT_OF_CONE, SPOT, the lamp
// whose light the ray runs into, or -1 where nothing does and the light is present at y.
#define OUT_OF_CONE -3
#define SPOT -2
int keptFrom(int k, vec3 y) {
  if (y.y < 0.0 || fieldDistance(k, y) >= INF) return OUT_OF_CONE;
  vec3 o = lampOrigin[k].xyz;
  vec3 d = y - o;
  float dist = length(d);
  if (spotBlocks(o, d / dist, dist)) return SPOT;
  int partner, stopper;
  return extinction(k, d / dist, dist, false, partner, stopper) < INF ? stopper : -1;
}

// Whether lamp k's light is present at y as far as `by` alone is concerned (see keptFrom()): near the edge
// of a shadow, the one thing that casts it.
bool presentDespite(int k, int by, vec3 y) {
  if (y.y < 0.0 || fieldDistance(k, y) >= INF) return false;
  if (by == OUT_OF_CONE) return true;
  vec3 o = lampOrigin[k].xyz;
  vec3 d = y - o;
  float dist = length(d);
  return by == SPOT ? !spotBlocks(o, d / dist, dist) : runsInto(k, by, d / dist, dist, false) >= INF;
}

// Where lamp k's light ends along the view ray near t, where its map has it end, `reach` being about how
// far off the map can be, from `from` at the earliest and to `within`. A wall that isn't a veil or Spot's
// surface is the edge of a shadow, made of one lamp's rays: k's own, where the view ray goes on into the
// shadow k's light casts, or those of the stronger lamp j whose light k's rays run into from the side,
// where they end on the wall. Either way the wall is found by following that lamp's rays to points of the
// view ray, which places it exactly; along the other lamp's rays, it would be only where that lamp's map
// has it. The shadow is cast by one thing, found once on its dark side, so each point is tested against
// that alone (presentDespite()). The map's end, t, where the light isn't absent on one side and present
// on the other of that stretch.
float exactEnd(int k, vec3 ro, vec3 rd, float t, float from, float reach, float within) {
  vec3 o = lampOrigin[k].xyz;
  vec3 d = ro + t * rd - o;
  float dist = length(d);
  int partner, stopper;
  float ends = extinction(k, d / dist, 1.05 * dist, true, partner, stopper);
  int j = stopper >= 0 && ends > 0.95 * dist ? stopper : k;
  // Whether j's light is present on k's side of the wall.
  bool before = j == k;
  float lo = max(t - reach, from);
  float hi = t + reach;
  int by = keptFrom(j, ro + (before ? hi : lo) * rd);
  if (by == -1 || !presentDespite(j, by, ro + (before ? lo : hi) * rd)) return t;
  for (int n = 0; n < 16 && hi - lo > within; ++n) {
    float m = 0.5 * (lo + hi);
    if (presentDespite(j, by, ro + m * rd) == before) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 far = uInvViewProj * vec4(2.0 * gl_FragCoord.xy / uResolution - 1.0, 1.0, 1.0);
  vec3 ro = uCameraPos;
  vec3 rd = normalize(far.xyz / far.w - ro);
  float end = min(texelFetch(uSceneDistance, px, 0).r, FAR);
  vec2 shell = texelFetch(uShell, px, 0).rg;
  outColor = vec4(0.0);
  outDistance = INF;

  // Where the walk starts, and in whose light. All the light is inside Spot, so from outside it starts
  // where the view goes into Spot, and a view from outside that misses Spot meets nothing.
  float s = 0.0;
  int cell = int(texelFetch(uCameraLight, ivec2(0), 0).r);
  bool missed = !(shell.x < INF);
  if (shell.y > 0.5) {
    s = shell.x * (1.0 + 1e-5);
    cell = strongestPresent(ro + s * rd);
  }
  // Where the ray next meets Spot's surface, going out of it.
  int triangle = -1;
  vec2 uv = vec2(0.0);
  float surface = missed ? end : spotHit(ro, rd, s, end, triangle, uv);
  bool inside = true;

  float wall = INF;
  int facing = -1;
  int partner = -1;
  bool onSurface = false;
  for (int n = 0; n < CELLS && s < end && !missed; ++n) {
    if (!inside) {
      // Outside Spot: in again where the ray next meets it.
      if (surface >= end) break;
      s = surface * (1.0 + 1e-5);
      surface = spotHit(ro, rd, s, end, triangle, uv);
      cell = strongestPresent(ro + s * rd);
      inside = true;
      continue;
    }
    if (cell < 0) {
      // In the dark: on to where the next lamp's light starts, or out of Spot.
      float next = surface;
      for (int k = 0; k < LAMP_COUNT; ++k) {
        vec2 span = coneSpan(k, ro, rd, next);
        if (span.y <= max(span.x, s)) continue;
        float t = mapPresentFrom(k, ro, rd, max(span.x, s), span.y);
        if (t < next) {
          next = t;
          cell = k;
        }
      }
      s = next;
      inside = cell >= 0;
      continue;
    }

    // Where this cell's light ends along the ray as its map has it, no further than where the ray leaves
    // the lamp's cone or goes out of Spot.
    float stop = min(surface, end);
    float leaves = min(coneSpan(cell, ro, rd, stop).y, stop);
    float exit = absentFrom(cell, ro, rd, s, leaves);
    if (exit >= end) break;
    vec3 x = ro + exit * rd;
    float footprint = 2.0 * lampRight[cell].w / sceneParams.z * distance(x, lampOrigin[cell].xyz);

    // Whether the light ends there on a veil: the first along the ray, before Spot's surface, of those
    // the rays of the map around there ended on, placed exactly near where the map has the light end.
    ivec4 partners = partnersAround(cell, x);
    int veil = -1;
    float best = surface;
    for (int k = 0; k < 4; ++k) {
      int p = partners[k];
      if (p < 0) continue;
      float t = veilCrossing(cell, p, ro, rd, exit, s, 16.0 * footprint);
      if (t > 0.0 && t < best && meets(cell, p, ro + t * rd)) {
        best = t;
        veil = p;
      }
    }
    // Where the light ends otherwise: on Spot's surface, exactly, where that is as near as the map is
    // good for, or else as the map has it. Drawing every end, the first; drawing veils, the veil, and
    // past any other wall to the next.
    float near = exit + 2.0 * footprint;
    bool reachesSurface = surface <= near;
    bool isVeil = veil >= 0 && (uVeils && !uBounds || best <= near);
    float at = isVeil ? best : reachesSurface ? surface : exit;
    if (isVeil || uBounds) {
      // Any other end, such as the edge of a shadow the lamp's own rays make, is found exactly too.
      wall = isVeil || reachesSurface ? at : exactEnd(cell, ro, rd, exit, s, 2.0 * footprint, 0.5 * uPixelAngle * exit);
      facing = cell;
      partner = isVeil ? veil : -1;
      onSurface = !isVeil && reachesSurface;
      break;
    }
    if (reachesSurface) {
      // Out of Spot.
      s = surface;
      inside = false;
      continue;
    }
    // On past a wall that isn't drawn, into whichever light is there.
    s = at + footprint;
    cell = strongestPresent(ro + s * rd);
  }
  // A veil's normal is its fields', Spot's surface's its own; other walls' come from their points at the
  // pixels next to this one, which is why nothing returns early.
  vec3 x = ro + (facing >= 0 ? wall : 0.0) * rd;
  vec3 across = cross(dFdx(x), dFdy(x));
  if (facing < 0) return;
  vec3 normal = across;
  if (partner >= 0) {
    normal = fieldDistanceGradient(facing, x) - fieldDistanceGradient(partner, x);
  } else if (onSurface && triangle >= 0) {
    normal = (1.0 - uv.x - uv.y) * dataAt(uBvhNormals, 3 * triangle).xyz + uv.x * dataAt(uBvhNormals, 3 * triangle + 1).xyz + uv.y * dataAt(uBvhNormals, 3 * triangle + 2).xyz;
  }
  float n2 = dot(normal, normal);
  float square = n2 > 0.0 ? abs(dot(normal, rd)) * inversesqrt(n2) : 1.0;
  outColor = vec4(lampColor[facing].rgb * (0.2 + 0.8 * square), 1.0);
  outDistance = wall;
}
