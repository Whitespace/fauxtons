// Surfaces, veils and the half-resolution fog brought together at full resolution, then blended
// into the running average of previous frames.

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDistance;
uniform sampler2D uFog;
uniform sampler2D uHistory;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec2 uResolution;
uniform float uBlend;
uniform float uLampRadius;
uniform float uLampEmission;

out vec4 outColor;

#define FAR 1000.0

vec3 background(vec3 rd) {
  return mix(vec3(0.0030, 0.0032, 0.0040), vec3(0.0060, 0.0064, 0.0080), smoothstep(-0.1, 0.7, rd.y));
}

float sphereHit(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float h = b * b - dot(oc, oc) + radius * radius;
  if (h < 0.0) return INF;
  float t = -b - sqrt(h);
  return t > 0.0 ? t : INF;
}

// Bilinear upsampling of the fog, with each of the four samples weighted down the further its
// integration distance is from this pixel's, so fog doesn't bleed across silhouettes.
vec3 upsampledFog(float depth) {
  vec2 st = gl_FragCoord.xy / 2.0 - 0.5;
  ivec2 base = ivec2(floor(st));
  vec2 f = st - vec2(base);
  ivec2 last = textureSize(uFog, 0) - 1;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int k = 0; k < 4; ++k) {
    ivec2 offset = ivec2(k & 1, k >> 1);
    vec4 s = texelFetch(uFog, clamp(base + offset, ivec2(0), last), 0);
    vec2 w2 = mix(1.0 - f, f, vec2(offset));
    float w = w2.x * w2.y / (1e-3 + abs(s.a - depth) / depth);
    sum += w * s.rgb;
    total += w;
  }
  return sum / max(total, 1e-12);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 far = uInvViewProj * vec4(2.0 * gl_FragCoord.xy / uResolution - 1.0, 1.0, 1.0);
  vec3 ro = uCameraPos;
  vec3 rd = normalize(far.xyz / far.w - ro);

  // The scene colour holds the surfaces and any veils in front of them or of the empty background.
  float depth = min(texelFetch(uSceneDistance, px, 0).r, FAR);
  vec3 color = texelFetch(uSceneColor, px, 0).rgb + (depth < FAR ? vec3(0.0) : background(rd));
  for (int i = 0; i < LAMP_COUNT; ++i) {
    if (sphereHit(ro, rd, lampOrigin[i].xyz, uLampRadius) < depth) color = uLampEmission * lampColor[i].rgb;
  }
  color += upsampledFog(depth);

  outColor = vec4(mix(texelFetch(uHistory, px, 0).rgb, color, uBlend), 1.0);
}
