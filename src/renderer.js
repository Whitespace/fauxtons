import { buildBvh } from './bvh.js';
import { bindTextures, createDataTexture, createDepthBuffer, createFramebuffer, createMesh, createProgram, createTexture } from './gl.js';
import { IDENTITY, transformPoint } from './mat4.js';
import { compareSurfacesWithReference, compareWithReference, createReference, sampleSurfaces } from './reference.js';
import { GROUND_ALBEDO, LAMP_CAPACITY, SPOT_ALBEDO, packLamps } from './scene.js';
import { BOUNDARY_STRIDE, ExtinctionSolver, VEIL_STRIDE } from './solver.js';

const MAX_ACCUMULATED_FRAMES = 256;
const WALL_FRAMES = 16;
// Rows of pixels the walls are found for in one draw, as a draw that runs for more than a second or so
// loses the WebGL context.
const WALL_BAND = 64;

// Tuned for a Spot 2.4 tall with its lamps a few units away. Inside a Spot ten times larger, light
// travels ten times as far through the air, and the sheets pass close to the lamps.
const LOOK = {
  exposure: 1.1,
  ambient: 0.004,
  fogDensity: 0.0035,
  veilOpacity: 0.06,
  veilGain: 0.08,
  boundaryOpacity: 0.06,
  boundaryGain: 0.1,
  lampRadius: 0.06,
  lampEmission: 4,
};

const halton = (index, base) => {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
};

export const SHADER_FILES = [
  'common.glsl',
  'exact.glsl',
  'fullscreen.vert',
  'occluder.vert',
  'occluder.frag',
  'sweep.frag',
  'copy.frag',
  'cells.frag',
  'slopes-rows.frag',
  'slopes-columns.frag',
  'ends.frag',
  'snap.frag',
  'diagonals.frag',
  'reach-bounds.frag',
  'refine.frag',
  'surface.vert',
  'surface.frag',
  'probe.frag',
  'visibility.frag',
  'veil.vert',
  'veil.frag',
  'boundary.vert',
  'boundary.frag',
  'camera-light.frag',
  'shell.frag',
  'walls.frag',
  'fog.frag',
  'composite.frag',
  'present.frag',
];

// Per frame: surfaces and veils at full resolution, light in the air at half resolution (or instead
// the boundaries of the lit volumes), a composite that upsamples the fog and averages frames while
// the view is still, and tone mapping. The scene's surface is `mesh`, placed in the world by `model`;
// it is called Spot here, as it mostly is.
export class Renderer {
  constructor(gl, shaders, mesh, model, layout) {
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This browser cannot render to float textures.');
    this.gl = gl;

    const plain = (name) => `#version 300 es\n${shaders[name]}`;
    const common = `#version 300 es\n#define LAMP_CAPACITY ${LAMP_CAPACITY}\n${shaders['common.glsl']}`;
    const shared = (name) => `${common}\n${shaders[name]}`;
    const exact = (name) => `${common}\n${shaders['exact.glsl']}\n${shaders[name]}`;
    const program = (label, vertex, fragment) => createProgram(gl, label, vertex, fragment);
    this.programs = {
      occluder: program('occluder', shared('occluder.vert'), shared('occluder.frag')),
      sweep: program('sweep', plain('fullscreen.vert'), shared('sweep.frag')),
      copy: program('copy', plain('fullscreen.vert'), shared('copy.frag')),
      cells: program('cells', plain('fullscreen.vert'), shared('cells.frag')),
      slopesRows: program('slopes-rows', plain('fullscreen.vert'), shared('slopes-rows.frag')),
      slopesColumns: program('slopes-columns', plain('fullscreen.vert'), shared('slopes-columns.frag')),
      ends: program('ends', plain('fullscreen.vert'), shared('ends.frag')),
      snap: program('snap', plain('fullscreen.vert'), shared('snap.frag')),
      diagonals: program('diagonals', plain('fullscreen.vert'), shared('diagonals.frag')),
      reachBounds: program('reach-bounds', plain('fullscreen.vert'), shared('reach-bounds.frag')),
      refine: program('refine', plain('fullscreen.vert'), exact('refine.frag')),
      surface: program('surface', plain('surface.vert'), exact('surface.frag')),
      probe: program('probe', plain('fullscreen.vert'), exact('probe.frag')),
      visibility: program('visibility', plain('fullscreen.vert'), exact('visibility.frag')),
      veil: program('veil', shared('veil.vert'), shared('veil.frag')),
      boundary: program('boundary', shared('boundary.vert'), shared('boundary.frag')),
      cameraLight: program('camera-light', plain('fullscreen.vert'), exact('camera-light.frag')),
      shell: program('shell', plain('surface.vert'), shared('shell.frag')),
      walls: program('walls', plain('fullscreen.vert'), exact('walls.frag')),
      fog: program('fog', plain('fullscreen.vert'), shared('fog.frag')),
      composite: program('composite', plain('fullscreen.vert'), shared('composite.frag')),
      present: program('present', plain('fullscreen.vert'), shared('present.frag')),
    };

    this.lampBlock = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lampBlock);
    gl.bufferData(gl.UNIFORM_BUFFER, packLamps({ lamps: [], atlasSide: 1, mapSize: 1 }).byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.lampBlock);

    this.mesh = mesh;
    this.fullscreen = gl.createVertexArray();
    this.spot = { model };
    this.spotFacets = createFacets(gl, mesh);
    this.spotTriangles = worldTriangles(mesh, this.spot.model);
    const bvh = buildBvh(this.spotTriangles, cornerNormals(mesh));
    this.bvh = {
      nodes: createDataTexture(gl, bvh.nodes),
      triangles: createDataTexture(gl, bvh.triangles),
      normals: createDataTexture(gl, bvh.normals),
      count: bvh.triangles.length / 12,
    };
    this.ground = createMesh(gl, {
      positions: new Float32Array([-40, 0, -40, 40, 0, -40, 40, 0, 40, -40, 0, 40]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    });

    // The lamp whose light the camera is in, for the walls (walls.frag).
    const cameraLight = createTexture(gl, 1, 1, gl.R32F);
    this.cameraLight = { texture: cameraLight, fbo: createFramebuffer(gl, [cameraLight]) };

    this.frame = 0;
    this.accumulated = 0;
    this.shown = { spot: true, veil: true, bounds: false, opaque: false, opaque2: false, cull: false };
    this.diffused = null;
    this.diffusedTexture = createDataTexture(gl, new Float32Array(4), 1);
    this.setLayout(layout);
  }

  // Shows Spot lit by the light leaving its shell (diffusion.js) rather than the light arriving: `owner`,
  // each vertex's cell, and `light`, the light leaving it, for the layout shown. Null goes back.
  setDiffusion(diffused) {
    const { gl } = this;
    gl.deleteTexture(this.diffusedTexture);
    const data = new Float32Array(4 * (diffused?.owner.length ?? 1));
    diffused?.owner.forEach((cell, v) => data.set([cell, diffused.light[v]], 4 * v));
    this.diffusedTexture = createDataTexture(gl, data);
    this.diffused = diffused;
    this.accumulated = 0;
  }

  // Solves for new lamps, keeping the atlas of maps if it has the same shape. Until the new solution is
  // published, frames show the old one.
  setLayout(layout) {
    const { gl } = this;
    this.pendingLayout = layout;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lampBlock);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, packLamps(layout));
    if (this.solver?.atlasSide !== layout.atlasSide || this.solver?.mapSize !== layout.mapSize) {
      this.solver?.dispose();
      this.solver = new ExtinctionSolver(gl, {
        programs: this.programs,
        fullscreen: this.fullscreen,
        bvh: this.bvh,
        layout,
      });
    }
    this.solver.start(layout.lamps);
    // Sweep passes per frame: under 20 ms of work at any map size and number of lamps, as every ray of
    // every map is checked against the other lamps' light.
    const n = layout.lamps.length;
    this.sweepPassesPerFrame = Math.max(1, Math.round(96 * (1024 / layout.mapSize) ** 2 * (12 / Math.max(n * (n - 1), 1))));
  }

  // New colours for the lamps of the layout shown, which leave its solution as it is.
  setColors(colors) {
    const layout = this.layout ?? this.pendingLayout;
    layout.lamps.forEach((lamp, i) => (lamp.color = colors[i]));
    this.useLayoutUniforms(layout);
    this.accumulated = 0;
  }

  // Solves the pending layout to the end at once.
  solve() {
    this.solver.step(Infinity);
    this.published();
  }

  published() {
    this.layout = this.pendingLayout;
    this.accumulated = 0;
  }

  get lamps() {
    return (this.layout ?? this.pendingLayout).lamps;
  }

  resize(width, height) {
    const { gl } = this;
    if (this.width === width && this.height === height) return false;
    this.width = width;
    this.height = height;
    for (const texture of this.targets?.textures ?? []) gl.deleteTexture(texture);
    for (const fbo of this.targets?.fbos ?? []) gl.deleteFramebuffer(fbo);
    for (const renderbuffer of this.targets?.renderbuffers ?? []) gl.deleteRenderbuffer(renderbuffer);

    const halfSize = [Math.ceil(width / 2), Math.ceil(height / 2)];
    const color = createTexture(gl, width, height, gl.RGBA16F);
    const distance = createTexture(gl, width, height, gl.R32F);
    const fog = createTexture(gl, ...halfSize, gl.RGBA16F);
    const depth = createDepthBuffer(gl, width, height);
    const accumulation = [0, 1].map(() => createTexture(gl, width, height, gl.RGBA32F));
    const scene = createFramebuffer(gl, [color, distance], depth);
    const veils = createFramebuffer(gl, [color], depth);
    const fogFbo = createFramebuffer(gl, [fog]);
    const history = accumulation.map((texture) => createFramebuffer(gl, [texture]));
    // The solid walls (walls.frag), and where the view first meets Spot's surface for them (shell.frag).
    const wallColor = createTexture(gl, width, height, gl.RGBA16F);
    const wallDistance = createTexture(gl, width, height, gl.R32F);
    const walls = createFramebuffer(gl, [wallColor, wallDistance]);
    const shell = createTexture(gl, width, height, gl.RG32F);
    const shellDepth = createDepthBuffer(gl, width, height);
    const shellFbo = createFramebuffer(gl, [shell], shellDepth);
    // For Backface culling, the lamp owning the surface in view at each pixel (drawOwners()); the solid
    // walls, which never cull, share its depth buffer.
    const owners = createTexture(gl, width, height, gl.R16F);
    const ownersFbo = createFramebuffer(gl, [owners], shellDepth);
    this.targets = {
      color,
      distance,
      fog,
      halfSize,
      depth,
      scene,
      veils,
      fogFbo,
      accumulation,
      history,
      wallColor,
      wallDistance,
      walls,
      shell,
      shellFbo,
      owners,
      ownersFbo,
      textures: [color, distance, fog, ...accumulation, wallColor, wallDistance, shell, owners],
      fbos: [scene, veils, fogFbo, ...history, walls, shellFbo, ownersFbo],
      renderbuffers: [depth, shellDepth],
    };
    return true;
  }

  // `spot` shows Spot's surface; its walls still stop the light either way. `opaque` draws the veils and
  // boundaries as solid sheets, and `opaque2` draws them solid from the boundary meshes, which wins if
  // both are on. `cull` shows only the cell each pixel's view meets first: its light in the air, or its
  // glowing sheets. Once
  // MAX_ACCUMULATED_FRAMES frames of a still view are averaged, nothing more is drawn until something
  // changes, though a sweep under way carries on. Returns whether a frame was drawn.
  render(camera, { spot, veil, bounds, opaque, opaque2, cull }, cameraMoved) {
    const { gl } = this;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    let changed = this.resize(width, height) || cameraMoved;

    if (this.solver.step(this.sweepPassesPerFrame)) {
      this.published();
      changed = true;
    }
    const shown = { spot, veil, bounds, opaque, opaque2, cull };
    changed = Object.keys(shown).some((key) => shown[key] !== this.shown[key]) || changed;
    this.shown = shown;
    if (changed) this.accumulated = 0;
    // Solid walls are found per pixel (`walls`), which costs much more than the sheets, or drawn from the
    // boundary meshes (`solid`). Either way they have only their edges to smooth, so fewer frames are
    // averaged for them.
    const solid = opaque2 && (veil || bounds);
    const walls = opaque && !solid && (veil || bounds);
    const frames = walls || solid ? WALL_FRAMES : MAX_ACCUMULATED_FRAMES;
    if (this.accumulated >= frames) return false;
    // Uniforms describe the lamps being solved for; while they are, frames show the lamps solved last.
    if (this.solver.busy && this.layout !== this.pendingLayout && this.layout) this.useLayoutUniforms(this.layout);
    this.solver.prepareDisplay({ veil: veil && !walls && !solid, bounds: (bounds && !walls) || solid });

    const n = this.accumulated;
    const jitter = n > 0 ? [(2 * halton(n, 2) - 1) / width, (2 * halton(n, 3) - 1) / height] : [0, 0];
    const view = camera.matrices(width / height, jitter);
    const blend = 1 / Math.min(n + 1, frames);

    // The light in the air is left out for the boundaries and for solid walls, which it would haze over.
    // Culled, each pixel shows only the cell owning the surface in view there; solid walls show only the
    // nearest anyway.
    const culled = cull && !walls && !solid;
    this.drawSurfaces(view, spot);
    if (culled) this.drawOwners(view);
    if (!bounds && !opaque && !opaque2) {
      this.drawFog(view, culled);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.fogFbo);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
    }
    if (walls) {
      this.drawWalls(view, { veil, bounds, pixelAngle: (2 * Math.tan(camera.fovy / 2)) / height });
    } else if (solid) {
      this.drawBoundaries(view, { solid, veilsOnly: !bounds });
    } else {
      if (veil) this.drawVeils(view, culled);
      if (bounds) this.drawBoundaries(view, { cull: culled });
    }
    this.present(this.composite(view, blend, walls, culled));
    if (this.solver.busy && this.layout !== this.pendingLayout && this.layout) this.useLayoutUniforms(this.pendingLayout);

    this.accumulated++;
    this.frame++;
    return true;
  }

  useLayoutUniforms(layout) {
    const { gl } = this;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lampBlock);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, packLamps(layout));
  }

  drawSurfaces(view, spot) {
    const { gl, targets } = this;
    const { program, uniforms } = this.programs.surface;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.scene);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
    gl.clearBufferfv(gl.COLOR, 1, [1e30, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(program);
    gl.uniformMatrix4fv(uniforms.uViewProj, false, view.viewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform1f(uniforms.uAmbient, LOOK.ambient);
    this.solver.bindExact(this.programs.surface);
    bindTextures(gl, this.programs.surface, { uDiffused: this.diffusedTexture }, 5);
    gl.uniform1i(uniforms.uDiffuse, this.diffused ? 1 : 0);

    // From below the ground, it would hide everything above it.
    if (view.eye[1] > 0) {
      gl.uniformMatrix4fv(uniforms.uModel, false, IDENTITY);
      gl.uniform3fv(uniforms.uAlbedo, GROUND_ALBEDO);
      gl.bindVertexArray(this.ground.vao);
      gl.drawElements(gl.TRIANGLES, this.ground.count, this.ground.type, 0);
    }
    if (spot) {
      gl.uniformMatrix4fv(uniforms.uModel, false, this.spot.model);
      gl.uniform3fv(uniforms.uAlbedo, SPOT_ALBEDO);
      gl.bindVertexArray(this.spotFacets.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.spotFacets.count);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  // For Backface culling, which lamp's cell owns the surface in view at each pixel, as the surface is lit
  // (surface.frag), whether or not the surface is shown; -1 where none does or the view misses it.
  drawOwners(view) {
    const { gl, targets } = this;
    const surface = this.programs.surface;
    const { uniforms } = surface;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.ownersFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearBufferfv(gl.COLOR, 0, [-1, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(surface.program);
    gl.uniformMatrix4fv(uniforms.uViewProj, false, view.viewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    this.solver.bindExact(surface);
    bindTextures(gl, surface, { uDiffused: this.diffusedTexture }, 5);
    gl.uniform1i(uniforms.uOwner, 1);
    gl.uniformMatrix4fv(uniforms.uModel, false, this.spot.model);
    gl.bindVertexArray(this.spotFacets.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.spotFacets.count);
    gl.uniform1i(uniforms.uOwner, 0);
    gl.disable(gl.DEPTH_TEST);
  }

  // Glowing sheets over the surfaces, added to what is behind them and hidden where a surface is in
  // front of them.
  beginSheets() {
    const { gl, targets } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.veils);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  endSheets() {
    const { gl } = this;
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
  }

  // With `cull`, sheets show only where they belong to the cell owning the surface in view (drawOwners()).
  drawVeils(view, cull) {
    const { gl, solver, targets } = this;
    const veil = this.programs.veil;
    const { uniforms } = veil;
    const quads = solver.mapSize / VEIL_STRIDE - 1;
    this.beginSheets();
    gl.useProgram(veil.program);
    bindTextures(gl, veil, { uReach: solver.texture, uTags: solver.tags, uCells: solver.cells, uOwners: targets.owners });
    gl.uniformMatrix4fv(uniforms.uViewProj, false, view.viewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform1i(uniforms.uStride, VEIL_STRIDE);
    gl.uniform1f(uniforms.uVeilOpacity, LOOK.veilOpacity);
    gl.uniform1f(uniforms.uVeilGain, LOOK.veilGain);
    gl.uniform1i(uniforms.uCull, cull ? 1 : 0);
    gl.bindVertexArray(this.fullscreen);
    // One instance per lamp and each of the two partners a cell of its mesh can have.
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * quads * quads, 2 * this.lamps.length);
    this.endSheets();
  }

  // The boundaries of the lit volumes, one mesh per lamp, as glowing sheets; with `cull`, only where they
  // belong to the cell owning the surface in view (drawOwners()). With `solid` (Opaque v2) they are solid
  // walls among the surfaces instead, drawn only from inside their volumes, so that a cell seen from
  // outside shows the inside of its far walls; with `veilsOnly`, only the walls on veils.
  drawBoundaries(view, { cull = false, solid = false, veilsOnly = false } = {}) {
    const { gl, solver, targets } = this;
    if (solver.prepared.boundaries < 0) return;
    const boundary = this.programs.boundary;
    const { uniforms } = boundary;
    if (solid) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets.scene);
      gl.viewport(0, 0, this.width, this.height);
      gl.enable(gl.DEPTH_TEST);
      // A mesh's triangles go round anticlockwise as seen from inside its volume (boundary.vert).
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    } else {
      this.beginSheets();
    }
    gl.useProgram(boundary.program);
    const { ends, offsets, diagonals, slopes } = solver.boundaries;
    bindTextures(gl, boundary, { uEnds: ends, uOffsets: offsets, uDiagonals: diagonals, uSlopes: slopes, uOwners: targets.owners, uTags: solver.tags });
    gl.uniformMatrix4fv(uniforms.uViewProj, false, view.viewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform1i(uniforms.uStride, BOUNDARY_STRIDE);
    gl.uniform1f(uniforms.uOpacity, LOOK.boundaryOpacity);
    gl.uniform1f(uniforms.uGain, LOOK.boundaryGain);
    gl.uniform1i(uniforms.uCull, cull ? 1 : 0);
    gl.uniform1i(uniforms.uSolid, solid ? 1 : 0);
    gl.uniform1i(uniforms.uVeilsOnly, veilsOnly ? 1 : 0);
    gl.bindVertexArray(this.fullscreen);
    // Six vertices for each cell between four neighbouring grid points, one instance per lamp.
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * (solver.mapSize / BOUNDARY_STRIDE - 1) ** 2, this.lamps.length);
    if (solid) {
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DEPTH_TEST);
    } else {
      this.endSheets();
    }
  }

  // Solid walls between the cells (walls.frag): the veils with `veil`, and with `bounds` every wall where
  // a lamp's light ends. `pixelAngle` is the angle a pixel spans, which is as near as walls need placing.
  drawWalls(view, { veil, bounds, pixelAngle }) {
    const { gl, targets, solver } = this;
    gl.bindVertexArray(this.fullscreen);
    const light = this.programs.cameraLight;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cameraLight.fbo);
    gl.viewport(0, 0, 1, 1);
    gl.useProgram(light.program);
    solver.bindExact(light);
    gl.uniform3fv(light.uniforms.uCameraPos, view.eye);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const shell = this.programs.shell;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.shellFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearBufferfv(gl.COLOR, 0, [1e30, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(shell.program);
    gl.uniformMatrix4fv(shell.uniforms.uViewProj, false, view.viewProj);
    gl.uniformMatrix4fv(shell.uniforms.uModel, false, this.spot.model);
    gl.uniform3fv(shell.uniforms.uCameraPos, view.eye);
    gl.bindVertexArray(this.spotFacets.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.spotFacets.count);
    gl.disable(gl.DEPTH_TEST);

    const walls = this.programs.walls;
    const { uniforms } = walls;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.walls);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(walls.program);
    solver.bindExact(walls);
    bindTextures(gl, walls, { uSceneDistance: targets.distance, uShell: targets.shell, uCameraLight: this.cameraLight.texture, uBvhNormals: this.bvh.normals }, 5);
    gl.uniformMatrix4fv(uniforms.uInvViewProj, false, view.invViewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform2f(uniforms.uResolution, this.width, this.height);
    gl.uniform1i(uniforms.uVeils, veil ? 1 : 0);
    gl.uniform1i(uniforms.uBounds, bounds ? 1 : 0);
    gl.uniform1f(uniforms.uPixelAngle, pixelAngle);
    gl.bindVertexArray(this.fullscreen);
    gl.enable(gl.SCISSOR_TEST);
    for (let y = 0; y < this.height; y += WALL_BAND) {
      gl.scissor(0, y, this.width, WALL_BAND);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // The light in the air; with `cull`, only of the cell owning the surface in view (drawOwners()).
  drawFog(view, cull) {
    const { gl, targets } = this;
    const fog = this.programs.fog;
    const { uniforms } = fog;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.fogFbo);
    gl.viewport(0, 0, ...targets.halfSize);
    gl.useProgram(fog.program);
    bindTextures(gl, fog, { uReach: this.solver.reachHalf, uSceneDistance: targets.distance, uOwners: targets.owners });
    gl.uniformMatrix4fv(uniforms.uInvViewProj, false, view.invViewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform2f(uniforms.uResolution, this.width, this.height);
    gl.uniform1i(uniforms.uFrame, this.frame);
    gl.uniform1f(uniforms.uFogDensity, LOOK.fogDensity);
    gl.uniform1i(uniforms.uCull, cull ? 1 : 0);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  composite(view, blend, walls, cull) {
    const { gl, targets } = this;
    const composite = this.programs.composite;
    const { uniforms } = composite;
    const read = this.frame % 2;
    const write = 1 - read;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.history[write]);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(composite.program);
    bindTextures(gl, composite, {
      uSceneColor: targets.color,
      uSceneDistance: targets.distance,
      uFog: targets.fog,
      uHistory: targets.accumulation[read],
      uWallColor: targets.wallColor,
      uWallDistance: targets.wallDistance,
      uOwners: targets.owners,
    });
    gl.uniform1i(uniforms.uWalls, walls ? 1 : 0);
    gl.uniform1i(uniforms.uCull, cull ? 1 : 0);
    gl.uniformMatrix4fv(uniforms.uInvViewProj, false, view.invViewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform2f(uniforms.uResolution, this.width, this.height);
    gl.uniform1f(uniforms.uBlend, blend);
    gl.uniform1f(uniforms.uLampRadius, LOOK.lampRadius);
    gl.uniform1f(uniforms.uLampEmission, LOOK.lampEmission);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return targets.accumulation[write];
  }

  present(image) {
    const { gl } = this;
    const present = this.programs.present;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(present.program);
    bindTextures(gl, present, { uImage: image });
    gl.uniform1f(present.uniforms.uExposure, LOOK.exposure);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Checks the published solution against the README's recursive definition at random points in the
  // box `bounds` ({ min, max }).
  check(samples = 200, bounds) {
    const { lamps } = this;
    const reference = createReference(lamps, this.spotTriangles);
    const reachAt = (x, y) => this.solver.reachAt(x, y);
    return compareWithReference({ lamps, layout: this.layout, reference, reachAt, samples, bounds });
  }

  // Checks which lamp lights points of Spot against the README's recursive definition, as the renderer
  // decides it and as the maps alone would. Of `candidates` random points, up to `limit` near an edge of
  // the light in the maps are checked, since elsewhere both are right. The reference tests light every
  // `step` along each ray; a coarse step can miss thin stretches of light, so the check is only as good
  // as the step is fine.
  checkSurfaces(candidates = 20000, limit = 300, step = 0.01) {
    const { mesh, spot, lamps } = this;
    const points = sampleSurfaces({ mesh, model: spot.model, withGround: false, count: candidates });
    const probe = this.createProbe(points);
    const lit = probe.run({ maps: true });
    probe.dispose();
    const reference = createReference(lamps, this.spotTriangles, step);
    return compareSurfacesWithReference({ reference, points, lit, limit });
  }

  // A list of points to find the lamp lighting, again for each new solution. On the surfaces (see
  // sampleSurfaces() in reference.js) that is decided by litBy() in exact.glsl, and also by the maps
  // alone with `maps`, with whether the maps' rays around the point disagree (see probe.frag). With
  // `air`, only `positions` are given, and the lamp whose light is present there is found.
  createProbe({ positions, facets, roughness, lifted, normals }, { air = false } = {}) {
    const { gl } = this;
    const count = positions.length / 3;
    const width = Math.min(count, 1024);
    const height = Math.ceil(count / width);
    const texels = (data, w) => {
      const rgba = new Float32Array(4 * width * height);
      for (let k = 0; k < count; k++) rgba.set([...data.subarray(3 * k, 3 * k + 3), w?.[k] ?? 0], 4 * k);
      return createDataTexture(gl, rgba, width);
    };
    // Every sampler gets a texture even where it isn't read, as WebGL refuses to draw while one could
    // read the texture being drawn to.
    const points = texels(positions);
    const inputs = air
      ? { uPoints: points, uFacets: points, uLifted: points, uNormals: points }
      : { uPoints: points, uFacets: texels(facets, roughness), uLifted: texels(lifted), uNormals: texels(normals) };
    const output = createTexture(gl, width, height, gl.RGBA32F);
    const fbo = createFramebuffer(gl, [output]);
    const result = new Float32Array(4 * width * height);
    return {
      count,
      // Rows of four floats per point: see probe.frag.
      run: ({ maps = false } = {}) => {
        const probe = this.programs.probe;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, width, height);
        gl.useProgram(probe.program);
        this.solver.bindExact(probe);
        bindTextures(gl, probe, inputs, 5);
        gl.uniform1i(probe.uniforms.uAir, air ? 1 : 0);
        gl.uniform1i(probe.uniforms.uMaps, maps ? 1 : 0);
        gl.bindVertexArray(this.fullscreen);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, result);
        return result.subarray(0, 4 * count);
      },
      dispose: () => {
        gl.deleteFramebuffer(fbo);
        for (const texture of new Set([output, ...Object.values(inputs)])) gl.deleteTexture(texture);
      },
    };
  }

  // For each place (xyz), the area of the target points of Spot's walls (xyz position, area, unit
  // normal) that a lamp there could light well (see visibility.frag). Drawn a row of places at a time,
  // as a draw that runs for more than a second or so loses the WebGL context.
  visibility(places, { positions, areas, normals }, { minCosine = 0, minDistance = 0, maxDistance = Infinity } = {}) {
    const { gl } = this;
    const count = places.length / 3;
    const targets = positions.length / 3;
    const width = Math.min(count, 128);
    const height = Math.ceil(count / width);
    const pack = (data, w, n, rowWidth) => {
      const rgba = new Float32Array(4 * rowWidth * Math.ceil(n / rowWidth));
      for (let k = 0; k < n; k++) rgba.set([data[3 * k], data[3 * k + 1], data[3 * k + 2], w?.[k] ?? 0], 4 * k);
      return createDataTexture(gl, rgba, rowWidth);
    };
    const inputs = {
      uPlaces: pack(places, null, count, width),
      uTargets: pack(positions, areas, targets, 1024),
      uTargetNormals: pack(normals, null, targets, 1024),
    };
    const output = createTexture(gl, width, height, gl.RGBA32F);
    const fbo = createFramebuffer(gl, [output]);
    const program = this.programs.visibility;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.useProgram(program.program);
    this.solver.bindExact(program);
    bindTextures(gl, program, inputs, 5);
    gl.uniform1i(program.uniforms.uTargetCount, targets);
    gl.uniform1f(program.uniforms.uMinCosine, minCosine);
    gl.uniform1f(program.uniforms.uMinDistance, minDistance);
    gl.uniform1f(program.uniforms.uMaxDistance, Math.min(maxDistance, 1e30));
    gl.bindVertexArray(this.fullscreen);
    const band = 1;
    const result = new Float32Array(4 * width * height);
    for (let y = 0; y < height; y += band) {
      gl.viewport(0, 0, width, height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, y, width, band);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
      gl.readPixels(0, y, width, Math.min(band, height - y), gl.RGBA, gl.FLOAT, result.subarray(4 * width * y));
    }
    gl.deleteFramebuffer(fbo);
    for (const texture of [output, ...Object.values(inputs)]) gl.deleteTexture(texture);
    return Float32Array.from({ length: count }, (_, k) => result[4 * k]);
  }
}

// Spot as separate triangles, each vertex also carrying its barycentric coordinates and its triangle's
// corners, their normals and their indices in the mesh, in the attribute locations of surface.vert.
function createFacets(gl, { positions, normals, indices }) {
  const count = indices.length;
  const barycentric = new Float32Array(3 * count);
  const own = [positions, normals].map(() => new Float32Array(3 * count));
  const triangle = [positions, normals].map(() => new Float32Array(9 * count));
  const corners = new Float32Array(3 * count);
  for (let t = 0; t < count; t += 3) {
    for (let k = 0; k < 3; k++) {
      barycentric[3 * (t + k) + k] = 1;
      corners.set([indices[t], indices[t + 1], indices[t + 2]], 3 * (t + k));
      [positions, normals].forEach((data, a) => {
        own[a].set(data.subarray(3 * indices[t + k], 3 * indices[t + k] + 3), 3 * (t + k));
        for (let m = 0; m < 3; m++) {
          triangle[a].set(data.subarray(3 * indices[t + m], 3 * indices[t + m] + 3), 9 * (t + k) + 3 * m);
        }
      });
    }
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const attributes = [[own[0], 1], [own[1], 1], [barycentric, 1], [triangle[0], 3], [triangle[1], 3], [corners, 1]];
  let location = 0;
  for (const [data, columns] of attributes) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (let c = 0; c < columns; c++, location++) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 12 * columns, 12 * c);
    }
  }
  gl.bindVertexArray(null);
  return { vao, count };
}

// Spot's triangles in the world, 9 floats each.
export function worldTriangles({ positions, indices }, model) {
  const triangles = new Float32Array(indices.length * 3);
  indices.forEach((v, k) => triangles.set(transformPoint(model, positions.subarray(3 * v, 3 * v + 3)), 3 * k));
  return triangles;
}

// The unit normals at the corners of Spot's triangles, 9 floats each, as in worldTriangles(); the model
// only scales uniformly and translates, which leaves directions alone.
function cornerNormals({ normals, indices }) {
  const corners = new Float32Array(indices.length * 3);
  indices.forEach((v, k) => corners.set(normals.subarray(3 * v, 3 * v + 3), 3 * k));
  return corners;
}
