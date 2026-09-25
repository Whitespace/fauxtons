import { createDepthBuffer, createFramebuffer, createTexture } from './gl.js';
import { MAP_SIZE, P_MIN, RANGE, lampViewProjection } from './scene.js';

const ALIVE = 1e30;

// Field-distance grows geometrically from pass to pass, so every ray advances by the same
// fraction of its distance from the lamp each pass, whatever its speed.
const STEP_RATIO = 1.03;
const START_DISTANCE = 0.004;

// Map texels between neighbouring vertices of the veil meshes (see cells.frag).
export const VEIL_STRIDE = 4;

// Solves where each lamp's light ends along every direction of its map by sweeping all rays
// outward in increasing field-distance. The result is an atlas of distances, one map per lamp.
export class ExtinctionSolver {
  constructor(gl, { programs, fullscreen, spot, lamps }) {
    this.gl = gl;
    this.programs = programs;
    this.fullscreen = fullscreen;
    this.spot = spot;
    this.lamps = lamps;
    this.size = 2 * MAP_SIZE;

    this.occluder = createTexture(gl, this.size, this.size, gl.R32F);
    this.occluderFbo = createFramebuffer(gl, [this.occluder], createDepthBuffer(gl, this.size, this.size));

    // Per ray: the distance at which its light ended, and the lamp whose veil it ended on (or -1).
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

  get busy() {
    return this.pass < this.passCount;
  }

  start(withSpot) {
    const { gl, programs, spot, size } = this;
    this.pendingSpot = withSpot;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.occluderFbo);
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
    gl.bindTexture(gl.TEXTURE_2D, this.occluder);
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
    this.withSpot = this.pendingSpot;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const copy = this.programs.copy;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.copyFbo);
    gl.useProgram(copy.program);
    gl.uniform1i(copy.uniforms.uState, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const cells = this.programs.cells;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cellsFbo);
    gl.viewport(0, 0, size / VEIL_STRIDE, size / VEIL_STRIDE);
    gl.useProgram(cells.program);
    gl.uniform1i(cells.uniforms.uState, 0);
    gl.uniform1i(cells.uniforms.uStride, VEIL_STRIDE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  // The published solution as RGBA floats (distance in red, veil partner in green), for checking.
  read() {
    const { gl, size } = this;
    const pixels = new Float32Array(size * size * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.published]);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, pixels);
    return pixels;
  }
}
