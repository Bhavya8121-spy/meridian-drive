// Fully synthesised, layered audio (Web Audio API): engine, tyres, wind, impacts, ambience,
// rain/thunder, horn and spatialised traffic. No external sound files.
import { clamp, lerp } from '../core/rng.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.vol = { master: 0.8, engine: 0.9, sfx: 0.8, ambience: 0.6 };
    this.interior = 0;
  }

  /** Must be called from a user gesture. */
  async start() {
    if (this.ready) { await this.ctx.resume(); return; }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain(); this.master.connect(comp);
    // interior muffling filter for cockpit view (outside sounds)
    this.outside = ctx.createBiquadFilter(); this.outside.type = 'lowpass'; this.outside.frequency.value = 20000;
    this.outside.connect(this.master);
    this.busEngine = ctx.createGain(); this.busEngine.connect(this.master);
    this.busSfx = ctx.createGain(); this.busSfx.connect(this.outside);
    this.busAmb = ctx.createGain(); this.busAmb.connect(this.outside);

    // shared noise buffers
    const len = ctx.sampleRate * 2;
    const white = ctx.createBuffer(1, len, ctx.sampleRate), brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { w[i] = Math.random() * 2 - 1; last = (last + 0.02 * w[i]) / 1.02; b[i] = last * 3.5; }
    this.white = white; this.brown = brown;

    this.buildEngine();
    this.tyre = this.noiseVoice('bandpass', 1100, 7, this.busSfx);
    this.scrub = this.noiseVoice('lowpass', 380, 0.8, this.busSfx);
    this.metal = this.noiseVoice('bandpass', 2600, 3.5, this.busSfx);
    this.wind = this.noiseVoice('bandpass', 700, 0.5, this.busSfx);
    this.rain = this.noiseVoice('highpass', 1800, 0.4, this.busAmb);
    this.rainLow = this.noiseVoice('lowpass', 500, 0.5, this.busAmb, true);
    this.city = this.noiseVoice('lowpass', 260, 0.6, this.busAmb, true);
    this.tunnelHum = this.noiseVoice('bandpass', 140, 1.5, this.busAmb, true);
    // traffic voices (spatial)
    this.traffic = [];
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 50;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
      const g = ctx.createGain(); g.gain.value = 0;
      const pan = ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 6; pan.rolloffFactor = 1.3; pan.maxDistance = 200;
      osc.connect(lp); lp.connect(g); g.connect(pan); pan.connect(this.busAmb);
      osc.start();
      this.traffic.push({ osc, g, pan, lp });
    }
    this.ready = true;
    this.applyVolumes();
    this.nextHorn = 6;
  }

  noiseVoice(type, freq, q, bus, useBrown = false) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = useBrown ? this.brown : this.white; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(0, Math.random() * 1.5);
    return { src, f, g };
  }

  buildEngine() {
    const ctx = this.ctx;
    const mix = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    this.engLP = ctx.createBiquadFilter(); this.engLP.type = 'lowpass'; this.engLP.Q.value = 0.2;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    mix.connect(shaper); shaper.connect(this.engLP); this.engLP.connect(this.engGain); this.engGain.connect(this.busEngine);
    const mk = (type, gain) => { const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = gain; o.connect(g); g.connect(mix); o.start(); return { o, g }; };
    // One repeating crank cycle keeps the firing orders phase-locked across revs.
    const sine = new Float32Array([0, 0.12, 0.21, 0.12, 0.48, 0.09, 0.13, 0.05, 0.23, 0.045, 0.07, 0.035, 0.09]);
    const cosine = new Float32Array(sine.length);
    cosine[3] = -0.08;
    cosine[5] = 0.12;
    cosine[7] = -0.07;
    this.engine = mk('sine', 0.7).o;
    this.engine.setPeriodicWave(ctx.createPeriodicWave(cosine, sine));
    this.engine.frequency.value = 850 / 60;
    // intake / mechanical noise
    this.intake = this.noiseVoice('bandpass', 1500, 1.2, this.busEngine);
  }

  applyVolumes() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master * 0.43, t, 0.05);
    this.busEngine.gain.setTargetAtTime(this.vol.engine * 0.64, t, 0.05);
    this.busSfx.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
    this.busAmb.gain.setTargetAtTime(this.vol.ambience, t, 0.05);
  }

  setVolumes(v) { Object.assign(this.vol, v); this.applyVolumes(); }
  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }

  shift() {
    if (!this.ready) return;
    this.thump(55, 0.09, 0.05, this.busEngine);
  }

  thump(freq, dur, gain, bus = this.busSfx) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(freq * 1.8, t); o.frequency.exponentialRampToValueAtTime(freq, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.05);
  }

  burst(filterType, freq, q, dur, gain, bus = this.busSfx, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const src = ctx.createBufferSource(); src.buffer = this.white;
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur * 0.1)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(t, Math.random()); src.stop(t + dur + 0.1);
  }

  impact(strength) {
    if (!this.ready) return;
    const s = clamp(strength, 0, 1);
    this.thump(45 + Math.random() * 20, 0.25 + s * 0.3, 0.4 + s * 0.6);
    this.burst('bandpass', 900 + Math.random() * 800, 0.8, 0.15 + s * 0.4, 0.2 + s * 0.6);
    if (s > 0.5) this.burst('highpass', 4000, 0.5, 0.6, 0.25 * s); // glass/debris
  }

  thunder(delay) {
    if (!this.ready) return;
    this.burst('lowpass', 120, 0.7, 5.5, 0.9, this.busAmb, delay);
    this.burst('lowpass', 420, 0.7, 1.4, 0.35, this.busAmb, delay);
  }

  horn(pos, listener, own = false) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(own ? 0.18 : 0.12, t + 0.02);
    const dur = own ? 0.45 : 0.35 + Math.random() * 0.4;
    g.gain.setValueAtTime(own ? 0.18 : 0.12, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    let out = g;
    if (!own && pos) {
      const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.refDistance = 8; p.rolloffFactor = 1.2;
      p.positionX.value = pos.x; p.positionY.value = pos.y + 1; p.positionZ.value = pos.z;
      g.connect(p); out = p;
    }
    out.connect(own ? this.busSfx : this.busAmb);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.connect(g);
    for (const f of own ? [415, 520] : [380 + Math.random() * 120, 480 + Math.random() * 120]) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(lp); o.start(t); o.stop(t + dur + 0.1);
    }
  }

  tick() {
    if (!this.ready) return;
    this.burst('highpass', 3000, 1, 0.03, 0.08, this.busEngine);
  }

  /** Per-frame update. s: telemetry + environment state. */
  update(dt, s) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, T = 0.04;
    // listener
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(s.cam.position.x, t, T); L.positionY.setTargetAtTime(s.cam.position.y, t, T); L.positionZ.setTargetAtTime(s.cam.position.z, t, T);
      L.forwardX.setTargetAtTime(s.camDir.x, t, T); L.forwardY.setTargetAtTime(s.camDir.y, t, T); L.forwardZ.setTargetAtTime(s.camDir.z, t, T);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    }
    const rpm = clamp(s.rpm, 650, 8000);
    const load = clamp(0.35 * s.throttle + 0.65 * s.engineLoad, 0, 1);
    const engineOn = s.engineOn ? 1 : 0;
    this.engine.frequency.setTargetAtTime(s.electric ? 17 + Math.abs(s.speed) * 2.2 : rpm / 60, t, 0.035);
    this.engLP.frequency.setTargetAtTime(360 + load * 950 + rpm * 0.11 - this.interior * 150, t, 0.08);
    this.engGain.gain.setTargetAtTime((s.electric ? 0.018 + 0.024 * load : 0.09 + 0.14 * load + 0.05 * rpm / 8000) * engineOn * (s.shifting ? 0.55 : 1), t, 0.045);
    this.intake.f.frequency.setTargetAtTime(500 + rpm * 0.115, t, 0.08);
    this.intake.g.gain.setTargetAtTime((s.electric ? 0 : 0.01 + load * 0.09) * (rpm / 8000) * engineOn, t, 0.08);
    // tyres
    const slide = clamp((s.slide - 2) / 8, 0, 1);
    const onAsphalt = s.surface !== 0 && s.surface !== 3 && s.surface !== 7;
    this.tyre.g.gain.setTargetAtTime(onAsphalt ? slide * 0.35 : 0, t, 0.05);
    this.tyre.f.frequency.setTargetAtTime(900 + slide * 500 + Math.sin(t * 13) * 60, t, 0.03);
    const offroad = !onAsphalt && s.speed > 1;
    this.scrub.g.gain.setTargetAtTime(offroad ? clamp(s.speed / 25, 0, 1) * 0.28 + slide * 0.3 : 0, t, 0.08);
    // metal scraping along walls / other cars
    const sc = clamp(s.scrape || 0, 0, 1);
    this.metal.g.gain.setTargetAtTime(sc * 0.4 * (0.7 + 0.3 * Math.sin(t * 37)), t, 0.03);
    this.metal.f.frequency.setTargetAtTime(1800 + sc * 1600 + Math.sin(t * 23) * 300, t, 0.03);
    // wind
    const v = Math.abs(s.speed);
    this.wind.g.gain.setTargetAtTime(clamp((v / 60) ** 2, 0, 1) * 0.3 * (1 - this.interior * 0.6), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(400 + v * 18, t, 0.1);
    // ambience
    const tunnel = s.inTunnel ? 1 : 0;
    this.city.g.gain.setTargetAtTime(0.18 * s.cityAmt * (1 - tunnel * 0.5), t, 0.5);
    this.tunnelHum.g.gain.setTargetAtTime(tunnel * 0.18 * clamp(v / 30, 0.2, 1), t, 0.3);
    this.rain.g.gain.setTargetAtTime(s.rain * 0.18 * (1 - tunnel), t, 0.4);
    this.rainLow.g.gain.setTargetAtTime(s.rain * (0.12 + this.interior * 0.25) * (1 - tunnel), t, 0.4);
    // distant horns in the city
    this.nextHorn -= dt;
    if (this.nextHorn <= 0) {
      this.nextHorn = 8 + Math.random() * 20;
      if (s.cityAmt > 0.4) this.horn({ x: s.cam.position.x + (Math.random() - 0.5) * 300, y: 0, z: s.cam.position.z + (Math.random() - 0.5) * 300 }, null, false);
    }
    // traffic voices
    for (let i = 0; i < this.traffic.length; i++) {
      const vo = this.traffic[i], car = s.traffic[i];
      if (!car) { vo.g.gain.setTargetAtTime(0, t, 0.2); continue; }
      vo.pan.positionX.setTargetAtTime(car.pos.x, t, T); vo.pan.positionY.setTargetAtTime(car.pos.y + 0.5, t, T); vo.pan.positionZ.setTargetAtTime(car.pos.z, t, T);
      vo.osc.frequency.setTargetAtTime(38 + car.v * 4.5, t, 0.1);
      vo.g.gain.setTargetAtTime(0.05 + clamp(car.v / 20, 0, 1) * 0.08, t, 0.2);
    }
    // cockpit muffling of the outside world
    this.interior = lerp(this.interior, s.cockpit ? 1 : 0, Math.min(1, dt * 5));
    this.outside.frequency.setTargetAtTime(lerp(20000, 2600, this.interior), t, 0.1);
  }
}
