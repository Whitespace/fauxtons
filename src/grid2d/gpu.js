// Fill and kill (sim.js) on the GPU, headless, for timing against the CPU (bench.js). The creatures are bits
// in a texture, one per lamp and kind for each cell, and a generation moves them all by passes over the
// whole grid. A fragment can't write to its neighbours, so a lamp's turn is two passes: its creatures act on
// their cells, and then every cell gathers the creatures that its neighbours' acts hatch onto it. Whether
// any kill creature is alive, which decides whether a generation moves kill or fill creatures, is found on
// the GPU and read there by the next generation, so the CPU reads the GPU only every CHECK_EVERY
// generations, to see whether all creatures have died.
//
// Within a lamp's turn every cell acts on the grid as the turn found it, where the CPU's creatures act on
// the grid as the creatures before them left it, so the two can differ in a few cells.

import { SIZE } from './sim.js';

const CHECK_EVERY = 16;
const MAX_LAMPS = 32;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(2.0 * p - 1.0, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
precision highp usampler2D;
#define SIZE ${SIZE}
uniform highp sampler2D uFields;  // lamp i's field at cell (x, y) is texel (x, y + SIZE i): 0 outside its cone
uniform ivec2 uLampCell[${MAX_LAMPS}];
uniform int uLampCount;

float fieldOf(int i, ivec2 c) {
  return texelFetch(uFields, ivec2(c.x, c.y + SIZE * i), 0).r;
}

bool isLampCell(ivec2 c) {
  for (int k = 0; k < ${MAX_LAMPS}; ++k) {
    if (k >= uLampCount) break;
    if (uLampCell[k] == c) return true;
  }
  return false;
}

bool inGrid(ivec2 c) {
  return all(greaterThanEqual(c, ivec2(0))) && all(lessThan(c, ivec2(SIZE)));
}

// Whether cell b lies further from lamp j than its neighbour a (behind() in sim.js).
bool behind(int j, ivec2 a, ivec2 b) {
  return length(vec2(b - uLampCell[j])) > length(vec2(a - uLampCell[j]));
}
`;

// Whether lamp i can see cell c through uSight, as inSight() in sim.js.
const SIGHT = `
uniform isampler2D uSight;

bool blocks(int i, ivec2 c) {
  int j = texelFetch(uSight, c, 0).r;
  return j >= 0 && j != i && fieldOf(j, c) >= fieldOf(i, c);
}

bool inSight(int i, ivec2 target) {
  ivec2 cell = uLampCell[i];
  int nx = abs(target.x - cell.x);
  int ny = abs(target.y - cell.y);
  int sx = sign(target.x - cell.x);
  int sy = sign(target.y - cell.y);
  int ix = 0;
  int iy = 0;
  for (int k = 0; k < 2 * SIZE + 2; ++k) {
    if (ix >= nx && iy >= ny) break;
    int decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision == 0) {
      if (blocks(i, cell + ivec2(sx, 0)) || blocks(i, cell + ivec2(0, sy))) return false;
      cell += ivec2(sx, sy);
      ix++;
      iy++;
    } else if (decision < 0) {
      cell.x += sx;
      ix++;
    } else {
      cell.y += sy;
      iy++;
    }
    if (cell != target && blocks(i, cell)) return false;
  }
  return true;
}
`;

// Lamp uLamp's creatures act on their cells: a kill creature puts out its lamp's light if the lamp can no
// longer see its cell, and a fill creature spreads the light into its cell, as in life() in sim.js.
const ACT = `${COMMON}${SIGHT}
uniform isampler2D uOwner;       // the grid as the turn found it
uniform usampler2D uCreatures;   // this generation's creatures: r fill bits, g kill bits
uniform usampler2D uAlive;       // 1 × 1: whether any fill (r) or kill (g) creature was alive as it began
uniform int uLamp;
layout(location = 0) out int outOwner;
layout(location = 1) out int outEvent;  // i + 1 where lamp i lit the cell, -(i + 1) where its kill put it out

bool near(int i, ivec2 c) {
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      ivec2 n = c + ivec2(dx, dy);
      if ((dx != 0 || dy != 0) && inGrid(n) && texelFetch(uOwner, n, 0).r == i) return true;
    }
  }
  return false;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = uLamp;
  int had = texelFetch(uOwner, c, 0).r;
  outOwner = had;
  outEvent = 0;
  bool killing = texelFetch(uAlive, ivec2(0), 0).g != 0u;
  uvec2 creatures = texelFetch(uCreatures, c, 0).rg;
  uint bit = 1u << uint(i);
  if (killing) {
    if ((creatures.g & bit) == 0u || had != i || inSight(i, c)) return;
    outOwner = -1;
    outEvent = -(i + 1);
    return;
  }
  if ((creatures.r & bit) == 0u || had == i || isLampCell(c)) return;
  if (fieldOf(i, c) <= (had >= 0 ? fieldOf(had, c) : 0.0)) return;
  if (!near(i, c) || !inSight(i, c)) return;
  outOwner = i;
  outEvent = i + 1;
}`;

// Every cell gathers the creatures that lamp uLamp's acts hatch onto it, as life() in sim.js hatches them.
const HATCH = `${COMMON}
uniform isampler2D uOwner;   // after the lamp's acts
uniform isampler2D uEvent;   // what the lamp's acts did to each cell
uniform usampler2D uNext;    // the next generation's creatures so far
uniform int uLamp;
out uvec2 outNext;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = uLamp;
  uvec2 next = texelFetch(uNext, c, 0).rg;
  int own = texelFetch(uOwner, c, 0).r;
  bool putOut = texelFetch(uEvent, c, 0).r == -(i + 1);
  bool lampCell = isLampCell(c);
  for (int dy = -1; dy <= 1; ++dy) {
    for (int dx = -1; dx <= 1; ++dx) {
      ivec2 n = c + ivec2(dx, dy);
      if ((dx == 0 && dy == 0) || !inGrid(n)) continue;
      int event = texelFetch(uEvent, n, 0).r;
      if (event == i + 1 && own != i) {
        // A neighbour lit by lamp i: its fill spreads here, and cuts off the lamp lighting this cell if that
        // lamp is no stronger there and this cell lies behind it.
        if (fieldOf(i, c) > (own >= 0 ? fieldOf(own, c) : 0.0)) next.r |= 1u << uint(i);
        if (own >= 0 && !lampCell && fieldOf(own, n) <= fieldOf(i, n) && behind(own, n, c)) next.g |= 1u << uint(own);
      } else if (event == -(i + 1) && own == i) {
        // A neighbour put out by lamp i's kill: the kill spreads to this cell of the lamp's.
        next.g |= 1u << uint(i);
      }
      if (putOut) {
        // This cell was put out: fill creatures for the lamps lighting its neighbours, to light it again.
        int j = texelFetch(uOwner, n, 0).r;
        if (j >= 0 && j != i) next.r |= 1u << uint(j);
      }
    }
  }
  outNext = next;
}`;

// The start of the next generation: the creatures that don't move this one. In a generation of kill
// creatures the fill creatures wait; in one of fill creatures, none are left over.
const CARRY = `${COMMON}
uniform usampler2D uCreatures;
uniform usampler2D uAlive;
out uvec2 outNext;
void main() {
  bool killing = texelFetch(uAlive, ivec2(0), 0).g != 0u;
  outNext = killing ? uvec2(texelFetch(uCreatures, ivec2(gl_FragCoord.xy), 0).r, 0u) : uvec2(0u);
}`;

// Whether any creature of each kind is on a block of uBlock × uBlock texels.
const REDUCE = `${COMMON}
uniform usampler2D uSource;
uniform int uBlock;
out uvec2 outAny;
void main() {
  ivec2 origin = ivec2(gl_FragCoord.xy) * uBlock;
  uvec2 any = uvec2(0u);
  for (int y = 0; y < uBlock; ++y) {
    for (int x = 0; x < uBlock; ++x) any |= texelFetch(uSource, origin + ivec2(x, y), 0).rg;
  }
  outAny = uvec2(any.x != 0u ? 1u : 0u, any.y != 0u ? 1u : 0u);
}`;

export class GpuLife {
  // For the lamps of `grid` (sim.js): their fields, cells and order of turns.
  constructor(grid) {
    if (grid.lamps.length > MAX_LAMPS) throw new Error(`At most ${MAX_LAMPS} lamps fit in the creatures' bits.`);
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    this.grid = grid;
    this.programs = { act: this.program(ACT), hatch: this.program(HATCH), carry: this.program(CARRY), reduce: this.program(REDUCE) };

    const texture = (width, height, format, data = null) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      if (data) this.upload(t, width, height, format, data);
      return t;
    };
    const fields = new Float32Array(SIZE * SIZE * grid.lamps.length);
    grid.fields.forEach((field, i) => fields.set(field, i * SIZE * SIZE));
    this.fields = texture(SIZE, SIZE * grid.lamps.length, gl.R32F, fields);
    this.owners = [0, 1].map(() => texture(SIZE, SIZE, gl.R32I));
    this.event = texture(SIZE, SIZE, gl.R32I);
    this.sight = texture(SIZE, SIZE, gl.R32I);
    this.creatures = [0, 1, 2].map(() => texture(SIZE, SIZE, gl.RG32UI));
    this.any = texture(SIZE / 16, SIZE / 16, gl.RG32UI);
    this.alive = texture(1, 1, gl.RG32UI);

    const framebuffer = (...colors) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      colors.forEach((t, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(colors.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer');
      return f;
    };
    this.actFbos = this.owners.map((owner) => framebuffer(owner, this.event));
    this.creatureFbos = this.creatures.map((t) => framebuffer(t));
    this.anyFbo = framebuffer(this.any);
    this.aliveFbo = framebuffer(this.alive);
    this.ownerFbos = this.owners.map((t) => framebuffer(t));

    const cells = new Int32Array(2 * MAX_LAMPS);
    grid.lamps.forEach(({ x, y }, i) => cells.set([x, y], 2 * i));
    for (const { program, uniforms } of Object.values(this.programs)) {
      gl.useProgram(program);
      if (uniforms.uLampCell) gl.uniform2iv(uniforms.uLampCell, cells);
      if (uniforms.uLampCount) gl.uniform1i(uniforms.uLampCount, grid.lamps.length);
    }
    gl.bindVertexArray(gl.createVertexArray());
  }

  program(fragment) {
    const { gl } = this;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = {};
    for (let k = 0; k < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); k++) {
      const { name } = gl.getActiveUniform(program, k);
      uniforms[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  upload(texture, width, height, format, data) {
    const { gl } = this;
    const [layout, type] = {
      [gl.R32F]: [gl.RED, gl.FLOAT],
      [gl.R32I]: [gl.RED_INTEGER, gl.INT],
      [gl.RG32UI]: [gl.RG_INTEGER, gl.UNSIGNED_INT],
    }[format];
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, layout, type, data);
  }

  bind(program, textures) {
    const { gl } = this;
    Object.entries(textures).forEach(([name, texture], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (program.uniforms[name]) gl.uniform1i(program.uniforms[name], unit);
    });
  }

  draw(fbo, width, height) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // No light but the lamps' own cells, fill creatures around every lamp, and with `sightFrom` (an Int32Array
  // of the last pass's owners), the line of sight judged against that grid. As hatch() in sim.js.
  reset(sightFrom = null) {
    const { gl, grid } = this;
    const owner = Int32Array.from(grid.lampAt);
    const creatures = new Uint32Array(2 * SIZE * SIZE);
    grid.lamps.forEach(({ x, y }, i) => {
      for (let ny = Math.max(0, y - 1); ny <= Math.min(SIZE - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(SIZE - 1, x + 1); nx++) {
          if (nx !== x || ny !== y) creatures[2 * (ny * SIZE + nx)] |= 1 << i;
        }
      }
    });
    this.owner = 0;
    this.current = 0;
    this.upload(this.owners[0], SIZE, SIZE, gl.R32I, owner);
    this.upload(this.creatures[0], SIZE, SIZE, gl.RG32UI, creatures);
    this.upload(this.alive, 1, 1, gl.RG32UI, new Uint32Array([1, 0]));
    this.sightFrom = sightFrom;
    if (sightFrom) this.upload(this.sight, SIZE, SIZE, gl.R32I, sightFrom);
    this.generation = 0;
  }

  // One generation: the creatures that wait carried over, then each lamp in turn acting and hatching, then
  // whether any creature of each kind is still alive.
  generationStep() {
    const { gl, programs } = this;
    const others = [0, 1, 2].filter((k) => k !== this.current);
    let [next, spare] = others;

    gl.useProgram(programs.carry.program);
    this.bind(programs.carry, { uCreatures: this.creatures[this.current], uAlive: this.alive, uFields: this.fields });
    this.draw(this.creatureFbos[next], SIZE, SIZE);

    for (const i of this.grid.order) {
      const from = this.owner;
      const to = 1 - from;
      gl.useProgram(programs.act.program);
      this.bind(programs.act, {
        uOwner: this.owners[from],
        uSight: this.sightFrom ? this.sight : this.owners[from],
        uCreatures: this.creatures[this.current],
        uAlive: this.alive,
        uFields: this.fields,
      });
      gl.uniform1i(programs.act.uniforms.uLamp, i);
      this.draw(this.actFbos[to], SIZE, SIZE);
      this.owner = to;

      gl.useProgram(programs.hatch.program);
      this.bind(programs.hatch, { uOwner: this.owners[to], uEvent: this.event, uNext: this.creatures[next], uFields: this.fields });
      gl.uniform1i(programs.hatch.uniforms.uLamp, i);
      this.draw(this.creatureFbos[spare], SIZE, SIZE);
      [next, spare] = [spare, next];
    }
    this.current = next;

    gl.useProgram(programs.reduce.program);
    this.bind(programs.reduce, { uSource: this.creatures[this.current], uFields: this.fields });
    gl.uniform1i(programs.reduce.uniforms.uBlock, 16);
    this.draw(this.anyFbo, SIZE / 16, SIZE / 16);
    this.bind(programs.reduce, { uSource: this.any, uFields: this.fields });
    gl.uniform1i(programs.reduce.uniforms.uBlock, SIZE / 16);
    this.draw(this.aliveFbo, 1, 1);
    this.generation++;
  }

  // Whether any creature is still alive, read back from the GPU.
  anyAlive() {
    const { gl } = this;
    const pixel = new Uint32Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.aliveFbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, pixel);
    return pixel[0] !== 0 || pixel[1] !== 0;
  }

  // A pass from no light until every creature has died, checked every CHECK_EVERY generations. Returns the
  // generations run.
  run(sightFrom = null, limit = 20000) {
    this.reset(sightFrom);
    while (this.generation < limit) {
      for (let k = 0; k < CHECK_EVERY; k++) this.generationStep();
      if (!this.anyAlive()) break;
    }
    return this.generation;
  }

  // The owners of the cells, read back.
  readOwners() {
    const { gl } = this;
    const pixels = new Int32Array(4 * SIZE * SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ownerFbos[this.owner]);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA_INTEGER, gl.INT, pixels);
    return Int32Array.from({ length: SIZE * SIZE }, (_, c) => pixels[4 * c]);
  }
}
