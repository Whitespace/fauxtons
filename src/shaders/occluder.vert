layout(location = 0) in vec3 aPosition;

uniform mat4 uModel;
uniform mat4 uViewProj;

out vec3 vWorld;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  gl_Position = uViewProj * world;
}
