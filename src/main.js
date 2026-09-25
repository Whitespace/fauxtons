import { TurntableCamera } from './camera.js';
import { parseObj } from './obj.js';
import { Renderer, SHADER_FILES } from './renderer.js';
import { decodeView, encodeView } from './view-state.js';

const deg = Math.PI / 180;

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}`);
  return response.text();
}

async function main() {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available.');

  const [obj, ...sources] = await Promise.all([
    fetchText('spot_triangulated.obj'),
    ...SHADER_FILES.map((name) => fetchText(`src/shaders/${name}`)),
  ]);
  const shaders = Object.fromEntries(SHADER_FILES.map((name, k) => [name, sources[k]]));
  const renderer = new Renderer(gl, shaders, parseObj(obj));

  const camera = new TurntableCamera(canvas, {
    target: [0, 1.6, 0],
    azimuth: 202 * deg,
    elevation: 15 * deg,
    distance: 14,
    fovy: 40 * deg,
    minElevation: -3 * deg,
    maxElevation: 85 * deg,
    minDistance: 3,
    maxDistance: 40,
  });

  const options = { spot: true, veil: true };
  const toggles = new Map([...document.querySelectorAll('[data-toggle]')].map((button) => [button.dataset.toggle, button]));
  const setOption = (key, value) => {
    options[key] = value;
    toggles.get(key).setAttribute('aria-pressed', String(value));
  };
  for (const [key, button] of toggles) button.addEventListener('click', () => setOption(key, !options[key]));

  const applyView = (hash) => {
    const view = decodeView(hash);
    camera.jumpTo({ ...camera.goal, ...view.camera });
    for (const [key, value] of Object.entries(view.options)) if (value !== undefined) setOption(key, value);
  };
  applyView(location.hash);
  window.addEventListener('hashchange', () => applyView(location.hash));

  const copyLink = document.querySelector('[data-action="copy-link"]');
  copyLink.addEventListener('click', async () => {
    const url = new URL(location.href);
    url.hash = encodeView(camera, options);
    history.replaceState(null, '', url);
    let label = 'Copied';
    try {
      await navigator.clipboard.writeText(url.href);
    } catch {
      label = 'Copy failed';
    }
    copyLink.textContent = label;
    clearTimeout(copyLink.reset);
    copyLink.reset = setTimeout(() => (copyLink.textContent = 'Copy link'), 1200);
  });

  const fps = document.querySelector('.fps');
  let frames = 0;
  let windowStart = performance.now();
  let last = windowStart;

  function frame(now) {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const moved = camera.update(Math.min((now - last) / 1000, 0.1));
    last = now;
    renderer.render(camera, options, moved);

    frames++;
    if (now - windowStart >= 500) {
      fps.textContent = `${Math.round((frames * 1000) / (now - windowStart))} fps`;
      frames = 0;
      windowStart = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Console hook: fauxton.check() compares the solution with the README's recursive definition.
  window.fauxton = { check: (samples) => renderer.check(samples) };
}

main().catch((error) => {
  console.error(error);
  document.body.dataset.error = error.message;
});
