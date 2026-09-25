import { buildBvh } from './bvh.js';
import { bindTextures, createDataTexture, createDepthBuffer, createFramebuffer, createMesh, createProgram, createTexture } from './gl.js';
import { IDENTITY, transformPoint } from './mat4.js';
import { compareSurfacesWithReference, compareWithReference, createReference, sampleSurfaces } from './reference.js';
import { GROUND_ALBEDO, LAMPS, MAP_SIZE, SPOT_ALBEDO, packLamps, spotModel } from './scene.js';
import { BOUNDARY_STRIDE, ExtinctionSolver, VEIL_STRIDE } from './solver.js';

// Sweep passes per frame while a new solution is being solved: under 20 ms of work at any map size.
const SWEEP_PASSES_PER_FRAME = Math.max(1, Math.round(96 * (1024 / MAP_SIZE) ** 2));
const MAX_ACCUMULATED_FRAMES = 256;

const LOOK = {
  exposure: 1.1,
  ambient: 0.004,
  fogDensity: 0.035,
  veilOpacity: 0.06,
  veilGain: 0.8,
  boundaryOpacity: 0.06,
  boundaryGain: 1,
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
  'veil.vert',
  'veil.frag',
  'boundary.vert',
  'boundary.frag',
  'fog.frag',
  'composite.frag',
  'present.frag',
];

// Per frame: surfaces and veils at full resolution, light in the air at half resolution (or instead
// the boundaries of the lit volumes), a composite that upsamples the fog and averages frames while
// the view is still, and tone mapping.
export class Renderer {
  constructor(gl, shaders, mesh) {
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This browser cannot render to float textures.');
    this.gl = gl;

    const plain = (name) => `#version 300 es\n${shaders[name]}`;
    const shared = (name) => `#version 300 es\n${shaders['common.glsl']}\n${shaders[name]}`;
    const exact = (name) => `#version 300 es\n${shaders['common.glsl']}\n${shaders['exact.glsl']}\n${shaders[name]}`;
    const program = (label, vertex, fragment) => createProgram(gl, label, vertex, fragment);
    this.programs = {
      occluder: program('occluder', plain('occluder.vert'), shared('occluder.frag')),
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
      veil: program('veil', shared('veil.vert'), shared('veil.frag')),
      boundary: program('boundary', shared('boundary.vert'), shared('boundary.frag')),
      fog: program('fog', plain('fullscreen.vert'), shared('fog.frag')),
      composite: program('composite', plain('fullscreen.vert'), shared('composite.frag')),
      present: program('present', plain('fullscreen.vert'), shared('present.frag')),
    };

    const lampBlock = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, lampBlock);
    gl.bufferData(gl.UNIFORM_BUFFER, packLamps(LAMPS), gl.STATIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, lampBlock);

    this.mesh = mesh;
    this.fullscreen = gl.createVertexArray();
    this.spot = { ...createMesh(gl, mesh), model: spotModel(mesh.bounds) };
    this.spotFacets = createFacets(gl, mesh);
    this.spotTriangles = worldTriangles(mesh, this.spot.model);
    const bvh = buildBvh(this.spotTriangles);
    this.bvh = { nodes: createDataTexture(gl, bvh.nodes), triangles: createDataTexture(gl, bvh.triangles) };
    this.ground = createMesh(gl, {
      positions: new Float32Array([-40, 0, -40, 40, 0, -40, 40, 0, 40, -40, 0, 40]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    });

    this.solver = new ExtinctionSolver(gl, {
      programs: this.programs,
      fullscreen: this.fullscreen,
      spot: this.spot,
      bvh: this.bvh,
      lamps: LAMPS,
    });
    this.solver.start(true);
    this.solver.step(Infinity);

    this.frame = 0;
    this.accumulated = 0;
    this.shown = { veil: true, bounds: false };
  }

  resize(width, height) {
    const { gl } = this;
    if (this.width === width && this.height === height) return false;
    this.width = width;
    this.height = height;
    for (const texture of this.targets?.textures ?? []) gl.deleteTexture(texture);
    for (const fbo of this.targets?.fbos ?? []) gl.deleteFramebuffer(fbo);
    if (this.targets) gl.deleteRenderbuffer(this.targets.depth);

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
      textures: [color, distance, fog, ...accumulation],
      fbos: [scene, veils, fogFbo, ...history],
    };
    return true;
  }

  render(camera, { spot, veil, bounds }, cameraMoved) {
    const { gl } = this;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    let changed = this.resize(width, height) || cameraMoved;

    if (spot !== this.solver.pendingSpot) this.solver.start(spot);
    changed = this.solver.step(SWEEP_PASSES_PER_FRAME) || changed;
    changed = veil !== this.shown.veil || bounds !== this.shown.bounds || changed;
    this.shown = { veil, bounds };
    if (changed) this.accumulated = 0;

    const n = this.accumulated;
    const jitter = n > 0 ? [(2 * halton(n, 2) - 1) / width, (2 * halton(n, 3) - 1) / height] : [0, 0];
    const view = camera.matrices(width / height, jitter);
    const blend = 1 / Math.min(n + 1, MAX_ACCUMULATED_FRAMES);

    this.drawSurfaces(view);
    if (veil) this.drawVeils(view);
    if (bounds) {
      this.drawBoundaries(view);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.fogFbo);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
    } else {
      this.drawFog(view);
    }
    this.present(this.composite(view, blend));

    this.accumulated++;
    this.frame++;
  }

  drawSurfaces(view) {
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

    gl.uniformMatrix4fv(uniforms.uModel, false, IDENTITY);
    gl.uniform3fv(uniforms.uAlbedo, GROUND_ALBEDO);
    gl.bindVertexArray(this.ground.vao);
    gl.drawElements(gl.TRIANGLES, this.ground.count, this.ground.type, 0);
    if (this.solver.withSpot) {
      gl.uniformMatrix4fv(uniforms.uModel, false, this.spot.model);
      gl.uniform3fv(uniforms.uAlbedo, SPOT_ALBEDO);
      gl.bindVertexArray(this.spotFacets.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.spotFacets.count);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  // Adds the veil sheets over the surfaces, hidden where a surface is in front of them.
  drawVeils(view) {
    const { gl, targets } = this;
    const veil = this.programs.veil;
    const { uniforms } = veil;
    const quads = MAP_SIZE / VEIL_STRIDE - 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.veils);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(veil.program);
    bindTextures(gl, veil, { uReach: this.solver.texture, uTags: this.solver.tags, uCells: this.solver.cells });
    gl.uniformMatrix4fv(uniforms.uViewProj, false, view.viewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform1i(uniforms.uStride, VEIL_STRIDE);
    gl.uniform1f(uniforms.uVeilOpacity, LOOK.veilOpacity);
    gl.uniform1f(uniforms.uVeilGain, LOOK.veilGain);
    gl.bindVertexArray(this.fullscreen);
    // One instance per lamp and each of the three lamps it can share a veil with.
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * quads * quads, 3 * LAMPS.length);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
  }

  // Adds sheets over the boundaries of the lit volumes, one mesh per lamp, hidden behind surfaces.
  drawBoundaries(view) {
    const { gl, targets } = this;
    const boundary = this.programs.boundary;
    const { uniforms } = boundary;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.veils);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(boundary.program);
    const { solver } = this;
    bindTextures(gl, boundary, {
      uEnds: solver.ends,
      uOffsets: solver.offsets,
      uDiagonals: solver.diagonals,
      uSlopes: solver.slopes,
    });
    gl.uniformMatrix4fv(uniforms.uViewProj, false, view.viewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform1i(uniforms.uStride, BOUNDARY_STRIDE);
    gl.uniform1f(uniforms.uOpacity, LOOK.boundaryOpacity);
    gl.uniform1f(uniforms.uGain, LOOK.boundaryGain);
    gl.bindVertexArray(this.fullscreen);
    // Six vertices for each cell between four neighbouring grid points, one instance per lamp.
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * (MAP_SIZE / BOUNDARY_STRIDE - 1) ** 2, LAMPS.length);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
  }

  drawFog(view) {
    const { gl, targets } = this;
    const fog = this.programs.fog;
    const { uniforms } = fog;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.fogFbo);
    gl.viewport(0, 0, ...targets.halfSize);
    gl.useProgram(fog.program);
    bindTextures(gl, fog, { uReach: this.solver.reachHalf, uSceneDistance: targets.distance });
    gl.uniformMatrix4fv(uniforms.uInvViewProj, false, view.invViewProj);
    gl.uniform3fv(uniforms.uCameraPos, view.eye);
    gl.uniform2f(uniforms.uResolution, this.width, this.height);
    gl.uniform1i(uniforms.uFrame, this.frame);
    gl.uniform1f(uniforms.uFogDensity, LOOK.fogDensity);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  composite(view, blend) {
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
    });
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

  // Checks the published solution against the README's recursive definition at random points.
  check(samples = 200) {
    const reference = createReference(LAMPS, this.solver.withSpot ? this.spotTriangles : null);
    const reachAt = (x, y) => this.solver.reachAt(x, y);
    return compareWithReference({ lamps: LAMPS, reference, reachAt, samples });
  }

  // Checks which lamp lights points of the ground and of Spot against the README's recursive
  // definition, as the renderer decides it and as the maps alone would. Of `candidates` random points,
  // up to `limit` near an edge of the light in the maps are checked, since elsewhere both are right.
  // The reference tests light every `step` along each ray; a coarse step can miss thin stretches of
  // light, so the check is only as good as the step is fine.
  checkSurfaces(candidates = 20000, limit = 300, step = 0.01) {
    const { mesh, spot } = this;
    const withSpot = this.solver.withSpot;
    const points = sampleSurfaces({ mesh, model: spot.model, withSpot, count: candidates });
    const lit = this.probe(points);
    const reference = createReference(LAMPS, withSpot ? this.spotTriangles : null, step);
    return compareSurfacesWithReference({ reference, points, lit, limit });
  }

  // For each surface point (see sampleSurfaces() in reference.js), the lamp that lights it by litBy() in
  // exact.glsl and by the maps alone, and whether the maps' rays around it disagree (see probe.frag).
  probe({ positions, facets, roughness, lifted, normals }) {
    const { gl } = this;
    const count = positions.length / 3;
    const width = Math.min(count, 1024);
    const height = Math.ceil(count / width);
    const texels = (data, w) => {
      const rgba = new Float32Array(4 * width * height);
      for (let k = 0; k < count; k++) rgba.set([...data.subarray(3 * k, 3 * k + 3), w?.[k] ?? 0], 4 * k);
      return createDataTexture(gl, rgba, width);
    };
    const inputs = {
      uPoints: texels(positions),
      uFacets: texels(facets, roughness),
      uLifted: texels(lifted),
      uNormals: texels(normals),
    };
    const output = createTexture(gl, width, height, gl.RGBA32F);
    const fbo = createFramebuffer(gl, [output]);

    const probe = this.programs.probe;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(probe.program);
    this.solver.bindExact(probe);
    bindTextures(gl, probe, inputs, 5);
    gl.bindVertexArray(this.fullscreen);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const result = new Float32Array(4 * width * height);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, result);

    gl.deleteFramebuffer(fbo);
    for (const texture of [output, ...Object.values(inputs)]) gl.deleteTexture(texture);
    return result.subarray(0, 4 * count);
  }
}

// Spot as separate triangles, each vertex also carrying its barycentric coordinates and its triangle's
// corners and normals, in the attribute locations of surface.vert.
function createFacets(gl, { positions, normals, indices }) {
  const count = indices.length;
  const barycentric = new Float32Array(3 * count);
  const own = [positions, normals].map(() => new Float32Array(3 * count));
  const triangle = [positions, normals].map(() => new Float32Array(9 * count));
  for (let t = 0; t < count; t += 3) {
    for (let k = 0; k < 3; k++) {
      barycentric[3 * (t + k) + k] = 1;
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
  const attributes = [[own[0], 1], [own[1], 1], [barycentric, 1], [triangle[0], 3], [triangle[1], 3]];
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
function worldTriangles({ positions, indices }, model) {
  const triangles = new Float32Array(indices.length * 3);
  indices.forEach((v, k) => triangles.set(transformPoint(model, positions.subarray(3 * v, 3 * v + 3)), 3 * k));
  return triangles;
}
