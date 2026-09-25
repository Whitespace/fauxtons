// Exact tests of whether a lamp's light reaches a point, for shading surfaces. A map of the solver knows
// a lamp's light only along the rays through its texel centres, so edges read from it are good to about
// a texel. Here the ray through the point itself is followed:
// - Spot is tested against its triangles, through a bounding volume hierarchy.
// - Wherever another lamp's field is the stronger along the ray, that lamp's light is looked for in its
//   map: in large steps where the map is clear, and point by point where the map's rays disagree. At
//   those points, whether Spot is in the way of that lamp's light is tested against the triangles too.
// So Spot's shadows are exact, both a lamp's own and those of other lamps' light that its light runs
// into. Where another lamp's light ends in the air is still read from its map.
//
// The test is run once per solution for every ray of the maps that ends on a surface (lit.frag), and
// per pixel only near the edges of the light, where those rays disagree (litFromMaps()).

uniform sampler2D uReach;        // per ray of the maps, where its light ended and why (sweep.frag)
uniform sampler2D uOccluder;     // per ray of the maps, the distance to Spot
uniform sampler2D uReachBounds;  // bounds of the reach over blocks of the maps (reach-bounds.frag)
uniform sampler2D uBvhNodes;     // Spot's bounding volume hierarchy (bvh.js)
uniform sampler2D uBvhTriangles;
uniform sampler2D uLit;          // per ray of the maps, whether its light reaches its surface (lit.frag)
uniform bool uSpot;              // whether Spot is in the scene

#define SURFACE_GAP sceneParams.w
#define LEAD_SAMPLES 24

vec4 dataAt(sampler2D data, int index) {
  int width = textureSize(data, 0).x;
  return texelFetch(data, ivec2(index % width, index / width), 0);
}

// Möller–Trumbore, for a hit strictly between the ray's origin and tMax.
bool hitsTriangle(int index, vec3 o, vec3 d, float tMax) {
  vec3 a = dataAt(uBvhTriangles, 3 * index).xyz;
  vec3 e1 = dataAt(uBvhTriangles, 3 * index + 1).xyz;
  vec3 e2 = dataAt(uBvhTriangles, 3 * index + 2).xyz;
  vec3 p = cross(d, e2);
  float det = dot(e1, p);
  if (det == 0.0) return false;
  vec3 s = (o - a) / det;
  float u = dot(s, p);
  if (u < 0.0 || u > 1.0) return false;
  vec3 q = cross(s, e1);
  float v = dot(d, q);
  if (v < 0.0 || u + v > 1.0) return false;
  float t = dot(e2, q);
  return t > 0.0 && t < tMax;
}

// Whether Spot is on the ray from o along the unit direction d before distance tMax. The walk goes into
// a node's subtree where the ray meets its box and jumps past the subtree where it doesn't.
bool spotBlocks(vec3 o, vec3 d, float tMax) {
  if (!uSpot) return false;
  vec3 inv = 1.0 / d;
  int end = int(dataAt(uBvhNodes, 0).w);
  for (int node = 0, step = 0; node < end && step < 16384; ++step) {
    vec4 lo = dataAt(uBvhNodes, 2 * node);
    vec4 hi = dataAt(uBvhNodes, 2 * node + 1);
    vec3 t0 = (lo.xyz - o) * inv;
    vec3 t1 = (hi.xyz - o) * inv;
    vec3 enter = min(t0, t1);
    vec3 exit = max(t0, t1);
    if (max(max(enter.x, enter.y), max(enter.z, 0.0)) > min(min(exit.x, exit.y), min(exit.z, tMax))) {
      node = int(lo.w);
    } else if (hi.w < 0.0) {
      node++;
    } else {
      int leaf = int(hi.w);
      for (int k = 0; k < (leaf & 7); ++k) {
        if (hitsTriangle((leaf >> 3) + k, o, d, tMax)) return true;
      }
      node = int(lo.w);
    }
  }
  return false;
}

// Whether lamp k's light gets as far as y, as far as meeting other light is concerned, judged from the
// four rays of its map around y as the sweep judges it (present() in sweep.frag). `spot` says whether
// Spot is on any of those rays before y, and then whether it is in the way of y has to be tested
// exactly. Rays whose light got as far as Spot can't tell where it would have ended beyond, so they are
// left out; the sweep stops light just short of a surface where a stronger light is there first.
bool mapLight(int k, vec3 y, out bool spot) {
  vec3 d = y - lampOrigin[k].xyz;
  float dist = length(d);
  float size = sceneParams.z;
  vec2 st = mapUV(k, d) * size - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = st - vec2(base);
  ivec2 origin = atlasOrigin(k);
  ivec2 last = ivec2(MAP_SIZE - 1);
  float sum = 0.0;
  float weights = 0.0;
  float lo = INF;
  float hi = 0.0;
  spot = false;
  for (int c = 0; c < 4; ++c) {
    ivec2 corner = ivec2(c & 1, c >> 1);
    ivec2 texel = origin + clamp(base + corner, ivec2(0), last);
    float reach = texelFetch(uReach, texel, 0).r;
    float occluder = texelFetch(uOccluder, texel, 0).r;
    if (occluder < dist) {
      spot = true;
      if (reach > 0.99 * occluder) continue;
    }
    vec2 w = mix(1.0 - f, f, vec2(corner));
    float weight = max(w.x * w.y, 1e-6);
    sum += weight * reach;
    weights += weight;
    lo = min(lo, reach);
    hi = max(hi, reach);
  }
  if (weights == 0.0) return true;
  return dist < sum / weights + min(hi - lo, REACH_TOLERANCE * dist);
}

// Whether lamp k's light is present at y.
bool presentAt(int k, vec3 y) {
  if (y.y < 0.0 || fieldDistance(k, y) >= INF) return false;
  bool spot;
  if (!mapLight(k, y, spot)) return false;
  if (!spot) return true;
  vec3 d = y - lampOrigin[k].xyz;
  float dist = length(d);
  return !spotBlocks(lampOrigin[k].xyz, d / dist, dist);
}

// Bounds of lamp k's reach over the rays at the corners of a block of 2^level × 2^level cells of its map,
// a cell being the square between four neighbouring rays.
vec2 reachBounds(int k, ivec2 block, int level) {
  if (level > 0) return texelFetch(uReachBounds, ivec2(k & 1, k >> 1) * (MAP_SIZE >> level) + block, level - 1).rg;
  ivec2 origin = atlasOrigin(k);
  ivec2 last = ivec2(MAP_SIZE - 1);
  vec2 bounds = vec2(INF, 0.0);
  for (int c = 0; c < 4; ++c) {
    float reach = texelFetch(uReach, origin + min(block + ivec2(c & 1, c >> 1), last), 0).r;
    bounds = vec2(min(bounds.x, reach), max(bounds.y, reach));
  }
  return bounds;
}

// Whether lamp k's light is present anywhere on the ray o + t w with ta < t < tb. The ray is followed
// through k's map a block of cells at a time: where every ray at the block's corners ends before the
// stretch of this ray inside the block, k's light isn't there, and where every one reaches past it, it
// is. Other blocks are split, down to single cells, which are decided at both ends of the stretch
// inside them. Light of k is missed only where it slips between the rays of the map altogether.
bool presentAlong(int k, vec3 o, vec3 w, float ta, float tb) {
  vec3 lamp = lampOrigin[k].xyz;
  float size = sceneParams.z;
  vec3 D = o - lamp;
  // Map coordinates along the ray, in texels from the first ray, are st = scale s / z + shift with s and
  // z linear in t, so they move along a straight line in the map, one way on each axis.
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
  float decided = ta;
  for (int step = 0; step < 1024 && t < tb; ++step) {
    float cells = exp2(float(level));
    vec2 st = scale * (s0 + t * s1) / (z0 + t * z1) + shift;
    vec2 block = clamp(floor((st + 0.01 * motion) / cells), vec2(0.0), vec2(size / cells - 1.0));
    // Where the ray leaves the block.
    vec2 edge = ((block + max(motion, 0.0)) * cells - shift) / scale;
    vec2 exits = (edge * z0 - s0) / (s1 - edge * z1);
    float exit = tb;
    if (motion.x != 0.0 && exits.x > t) exit = min(exit, exits.x);
    if (motion.y != 0.0 && exits.y > t) exit = min(exit, exits.y);
    // Distances from k's lamp along this stretch of the ray.
    float first = distance(o + t * w, lamp);
    float last = distance(o + exit * w, lamp);
    float nearest = closest > t && closest < exit ? distance(o + closest * w, lamp) : min(first, last);
    vec2 bounds = reachBounds(k, ivec2(block), level);
    if (nearest * (1.0 - REACH_TOLERANCE) > bounds.y) {
      t = exit;
      level = min(level + 1, top);
    } else if (max(first, last) < bounds.x) {
      return true;
    } else if (level > 0) {
      level--;
    } else {
      // The start of the stretch is decided already when a cell follows one decided at its end.
      if (t > decided && presentAt(k, o + t * w)) return true;
      if (presentAt(k, o + exit * w)) return true;
      t = exit;
      decided = exit;
      level = 1;
    }
  }
  return false;
}

// How much stronger lamp k's field is than lamp j's at distance t along j's ray, as the difference of
// their field-distances d_j - d_k: positive where k's is the stronger. Along the ray d_j = t / speed.
float lead(int k, vec3 o, vec3 w, float speed, float t) {
  return t / speed - fieldDistance(k, o + t * w);
}

float leadSlope(int k, vec3 o, vec3 w, float speed, float t) {
  return 1.0 / speed - dot(fieldDistanceGradient(k, o + t * w), w);
}

// Bisection for where the lead changes sign between `inside`, where it is positive, and `outside`;
// returns the last point found inside.
float leadEdge(int k, vec3 o, vec3 w, float speed, float inside, float outside) {
  for (int n = 0; n < 20; ++n) {
    float m = 0.5 * (inside + outside);
    if (lead(k, o, w, speed, m) > 0.0) inside = m; else outside = m;
  }
  return inside;
}

// Bisection for where the slope of the lead changes sign between a and b.
float leadTurn(int k, vec3 o, vec3 w, float speed, float a, float b) {
  bool rising = leadSlope(k, o, w, speed, a) > 0.0;
  for (int n = 0; n < 16; ++n) {
    float m = 0.5 * (a + b);
    if ((leadSlope(k, o, w, speed, m) > 0.0) == rising) a = m; else b = m;
  }
  return 0.5 * (a + b);
}

// Whether the light of lamp j, travelling from its lamp along the unit direction w, runs into the light
// of a lamp with a stronger field before distance tEnd. The stretches of the ray where another lamp's
// field is the stronger are found by sampling the lead along the ray and refining by bisection,
// including brief ones where the ray just grazes the other lamp's side of their isolux veil.
bool extinguishedAlong(int j, vec3 w, float tEnd) {
  vec3 o = lampOrigin[j].xyz;
  float speed = lampOrigin[j].w * profile(j, w);
  for (int k = 0; k < LAMP_COUNT; ++k) {
    if (k == j) continue;
    vec2 span = coneSpan(k, o, w, tEnd);
    if (span.x >= span.y) continue;
    float h = (span.y - span.x) / float(LEAD_SAMPLES);
    float a = span.x;
    float slopeA = leadSlope(k, o, w, speed, a);
    float start = lead(k, o, w, speed, a) > 0.0 ? a : -1.0;  // start of the open stretch, if any
    for (int n = 1; n <= LEAD_SAMPLES; ++n) {
      float b = span.x + float(n) * h;
      float leadB = lead(k, o, w, speed, b);
      float slopeB = leadSlope(k, o, w, speed, b);
      if (start < 0.0) {
        if (leadB > 0.0) {
          start = leadEdge(k, o, w, speed, b, a);
        } else if (slopeA > 0.0 && slopeB < 0.0) {
          float peak = leadTurn(k, o, w, speed, a, b);
          if (lead(k, o, w, speed, peak) > 0.0 &&
              presentAlong(k, o, w, leadEdge(k, o, w, speed, peak, a), leadEdge(k, o, w, speed, peak, b))) {
            return true;
          }
        }
      } else if (leadB <= 0.0) {
        if (presentAlong(k, o, w, start, leadEdge(k, o, w, speed, a, b))) return true;
        start = -1.0;
      } else if (slopeA < 0.0 && slopeB > 0.0) {
        float dip = leadTurn(k, o, w, speed, a, b);
        if (lead(k, o, w, speed, dip) <= 0.0) {
          if (presentAlong(k, o, w, start, leadEdge(k, o, w, speed, a, dip))) return true;
          start = leadEdge(k, o, w, speed, b, dip);
        }
      }
      a = b;
      slopeA = slopeB;
    }
    if (start >= 0.0 && presentAlong(k, o, w, start, span.y)) return true;
  }
  return false;
}

// Whether lamp j's light reaches the surface point x, which must be in its cone and range. Spot is
// looked for only up to `skip` short of x (see litBy()).
bool reachesExact(int j, vec3 x, float skip) {
  vec3 o = lampOrigin[j].xyz;
  vec3 d = x - o;
  float dist = length(d);
  vec3 w = d / dist;
  float end = (1.0 - SURFACE_GAP) * dist;
  return !spotBlocks(o, w, min(end, dist - skip)) && !extinguishedAlong(j, w, end);
}

// Whether lamp j's light reaches the point x of a flat facet with normal `facet`, as far as the four
// rays of its map around x tell (lit.frag): 1 or 0 where they all end on the facet's plane and agree,
// 0 where all of them end on a surface before it, and -1 otherwise: near an edge of the light, or where
// the facet faces away from the lamp and only the smooth surface over it is lit.
int litFromMaps(int j, vec3 x, vec3 facet) {
  vec3 o = lampOrigin[j].xyz;
  vec3 d = x - o;
  float height = dot(facet, d);
  if (height >= 0.0) return -1;
  float size = sceneParams.z;
  ivec2 base = ivec2(floor(mapUV(j, d) * size - 0.5));
  ivec2 origin = atlasOrigin(j);
  int stopped = 0;
  int onPlane = 0;
  int lit = 0;
  for (int c = 0; c < 4; ++c) {
    ivec2 texel = clamp(base + ivec2(c & 1, c >> 1), ivec2(0), ivec2(MAP_SIZE - 1));
    vec3 dir = mapDirection(j, (vec2(texel) + 0.5) / size);
    float surface = min(texelFetch(uOccluder, origin + texel, 0).r, dir.y < 0.0 ? -o.y / dir.y : INF);
    float plane = height / dot(facet, dir);
    if (surface < (1.0 - 1e-3) * plane) {
      stopped++;
    } else if (surface < (1.0 + 1e-3) * plane) {
      onPlane++;
      lit += int(texelFetch(uLit, origin + texel, 0).r > 0.5);
    }
  }
  if (stopped == 4) return 0;
  if (onPlane < 4) return -1;
  return lit == 4 ? 1 : lit == 0 ? 0 : -1;
}

// The lamp whose light reaches a surface point, or -1 if none does. The point is x on a flat facet with
// normal `facet`, shaded as the smooth surface with normal `normal`, and its light is tested at the
// point `lifted` of that smooth surface over x (see surface.frag). Where the light of more than one lamp
// gets there, the weaker was extinguished just before it, so the lamps are tried strongest first.
//
// The facets follow the smooth surface only to within about `rough`, so where a lamp's light grazes it,
// the facets next to x would still cut into its light. Spot is not looked for on the last stretch of the
// lamp's ray that is less than `rough` above the smooth surface's tangent plane at x, up to 30 `rough`.
int litBy(vec3 x, vec3 facet, vec3 lifted, vec3 normal, float rough) {
  float strength[LAMP_COUNT];
  float skip[LAMP_COUNT];
  for (int i = 0; i < LAMP_COUNT; ++i) {
    vec3 d = x - lampOrigin[i].xyz;
    float cosine = -dot(normal, d) / length(d);
    strength[i] = cosine > 0.0 ? field(i, x) : 0.0;
    skip[i] = min(rough / max(cosine, 1e-3), 30.0 * rough);
  }
  for (int n = 0; n < LAMP_COUNT; ++n) {
    int best = -1;
    for (int i = 0; i < LAMP_COUNT; ++i) {
      if (strength[i] > 0.0 && (best < 0 || strength[i] > strength[best])) best = i;
    }
    if (best < 0) break;
    int known = litFromMaps(best, x, facet);
    if (known == 1 || (known < 0 && reachesExact(best, lifted, skip[best]))) return best;
    strength[best] = 0.0;
  }
  return -1;
}
