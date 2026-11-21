// HDR post-processing chain: GTAO -> auto-exposure metering -> bloom (half-res) -> one final pass (AgX tone
// mapping, FXAA, contrast-adaptive sharpening, colour grade) -> SMAA on Ultra only. No motion blur or depth of field: both read as a blurry
// picture in play (removed on purpose), and sharpening restores detail when dynamic resolution drops.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { clamp, lerp } from '../core/rng.js';

/** Measures average log-luminance of the HDR frame on a 32x32 target (read back every few frames). */
class MeterPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(32, 32, { type: THREE.UnsignedByteType });
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){
          vec3 c = vec3(0.0);
          for (int i = 0; i < 4; i++) for (int j = 0; j < 4; j++) c += texture2D(tDiffuse, vUv + (vec2(i, j) - 1.5) / 128.0).rgb;
          c /= 16.0;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float e = clamp((log2(max(l, 1e-4)) + 12.0) / 16.0, 0.0, 1.0);
          gl_FragColor = vec4(e, e, e, 1.0);
        }`,
    }));
    this.buf = new Uint8Array(32 * 32 * 4);
    this.frame = 0;
    this.avgLum = 0.18;
    this.enabled = true;
  }
  render(renderer, writeBuffer, readBuffer) {
    // Meter ~4x per second and read back asynchronously: a synchronous readPixels stalls the CPU until
    // the GPU has finished every queued frame, which showed up as an 80 ms hitch every 6th frame.
    if (this.frame++ % 15 !== 0 || this.pending) return;
    this.quad.material.uniforms.tDiffuse.value = readBuffer.texture;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    this.pending = true;
    renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, 32, 32, this.buf).then(() => {
      this.pending = false;
      let sum = 0, wsum = 0;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const w = 1.0 - 0.6 * Math.hypot((x - 15.5) / 16, (y - 15.5) / 16); // centre-weighted
        sum += ((this.buf[(y * 32 + x) * 4] / 255) * 16 - 12) * w;
        wsum += w;
      }
      this.avgLum = Math.pow(2, sum / wsum);
    }).catch(() => { this.pending = false; });
  }
}

/**
 * Final pass: AgX tone mapping + sRGB, FXAA, contrast-adaptive sharpening and the colour grade in ONE full-screen
 * pass. These used to be OutputPass + SMAA (3 internal passes) + grade: each full-screen pass cost ~4-5 ms at
 * 1536x1152 on the integrated GPU we measured, so merging them is the largest single GPU saving.
 */
// three's tone-mapping functions under a pp_ prefix: three injects its own copies into ShaderMaterials that render
// to the screen, so the original names would collide (and be missing when SMAA makes this pass render off-screen)
const TONEMAP = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  /\b(toneMappingExposure|LinearToneMapping|ReinhardToneMapping|CineonToneMapping|RRTAndODTFit|ACESFilmicToneMapping|LINEAR_REC2020_TO_LINEAR_SRGB|LINEAR_SRGB_TO_LINEAR_REC2020|agxDefaultContrastApprox|AgXToneMapping|NeutralToneMapping|CustomToneMapping)\b/g, 'pp_$1');

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, pp_toneMappingExposure: { value: 1 }, uFxaa: { value: 1 },
    uContrast: { value: 1.1 }, uSaturation: { value: 1.08 }, uTint: { value: new THREE.Color(1, 1, 1) },
    uVignette: { value: 0.12 }, uLift: { value: 0.006 }, uTime: { value: 0 }, uGrain: { value: 0.002 }, uFlash: { value: 0 }, uSharp: { value: 0.35 }, uPixel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    ${TONEMAP}
    uniform sampler2D tDiffuse; uniform float uContrast; uniform float uSaturation; uniform vec3 uTint; uniform float uFxaa;
    uniform vec2 uPixel; uniform float uVignette; uniform float uLift; uniform float uTime; uniform float uGrain; uniform float uFlash; uniform float uSharp;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    // scene-referred HDR -> display sRGB
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    vec3 tm(vec2 uv) { return toSRGB(pp_AgXToneMapping(texture2D(tDiffuse, uv).rgb)); }
    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      vec3 m = tm(vUv);
      // CAS (after AMD FidelityFX CAS): adaptive sharpening on the cross neighbourhood
      vec3 a = tm(vUv - vec2(uPixel.x, 0.0)), b = tm(vUv - vec2(0.0, uPixel.y)), d = tm(vUv + vec2(uPixel.x, 0.0)), e = tm(vUv + vec2(0.0, uPixel.y));
      vec3 mn = min(min(min(a, b), min(d, e)), m), mx = max(max(max(a, b), max(d, e)), m);
      vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
      vec3 w = amp * (-1.0 / mix(8.0, 5.0, uSharp));
      vec3 c = clamp((m + (a + b + d + e) * w) / (1.0 + 4.0 * w), 0.0, 1.0);
      // FXAA (Lottes' lite variant) on edges only: flat areas keep the sharpened colour
      if (uFxaa > 0.5) {
        float lM = lum(m), lW = lum(a), lN = lum(b), lE = lum(d), lS = lum(e);
        float lMin = min(lM, min(min(lW, lN), min(lE, lS))), lMax = max(lM, max(max(lW, lN), max(lE, lS)));
        float range = lMax - lMin;
        if (range > max(0.0312, lMax * 0.125)) {
          vec2 dir = vec2(-(lN - lS), lW - lE);
          float reduce = max((lW + lN + lE + lS) * 0.03125, 1.0 / 128.0);
          float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
          dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uPixel;
          vec3 A = 0.5 * (tm(vUv + dir * (1.0 / 3.0 - 0.5)) + tm(vUv + dir * (2.0 / 3.0 - 0.5)));
          vec3 B = A * 0.5 + 0.25 * (tm(vUv - dir * 0.5) + tm(vUv + dir * 0.5));
          float lB = lum(B);
          vec3 f = (lB < lMin || lB > lMax) ? A : B;
          c = mix(c, f, smoothstep(0.03, 0.12, range));
        }
      }
      c = (c - 0.5) * uContrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation) * uTint + uLift;
      c *= mix(vec3(0.94, 0.98, 1.06), vec3(1.05, 1.0, 0.93), smoothstep(0.15, 0.75, l));
      vec2 q = vUv - 0.5;
      c *= 1.0 - uVignette * dot(q, q) * 2.2;
      c += (h(vUv * 1024.0 + uTime) - 0.5) * uGrain;
      c += uFlash * 0.25;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(size.x, size.y) });
    rt.depthTexture.type = THREE.UnsignedIntType;
    this.composer = new EffectComposer(renderer, rt);
    // EffectComposer clones rt for its second buffer; a cloned DepthTexture shares the same GPU
    // texture source, which would make depth sampling a feedback loop. Give it its own.
    const d2 = new THREE.DepthTexture(size.x, size.y);
    d2.type = THREE.UnsignedIntType;
    this.composer.renderTarget2.depthTexture = d2;
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.gtao = new GTAOPass(scene, camera, size.x, size.y);
    this.gtao.blendIntensity = 0.85;
    this.gtao.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 12 });
    this.composer.addPass(this.gtao);
    this.meter = new MeterPass();
    this.composer.addPass(this.meter);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.16, 0.28, 1.1); // tight glow on lights only
    // bloom is a soft glow: run its bright-pass and blur chain at half the internal resolution (~4x cheaper)
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSetSize(Math.max(2, Math.round(w / 2)), Math.max(2, Math.round(h / 2)));
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(FinalShader); // tone mapping + FXAA + sharpening + grade
    this.grade.material.toneMapped = false; // it does its own tone mapping
    this.composer.addPass(this.grade);
    // SMAA (3 extra full-screen passes) only on Ultra, after the final pass in display space
    this.smaa = new SMAAPass(size.x, size.y);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    // Composer dimensions are supplied in drawing-buffer pixels.
    this.composer.setPixelRatio(1);
    this.exposure = 1;
    this.autoExposure = true;
  }

  setSize() {
    const size = this.renderer.getDrawingBufferSize(this.bufferSize ||= new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
    this.grade.uniforms.uPixel.value.set(1 / size.x, 1 / size.y);
  }

  /** Sharpening strength from the render scale (1 = native pixels): more sharpening the more we upscale. */
  setSharpness(scale) { this.grade.uniforms.uSharp.value = clamp(0.3 + (1 - scale) * 1.1, 0.3, 1); }

  configure(q) {
    this.gtao.enabled = !!q.ao;
    this.bloom.enabled = !!q.bloom;
    this.smaa.enabled = q.aa === 'smaa';
    this.grade.uniforms.uFxaa.value = q.aa === 'smaa' || q.aa === false ? 0 : 1;
  }

  render(dt, { cinematic, cockpit, focusDist, night, flash }) {
    const cam = this.camera;
    // auto exposure (eye adaptation)
    if (this.autoExposure) {
      const target = clamp(lerp(0.134, 0.175, night) / Math.max(this.meter.avgLum, 1e-4), 0.42 + 0.24 * (1 - night), lerp(1.55, 2.65, night));
      const rate = target > this.exposure ? 1.1 : 2.6; // adapt to bright faster
      this.exposure = lerp(this.exposure, target, 1 - Math.exp(-rate * dt));
    }
    this.renderer.toneMappingExposure = this.exposure;
    this.grade.uniforms.pp_toneMappingExposure.value = this.exposure;
    // grade: slightly cooler at night, warmer in daylight
    const g = this.grade.uniforms;
    g.uTint.value.setRGB(lerp(1.02, 0.94, night), 1.0, lerp(0.97, 1.08, night));
    g.uTime.value = (g.uTime.value + dt * 60) % 1000;
    g.uFlash.value = flash * 0.4;
    this.composer.render(dt);
  }
}
