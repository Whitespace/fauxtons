import { bindTextures, createDepthBuffer, createFramebuffer, createMesh, createProgram, createTexture } from './gl.js';
import { IDENTITY, transformPoint } from './mat4.js';
import { compareWithReference, createReference } from './reference.js';
import { GROUND_ALBEDO, LAMPS, MAP_SIZE, SPOT_ALBEDO, packLamps, spotModel } from './scene.js';
import { ExtinctionSolver, VEIL_STRIDE } from './solver.js';

const SWEEP_PASSES_PER_FRAME = 96;
const MAX_ACCUMULATED_FRAMES = 256;

const LOOK = {
  exposure: 1.1,
  ambient: 0.004,
  fogDensity: 0.035,
  veilOpacity: 0.06,
  veilGain: 0.8,
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
  'fullscreen.vert',
  'occluder.vert',
  'occluder.frag',
  'sweep.frag',
  'copy.frag',
  'cells.frag',
  'surface.vert',
  'surface.frag',
  'veil.vert',
  'veil.frag',
  'fog.frag',
  'composite.frag',
  'present.frag',
];

// Per frame: surfaces and veils at full resolution, light in the air at half resolution, a
// composite that upsamples the fog and averages frames while the view is still, and tone mapping.
export class Renderer {
  constructor(gl, shaders, mesh) {
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This browser cannot render to float textures.');
    this.gl = gl;

    const plain = (name) => `#version 300 es\n${shaders[name]}`;
    const shared = (name) => `#version 300 es\n${shaders['common.glsl']}\n${shaders[name]}`;
    const program = (label, vertex, fragment) => createProgram(gl, label, vertex, fragment);
    this.programs = {
      occluder: program('occluder', plain('occluder.vert'), shared('occluder.frag')),
      sweep: program('sweep', plain('fullscreen.vert'), shared('sweep.frag')),
      copy: program('copy', plain('fullscreen.vert'), shared('copy.frag')),
      cells: program('cells', plain('fullscreen.vert'), shared('cells.frag')),
      surface: program('surface', plain('surface.vert'), shared('surface.frag')),
      veil: program('veil', shared('veil.vert'), shared('veil.frag')),
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
    this.ground = createMesh(gl, {
      positions: new Float32Array([-40, 0, -40, 40, 0, -40, 40, 0, 40, -40, 0, 40]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
    });

    this.solver = new ExtinctionSolver(gl, {
      programs: this.programs,
      fullscreen: this.fullscreen,
      spot: this.spot,
      lamps: LAMPS,
    });
    this.solver.start(true);
    this.solver.step(Infinity);

    this.frame = 0;
    this.accumulated = 0;
    this.showVeil = true;
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

  render(camera, { spot, veil }, cameraMoved) {
    const { gl } = this;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    let changed = this.resize(width, height) || cameraMoved;

    if (spot !== this.solver.pendingSpot) this.solver.start(spot);
    changed = this.solver.step(SWEEP_PASSES_PER_FRAME) || changed;
    changed = veil !== this.showVeil || changed;
    this.showVeil = veil;
    if (changed) this.accumulated = 0;

    const n = this.accumulated;
    const jitter = n > 0 ? [(2 * halton(n, 2) - 1) / width, (2 * halton(n, 3) - 1) / height] : [0, 0];
    const view = camera.matrices(width / height, jitter);
    const blend = 1 / Math.min(n + 1, MAX_ACCUMULATED_FRAMES);

    this.drawSurfaces(view);
    if (this.showVeil) this.drawVeils(view);
    this.drawFog(view);
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
    bindTextures(gl, this.programs.surface, { uReach: this.solver.texture });

    const draw = (mesh, model, albedo) => {
      gl.uniformMatrix4fv(uniforms.uModel, false, model);
      gl.uniform3fv(uniforms.uAlbedo, albedo);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
    };
    draw(this.ground, IDENTITY, GROUND_ALBEDO);
    if (this.solver.withSpot) draw(this.spot, this.spot.model, SPOT_ALBEDO);
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
    let triangles = null;
    if (this.solver.withSpot) {
      const { positions, indices } = this.mesh;
      triangles = new Float32Array(indices.length * 3);
      indices.forEach((v, k) => {
        triangles.set(transformPoint(this.spot.model, positions.subarray(3 * v, 3 * v + 3)), 3 * k);
      });
    }
    const reference = createReference(LAMPS, triangles);
    return compareWithReference({ lamps: LAMPS, reference, atlas: this.solver.read(), samples });
  }
}
