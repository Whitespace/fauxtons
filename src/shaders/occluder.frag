// Distance from a lamp to the nearest occluder along each of its map's rays.

uniform vec3 uOrigin;

in vec3 vWorld;

out float outDistance;

void main() {
  outDistance = length(vWorld - uOrigin);
}
