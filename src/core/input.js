// Keyboard + gamepad input with frame-rate independent smoothing and edge-triggered actions.
import { clamp } from './rng.js';

const KEYMAP = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
};
const ACTIONS = {
  KeyC: 'camera', KeyL: 'headlights', KeyR: 'reset', Escape: 'pause', KeyV: 'cinematic',
  KeyH: 'horn', KeyQ: 'indLeft', KeyE: 'indRight', KeyZ: 'hazard', F3: 'debug', KeyM: 'mute', Digit1: 'accept', Digit2: 'decline', KeyG: 'garage', KeyF: 'service', KeyP: 'phone', Tab: 'phoneNext',
};

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pressed = [];
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this.steerSensitivity = 1;
    this.usingPad = false;
    this.mouse = { dx: 0, dy: 0, down: false };
    target.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3'].includes(e.code)) e.preventDefault();
      if (e.code === 'Tab' && !e.target.closest?.('dialog, .panel, input, select')) e.preventDefault(); // Tab cycles phone apps while driving
      if (!e.repeat && ACTIONS[e.code]) this.pressed.push(ACTIONS[e.code]);
      this.keys.add(e.code);
      this.usingPad = false;
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousedown', (e) => { if (e.button === 0 && e.target.tagName === 'CANVAS') this.mouse.down = true; });
    target.addEventListener('mouseup', () => (this.mouse.down = false));
    target.addEventListener('mousemove', (e) => { if (this.mouse.down) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; } });
    this.padPrev = {};
  }

  /** Returns and clears the queue of edge-triggered actions. */
  consume() { const p = this.pressed; this.pressed = []; return p; }
  consumeMouse() { const m = { dx: this.mouse.dx, dy: this.mouse.dy }; this.mouse.dx = this.mouse.dy = 0; return m; }

  any(list) { return list.some((k) => this.keys.has(k)); }

  update(dt, speedAbs = 0) {
    const s = this.state;
    let thrT = this.any(KEYMAP.throttle) ? 1 : 0;
    let brkT = this.any(KEYMAP.brake) ? 1 : 0;
    let steerT = (this.any(KEYMAP.right) ? 1 : 0) - (this.any(KEYMAP.left) ? 1 : 0);
    let hb = this.any(KEYMAP.handbrake);
    let analog = false;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] || 0;
      const dz = 0.12;
      const sx = Math.abs(ax) < dz ? 0 : Math.sign(ax) * ((Math.abs(ax) - dz) / (1 - dz)) ** 1.4;
      const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0;
      if (Math.abs(sx) > 0 || rt > 0.02 || lt > 0.02 || p.buttons[0]?.pressed) {
        this.usingPad = true;
      }
      if (this.usingPad) {
        thrT = rt; brkT = lt; steerT = sx; hb = !!p.buttons[0]?.pressed; analog = true;
      }
      const edge = (i, action) => {
        const now = !!p.buttons[i]?.pressed;
        if (now && !this.padPrev[i]) this.pressed.push(action);
        this.padPrev[i] = now;
      };
      edge(3, 'camera'); edge(2, 'headlights'); edge(8, 'reset'); edge(9, 'pause'); edge(5, 'cinematic'); edge(1, 'horn');
      const rx = p.axes[2] || 0, ry = p.axes[3] || 0;
      if (Math.abs(rx) > 0.2 || Math.abs(ry) > 0.2) { this.mouse.dx += rx * 18; this.mouse.dy += ry * 10; this.mouse.lastPad = performance.now(); }
      break;
    }

    if (analog) {
      s.throttle = thrT; s.brake = brkT; s.steer = clamp(steerT * this.steerSensitivity, -1, 1);
    } else {
      // pedals ramp quickly; steering ramps slower at speed and recentres faster
      s.throttle = approach(s.throttle, thrT, (thrT > s.throttle ? 5 : 8) * dt);
      s.brake = approach(s.brake, brkT, (brkT > s.brake ? 6 : 10) * dt);
      const steerRate = (steerT === 0 ? 4.5 : 2.6 - Math.min(1.2, speedAbs / 40)) * this.steerSensitivity;
      const opposite = steerT !== 0 && Math.sign(steerT) !== Math.sign(s.steer);
      s.steer = approach(s.steer, steerT, (opposite ? steerRate * 1.8 : steerRate) * dt);
    }
    s.handbrake = hb;
    return s;
  }
}

function approach(v, t, step) {
  return v < t ? Math.min(t, v + step) : Math.max(t, v - step);
}
