// The surfaces of the lit volumes. Along each of its rays a lamp's light fills the stretch from the
// lamp to where that ray's light ended, so the lamp's volume is bounded by the end points of all its
// rays. Instance i meshes lamp i's map with those end points, on a grid of rays every uStride texels.
// Where the end distance jumps between neighbouring grid points, the cells across the jump are the
// volume's side walls: the edges of its shadows and of its cone.
//
// The end distances are smoothed except across jumps (ends.frag), grid points beside a jump have been
// moved onto a smooth curve through the map (snap.frag), and each cell is split along the diagonal
// that keeps its triangles off the jump (diagonals.frag), so every cell is drawn with its own six
// vertices.

uniform sampler2D uEnds;       // smoothed end distance of each ray
uniform sampler2D uOffsets;    // where each grid point moved in the map, in texels
uniform sampler2D uDiagonals;  // which diagonal splits each cell
uniform mat4 uViewProj;
uniform int uStride;           // map texels between grid points

flat out int vLamp;
out vec3 vWorld;

// The corners of a cell's two triangles when it is split from (0, 0) to (1, 1), then from (1, 0) to (0, 1).
const ivec2 CORNERS[12] = ivec2[12](
  ivec2(0, 0), ivec2(1, 0), ivec2(1, 1), ivec2(0, 0), ivec2(1, 1), ivec2(0, 1),
  ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 0), ivec2(1, 1), ivec2(0, 1));

void main() {
  int i = gl_InstanceID;
  int cells = MAP_SIZE / uStride - 1;
  int cell = gl_VertexID / 6;
  ivec2 grid = ivec2(cell % cells, cell / cells);
  int diagonal = int(texelFetch(uDiagonals, gridOrigin(i, uStride) + grid, 0).r + 0.5);
  vWorld = boundaryPoint(uEnds, uOffsets, i, grid + CORNERS[6 * diagonal + gl_VertexID % 6], uStride);
  vLamp = i;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
