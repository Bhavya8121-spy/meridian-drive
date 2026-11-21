// Game orchestration: loading, fixed-step simulation, rendering, state machine and settings.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Settings, QUALITY } from './core/settings.js';
import { Input } from './core/input.js';
import { buildLayout, nearestLanePoint, TUNNEL } from './world/layout.js';
import { createMaterialLibrary, WORLD } from './render/materials.js';
import { loadPhotoTextures, loadCityHdris } from './render/photoTextures.js';
import { loadCarKits, bodyOverride } from './vehicle/gltfCars.js';
import { buildCity } from './world/cityBuilder.js';
import { Environment, WEATHER } from './world/environment.js';
import { PlayerCar } from './vehicle/playerCar.js';
import { DRIVING_PRESETS } from './vehicle/specs.js';
import { TrafficSystem } from './traffic/traffic.js';
import { CameraRig } from './camera/cameraRig.js';
import { PostFX } from './render/postfx.js';
import { AudioEngine } from './audio/audio.js';
import { Sparks } from './render/sparks.js';
import { GROUPS } from './core/physicsGroups.js';
import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { Career } from './career/career.js';
import { buildCareerCity } from './career/city.js';
import { vehicleSpec, BODY_OVERRIDES } from './career/vehicles.js';
import { DispatchUI } from './career/dispatch-ui.js';
import { StreetLife } from './career/street-life.js';
import { RestRoom } from './career/rest-room.js';
import { RoadRules, speedLimitAt, impactInvoice } from './career/road-rules.js';
import { navigationCue } from './career/navigation.js';
import { addSpeedSigns } from './career/speed-signs.js';

const FIXED_DT = 1 / 120;
// static colliders kept enabled around the player (m): Rapier's step cost grows with enabled colliders
const STREAM_R = 130;
const SPAWN = { x: -170, y: 0.35, z: 5.25, heading: Math.PI / 2 };

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = new Settings();
    this.state = 'loading';
    this.acc = 0;
    this.drs = 1;            // dynamic resolution factor
    this.ftAvg = 16.7;       // smoothed frame time (ms)
    this.drsTimer = 0;
    this.drsLastDrop = 0;
    this.stats = { fps: 0, frames: 0, t: 0, physMs: 0 };
  }

  async init(progress) {
    const step = async (pct, text) => { progress(pct, text); await new Promise((r) => setTimeout(r, 0)); };
    await step(0.05, 'Initialising renderer');
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false }));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping; // neutral, photographic highlight roll-off (ACES pushed greens/oranges toward "game" colours)
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.08, 6000);

    await step(0.12, 'Starting physics');
    await RAPIER.init();
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this.events = new RAPIER.EventQueue(true);

    await step(0.2, 'Laying out the road network');
    this.layout = buildLayout(1337);
    this.career = new Career(buildCareerCity(this.layout));
    this.roadRules = new RoadRules();
    this.incidentTimes = new Map();

    await step(0.3, 'Generating PBR textures');
    const aniso = renderer.capabilities.getMaxAnisotropy();
    let photo = null;
    try { photo = await loadPhotoTextures(aniso); } catch (e) { console.warn('photo textures unavailable, using procedural ones', e); }
    const { M, tex } = createMaterialLibrary(aniso, photo);
    this.M = M; this.tex = tex;

    await step(0.4, 'Loading vehicles');
    try {
      await loadCarKits(aniso);
      for (const type of ['hatch', 'sedan', 'suv']) { const o = bodyOverride(type); if (o) BODY_OVERRIDES[type] = o; }
    } catch (e) { console.warn('car models unavailable, using procedural cars', e); }

    await step(0.45, 'Building the city');
    this.city = buildCity({ scene: this.scene, layout: this.layout, M, RAPIER, world: this.world });

    await step(0.62, 'Sky, weather and lighting');
    const q = this.settings.quality;
    this.env = new Environment({ scene: this.scene, renderer, lamps: this.city.lamps, quality: q });
    this.env.time = this.settings.get('timeOfDay');
    this.env.setWeather(this.settings.get('weather'), true);
    this.env.onThunder = (d) => this.audio.thunder(d);
    loadCityHdris().then((h) => h && this.env.setCityHdris(h));

    await step(0.7, 'Preparing the car');
    const savedPos = this.career.profile.location;
    const lane = savedPos && nearestLanePoint(this.layout, savedPos.x, savedPos.z);
    const initial = lane ? { ...lane, y: lane.y + 0.35 } : SPAWN;
    this.installVehicle(initial, initial.heading);
    this.spawnHeading = initial.heading;
    this.streetLife = new StreetLife(this.scene, this.career.city, { RAPIER, world: this.world, registerStatic: this.city.registerStatic, cull: this.city.cull });
    this.restRoom = new RestRoom(this.scene);
    addSpeedSigns(this.scene, this.layout);

    await step(0.78, 'Spawning traffic');
    this.traffic = new TrafficSystem({ scene: this.scene, layout: this.layout, M, RAPIER, world: this.world, maxCars: 48, cull: this.city.cull, registerStatic: this.city.registerStatic, retire: this.city.retire });
    this.sparks = new Sparks(this.scene);
    this.scrape = 0;
    this.city.updateStreaming(this.player.curr.pos, STREAM_R);
    this.traffic.onHonk = (pos) => this.audio.horn(pos, null, false);

    await step(0.86, 'Cameras and post-processing');
    this.rig = new CameraRig(this.camera, { RAPIER, world: this.world, excludeBody: this.player.body });
    this.post = new PostFX(renderer, this.scene, this.camera);
    this.audio = new AudioEngine();
    this.input = new Input(window);
    this.hud = new HUD(this.layout);
    this.dispatch = new DispatchUI(this.career, (action, id) => this.careerAction(action, id), this.M);
    window.addEventListener('pagehide', () => this.career.save());
    this.menus = new Menus(this.settings, {
      drive: () => this.startDriving(),
      resume: () => this.setState('drive'),
      reset: () => this.resetVehicle(),
      quit: () => this.toMainMenu(),
      setTime: (h) => { this.env.time = h; this.settings.set('timeOfDay', h); },
      getTime: () => this.env.time,
    });
    this.settings.onChange((k, v) => this.applySetting(k, v));
    this.applyAll();
    window.addEventListener('resize', () => this.resize());
    this.resize();

    await step(0.94, 'Compiling shaders');
    this.rig.setMode('cinematic');
    this.warmup();
    renderer.compile(this.scene, this.camera);
    this.post.render(1 / 60, { cinematic: true, focusDist: 8, night: 0, flash: 0 });
    await step(1, 'Ready');
    this.toMainMenu();
    this.last = performance.now();
    renderer.setAnimationLoop(() => this.frame());
    window.__game = this;
  }

  warmup() {
    // settle the car and populate traffic before the first frame
    for (let i = 0; i < 120; i++) this.physicsStep({ throttle: 0, brake: 0, steer: 0, handbrake: false });
    const pv = { pos: this.player.pos.copy(this.player.curr.pos), vel: new THREE.Vector3() };
    for (let i = 0; i < 60; i++) this.traffic.fixedUpdate(FIXED_DT, pv, null);
    this.env.update(0, this.camera, this.player.curr.pos);
  }

  // ---------------- settings ----------------
  applyAll() {
    for (const k of Object.keys(this.settings.data)) this.applySetting(k, this.settings.get(k), true);
  }

  applySetting(k, v, initial = false) {
    const s = this.settings, q = s.quality;
    switch (k) {
      case 'quality':
        this.env.setShadowQuality(q.shadowMap, q.shadowExtent);
        this.env.setLightCount(q.streetLights);
        this.traffic.setDensity(q.traffic * s.get('trafficDensity'));
        this.resize();
        this.post.configure({ ao: s.get('ao'), bloom: s.get('bloom'), aa: s.get('quality') === 'ultra' ? 'smaa' : 'fxaa' });
        break;
      case 'ao': case 'bloom':
        this.post.configure({ ao: s.get('ao'), bloom: s.get('bloom'), aa: s.get('quality') === 'ultra' ? 'smaa' : 'fxaa' });
        break;
      case 'renderScale': this.resize(); break;
      case 'trafficDensity': this.traffic.setDensity(q.traffic * v); break;
      case 'masterVolume': case 'engineVolume': case 'sfxVolume': case 'ambienceVolume':
        this.audio.setVolumes({ master: s.get('masterVolume'), engine: s.get('engineVolume'), sfx: s.get('sfxVolume'), ambience: s.get('ambienceVolume') });
        break;
      case 'drivingPreset': this.player.phys.setPreset(this.careerPreset()); break;
      case 'steerSensitivity': this.input.steerSensitivity = v; break;
      case 'timeSpeed': this.env.timeSpeed = v; break;
      case 'weather': this.env.setWeather(v); break;
      case 'paint':
        if (!initial) {
          this.career.vehicle.paint = v;
          this.player.setPaint(v);
          this.career.save();
        }
        break;
      case 'timeOfDay': break;
    }
  }

  resize() {
    if (!this.renderer) return;
    const q = this.settings.quality;
    const pr = Math.min(window.devicePixelRatio || 1, q.pixelRatioCap) * this.settings.get('renderScale') * (this.settings.get('dynamicRes') !== false ? this.drs : 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(pr);
    this.post?.setSharpness(pr / (window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize();
  }

  careerPreset() {
    const base = DRIVING_PRESETS[this.settings.get('drivingPreset')] || DRIVING_PRESETS.balanced;
    return { ...base, grip: base.grip * this.career.car.grip * (1 + this.career.vehicle.level * 0.04) };
  }

  installVehicle(position, heading) {
    const current = this.player;
    current?.dispose();
    this.player = new PlayerCar({
      scene: this.scene, RAPIER: this.R, world: this.world, M: this.M,
      preset: this.careerPreset(), surfaceAt: this.layout.surfaceAt, position, heading,
      type: this.career.car.type, spec: vehicleSpec(this.career.car, this.career.vehicle.level), skids: current?.skids,
    });
    this.player.setPaint(this.career.vehicle.paint ?? this.career.car.color);
    this.player.headlightsOn = current?.headlightsOn ?? false;
    this.player.phys.damage = this.career.vehicle.damage ?? 0;
    this.roadRules.reset();
    this.player.phys.onShift = (g) => { if (g > 1 || g === -1) this.audio?.shift(); };
    if (this.rig) this.rig.exclude = this.player.body;
  }

  careerAction(action, id) {
    const c = this.career;
    const p = this.player.curr.pos;
    const speed = this.player.phys.speed;
    if (this.state === 'garage') {
      if (action === 'closeGarage') {
        this.dispatch.closeGarage();
        this.setState('drive');
        this.canvas.focus();
        return;
      }
      const changed = action === 'select' ? c.selectCar(id) : action === 'repair' ? c.repair() : c.buy(action, Number(id));
      if (changed && action === 'repair') this.player.phys.damage = 0;
      if (changed && (action === 'select' || action === 'car')) {
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.player.curr.quat);
        this.installVehicle({ x: p.x, y: Math.max(p.y, 0.14), z: p.z }, Math.atan2(fwd.x, fwd.z));
      }
      if (changed) this.dispatch.renderGarage();
      return;
    }
    if (this.state !== 'drive') return;
    switch (action) {
      case 'phone': this.dispatch.togglePhone(); break;
      case 'phoneNext': this.dispatch.nextApp(); break;
      case 'accept': c.accept(); this.dispatch.togglePhone(false); break;
      case 'decline': c.decline(); break;
      case 'cancelRide': c.cancelRide(); break;
      case 'cancelNav': c.clearNavigation(); break;
      case 'fuel': c.navigate('fuel', p); break;
      case 'home':
        if (c.ride) this.hud.toast('Finish or cancel your ride first');
        else c.navigate('home', p);
        break;
      case 'garage':
        if (Math.abs(speed) > 1.5 || this.player.vel.length() > 2) this.hud.toast('Stop the car to open the garage');
        else { this.setState('garage'); this.dispatch.openGarage(); }
        break;
      case 'homeCharge':
        if (c.serviceAt(p, speed)?.type === 'base' && !c.refuel(true)) this.hud.toast('Battery is full or balance is too low');
        break;
      case 'service': {
        const stop = c.serviceAt(p, speed);
        if (stop?.type === 'fuel' || stop?.type === 'charge') {
          if (!c.refuel()) this.hud.toast(c.electric ? 'Battery is full or balance is too low' : 'Tank is full or balance is too low');
        } else if (stop?.type === 'base' && !c.ride) {
          const from = p.clone();
          if (stop.road.axis === 'x') from.z += stop.side * 1.05;
          else from.x += stop.side * 1.05;
          this.rest = { elapsed: 0, from, to: stop.entrance, camera: this.rig.mode };
          this.setState('rest');
        } else if (c.vehicle.fuel <= 0) this.careerAction('recover');
        else if (stop?.type === 'base') this.hud.toast('Finish or cancel your ride first');
        else this.hud.toast(c.electric ? 'Stop at a charger or your apartment' : 'Stop at a fuel station or your apartment');
        break;
      }
      case 'recover':
        if (c.vehicle.fuel <= 0.01) {
          c.recover();
          const stop = c.city.home;
          const heading = stop.road.axis === 'x' ? stop.side * Math.PI / 2 : stop.side > 0 ? Math.PI : 0;
          this.player.reset({ x: stop.x, y: 0.35, z: stop.z }, heading);
          this.city.updateStreaming(stop, STREAM_R);
          this.rig.yaw = heading;
          this.roadRules.reset();
        }
        break;
    }
    this.dispatch.update(this.player.curr.pos, this.player.phys.speed);
  }

  updateRest(dt) {
    const rest = this.rest;
    if (!rest) return;
    const before = rest.elapsed;
    rest.elapsed += dt;
    if (before < 3.6 && rest.elapsed >= 3.6) {
      this.career.rest();
      this.restRoom.hide();
      this.rig.setMode('cockpit');
    }
    this.dispatch.showRest(rest.elapsed);
    if (rest.elapsed < 1.8) {
      this.camera.position.set(rest.from.x + 5, 2.6, rest.from.z + 5);
      const t = rest.elapsed / 1.8;
      this.camera.lookAt(THREE.MathUtils.lerp(rest.from.x, rest.to.x, t), 1, THREE.MathUtils.lerp(rest.from.z, rest.to.z, t));
    } else if (rest.elapsed < 3.6) {
      this.restRoom.show(this.camera, rest.elapsed);
    }
    if (rest.elapsed >= 4.7) {
      this.rig.setMode(rest.camera);
      this.rest = null;
      this.dispatch.showRest(null);
      this.setState('drive');
      this.canvas.focus();
    }
  }

  // ---------------- state ----------------
  setState(s) {
    this.state = s;
    this.hud.show(s === 'drive');
    this.dispatch.show(s === 'drive');
    if (s === 'paused' || s === 'garage' || s === 'rest') this.audio.suspend(); else this.audio.resume();
  }

  toMainMenu() {
    this.setState('menu');
    this.rig.setMode('cinematic');
    this.menus.clear();
    this.menus.push('main');
    document.getElementById('loading').hidden = true;
  }

  async startDriving() {
    await this.audio.start();
    this.audio.setVolumes({ master: this.settings.get('masterVolume'), engine: this.settings.get('engineVolume'), sfx: this.settings.get('sfxVolume'), ambience: this.settings.get('ambienceVolume') });
    this.rig.setMode('chase');
    this.rig.yaw = this.spawnHeading;
    this.setState('drive');
    this.env.time = this.career.time;
    this.hud.toast('Driver online');
    this.canvas.focus?.();
  }

  resetVehicle() {
    const p = this.player.curr.pos;
    const lp = nearestLanePoint(this.layout, p.x, p.z) || { x: SPAWN.x, y: 0, z: SPAWN.z, heading: SPAWN.heading };
    this.player.reset({ x: lp.x, y: lp.y + 0.6, z: lp.z }, lp.heading);
    this.rig.yaw = lp.heading;
    this.roadRules.reset();
    this.hud.toast('Vehicle reset');
  }

  // ---------------- loop ----------------
  physicsStep(input) {
    this.predictHits();
    this.player.step(FIXED_DT, input);
    const pv = { pos: this.player.curr.pos, vel: this.player.vel };
    this.traffic.fixedUpdate(FIXED_DT, pv, this.camera);
    this.world.step(this.events);
    const P = this.player.phys;
    let touching = 0, otherHandle;
    this.events.drainContactForceEvents((e) => {
      const h1 = e.collider1(), h2 = e.collider2();
      const mine = P.colliderHandles.has(h1) ? h1 : P.colliderHandles.has(h2) ? h2 : null;
      if (mine === null) return;
      const other = mine === h1 ? h2 : h1;
      const force = e.totalForceMagnitude();
      if (force > touching) { touching = force; otherHandle = other; }
    });
    // impacts: crumple delta-v (fixed obstacles / wrecks) plus rigid contact force (everything else)
    const crush = P.crumple;
    const hitHandle = crush > 0 ? P.impact?.handle ?? otherHandle : otherHandle;
    P.crumple = 0;
    const rigid = touching / 250000;
    const strength = Math.min(1, crush / 9 + rigid);
    // damage from the energy actually absorbed: ~25% for a 90 km/h wall hit, nothing for light scrapes
    P.damage = Math.min(1, P.damage + crush * 0.011);
    if (this.state === 'drive' && hitHandle !== undefined && (crush > 0.45 || touching > 5500)) {
      const otherCar = this.traffic.carOwner.has(hitHandle) || this.traffic.parkedOwner.has(hitHandle);
      this.billImpact(hitHandle, otherCar ? 'vehicle' : 'property', Math.max(rigid, crush / 9));
    }
    const now = performance.now();
    if (strength > 0.06 && now - (this.lastImpact || 0) > 160) {
      this.lastImpact = now;
      this.audio.impact(strength);
      if (rigid > 0.25) P.damage = Math.min(1, P.damage + Math.min(0.08, rigid * 0.03)); // hard knocks against movable things
      this.rig.kick(this.player.vel, strength);
      const pt = P.impact?.point || this.player.curr.pos;
      const n = P.impact?.normal || new THREE.Vector3(0, 0, 0);
      if (strength > 0.15) this.sparks.emit(pt, n, this.player.vel, Math.round(10 + 40 * strength), 0.6 + strength);
      P.impact = null;
    }
    // continuous contact while moving = metal scraping along a wall/car
    const speed = this.player.vel.length();
    const scraping = touching > 2500 && speed > 3;
    this.scrape += ((scraping ? Math.min(1, speed / 20) : 0) - this.scrape) * 0.08;
    if (scraping && Math.random() < 0.35) {
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.player.quat);
      const o = this.player.curr.pos.clone().addScaledVector(side, Math.random() < 0.5 ? 0.95 : -0.95);
      o.y += 0.4;
      this.sparks.emit(o, new THREE.Vector3(), this.player.vel, 3, 0.5);
    }
  }

  billImpact(id, kind, strength) {
    const time = this.traffic.time;
    const last = this.incidentTimes.get(id);
    this.incidentTimes.set(id, time);
    if (last !== undefined && time - last < 1.6) return;
    if (this.incidentTimes.size > 256) {
      for (const [key, stamp] of this.incidentTimes) if (time - stamp > 5) this.incidentTimes.delete(key);
    }
    const { label, cost, wear } = impactInvoice(kind, strength);
    const physics = this.player.phys;
    physics.damage = Math.min(1, physics.damage + wear);
    this.career.recordDamage(physics.damage);
    // no liability fines (removed with the other strict rules): crashes only wear the car (repair cost)
    void label; void cost;
  }

  /**
   * Look a short distance ahead along the car's motion. Traffic, parked cars and street furniture we are
   * about to hit become dynamic rigid bodies *before* contact, so the solver exchanges momentum instead of
   * treating them as immovable.
   */
  predictHits() {
    const P = this.player.phys, b = P.body;
    const lv = b.linvel();
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    if (speed < 0.3) return;
    const t = b.translation(), r = b.rotation();
    const q = (this._phQ ||= new THREE.Quaternion()).set(r.x, r.y, r.z, r.w);
    const c = (this._phC ||= new THREE.Vector3()).set(0, 0.6, 0).applyQuaternion(q);
    c.x += t.x; c.y += t.y; c.z += t.z;
    const dir = { x: lv.x / speed, y: lv.y / speed, z: lv.z / speed };
    const hit = this.world.castShape(c, r, dir, P.castBox, 0, speed * 0.12 + 0.4, true, this.R.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.contactCast, undefined, b);
    if (!hit) return;
    const h = hit.collider.handle;
    const car = this.traffic.carOwner.get(h);
    if (car) {
      if (!car.active || car.state === 'wreck') return;
      const to = car.pos.clone().sub(this.player.curr.pos).setY(0).normalize();
      const closing = (lv.x * to.x + lv.z * to.z) - car.v * (car.fwd.x * to.x + car.fwd.z * to.z);
      if (closing > 1.0) this.traffic.wreck(car);
      return;
    }
    const parked = this.traffic.parkedOwner.get(h);
    if (parked) { if (speed > 1.0) this.traffic.convertParked(parked, this.player.curr.pos); return; }
    const prop = this.city.propOwner.get(h);
    if (prop && !prop.broken && speed > prop.breakSpeed) this.city.breakProp(prop);
  }

  /** Mark the end of a frame section for the profiler (EMA + peak in ms). */
  mark(name) {
    const t = performance.now();
    const ms = t - this._mt;
    this._mt = t;
    const p = (this.prof ||= {});
    const e = (p[name] ||= { avg: 0, peak: 0 });
    e.avg = e.avg * 0.95 + ms * 0.05;
    e.peak = Math.max(e.peak * 0.995, ms);
    e.last = ms;
  }

  /**
   * Dynamic resolution: if frames take longer than ~18.5 ms for a while, render at a lower pixel ratio
   * (down to 80%); creep back up when the frame rate is pinned at vsync. Resizes at most every 1.5 s.
   */
  updateDynamicResolution(dtMs) {
    if (this.settings.get('dynamicRes') === false || dtMs > 100 || document.hidden) return;
    this.ftAvg = this.ftAvg * 0.94 + dtMs * 0.06;
    this.drsTimer += dtMs / 1000;
    if (this.drsTimer < 1.5) return;
    this.drsTimer = 0;
    const now = performance.now();
    let next = this.drs;
    // floor at 80%: lower than that turns into a visibly soft image (sharpening only recovers so much)
    if (this.ftAvg > 18.5 && this.drs > 0.81) { next = Math.max(0.8, this.drs - 0.05); this.drsLastDrop = now; }
    else if (this.ftAvg < 17.4 && this.drs < 1 && now - this.drsLastDrop > 6000) next = Math.min(1, this.drs + 0.05);
    if (next !== this.drs) { this.drs = next; this.resize(); }
  }

  frame() {
    const now = performance.now();
    this._mt = now;
    if (this.state === 'drive') this.updateDynamicResolution(now - this.last);
    const elapsed = (now - this.last) / 1000;
    const dt = Math.min(0.1, elapsed);
    this.last = now;
    this.renderer.info.reset();

    // input & actions
    const speedAbs = this.player.phys.speedAbs || 0;
    const inp = this.input.update(dt, speedAbs);
    for (const a of this.input.consume()) this.handleAction(a);
    if (this.state === 'garage') return;
    const mouse = this.input.consumeMouse();
    if (mouse.dx || mouse.dy) this.rig.mouseLook(mouse.dx, mouse.dy);

    // simulation
    const running = this.state === 'drive' || this.state === 'menu';
    const t0 = performance.now();
    if (running) {
      const drive = this.state === 'drive'
        ? { ...inp, noFuel: this.career.vehicle.fuel <= 0, throttle: inp.throttle * (0.65 + 0.35 * Math.min(1, this.career.energy * 2)) }
        : { throttle: 0, brake: 0, steer: 0, handbrake: false };
      this.player.phys.weatherGrip = this.env.grip;
      this.acc += dt;
      let n = 0;
      // at most 3 catch-up steps: on a slow frame, more physics steps make the next frame slower still
      // (spiral of death); dropping the backlog briefly slows the simulation instead
      while (this.acc >= FIXED_DT && n < 3) { this.physicsStep(drive); this.acc -= FIXED_DT; n++; }
      if (n === 3 && this.acc >= FIXED_DT) this.acc %= FIXED_DT;
      if (this.state === 'drive' && this.player.phys.isUpsideDown() && speedAbs < 2) {
        this.upsideTimer = (this.upsideTimer || 0) + dt;
        if (this.upsideTimer > 2.5) { this.upsideTimer = 0; this.resetVehicle(); }
      } else this.upsideTimer = 0;
    }
    this.stats.physMs = this.stats.physMs * 0.9 + (performance.now() - t0) * 0.1;
    this.mark('input+physics');
    const alpha = running ? this.acc / FIXED_DT : 1;
    WORLD.uTime.value += running ? dt : 0;
    if (this.state === 'drive') {
      const phys = this.player.phys;
      const pos = this.player.curr.pos;
      const fwd = (this._fwd ||= new THREE.Vector3()).set(0, 0, 1).applyQuaternion(this.player.curr.quat);
      const heading = Math.atan2(fwd.x, fwd.z);
      const speed = Math.abs(phys.speed);
      const previous = this.roadRules.previous;
      if (speed > 0.4) this.streetLife.contact(previous, pos, heading, this.player.model.params.W / 2, this.player.model.params.L / 2, (person) => {
        this.billImpact(person.id, 'pedestrian', speed / 17);
        const velocity = phys.body.linvel();
        phys.body.setLinvel({ x: velocity.x * 0.24, y: velocity.y, z: velocity.z * 0.24 }, true);
      });
      this.roadRules.update(dt, pos, heading, speed * 3.6, this.traffic.time, (label, cost) => this.career.charge(label, cost));
      this.career.recordDamage(phys.damage);
      this.career.update(dt, this.player.curr.pos, phys.speed, phys.engineLoad || 0, this.env.wet, phys.damage);
      this.dispatch.update(this.player.curr.pos, phys.speed);
      if (this.career.notice) {
        this.hud.toast(this.career.notice, 3.5);
        this.career.notice = '';
      }
    }
    if (this.state === 'drive' || this.state === 'rest') {
      this.env.time = this.career.time;
      this.env.timeSpeed = 0;
    } else if (this.state === 'menu') this.env.timeSpeed = this.settings.get('timeSpeed');
    this.env.update(running || this.state === 'rest' ? dt : 0, this.camera, this.player.pos);
    this.streetLife.update(running || this.rest ? dt : 0, this.player.curr.pos, this.career, this.rest, this.traffic.time);
    this.M.streetLens.emissiveIntensity = this.env.lightsOn * 3;
    this.mark('environment');
    this.player.update(dt, alpha, this.env);
    this.mark('player visuals');
    this.sparks.update(dt);
    this.city.updateDebris(dt, this.player.curr.pos);
    if (this.player.blinkEdge && this.player.indicator) this.audio.tick();
    this.traffic.update(dt, this.env.lightsOn, this.city.signalLamps, this.city.lampInstances);
    this.mark('traffic visuals');

    // automatic headlights at dusk (once)
    if (this.env.night > 0.5 && !this.autoLightsDone) { this.autoLightsDone = true; this.player.headlightsOn = true; }
    if (this.env.night < 0.2) this.autoLightsDone = false;

    // camera
    const car = { pos: this.player.pos, quat: this.player.quat, vel: this.player.vel, speed: this.player.phys.speed, rpm: this.player.phys.rpm, driverEye: this.player.model.driverEye };
    this.rig.update(dt, car);
    this.updateRest(dt);
    if (this.shake > 0) {
      this.shake -= dt;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, 0));
    }
    const cockpit = this.rig.mode === 'cockpit';
    this.hud.el.classList.toggle('cockpit', cockpit);
    this.player.model.rider.visible = this.career.ride?.phase === 'dropoff';
    const carMaterials = this.player.model.materials;
    carMaterials.glass.opacity = cockpit ? 0.075 : 0.84;
    carMaterials.interior.emissiveIntensity = cockpit ? this.env.night * 0.18 : 0;
    carMaterials.leather.emissiveIntensity = cockpit ? this.env.night * 0.15 : 0;
    if (cockpit) {
      const P = this.player.phys;
      this.player.model.updateCluster(P.speed, P.rpm, P.gear, this.settings.get('units') === 'mph');
      const fwd = (this._fwd ||= new THREE.Vector3()).set(0, 0, 1).applyQuaternion(this.player.quat);
      const cue = navigationCue(this.player.pos, Math.atan2(fwd.x, fwd.z), this.career.route, this.career.target);
      this.player.model.navigation.draw(now, cue, this.hud.mini);
    }
    this.city.cull.update(this.camera.position, this.settings.quality.drawMul);
    this.streamTimer = (this.streamTimer || 0) - dt;
    if (this.streamTimer <= 0) { this.streamTimer = 0.3; this.city.updateStreaming(this.player.curr.pos, STREAM_R); }
    this.mark('camera+cull+stream');
    const inTunnel = this.player.pos.x > TUNNEL.x0 && this.player.pos.x < TUNNEL.x1 && Math.abs(this.player.pos.z - TUNNEL.z) < 13;

    // audio
    const tel = this.player.phys.telemetry;
    const camDir = this.camera.getWorldDirection(this._camDir || (this._camDir = new THREE.Vector3()));
    this.audio.update(dt, {
      ...tel, cam: this.camera, camDir, engineOn: (this.state === 'drive' || this.state === 'menu') && this.career.vehicle.fuel > 0, electric: this.career.electric, surface: this.player.phys.wheels[2].surface,
      rain: this.env.cur.rain, inTunnel, cityAmt: Math.max(0, 1 - Math.max(Math.abs(this.player.pos.x), Math.abs(this.player.pos.z)) / 700),
      traffic: this.traffic.nearest(this.player.pos, 3), cockpit, scrape: this.scrape,
    });

    this.mark('audio');
    // render
    const night = this.env.night;
    this.post.render(dt, { cinematic: this.rig.mode === 'cinematic', cockpit, focusDist: this.camera.position.distanceTo(this.player.pos), night, flash: this.env.flash });

    this.mark('render (CPU submit)');
    // HUD
    if (this.state === 'drive') {
      const P = this.player.phys;
      const fwd = (this._fwd || (this._fwd = new THREE.Vector3())).set(0, 0, 1).applyQuaternion(this.player.quat);
      this.hud.update(dt, {
        speed: P.speed, rpm: P.rpm, gear: P.gear, units: this.settings.get('units'), preset: P.preset.label, camLabel: this.rig.label,
        tcs: P.tcsActive, abs: P.absActive, headlights: this.player.headlightsOn, time: this.env.time, weather: WEATHER[this.env.weatherName].label,
        pos: this.player.pos, heading: Math.atan2(fwd.x, fwd.z), damage: P.damage, traffic: this.traffic.cars, inTunnel,
        route: this.career.route, stations: this.career.city.stations, chargers: this.career.city.chargers, target: this.career.target, speedLimit: speedLimitAt(this.player.curr.pos), wallet: this.career.profile.balance,
        fuelPct: this.career.vehicle.fuel / this.career.capacity, energy: this.career.energy, electric: this.career.electric,
      });
    }
    this.mark('hud');
    this.updateStats(elapsed);
  }

  handleAction(a) {
    if (a === 'pause') {
      if (this.state === 'garage') { this.careerAction('closeGarage'); return; }
      if (this.menus.escape()) return;
      if (this.state === 'drive') { this.setState('paused'); this.menus.push('pause'); }
      return;
    }
    if (a === 'debug') { this.settings.set('showFps', !this.settings.get('showFps')); return; }
    if (this.state !== 'drive') return;
    switch (a) {
      case 'camera': this.rig.next(); this.hud.toast('Camera: ' + this.rig.label); break;
      case 'cinematic': this.rig.toggleCinematic(); this.hud.toast(this.rig.label); break;
      case 'headlights': this.player.headlightsOn = !this.player.headlightsOn; this.hud.toast(this.player.headlightsOn ? 'Headlights on' : 'Headlights off'); break;
      case 'reset': this.resetVehicle(); break;
      case 'horn': this.audio.horn(null, null, true); break;
      case 'indLeft': this.player.indicator = this.player.indicator === -1 ? 0 : -1; break;
      case 'indRight': this.player.indicator = this.player.indicator === 1 ? 0 : 1; break;
      case 'hazard': this.player.indicator = this.player.indicator === 2 ? 0 : 2; break;
      case 'phone': case 'phoneNext': case 'garage': case 'accept': case 'decline': case 'service': this.careerAction(a); break;
      case 'mute': this.settings.set('masterVolume', this.settings.get('masterVolume') > 0 ? 0 : 0.8); break;
    }
  }

  updateStats(dt) {
    const s = this.stats;
    s.frames++; s.t += dt;
    if (s.t >= 0.5) { s.fps = s.frames / s.t; s.frames = 0; s.t = 0; }
    if (!this.settings.get('showFps')) { this.hud.setDebug(null); return; }
    const info = this.renderer.info;
    const p = this.player.pos;
    this.hud.setDebug(
      `FPS        ${s.fps.toFixed(0)}\n` +
      `draw calls ${info.render.calls}\n` +
      `triangles  ${(info.render.triangles / 1e6).toFixed(2)} M\n` +
      `physics    ${s.physMs.toFixed(2)} ms\n` +
      `traffic    ${this.traffic.activeCount ?? 0} active\n` +
      `exposure   ${this.post.exposure.toFixed(2)}\n` +
      `pos        ${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)}\n` +
      Object.entries(this.prof || {}).map(([k, v]) => `${k.padEnd(20)} ${v.avg.toFixed(2)} / ${v.peak.toFixed(1)} ms`).join('\n'),
    );
  }
}
