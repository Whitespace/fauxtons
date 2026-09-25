// Exposure, filmic tone curve and sRGB encoding of the accumulated image.

uniform sampler2D uImage;
uniform float uExposure;

out vec4 outColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 c = aces(uExposure * texelFetch(uImage, ivec2(gl_FragCoord.xy), 0).rgb);
  c = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  outColor = vec4(c + dither / 255.0, 1.0);
}
