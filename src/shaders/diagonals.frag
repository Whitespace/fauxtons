// Which diagonal splits each cell of the boundary meshes (see boundary.vert): the shorter one in space,
// as a Delaunay edge flip would choose. Where a cell has one corner across a jump, the other diagonal
// would run from that corner, high up a wall, to the far side of the cell on the ground below it.

uniform sampler2D uEnds;
uniform sampler2D uOffsets;
uniform int uStride;  // map texels between grid points

out float outDiagonal;  // 1 to split the cell from (1, 0) to (0, 1), 0 from (0, 0) to (1, 1)

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int n = MAP_SIZE / uStride;
  int i = (px.x < n ? 0 : 1) + (px.y < n ? 0 : 2);
  ivec2 g = px - gridOrigin(i, uStride);
  vec3 a = boundaryPoint(uEnds, uOffsets, i, g, uStride);
  vec3 b = boundaryPoint(uEnds, uOffsets, i, g + ivec2(1, 0), uStride);
  vec3 c = boundaryPoint(uEnds, uOffsets, i, g + ivec2(1, 1), uStride);
  vec3 d = boundaryPoint(uEnds, uOffsets, i, g + ivec2(0, 1), uStride);
  outDiagonal = distance(b, d) < distance(a, c) ? 1.0 : 0.0;
}
