import { bindTextures, createDepthBuffer, createFramebuffer, createTexture } from './gl.js';
import { MAP_SIZE, P_MIN, RANGE, lampViewProjection } from './scene.js';

const ALIVE = 1e30;

// Field-distance grows geometrically from pass to pass, so every ray advances by the same
// fraction of its distance from the lamp each pass, whatever its speed.
const STEP_RATIO = 1.03;
const START_DISTANCE = 0.004;

// Passes refining the sweep's solution ray by ray (see refine.frag). The first corrects rays whose light
// ran into light the sweep stepped over; the second, rays whose light ran into light the first corrected.
const REFINE_PASSES = 2;

// Map texels between neighbouring vertices of the veil meshes (see cells.frag) and of the lit volumes'
// boundary meshes (see boundary.vert).
export const VEIL_STRIDE = 8;
export const BOUNDARY_STRIDE = 1;

// Solves where each lamp's light ends along every direction of its map by sweeping all rays outward in
// increasing field-distance, then following each ray exactly against the others' light (exact.glsl).
// The result is an atlas of distances, one map per lamp. `bvh` holds Spot's triangles (bvh.js).
export class ExtinctionSolver {
  constructor(gl, { programs, fullscreen, spot, bvh, lamps }) {
    this.gl = gl;
    this.programs = programs;
    this.fullscreen = fullscreen;
    this.spot = spot;
    this.bvh = bvh;
    this.lamps = lamps;
    this.size = 2 * MAP_SIZE;

    // Distance to the nearest occluder along every ray: one for the sweep, one kept with the published
    // solution (see exact.glsl).
    const occluderDepth = createDepthBuffer(gl, this.size, this.size);
    this.occluders = [0, 1].map(() => createTexture(gl, this.size, this.size, gl.R32F));
    this.occluderFbos = this.occluders.map((texture) => createFramebuffer(gl, [texture], occluderDepth));
    this.solving = 0;
    this.publishedOccluder = 1;

    // Per ray: the distance at which its light ended, and the lamp whose veil it ended on (-2 if it
    // ended on a surface, else -1).
    // One texture holds the published solution while the other two ping-pong through a sweep.
    this.textures = [0, 1, 2].map(() => createTexture(gl, this.size, this.size, gl.RG32F));
    this.fbos = this.textures.map((texture) => createFramebuffer(gl, [texture]));
    this.published = 0;
    this.work = [1, 2];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.published]);
    gl.clearBufferfv(gl.COLOR, 0, [0, -1, 0, 0]);

    // Compact copies of the published solution (see copy.frag).
    this.reachHalf = createTexture(gl, this.size, this.size, gl.R16F, gl.LINEAR);
    this.tags = createTexture(gl, this.size, this.size, gl.R8UI);
    this.copyFbo = createFramebuffer(gl, [this.reachHalf, this.tags]);

    // Which cells of each lamp's veil meshes have geometry (see cells.frag).
    const cells = this.size / VEIL_STRIDE;
    this.cells = createTexture(gl, cells, cells, gl.RGBA32F);
    this.cellsFbo = createFramebuffer(gl, [this.cells]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cellsFbo);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);

    // For the boundaries of the lit volumes (see boundary.vert): the slopes of the blurred end distances
    // (for normals), the smoothed end distances, where each grid point of the meshes moves in the map,
    // and how each cell is split.
    this.slopes = createTexture(gl, this.size, this.size, gl.RG16F, gl.LINEAR);
    this.slopesFbo = createFramebuffer(gl, [this.slopes]);
    this.ends = createTexture(gl, this.size, this.size, gl.R32F);
    this.endsFbo = createFramebuffer(gl, [this.ends]);
    const grid = this.size / BOUNDARY_STRIDE;
    this.offsets = createTexture(gl, grid, grid, gl.RG16F);
    this.offsetsFbo = createFramebuffer(gl, [this.offsets]);
    this.diagonals = createTexture(gl, grid, grid, gl.R8);
    this.diagonalsFbo = createFramebuffer(gl, [this.diagonals]);

    // Bounds of the reach over blocks of each map, level L of the blocks at mip L - 1 (see
    // reach-bounds.frag).
    this.boundsLevels = Math.log2(MAP_SIZE);
    this.bounds = createTexture(gl, MAP_SIZE, MAP_SIZE, gl.RG32F, gl.NEAREST, this.boundsLevels);
    this.boundsFbos = Array.from({ length: this.boundsLevels }, (_, m) => createFramebuffer(gl, [this.bounds], null, m));

    const fastest = Math.max(...lamps.map((lamp) => lamp.sqrtPower));
    const slowest = Math.min(...lamps.map((lamp) => lamp.sqrtPower)) * P_MIN;
    this.firstTime = START_DISTANCE / fastest;
    this.passCount = Math.ceil(Math.log(RANGE / slowest / this.firstTime) / Math.log(STEP_RATIO)) + 1;
    this.pass = this.passCount;

    this.withSpot = false;  // occluders of the published solution
    this.pendingSpot = false;
  }

  get texture() {
    return this.textures[this.published];
  }

  get occluder() {
    return this.occluders[this.publishedOccluder];
  }

  get busy() {
    return this.pass < this.passCount;
  }

  start(withSpot) {
    const { gl, programs, spot, size } = this;
    this.pendingSpot = withSpot;

    this.solving = 1 - this.publishedOccluder;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.occluderFbos[this.solving]);
    gl.viewport(0, 0, size, size);
    gl.clearBufferfv(gl.COLOR, 0, [ALIVE, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    if (withSpot) {
      const { program, uniforms } = programs.occluder;
      gl.useProgram(program);
      gl.enable(gl.DEPTH_TEST);
      gl.uniformMatrix4fv(uniforms.uModel, false, spot.model);
      gl.bindVertexArray(spot.vao);
      this.lamps.forEach((lamp, i) => {
        gl.viewport((i & 1) * MAP_SIZE, (i >> 1) * MAP_SIZE, MAP_SIZE, MAP_SIZE);
        gl.uniformMatrix4fv(uniforms.uViewProj, false, lampViewProjection(lamp));
        gl.uniform3fv(uniforms.uOrigin, lamp.position);
        gl.drawElements(gl.TRIANGLES, spot.count, spot.type, 0);
      });
      gl.disable(gl.DEPTH_TEST);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.work[0]]);
    gl.clearBufferfv(gl.COLOR, 0, [ALIVE, -1, 0, 0]);
    this.pass = 0;
  }

  // Runs up to `budget` sweep passes. Returns true when a new solution has been published.
  step(budget) {
    if (!this.busy) return false;
    const { gl, size } = this;
    const { program, uniforms } = this.programs.sweep;
    gl.useProgram(program);
    gl.viewport(0, 0, size, size);
    gl.bindVertexArray(this.fullscreen);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.occluders[this.solving]);
    gl.uniform1i(uniforms.uOccluder, 1);
    gl.uniform1i(uniforms.uState, 0);
    gl.activeTexture(gl.TEXTURE0);

    for (let n = 0; n < budget && this.busy; n++, this.pass++) {
      const k = this.pass;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.work[(k + 1) % 2]]);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[this.work[k % 2]]);
      gl.uniform1f(uniforms.uTimePrev, k === 0 ? 0 : this.firstTime * STEP_RATIO ** (k - 1));
      gl.uniform1f(uniforms.uTime, this.firstTime * STEP_RATIO ** k);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (this.busy) return false;

    const slot = this.passCount % 2;
    [this.published, this.work[slot]] = [this.work[slot], this.published];
    this.publishedOccluder = this.solving;
    this.withSpot = this.pendingSpot;

    this.prepareBounds();
    for (let n = 0; n < REFINE_PASSES; n++) this.refine();

    const copy = this.programs.copy;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.copyFbo);
    gl.viewport(0, 0, size, size);
    gl.useProgram(copy.program);
    bindTextures(gl, copy, { uState: this.texture });
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const cells = this.programs.cells;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cellsFbo);
    gl.viewport(0, 0, size / VEIL_STRIDE, size / VEIL_STRIDE);
    gl.useProgram(cells.program);
    bindTextures(gl, cells, { uState: this.texture });
    gl.uniform1i(cells.uniforms.uStride, VEIL_STRIDE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.prepareBoundaries();
    return true;
  }

  // What the exact tests of exact.glsl read, on the first five texture units, for a program using them.
  bindExact(program) {
    bindTextures(this.gl, program, {
      uReach: this.texture,
      uOccluder: this.occluder,
      uReachBounds: this.bounds,
      uBvhNodes: this.bvh.nodes,
      uBvhTriangles: this.bvh.triangles,
    });
    this.gl.uniform1i(program.uniforms.uSpot, this.withSpot ? 1 : 0);
  }

  // One pass refining the published solution ray by ray (see refine.frag), into a work texture that is
  // then published, with the bounds of its reach.
  refine() {
    const { gl, size } = this;
    const refine = this.programs.refine;
    const target = this.work[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[target]);
    gl.viewport(0, 0, size, size);
    gl.useProgram(refine.program);
    this.bindExact(refine);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    [this.published, this.work[0]] = [target, this.published];
    this.prepareBounds();
  }

  // The bounds of the reach over blocks of each map, level by level. While a level is drawn, the
  // texture exposes only the level below to sampling, so that it doesn't read the level it writes.
  prepareBounds() {
    const { gl, bounds } = this;
    const { program, uniforms } = this.programs.reachBounds;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uniforms.uSource, 0);
    for (let level = 1; level <= this.boundsLevels; level++) {
      const size = MAP_SIZE >> (level - 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundsFbos[level - 1]);
      gl.viewport(0, 0, size, size);
      if (level === 1) {
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, bounds);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, level - 2);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 2);
      }
      gl.uniform1i(uniforms.uLevel, level);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindTexture(gl.TEXTURE_2D, bounds);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this.boundsLevels - 1);
  }

  // What the boundary meshes of the lit volumes need from a new solution (see boundary.vert). The
  // separable blurs go through the two work textures, which are free until the next sweep starts.
  prepareBoundaries() {
    const { gl, size, programs } = this;
    const [a, b] = this.work;
    const pass = (name, fbo, textures) => {
      const program = programs[name];
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(program.program);
      bindTextures(gl, program, textures);
      return program.uniforms;
    };
    const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.viewport(0, 0, size, size);

    let uniforms = pass('ends', this.fbos[b], { uState: this.texture, uValues: this.texture });
    gl.uniform1i(uniforms.uFirstPass, 1);
    gl.uniform2i(uniforms.uAxis, 1, 0);
    draw();
    uniforms = pass('ends', this.endsFbo, { uState: this.texture, uValues: this.textures[b] });
    gl.uniform1i(uniforms.uFirstPass, 0);
    gl.uniform2i(uniforms.uAxis, 0, 1);
    draw();

    pass('slopesRows', this.fbos[a], { uEnds: this.ends });
    draw();
    pass('slopesColumns', this.slopesFbo, { uRows: this.textures[a] });
    draw();

    const grid = size / BOUNDARY_STRIDE;
    gl.viewport(0, 0, grid, grid);
    uniforms = pass('snap', this.offsetsFbo, { uState: this.texture });
    gl.uniform1i(uniforms.uStride, BOUNDARY_STRIDE);
    draw();
    uniforms = pass('diagonals', this.diagonalsFbo, { uEnds: this.ends, uOffsets: this.offsets });
    gl.uniform1i(uniforms.uStride, BOUNDARY_STRIDE);
    draw();
  }

  // Where the published solution's ray at atlas texel (x, y) ended, for checking.
  reachAt(x, y) {
    const { gl } = this;
    const pixel = new Float32Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.published]);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, pixel);
    return pixel[0];
  }
}
