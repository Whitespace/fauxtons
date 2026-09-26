import { bindTextures, createDepthBuffer, createFramebuffer, createTexture } from './gl.js';
import { P_MIN, RANGE } from './scene.js';

const ALIVE = 1e30;

// Field-distance grows geometrically from pass to pass, so every ray advances by the same
// fraction of its distance from the lamp each pass, whatever its speed.
const STEP_RATIO = 1.03;
const START_DISTANCE = 0.004;

// Passes refining the sweep's solution ray by ray (see refine.frag). The first corrects rays whose light
// ran into light the sweep stepped over; the second, rays whose light ran into light the first corrected.
const REFINE_PASSES = 2;

// A solve from sight ends once a pass changes no ray by more than a thousandth of its distance, or no longer
// cuts the number that change by a tenth: a few hundred rays, ending at the walls where patches meet, flip
// between two answers from pass to pass however long it runs, as they do when the sweep's solution is
// refined further. SIGHT_PASSES is the most it takes, and CHANGE_BLOCK the texels a side of the blocks of
// the maps whose changed rays are counted together (changes.frag).
const SIGHT_PASSES = 24;
const SETTLED = 0.9;
const CHANGE_BLOCK = 16;

// Map texels between neighbouring vertices of the veil meshes (see cells.frag) and of the lit volumes'
// boundary meshes (see boundary.vert).
export const VEIL_STRIDE = 8;
export const BOUNDARY_STRIDE = 1;

// Solves where each lamp's light ends along every direction of its map by sweeping all rays outward in
// increasing field-distance, then following each ray exactly against the others' light (exact.glsl).
// The result is an atlas of distances, one map per lamp, laid out as `layout` says (createLayout() in
// scene.js). `bvh` holds Spot's triangles, `count` of them (bvh.js).
//
// Solving from sight gets there another way. It starts with every ray's light reaching as far as nothing
// solid is in its way, then follows every ray exactly against the others' light as the last pass left it,
// over and over, until the rays settle (SETTLED). After the first pass each lamp's light reaches where it
// is the brightest lamp in sight all the way from the lamp; the later passes let light into the shadows of
// light that has itself been cut short. Every cut depends only on light at smaller field-distances, so the
// passes settle on the same solution as the sweep (README).
export class ExtinctionSolver {
  constructor(gl, { programs, fullscreen, bvh, layout }) {
    this.gl = gl;
    this.programs = programs;
    this.fullscreen = fullscreen;
    this.bvh = bvh;
    this.atlasSide = layout.atlasSide;
    this.mapSize = layout.mapSize;
    this.size = this.atlasSide * this.mapSize;
    const { size, mapSize } = this;
    const owned = { textures: [], fbos: [], renderbuffers: [] };
    this.owned = owned;
    const texture = (...args) => {
      const t = createTexture(gl, ...args);
      owned.textures.push(t);
      return t;
    };
    const framebuffer = (...args) => {
      const f = createFramebuffer(gl, ...args);
      owned.fbos.push(f);
      return f;
    };

    // Distance to the nearest occluder along every ray: one for the sweep, one kept with the published
    // solution (see exact.glsl).
    const occluderDepth = createDepthBuffer(gl, size, size);
    owned.renderbuffers.push(occluderDepth);
    this.occluders = [0, 1].map(() => texture(size, size, gl.R32F));
    this.occluderFbos = this.occluders.map((t) => framebuffer([t], occluderDepth));
    this.solving = 0;
    this.publishedOccluder = 1;

    // Per ray: the distance at which its light ended, and the lamp whose veil it ended on (-2 if it
    // ended on a surface, else -1).
    // One texture holds the published solution while the other two ping-pong through a sweep.
    this.textures = [0, 1, 2].map(() => texture(size, size, gl.RG32F));
    this.fbos = this.textures.map((t) => framebuffer([t]));
    this.published = 0;
    this.work = [1, 2];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.published]);
    gl.clearBufferfv(gl.COLOR, 0, [0, -1, 0, 0]);

    // Compact copies of the published solution (see copy.frag).
    this.reachHalf = texture(size, size, gl.R16F, gl.LINEAR);
    this.tags = texture(size, size, gl.R8UI);
    this.copyFbo = framebuffer([this.reachHalf, this.tags]);

    // Which cells of each lamp's veil meshes have geometry (see cells.frag).
    const cells = size / VEIL_STRIDE;
    this.cells = texture(cells, cells, gl.RGBA32F);
    this.cellsFbo = framebuffer([this.cells]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cellsFbo);
    gl.clearBufferfv(gl.COLOR, 0, [0, -1, 0, -1]);

    // For the boundaries of the lit volumes (see boundary.vert): the slopes of the blurred end distances
    // (for normals), the smoothed end distances, where each grid point of the meshes moves in the map,
    // and how each cell is split. Made when first needed.
    this.boundaryTargets = null;

    // Bounds of the reach over blocks of each map, level L of the blocks at mip L - 1 (see
    // reach-bounds.frag): of the published solution, and of the one a solve from sight is working on,
    // made when first needed.
    this.boundsLevels = Math.log2(mapSize);
    this.pyramids = [this.createPyramid()];
    this.publishedPyramid = 0;
    // For counting the rays that differ between two solutions (countChanges()), made when first needed.
    this.changeTarget = null;

    // 'sweep' or 'sight', and for a solve from sight, the rays each pass changed (changes.frag).
    this.method = 'sweep';
    this.changes = [];
    this.pass = 0;
    this.passCount = 0;
    // Solutions published so far, and the one each copy for display was last made from.
    this.version = 0;
    this.prepared = { copy: -1, cells: -1, boundaries: -1 };
  }

  dispose() {
    const { gl, owned } = this;
    owned.fbos.forEach((f) => gl.deleteFramebuffer(f));
    owned.textures.forEach((t) => gl.deleteTexture(t));
    owned.renderbuffers.forEach((r) => gl.deleteRenderbuffer(r));
  }

  get texture() {
    return this.textures[this.published];
  }

  get occluder() {
    return this.occluders[this.publishedOccluder];
  }

  get pyramid() {
    return this.pyramids[this.publishedPyramid];
  }

  get busy() {
    return this.pass < this.passCount;
  }

  createPyramid() {
    const { gl, size, boundsLevels, owned } = this;
    const texture = createTexture(gl, size / 2, size / 2, gl.RG32F, gl.NEAREST, boundsLevels);
    const fbos = Array.from({ length: boundsLevels }, (_, m) => createFramebuffer(gl, [texture], null, m));
    owned.textures.push(texture);
    owned.fbos.push(...fbos);
    return { texture, fbos };
  }

  // Starts solving for `lamps`, which the Lamps uniform block must already hold, by the sweep or, with
  // `method` 'sight', from sight.
  start(lamps, method = 'sweep') {
    const { gl, programs, bvh, size, atlasSide, mapSize } = this;
    const fastest = Math.max(...lamps.map((lamp) => lamp.sqrtPower));
    const slowest = Math.min(...lamps.map((lamp) => lamp.sqrtPower)) * P_MIN;
    this.firstTime = START_DISTANCE / fastest;
    this.method = method;
    this.changes = [];
    this.passCount = method === 'sight' ? SIGHT_PASSES : Math.ceil(Math.log(RANGE / slowest / this.firstTime) / Math.log(STEP_RATIO)) + 1;

    // The distance to Spot along every ray, one map at a time (see occluder.vert).
    this.solving = 1 - this.publishedOccluder;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.occluderFbos[this.solving]);
    gl.viewport(0, 0, size, size);
    gl.clearBufferfv(gl.COLOR, 0, [ALIVE, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    const occluder = programs.occluder;
    gl.useProgram(occluder.program);
    bindTextures(gl, occluder, { uTriangles: bvh.triangles });
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.fullscreen);
    lamps.forEach((lamp, i) => {
      gl.viewport((i % atlasSide) * mapSize, Math.floor(i / atlasSide) * mapSize, mapSize, mapSize);
      gl.uniform1i(occluder.uniforms.uLamp, i);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, bvh.count);
    });
    gl.disable(gl.DEPTH_TEST);

    this.pass = 0;
    if (method === 'sight') return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.work[0]]);
    gl.viewport(0, 0, size, size);
    gl.clearBufferfv(gl.COLOR, 0, [ALIVE, -1, 0, 0]);
  }

  // Runs up to `budget` passes. Returns true when a new solution has been published.
  step(budget) {
    if (!this.busy) return false;
    if (this.method === 'sight') return this.stepFromSight(budget);
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

    this.prepareBounds();
    for (let n = 0; n < REFINE_PASSES; n++) this.refine();
    this.version++;
    return true;
  }

  // Up to `budget` passes of a solve from sight (see the class's comment), each into the work texture the
  // last didn't write, against the new distances to Spot and the bounds of the last pass's reach, kept in
  // the pyramid the published solution doesn't use. The first lets every ray's light reach as far as it
  // can see. The solution is published once it has settled (SETTLED).
  stepFromSight(budget) {
    const { gl, size } = this;
    const refine = this.programs.refine;
    if (this.pyramids.length < 2) this.pyramids.push(this.createPyramid());
    const pyramid = this.pyramids[1 - this.publishedPyramid];
    for (let n = 0; n < budget && this.busy; n++) {
      const k = this.pass++;
      const before = this.textures[this.work[(k + 1) % 2]];
      const after = this.textures[this.work[k % 2]];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[this.work[k % 2]]);
      gl.viewport(0, 0, size, size);
      gl.useProgram(refine.program);
      this.bindExact(refine, { reach: before, occluder: this.occluders[this.solving], bounds: pyramid.texture });
      gl.uniform1i(refine.uniforms.uStart, k === 0 ? 1 : 0);
      gl.bindVertexArray(this.fullscreen);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.prepareBounds(after, pyramid);
      if (k > 0) {
        const changed = this.countChanges(before, after);
        const last = this.changes.at(-1);
        this.changes.push(changed);
        if (changed.far === 0 || (last && changed.far > SETTLED * last.far)) this.passCount = this.pass;
      }
    }
    if (this.busy) return false;

    const slot = (this.pass - 1) % 2;
    [this.published, this.work[slot]] = [this.work[slot], this.published];
    this.publishedOccluder = this.solving;
    this.publishedPyramid = 1 - this.publishedPyramid;
    this.version++;
    return true;
  }

  // How many rays differ between two solutions (changes.frag): `any` however little, and `far` by more
  // than a thousandth of their distance or in why their light ended.
  countChanges(before, after) {
    const { gl } = this;
    if (!this.changeTarget) {
      const blocks = this.size / CHANGE_BLOCK;
      const texture = createTexture(gl, blocks, blocks, gl.RG32F);
      this.owned.textures.push(texture);
      const fbo = createFramebuffer(gl, [texture]);
      this.owned.fbos.push(fbo);
      this.changeTarget = { blocks, fbo, pixels: new Float32Array(4 * blocks * blocks) };
    }
    const { blocks, fbo, pixels } = this.changeTarget;
    const changes = this.programs.changes;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, blocks, blocks);
    gl.useProgram(changes.program);
    bindTextures(gl, changes, { uBefore: before, uAfter: after });
    gl.uniform1i(changes.uniforms.uBlock, CHANGE_BLOCK);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, blocks, blocks, gl.RGBA, gl.FLOAT, pixels);
    let any = 0;
    let far = 0;
    for (let k = 0; k < pixels.length; k += 4) {
      any += pixels[k];
      far += pixels[k + 1];
    }
    return { any, far };
  }

  // Makes what drawing the published solution needs, if it isn't made yet: the compact copies for the
  // fog and the veils, the cells of the veil meshes, and the boundary meshes of the lit volumes. Those
  // borrow the solver's work textures, so they wait while a solve is running.
  prepareDisplay({ veil, bounds }) {
    const { gl, size, version, prepared } = this;
    if (prepared.copy !== version) {
      const copy = this.programs.copy;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.copyFbo);
      gl.viewport(0, 0, size, size);
      gl.useProgram(copy.program);
      bindTextures(gl, copy, { uState: this.texture });
      gl.bindVertexArray(this.fullscreen);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      prepared.copy = version;
    }
    if (veil && prepared.cells !== version) {
      const cells = this.programs.cells;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.cellsFbo);
      gl.viewport(0, 0, size / VEIL_STRIDE, size / VEIL_STRIDE);
      gl.useProgram(cells.program);
      bindTextures(gl, cells, { uState: this.texture });
      gl.uniform1i(cells.uniforms.uStride, VEIL_STRIDE);
      gl.bindVertexArray(this.fullscreen);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      prepared.cells = version;
    }
    if (bounds && prepared.boundaries !== version && !this.busy) {
      this.prepareBoundaries();
      prepared.boundaries = version;
    }
  }

  // What the exact tests of exact.glsl read, on the first five texture units, for a program using them: by
  // default the published solution, with its distances to Spot and the bounds of its reach.
  bindExact(program, { reach = this.texture, occluder = this.occluder, bounds = this.pyramid.texture } = {}) {
    bindTextures(this.gl, program, {
      uReach: reach,
      uOccluder: occluder,
      uReachBounds: bounds,
      uBvhNodes: this.bvh.nodes,
      uBvhTriangles: this.bvh.triangles,
    });
    this.gl.uniform1i(program.uniforms.uSpot, 1);
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
    gl.uniform1i(refine.uniforms.uStart, 0);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    [this.published, this.work[0]] = [target, this.published];
    this.prepareBounds();
  }

  // The bounds of the reach of solution `source` over blocks of each map, level by level, into `pyramid`.
  // While a level is drawn, the texture exposes only the level below to sampling, so that it doesn't read
  // the level it writes.
  prepareBounds(source = this.texture, pyramid = this.pyramid) {
    const { gl } = this;
    const { texture: bounds, fbos } = pyramid;
    const { program, uniforms } = this.programs.reachBounds;
    gl.useProgram(program);
    gl.bindVertexArray(this.fullscreen);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uniforms.uSource, 0);
    for (let level = 1; level <= this.boundsLevels; level++) {
      const size = this.size >> level;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[level - 1]);
      gl.viewport(0, 0, size, size);
      if (level === 1) {
        gl.bindTexture(gl.TEXTURE_2D, source);
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

  get boundaries() {
    if (!this.boundaryTargets) {
      const { gl, size, owned } = this;
      const texture = (...args) => {
        const t = createTexture(gl, ...args);
        owned.textures.push(t);
        return t;
      };
      const framebuffer = (colors) => {
        const f = createFramebuffer(gl, colors);
        owned.fbos.push(f);
        return f;
      };
      const grid = size / BOUNDARY_STRIDE;
      const slopes = texture(size, size, gl.RG16F, gl.LINEAR);
      const ends = texture(size, size, gl.R32F);
      const offsets = texture(grid, grid, gl.RG16F);
      const diagonals = texture(grid, grid, gl.R8);
      this.boundaryTargets = {
        slopes,
        ends,
        offsets,
        diagonals,
        slopesFbo: framebuffer([slopes]),
        endsFbo: framebuffer([ends]),
        offsetsFbo: framebuffer([offsets]),
        diagonalsFbo: framebuffer([diagonals]),
      };
    }
    return this.boundaryTargets;
  }

  // What the boundary meshes of the lit volumes need from a new solution (see boundary.vert). The
  // separable blurs go through the two work textures, which are free until the next sweep starts.
  prepareBoundaries() {
    const { gl, size, programs } = this;
    const targets = this.boundaries;
    const [a, b] = this.work;
    const pass = (name, fbo, textures) => {
      const program = programs[name];
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(program.program);
      bindTextures(gl, program, textures);
      return program.uniforms;
    };
    const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(this.fullscreen);
    gl.viewport(0, 0, size, size);

    let uniforms = pass('ends', this.fbos[b], { uState: this.texture, uValues: this.texture });
    gl.uniform1i(uniforms.uFirstPass, 1);
    gl.uniform2i(uniforms.uAxis, 1, 0);
    draw();
    uniforms = pass('ends', targets.endsFbo, { uState: this.texture, uValues: this.textures[b] });
    gl.uniform1i(uniforms.uFirstPass, 0);
    gl.uniform2i(uniforms.uAxis, 0, 1);
    draw();

    pass('slopesRows', this.fbos[a], { uEnds: targets.ends });
    draw();
    pass('slopesColumns', targets.slopesFbo, { uRows: this.textures[a] });
    draw();

    const grid = size / BOUNDARY_STRIDE;
    gl.viewport(0, 0, grid, grid);
    uniforms = pass('snap', targets.offsetsFbo, { uState: this.texture });
    gl.uniform1i(uniforms.uStride, BOUNDARY_STRIDE);
    draw();
    uniforms = pass('diagonals', targets.diagonalsFbo, { uEnds: targets.ends, uOffsets: targets.offsets });
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
