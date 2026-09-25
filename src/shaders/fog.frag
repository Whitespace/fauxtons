// Light in the air, at half resolution: each pixel covers a 2×2 block of the full image.
//
// Blocks alternate between integrating up to the nearest and the farthest surface in them, so that
// at silhouettes the upsampling in composite.frag finds a neighbour integrated to the right depth.

uniform sampler2D uReach;          // half-float copy of the reach distances
uniform sampler2D uSceneDistance;  // full resolution
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec2 uResolution;          // full resolution
uniform int uFrame;
uniform float uFogDensity;

out vec4 outFog;                   // rgb light, a the distance it was integrated to

#define FOG_SAMPLES 12
#define FAR 1000.0

// Interleaved gradient noise, animated over frames; k decorrelates independent uses.
float noise(float k) {
  vec2 p = gl_FragCoord.xy + 5.588238 * float(uFrame & 63);
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))) + 0.61803399 * k);
}

float fogReach(int i, vec3 d) {
  float n = sceneParams.z;
  vec2 uv = clamp(mapUV(i, d), 0.5 / n, 1.0 - 0.5 / n);
  return texture(uReach, (vec2(atlasOrigin(i)) + uv * n) / (float(ATLAS_SIDE) * n)).r;
}

// Light lamp i puts into the air along the view ray, in its colour and with its field strength,
// wherever that light is present. The 1/r² falloff is importance sampled (equiangular sampling
// about the lamp), leaving p² and the presence test in the estimator.
vec3 inscatter(int i, vec3 ro, vec3 rd, vec2 span) {
  vec3 o = lampOrigin[i].xyz;
  vec3 axis = lampAxis[i].xyz;
  float c = lampAxis[i].w;
  float spread = 1.0 / (1.0 - c);
  float tc = dot(o - ro, rd);
  float b = max(length(ro + tc * rd - o), 1e-4);
  float th0 = atan((span.x - tc) / b);
  float th1 = atan((span.y - tc) / b);
  float step = (th1 - th0) / float(FOG_SAMPLES);
  // Successive tangents by the addition formula, tan(a + s) = (tan a + tan s) / (1 - tan a tan s),
  // which is much cheaper than calling tan() per sample.
  float slope = tan(th0 + noise(float(i)) * step);
  float turn = tan(step);
  float sum = 0.0;
  for (int k = 0; k < FOG_SAMPLES; ++k) {
    vec3 d = ro + (tc + b * slope) * rd - o;
    slope = (slope + turn) / (1.0 - slope * turn);
    float r2 = dot(d, d);
    float invR = inversesqrt(r2);
    float ct = dot(axis, d) * invR;
    float p = (ct * ct - c) * spread;
    if (ct > 0.0 && p >= P_MIN && r2 * invR <= fogReach(i, d)) sum += p * p;
  }
  return lampColor[i].rgb * lampColor[i].w * sum * (th1 - th0) / (b * float(FOG_SAMPLES));
}

void main() {
  ivec2 block = ivec2(gl_FragCoord.xy);
  ivec2 last = ivec2(uResolution) - 1;
  ivec2 full = 2 * block;
  vec4 depths = vec4(
    texelFetch(uSceneDistance, min(full, last), 0).r,
    texelFetch(uSceneDistance, min(full + ivec2(1, 0), last), 0).r,
    texelFetch(uSceneDistance, min(full + ivec2(0, 1), last), 0).r,
    texelFetch(uSceneDistance, min(full + ivec2(1, 1), last), 0).r);
  float nearest = min(min(depths.x, depths.y), min(depths.z, depths.w));
  float farthest = max(max(depths.x, depths.y), max(depths.z, depths.w));
  float depth = min(((block.x + block.y) & 1) == 0 ? nearest : farthest, FAR);

  vec2 ndc = (vec2(full) + 1.0) / uResolution * 2.0 - 1.0;
  vec4 far = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = uCameraPos;
  vec3 rd = normalize(far.xyz / far.w - ro);

  vec3 fog = vec3(0.0);
  for (int i = 0; i < LAMP_COUNT; ++i) {
    vec2 span = coneSpan(i, ro, rd, depth);
    if (span.x < span.y) fog += inscatter(i, ro, rd, span);
  }
  outFog = vec4(uFogDensity * fog, depth);
}
