// Thin WebGL2 helpers.

export function createProgram(gl, label, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`${label}: ${annotate(gl.getShaderInfoLog(shader), source)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`${label}: ${gl.getProgramInfoLog(program)}`);
  }

  const block = gl.getUniformBlockIndex(program, 'Lamps');
  if (block !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, block, 0);

  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let k = 0; k < count; k++) {
    const { name } = gl.getActiveUniform(program, k);
    const location = gl.getUniformLocation(program, name);
    if (location) uniforms[name.replace(/\[0\]$/, '')] = location;
  }
  return { program, uniforms };
}

// Appends the offending source lines to a compiler log of the form "ERROR: 0:<line>: ...".
function annotate(log, source) {
  const lines = source.split('\n');
  return log.replace(/ERROR: \d+:(\d+):(.*)/g, (match, line) => `${match}\n    > ${lines[line - 1]?.trim()}`);
}

export function createTexture(gl, width, height, internalFormat, filter = gl.NEAREST, levels = 1) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, levels, internalFormat, width, height);
  // texelFetch() reads levels past the first only from a texture whose filter uses mipmaps.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.NEAREST_MIPMAP_NEAREST : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

// A float array as an RGBA32F texture, four floats per texel, row by row.
export function createDataTexture(gl, data, width = 1024) {
  const height = Math.ceil(data.length / (4 * width));
  const padded = new Float32Array(4 * width * height);
  padded.set(data);
  const texture = createTexture(gl, width, height, gl.RGBA32F);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, padded);
  return texture;
}

export function createDepthBuffer(gl, width, height) {
  const renderbuffer = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
  return renderbuffer;
}

export function createFramebuffer(gl, colors, depth = null, level = 0) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  colors.forEach((texture, k) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, texture, level);
  });
  if (depth) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.drawBuffers(colors.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Incomplete framebuffer (0x${status.toString(16)})`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return framebuffer;
}

export function createMesh(gl, { positions, normals, indices }) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  [positions, normals].forEach((data, location) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
  });
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: indices.length, type: indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
}

export function bindTextures(gl, program, textures, firstUnit = 0) {
  Object.entries(textures).forEach(([name, texture], k) => {
    const unit = firstUnit + k;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (program.uniforms[name]) gl.uniform1i(program.uniforms[name], unit);
  });
}
