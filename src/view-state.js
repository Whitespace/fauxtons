// Scene state carried in the URL fragment, e.g.
// #az=25.00&el=16.00&d=13.000&t=0.000,1.600,0.000&fov=40.0&spot=1&veil=1&bounds=0&n=64
// Angles are in degrees, and n is the number of lamps. Anything missing keeps its current value.

const DEG = 180 / Math.PI;

export function encodeView(camera, options) {
  const { azimuth, elevation, distance } = camera.goal;
  const params = {
    az: ((((azimuth * DEG) % 360) + 360) % 360).toFixed(2),
    el: (elevation * DEG).toFixed(2),
    d: distance.toFixed(3),
    t: camera.target.map((x) => x.toFixed(3)).join(','),
    fov: (camera.fovy * DEG).toFixed(1),
    spot: options.spot ? '1' : '0',
    veil: options.veil ? '1' : '0',
    bounds: options.bounds ? '1' : '0',
    n: String(options.count),
  };
  // Every value is numeric, so nothing needs escaping; this keeps the commas readable.
  return `#${Object.entries(params).map(([key, value]) => `${key}=${value}`).join('&')}`;
}

export function decodeView(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const number = (key) => {
    const value = parseFloat(params.get(key));
    return Number.isFinite(value) ? value : undefined;
  };
  const flag = (key) => (params.has(key) ? params.get(key) !== '0' : undefined);
  const camera = {};
  if (number('az') !== undefined) camera.azimuth = number('az') / DEG;
  if (number('el') !== undefined) camera.elevation = number('el') / DEG;
  if (number('d') !== undefined) camera.distance = number('d');
  if (number('fov') !== undefined) camera.fovy = number('fov') / DEG;
  const target = (params.get('t') ?? '').split(',').map(parseFloat);
  if (target.length === 3 && target.every(Number.isFinite)) camera.target = target;
  return { camera, options: { spot: flag('spot'), veil: flag('veil'), bounds: flag('bounds'), count: number('n') } };
}
