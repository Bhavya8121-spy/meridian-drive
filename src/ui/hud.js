// Driving HUD: tachometer, speed, gear, assists, condition, clock, district and rotating minimap.
import { SURF, RASTER, districtOf, DISTRICT_NAMES } from '../world/layout.js';
import { clamp } from '../core/rng.js';

const $ = (id) => document.getElementById(id);
const CX = 130, CY = 130, R = 112, A0 = (135 * Math.PI) / 180, SWEEP = (270 * Math.PI) / 180, MAXRPM = 8000;

function arc(a0, a1, r = R) {
  const p = (a) => [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export class HUD {
  constructor(layout) {
    this.el = $('hud');
    this.speed = $('speed'); this.gear = $('gear'); this.unit = $('unit');
    this.fill = $('tach-fill');
    this.shift = $('shift-light');
    $('tach-track').setAttribute('d', arc(A0, A0 + SWEEP));
    $('tach-red').setAttribute('d', arc(A0 + (7000 / MAXRPM) * SWEEP, A0 + SWEEP));
    const ticks = $('tach-ticks');
    let svg = '';
    for (let k = 0; k <= 8; k++) {
      const a = A0 + (k / 8) * SWEEP;
      const x0 = CX + Math.cos(a) * (R - 12), y0 = CY + Math.sin(a) * (R - 12);
      const x1 = CX + Math.cos(a) * (R - 20), y1 = CY + Math.sin(a) * (R - 20);
      const tx = CX + Math.cos(a) * (R - 33), ty = CY + Math.sin(a) * (R - 33);
      svg += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/><text x="${tx}" y="${ty}">${k}</text>`;
    }
    ticks.innerHTML = svg;
    this.chips = { mode: $('chip-mode'), cam: $('chip-cam'), tcs: $('chip-tcs'), abs: $('chip-abs'), lights: $('chip-lights') };
    this.district = $('hud-district'); this.clock = $('hud-clock'); this.weather = $('hud-weather');
    this.condFill = $('cond-fill'); this.condVal = $('cond-val');
    this.toastEl = $('toast'); this.toastTimer = 0;
    this.debug = $('debug');
    this.hint = $('hint');
    this.last = {};
    this.mini = $('minimap').querySelector('canvas');
    this.mctx = this.mini.getContext('2d');
    this.mapImg = this.renderMap(layout);
    this.hintTimer = 14;
  }

  renderMap(L) {
    const s = 2; // metres per pixel
    const w = Math.floor(RASTER.w / s), h = Math.floor(RASTER.h / s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const COL = {
      [SURF.GROUND]: [24, 32, 26], [SURF.ROAD]: [92, 98, 108], [SURF.SIDEWALK]: [40, 44, 50], [SURF.PARK]: [32, 58, 38],
      [SURF.BUILDING]: [18, 20, 24], [SURF.PARKING]: [60, 64, 72], [SURF.HIGHWAY]: [120, 126, 136], [SURF.YARD]: [44, 44, 46],
    };
    const d = L.raster.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = d[(y * s) * RASTER.w + x * s];
      const col = COL[v] || COL[0];
      const i = (y * w + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: c, scale: s };
  }

  show(v) { this.el.hidden = !v; }

  toast(text, secs = 1.6) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTimer = secs;
  }

  set(key, el, value, fn) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    fn ? fn(el, value) : (el.textContent = value);
  }

  update(dt, s) {
    const kmh = Math.abs(s.speed) * 3.6;
    this.el.classList.toggle('over-limit', !!s.speedLimit && kmh > s.speedLimit + 0.5);
    this.el.classList.toggle('no-limit', !s.speedLimit); // limits apply on city streets only
    this.el.classList.toggle('electric', s.electric);
    if (s.speedLimit) this.set('limit', $('speed-limit-value'), s.units === 'mph' ? Math.round(s.speedLimit * 0.621371) : s.speedLimit);
    this.set('wallet', $('hud-wallet'), (s.wallet < 0 ? '−$' : '$') + Math.abs(s.wallet).toFixed(2));
    this.set('fuelStatus', $('hud-reserve'), (s.electric ? 'Charge ' : 'Fuel ') + Math.round(s.fuelPct * 100) + '%');
    this.set('energyStatus', $('hud-energy'), 'Energy ' + Math.round(s.energy * 100) + '%');
    const shown = s.units === 'mph' ? kmh * 0.621371 : kmh;
    this.set('speed', this.speed, Math.round(shown));
    this.set('unit', this.unit, s.units === 'mph' ? 'MPH' : 'KM/H');
    const g = s.gear < 0 ? 'R' : s.gear === 0 ? 'N' : s.electric ? 'D' : String(s.gear);
    this.set('gear', this.gear, g);
    const rpmA = A0 + clamp(s.rpm / MAXRPM, 0.001, 1) * SWEEP;
    this.fill.setAttribute('d', arc(A0, rpmA));
    this.shift.classList.toggle('on', s.rpm > 7150 && s.gear > 0);
    this.set('mode', this.chips.mode, s.preset);
    this.set('cam', this.chips.cam, s.camLabel);
    this.set('tcs', this.chips.tcs, s.tcs, (el, v) => el.classList.toggle('on', v));
    this.set('abs', this.chips.abs, s.abs, (el, v) => el.classList.toggle('on', v));
    this.set('lights', this.chips.lights, s.headlights, (el, v) => el.classList.toggle('on', v));
    const h = Math.floor(s.time), m = Math.floor((s.time - h) * 60);
    this.set('clock', this.clock, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    this.set('weather', this.weather, s.weather);
    const dn = s.inTunnel ? 'Northgate Tunnel' : DISTRICT_NAMES[districtOf(s.pos.x, s.pos.z)];
    this.set('district', this.district, dn);
    const cond = Math.round((1 - s.damage) * 100);
    this.set('cond', this.condVal, cond + '%', (el, v) => {
      el.textContent = v;
      this.condFill.style.width = cond + '%';
      this.condFill.style.background = cond > 60 ? 'var(--ok)' : cond > 30 ? 'var(--warn)' : 'var(--accent)';
    });
    if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) this.toastEl.classList.remove('show'); }
    if (this.hintTimer > 0) { this.hintTimer -= dt; if (this.hintTimer <= 0) this.hint.style.opacity = '0'; }
    this.drawMinimap(s);
  }

  drawMinimap(s) {
    const ctx = this.mctx, W = this.mini.width;
    const { canvas, scale } = this.mapImg;
    const zoom = s.target ? 0.86 : 1.3 - clamp(Math.abs(s.speed) / 60, 0, 1) * 0.5;
    ctx.save();
    ctx.fillStyle = '#0d1014'; ctx.fillRect(0, 0, W, W);
    ctx.translate(W / 2, W / 2 + 30);
    ctx.rotate(Math.PI + s.heading); // heading-up
    ctx.scale(zoom, zoom);
    const mx = (s.pos.x - RASTER.x0) / scale, mz = (s.pos.z - RASTER.z0) / scale;
    ctx.drawImage(canvas, -mx, -mz);
    const point = (p) => [(p.x - s.pos.x) / scale, (p.z - s.pos.z) / scale];
    if (s.route?.length > 1) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (const stop of s.route) ctx.lineTo(...point(stop));
      ctx.lineJoin = 'round';
      ctx.lineWidth = 7;
      ctx.strokeStyle = '#101e2a';
      ctx.stroke();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#66d8ff';
      ctx.stroke();
    }
    for (const stop of s.stations ?? []) {
      const [x, y] = point(stop);
      ctx.fillStyle = '#75f2ac';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.fillStyle = '#7dcaff';
    for (const stop of s.chargers ?? []) {
      const [x, y] = point(stop);
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    if (s.target) {
      ctx.beginPath();
      ctx.arc(...point(s.target), 5, 0, Math.PI * 2);
      ctx.fillStyle = '#9ce7ff';
      ctx.fill();
    }
    // traffic
    ctx.fillStyle = '#e5e7eb';
    for (const c of s.traffic) if (c.active) ctx.fillRect((c.pos.x - RASTER.x0) / scale - mx - 1.2, (c.pos.z - RASTER.z0) / scale - mz - 1.2, 2.4, 2.4);
    ctx.restore();
    // player arrow
    ctx.save();
    ctx.translate(W / 2, W / 2 + 30);
    ctx.fillStyle = '#ff5a36';
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6.5, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6.5, 7); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  setDebug(text) {
    if (text == null) { this.debug.hidden = true; return; }
    this.debug.hidden = false;
    this.debug.textContent = text;
  }
}
