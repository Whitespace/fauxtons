// The lamp whose light is present at the camera, -1 if none, for walls.frag.

uniform vec3 uCameraPos;

out float outLight;

void main() {
  outLight = float(lightAt(uCameraPos));
}
