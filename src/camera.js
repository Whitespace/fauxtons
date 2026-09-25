import { invert, lookAt, multiply, perspective } from './mat4.js';

const ROTATE_SPEED = 0.006;
const ZOOM_SPEED = 0.0012;
const SMOOTHING = 22;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Orbits a fixed target: dragging turns the scene about the vertical axis and tilts it, the wheel dollies.
export class TurntableCamera {
  constructor(element, { target, azimuth, elevation, distance, fovy, minElevation, maxElevation, minDistance, maxDistance }) {
    this.target = target;
    this.fovy = fovy;
    this.limits = { minElevation, maxElevation, minDistance, maxDistance };
    this.goal = { azimuth, elevation, distance };
    this.current = { ...this.goal };
    this.jumped = false;

    let last = null;
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      element.setPointerCapture(event.pointerId);
      element.classList.add('dragging');
      last = [event.clientX, event.clientY];
    });
    element.addEventListener('pointermove', (event) => {
      if (!last) return;
      const [dx, dy] = [event.clientX - last[0], event.clientY - last[1]];
      last = [event.clientX, event.clientY];
      this.goal.azimuth -= dx * ROTATE_SPEED;
      this.goal.elevation = clamp(this.goal.elevation + dy * ROTATE_SPEED, minElevation, maxElevation);
    });
    const release = () => {
      last = null;
      element.classList.remove('dragging');
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.goal.distance = clamp(this.goal.distance * Math.exp(event.deltaY * ZOOM_SPEED), minDistance, maxDistance);
      },
      { passive: false },
    );
  }

  // Moves straight to a view, without easing. Target and field of view are optional.
  jumpTo({ azimuth, elevation, distance, target = this.target, fovy = this.fovy }) {
    const { minElevation, maxElevation, minDistance, maxDistance } = this.limits;
    this.goal.azimuth = azimuth;
    this.goal.elevation = clamp(elevation, minElevation, maxElevation);
    this.goal.distance = clamp(distance, minDistance, maxDistance);
    this.current = { ...this.goal };
    this.target = target;
    this.fovy = fovy;
    this.jumped = true;
  }

  // Eases toward the goal; returns whether the view changed.
  update(dt) {
    const k = 1 - Math.exp(-SMOOTHING * dt);
    let moved = this.jumped;
    this.jumped = false;
    for (const key of Object.keys(this.goal)) {
      const delta = this.goal[key] - this.current[key];
      if (delta === 0) continue;
      this.current[key] = Math.abs(delta) < 1e-5 ? this.goal[key] : this.current[key] + k * delta;
      moved = true;
    }
    return moved;
  }

  get eye() {
    const { azimuth, elevation, distance } = this.current;
    return [
      this.target[0] + distance * Math.cos(elevation) * Math.sin(azimuth),
      this.target[1] + distance * Math.sin(elevation),
      this.target[2] + distance * Math.cos(elevation) * Math.cos(azimuth),
    ];
  }

  // `jitter` is a sub-pixel offset in normalised device coordinates.
  matrices(aspect, jitter = [0, 0]) {
    const eye = this.eye;
    const proj = perspective(this.fovy, aspect, 0.05, 200);
    proj[8] -= jitter[0];
    proj[9] -= jitter[1];
    const viewProj = multiply(proj, lookAt(eye, this.target, [0, 1, 0]));
    return { eye, viewProj, invViewProj: invert(viewProj) };
  }
}
