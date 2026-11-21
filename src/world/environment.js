// Sky, sun/moon, clouds, stars, fog, weather, rain, lightning, image-based lighting and the
// pooled street-light system.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { WORLD } from '../render/materials.js';
import { clamp, lerp, smoothstep, damp } from '../core/rng.js';

export const WEATHER = {
  clear:  { cloud: 0.18, overcast: 0.0, rain: 0, fog: 0.00032, haze: 0.0, label: 'Clear' },
  cloudy: { cloud: 0.72, overcast: 0.35, rain: 0, fog: 0.0008, haze: 0.15, label: 'Cloudy' },
  rain:   { cloud: 0.95, overcast: 0.85, rain: 1, fog: 0.0024, haze: 0.4, label: 'Rain' },
  fog:    { cloud: 0.55, overcast: 0.6, rain: 0, fog: 0.0105, haze: 1.0, label: 'Fog' },
};

const CLOUD_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const CLOUD_FS = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uFogColor;
uniform float uCover; uniform float uOvercast; uniform float uHaze; uniform float uTime; uniform float uDay; uniform float uNight; uniform float uFlash;
varying vec3 vDir;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  vec2 uv = d.xz / (max(up, 0.0) + 0.1) * 0.55 + uTime * vec2(0.006, 0.002);
  float n = fbm(uv * 1.4) * 0.72 + fbm(uv * 4.3 + 7.0) * 0.28;
  float dens = smoothstep(1.02 - uCover - 0.12, 1.02 - uCover + 0.3, n);
  float sunAmt = pow(max(dot(d, uSunDir), 0.0), 5.0);
  vec3 base = mix(vec3(0.03, 0.035, 0.05), vec3(0.86, 0.88, 0.92), uDay);
  vec3 lit = base * mix(vec3(1.0), uSunColor, 0.35) + sunAmt * uSunColor * 0.7 * uDay;
  vec3 col = lit * mix(1.0, 0.55, dens * dens);
  float horizon = smoothstep(-0.02, 0.22, up);
  float alpha = dens * horizon;
  // full overcast deck
  vec3 deck = mix(vec3(0.02, 0.022, 0.03), vec3(0.58, 0.6, 0.64), uDay) * (0.85 + 0.3 * n);
  col = mix(col, deck, uOvercast * (1.0 - alpha * 0.5));
  alpha = max(alpha, uOvercast * smoothstep(-0.04, 0.12, up));
  // horizon haze / fog
  float hz = uHaze * (1.0 - smoothstep(0.0, 0.45, up)) + (1.0 - smoothstep(-0.03, 0.06, up)) * 0.85;
  col = mix(col, uFogColor, clamp(hz, 0.0, 1.0));
  alpha = max(alpha, clamp(hz, 0.0, 1.0));
  // stars + moon at night
  vec3 sd = floor(d * 420.0);
  float star = step(0.9975, h21(sd.xy + sd.z * 1.7)) * h21(sd.zx) * uNight * (1.0 - alpha) * smoothstep(0.05, 0.3, up);
  vec3 moonDir = -uSunDir;
  float moon = smoothstep(0.99955, 0.9997, dot(d, moonDir)) * uNight * (1.0 - alpha * 0.8);
  col += vec3(star * 1.6) + vec3(1.4, 1.45, 1.5) * moon;
  alpha = max(alpha, max(star, moon));
  col += vec3(0.7, 0.75, 0.9) * uFlash * dens;
  gl_FragColor = vec4(col, alpha);
}`;

const RAIN_VS = /* glsl */`
attribute float aEnd;
uniform float uTime; uniform vec3 uCam; uniform vec2 uWindXZ;
varying float vEnd;
void main() {
  vec3 p = position;
  p.y -= uTime * 13.0;
  p.xz += uTime * uWindXZ;
  vec3 box = vec3(60.0, 36.0, 60.0);
  p = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
  p -= vec3(uWindXZ.x, -13.0, uWindXZ.y) * 0.032 * aEnd;
  vEnd = aEnd;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAIN_FS = /* glsl */`
uniform float uRain; uniform float uBright;
varying float vEnd;
void main() { gl_FragColor = vec4(vec3(0.72, 0.76, 0.82) * uBright, uRain * 0.32 * (0.25 + 0.75 * vEnd)); }`;

export class Environment {
  constructor({ scene, renderer, lamps, quality }) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 16.5;
    this.timeSpeed = 1;
    this.weatherName = 'clear';
    const w = WEATHER.clear;
    this.cur = { cloud: w.cloud, overcast: w.overcast, rain: w.rain, fog: w.fog, haze: w.haze };
    this.wet = 0;
    this.flash = 0;
    this.lightningTimer = 8;
    this.onThunder = null;
    this.lightsOn = 0;

    // sun / moon
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.035;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b5440, 0.3);
    scene.add(this.hemi);

    // sky (main + env copy sharing uniforms)
    this.sky = new Sky();
    this.sky.scale.setScalar(4500);
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.cloudMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 1, 1) }, uFogColor: { value: new THREE.Color() },
        uCover: { value: 0.2 }, uOvercast: { value: 0 }, uHaze: { value: 0 }, uTime: WORLD.uTime, uDay: { value: 1 }, uNight: { value: 0 }, uFlash: { value: 0 },
      },
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), this.cloudMat);
    this.clouds.renderOrder = -1;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);

    this.envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.material.uniforms = this.sky.material.uniforms;
    sky2.scale.setScalar(4500);
    this.envScene.add(sky2);
    const clouds2 = new THREE.Mesh(this.clouds.geometry, this.cloudMat);
    this.envScene.add(clouds2);
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(3000, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2b2a28 }));
    this.envGround.position.y = -40;
    this.envScene.add(this.envGround);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.cityEnv = null; // photo city panorama blended into the reflection capture (setCityHdris)
    this.envRT = null;
    this.envTimer = 0;
    this.envKey = '';

    scene.fog = new THREE.FogExp2(0xbfd0e0, 0.0005);

    // rain
    const N = 9000;
    const pos = new Float32Array(N * 6), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random() * 60, y = Math.random() * 36, z = Math.random() * 60;
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false,
      uniforms: { uTime: WORLD.uTime, uCam: { value: new THREE.Vector3() }, uWindXZ: { value: new THREE.Vector2(1.5, 0.6) }, uRain: { value: 0 }, uBright: { value: 1 } },
    });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    // pooled street lights
    this.lamps = lamps;
    this.lightPool = [];
    this.setLightCount(quality?.streetLights ?? 10);
    this.poolTimer = 0;
    this.sunDir = new THREE.Vector3();
  }

  setLightCount(n) {
    for (const l of this.lightPool) { this.scene.remove(l, l.target); l.dispose?.(); }
    this.lightPool = [];
    for (let i = 0; i < n; i++) {
      const l = new THREE.SpotLight(0xffd2a0, 0, 42, 1.0, 0.65, 1.6);
      l.castShadow = false;
      this.scene.add(l, l.target);
      this.lightPool.push(l);
    }
    this.poolTimer = 0;
  }

  setShadowQuality(size, extent) {
    const s = this.sun.shadow;
    if (s.mapSize.x !== size) {
      s.mapSize.set(size, size);
      s.map?.dispose(); s.map = null;
    }
    this.shadowExtent = extent;
    const c = s.camera;
    c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent;
    c.near = 1; c.far = 900;
    c.updateProjectionMatrix();
  }

  setWeather(name, instant = false) {
    this.weatherName = name;
    if (instant) Object.assign(this.cur, WEATHER[name]);
    this.envKey = '';
  }

  /**
   * Blend real street panoramas (day / night HDRIs) into the image-based-lighting capture: they replace the
   * horizon and below (buildings, street), while the live procedural sky and clouds stay above, so reflections
   * show a city yet still follow the time of day and weather.
   */
  setCityHdris({ day, night }) {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, fog: false,
      uniforms: { uDay: { value: day }, uNight: { value: night }, uNightMix: { value: 0 }, uTint: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D uDay; uniform sampler2D uNight; uniform float uNightMix; uniform vec3 uTint; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
          vec3 c = mix(texture2D(uDay, uv).rgb, texture2D(uNight, uv).rgb, uNightMix);
          c = min(c, vec3(3.0)) * uTint; // clamp the panoramas' own sun / lamps so they don't add a second sun
          gl_FragColor = vec4(c, 1.0 - smoothstep(0.1, 0.38, d.y));
        }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(4200, 48, 24), mat);
    m.renderOrder = 10;
    this.envScene.add(m);
    this.envGround.visible = false;
    this.cityEnv = mat;
    this.envKey = '';
  }

  /** Grip multiplier for vehicle physics (wet roads). */
  get grip() { return 1 - 0.3 * this.wet; }
  get isNight() { return this.night > 0.5; }

  update(dt, camera, focus) {
    // time of day
    this.time = (this.time + (dt * this.timeSpeed) / 120 + 24) % 24;
    // weather blending
    const tgt = WEATHER[this.weatherName];
    const k = damp(0.25, dt);
    for (const key of ['cloud', 'overcast', 'rain', 'haze']) this.cur[key] = lerp(this.cur[key], tgt[key], k);
    this.cur.fog = Math.exp(lerp(Math.log(this.cur.fog), Math.log(tgt.fog), k));
    const rain = this.cur.rain;
    this.wet = clamp(this.wet + (rain > 0.3 ? dt / 25 * rain : -dt / 120), 0, 1);
    WORLD.uWet.value = this.wet;
    WORLD.uRain.value = rain;
    WORLD.uWind.value = 1 + rain * 1.5 + this.cur.cloud * 0.5;

    // sun position
    const t = this.time;
    const elev = Math.sin(((t - 6) / 24) * Math.PI * 2) * THREE.MathUtils.degToRad(64);
    const az = ((t - 6) / 12) * Math.PI + 0.35;
    this.sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev) * 0.6 - 0.3).normalize();
    const sinEl = this.sunDir.y;
    const day = smoothstep(-0.1, 0.12, sinEl);
    const night = 1 - smoothstep(-0.14, 0.05, sinEl);
    this.day = day; this.night = night;
    WORLD.uNight.value = night;
    const cloudDim = 1 - 0.78 * this.cur.overcast - 0.15 * this.cur.cloud;

    const warm = new THREE.Color(1.0, 0.48, 0.2), white = new THREE.Color(1.0, 0.96, 0.9);
    const sunCol = warm.clone().lerp(white, smoothstep(0.02, 0.4, sinEl));
    const sunI = 3.15 * smoothstep(-0.02, 0.14, sinEl) * cloudDim;
    const moonI = 0.22 * night * (1 - this.cur.overcast * 0.7);
    if (sinEl > -0.02) {
      this.sun.color.copy(sunCol);
      this.sun.intensity = sunI;
      this.lightDir = this.sunDir;
    } else {
      this.sun.color.setRGB(0.55, 0.65, 0.95);
      this.sun.intensity = moonI;
      this.lightDir = this.sunDir.clone().negate();
    }
    if (this.sun.shadow.intensity !== undefined) this.sun.shadow.intensity = 1 - 0.6 * this.cur.overcast;
    // lightning
    this.flash = Math.max(0, this.flash - dt * 6);
    if (this.weatherName === 'rain' && rain > 0.7) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 9 + Math.random() * 16;
        this.flash = 1.4;
        setTimeout(() => { this.flash = Math.max(this.flash, 0.9); }, 140);
        this.onThunder?.(1.2 + Math.random() * 3);
      }
    }
    this.hemi.intensity = (0.42 * day + 0.092 + 0.20 * this.cur.overcast * day) + this.flash * 1.6;
    this.hemi.color.setRGB(lerp(0.3, 0.62, day), lerp(0.36, 0.72, day), lerp(0.55, 0.95, day));
    this.scene.environmentIntensity = lerp(0.23, 0.42, day) * (1 + 0.6 * this.cur.overcast);

    // sky
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.turbidity.value = lerp(1.85, 8.4, this.cur.cloud);
    u.rayleigh.value = lerp(1.4, 0.5, this.cur.cloud) + (1 - smoothstep(0.0, 0.25, sinEl)) * 0.8;
    u.mieCoefficient.value = 0.0025 + 0.009 * this.cur.cloud;
    u.mieDirectionalG.value = 0.82;
    this.sky.position.copy(camera.position);
    this.clouds.position.copy(camera.position);

    // fog colour
    const fogDay = new THREE.Color(0.66, 0.74, 0.84).lerp(new THREE.Color(0.62, 0.63, 0.65), this.cur.overcast);
    const fogSunset = new THREE.Color(0.85, 0.58, 0.42);
    const fogNight = new THREE.Color(0.018, 0.022, 0.034);
    const sunsetAmt = (1 - smoothstep(0.02, 0.3, Math.abs(sinEl))) * (1 - this.cur.overcast) * day;
    const fc = fogDay.clone().lerp(fogSunset, sunsetAmt * 0.7).multiplyScalar(lerp(0.4, 1, day) * cloudDim * 0.9 + 0.1).lerp(fogNight, night);
    this.scene.fog.color.copy(fc);
    this.scene.fog.density = this.cur.fog;
    const cu = this.cloudMat.uniforms;
    cu.uSunDir.value.copy(this.sunDir);
    cu.uSunColor.value.copy(sunCol);
    cu.uFogColor.value.copy(fc);
    cu.uCover.value = this.cur.cloud;
    cu.uOvercast.value = this.cur.overcast;
    cu.uHaze.value = this.cur.haze;
    cu.uDay.value = day * cloudDim + 0.04;
    cu.uNight.value = night;
    cu.uFlash.value = this.flash;
    this.envGround.material.color.copy(fc).multiplyScalar(0.45);
    if (this.cityEnv) {
      // day panorama scaled to the current daylight (and tinted toward the sky/fog colour); night panorama at night
      const cu2 = this.cityEnv.uniforms;
      cu2.uNightMix.value = night;
      const dayI = lerp(0.12, 0.75, day) * cloudDim;
      cu2.uTint.value.setRGB(lerp(1, fc.r / Math.max(0.05, fc.g), 0.35), 1, lerp(1, fc.b / Math.max(0.05, fc.g), 0.35)).multiplyScalar(lerp(dayI, 0.6, night));
    }

    // shadow camera follows the focus point, snapped to texels to avoid shimmering
    const ext = this.shadowExtent || 90;
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx, 0, fz).addScaledVector(this.lightDir, 400);
    this.sun.target.updateMatrixWorld();

    // rain
    this.rain.visible = rain > 0.02;
    this.rainMat.uniforms.uRain.value = rain;
    this.rainMat.uniforms.uCam.value.copy(camera.position);
    this.rainMat.uniforms.uBright.value = 0.25 + day * 0.9 + this.flash;

    // street lights
    this.lightsOn = clamp(Math.max(night * 1.2, this.cur.overcast * 0.45 * (1 - day * 0.4), this.cur.haze * 0.5) , 0, 1);
    this.poolTimer -= dt;
    if (this.poolTimer <= 0) { this.poolTimer = 0.2; this.assignLights(camera.position); }
    for (const l of this.lightPool) {
      const want = l.userData.mode === 'always' ? 1 : this.lightsOn;
      const base = l.userData.mode === 'always' ? 160 : l.userData.kind === 'highway' ? 260 : 170;
      l.intensity = lerp(l.intensity, l.userData.active ? want * base : 0, damp(4, dt));
    }

    // image-based lighting refresh
    this.envTimer -= dt;
    const key = `${Math.round(t * 4)}|${this.cur.cloud.toFixed(2)}|${this.cur.overcast.toFixed(2)}|${this.cur.haze.toFixed(2)}`;
    if (this.envTimer <= 0 && key !== this.envKey) {
      this.envKey = key;
      this.envTimer = 2;
      const rt = this.pmrem.fromScene(this.envScene, 0.02, 1, 5000);
      this.envRT?.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
  }

  assignLights(cam) {
    const n = this.lightPool.length;
    if (!n) return;
    const best = [];
    for (const lp of this.lamps) {
      if (lp.broken || (lp.mode !== 'always' && this.lightsOn < 0.05)) continue;
      const d = (lp.x - cam.x) ** 2 + (lp.z - cam.z) ** 2 + (lp.y - cam.y) ** 2 * 0.2;
      if (best.length < n) { best.push([d, lp]); best.sort((a, b) => a[0] - b[0]); }
      else if (d < best[n - 1][0]) { best[n - 1] = [d, lp]; best.sort((a, b) => a[0] - b[0]); }
    }
    for (let i = 0; i < n; i++) {
      const l = this.lightPool[i];
      const lp = best[i]?.[1];
      if (!lp) { l.userData.active = false; continue; }
      if (l.userData.lamp !== lp) {
        l.userData.lamp = lp;
        l.intensity = 0;
      }
      l.userData.active = true;
      l.userData.mode = lp.mode;
      l.userData.kind = lp.kind;
      l.position.set(lp.x, lp.y, lp.z);
      l.target.position.set(lp.x, lp.y - 10, lp.z);
      l.target.updateMatrixWorld();
      if (lp.kind === 'tunnel') { l.angle = 1.2; l.distance = 30; l.color.setRGB(1, 0.92, 0.8); }
      else if (lp.kind === 'billboard') { l.angle = 0.8; l.distance = 20; l.color.setRGB(1, 1, 1); }
      else { l.angle = 1.0; l.distance = lp.kind === 'highway' ? 55 : 42; l.color.setRGB(1, 0.8, 0.58); }
    }
  }
}
