// Contender A: three's classic WebGLRenderer (what the game ships), the facade as an onBeforeCompile GLSL patch.
// GPU time: EXT_disjoint_timer_query_webgl2 around the whole frame (shadow pass + main pass [+ post]).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildScene, WIDTH, HEIGHT, tick } from './common.js';
import { facadeParams, NIGHT } from './facade-params.js';

const FACADE_GLSL_HEAD = /* glsl */`
varying vec3 vWPos; varying vec3 vWNormal;
uniform vec3 uStone; uniform vec3 uGlass; uniform float uBayW; uniform float uFloorH; uniform vec3 uMargin;
uniform float uStore; uniform float uLit; uniform float uRough; uniform float uMetal; uniform float uGlassMetal; uniform float uNight;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

function facadeMaterial(name, st) {
  const P = facadeParams(st);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: P.rough, metalness: P.metal });
  const u = {
    uStone: { value: new THREE.Color(...P.stone) }, uGlass: { value: new THREE.Color(...P.glass) }, uBayW: { value: P.bayW }, uFloorH: { value: P.floorH },
    uMargin: { value: new THREE.Vector3(...P.margin) }, uStore: { value: P.store }, uLit: { value: P.lit }, uRough: { value: P.rough },
    uMetal: { value: P.metal }, uGlassMetal: { value: P.glassMetal }, uNight: { value: NIGHT },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 wp = vec4(transformed, 1.0); vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp; wn = mat3(instanceMatrix) * wn;
          #endif
          wp = modelMatrix * wp; vWPos = wp.xyz; vWNormal = normalize(mat3(modelMatrix) * wn); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FACADE_GLSL_HEAD)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 fN = normalize(vWNormal);
        float isWall = 1.0 - step(0.5, abs(fN.y));
        vec2 fc = vec2(dot(vWPos.xz, vec2(-fN.z, fN.x)), vWPos.y);
        vec2 cell = fc / vec2(uBayW, uFloorH);
        vec2 cid = floor(cell); vec2 f = fract(cell);
        float win = step(uMargin.x, f.x) * step(f.x, 1.0 - uMargin.x) * step(uMargin.y, f.y) * step(f.y, 1.0 - uMargin.z);
        float sx = fract(fc.x / 4.2);
        float shop = uStore * step(fc.y, 4.4);
        win = mix(win, step(0.07, sx) * step(sx, 0.93) * step(0.35, fc.y) * step(fc.y, 3.5), shop) * isWall;
        float wh = hash12(cid * 1.37 + floor(vWPos.xz / 61.0) * 7.13);
        float brick = 0.85 + 0.3 * hash12(floor(fc * vec2(4.0, 13.0)));
        vec3 wallCol = uStone * brick * mix(0.55, 1.0, smoothstep(0.1, 2.6, fc.y));
        wallCol = mix(vec3(0.3, 0.3, 0.29) * brick, wallCol, isWall);
        vec3 glassCol = uGlass * (0.75 + 0.5 * wh);
        diffuseColor.rgb *= mix(wallCol, glassCol, win);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(uRough * brick, 0.05 + wh * 0.06, win);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(uMetal, uGlassMetal, win) * isWall;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float lit = step(1.0 - uLit, hash12(cid * 2.71 + floor(vWPos.xz / 53.0) * 3.7 + fN.xz));
          vec3 warm = mix(vec3(1.0, 0.68, 0.38), vec3(0.8, 0.88, 1.0), step(0.72, hash12(cid + 5.3)));
          totalEmissiveRadiance += win * lit * uNight * warm * 0.55; }`);
  };
  mat.customProgramCacheKey = () => 'proto_facade_' + name;
  return mat;
}

export async function createWebGL(canvas, data, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false; // count every pass of a frame (shadow, scene, post)
  const loader = new THREE.TextureLoader();
  const load = async (f, srgb) => { const t = await loader.loadAsync('assets/textures/' + f); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t; };
  const sets = {};
  for (const [k, id] of [['asphalt', 'asphalt_02'], ['concrete', 'concrete_pavement']]) {
    const [map, normalMap, roughnessMap] = await Promise.all([load(id + '_col.jpg', true), load(id + '_nor.jpg', false), load(id + '_rough.jpg', false)]);
    sets[k] = { map, normalMap, roughnessMap };
  }
  const mats = {
    facade: facadeMaterial,
    ground: (k) => new THREE.MeshStandardMaterial({ ...sets[k], roughness: 1, color: k === 'asphalt' ? 0xc8c8c8 : 0xb2b6ba }),
    std: (o) => new THREE.MeshStandardMaterial({ color: o.color, roughness: o.roughness, metalness: o.metalness ?? 0, map: o.map || null, alphaTest: o.alphaTest || 0 }),
    basic: (o) => new THREE.MeshBasicMaterial(o),
    texture: (t) => t,
  };
  const world = buildScene(THREE, mats, data, opts);
  const { scene, camera } = world;

  // optional post chain: scene -> half-res bloom -> output (tone map + sRGB), the minimum the game runs
  const rt = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(WIDTH / 2, HEIGHT / 2), 0.16, 0.28, 1.1);
  const bs = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bs(Math.round(w / 2), Math.round(h / 2));
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.setSize(WIDTH, HEIGHT);

  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let post = false, shadowHook = null;
  const shadowRender = renderer.shadowMap.render.bind(renderer.shadowMap);
  renderer.shadowMap.render = (...a) => { shadowRender(...a); shadowHook?.(); };
  return {
    name: 'webgl', renderer, world,
    setPost(v) { post = v; },
    /** Render one frame; resolves with { cpu, gpu, calls, triangles } once the GPU timer is available. */
    async frame(pose) {
      world.setPose(pose);
      // two back-to-back (not nested) timer queries: [start .. shadow map done] and [shadow map done .. frame end]
      const qShadow = gl.createQuery(), qRest = gl.createQuery();
      let split = false;
      shadowHook = () => { if (!split) { gl.endQuery(ext.TIME_ELAPSED_EXT); gl.beginQuery(ext.TIME_ELAPSED_EXT, qRest); split = true; } };
      gl.beginQuery(ext.TIME_ELAPSED_EXT, qShadow);
      renderer.info.reset();
      const t0 = performance.now();
      if (post) composer.render(); else renderer.render(scene, camera);
      const cpu = performance.now() - t0;
      if (!split) { gl.endQuery(ext.TIME_ELAPSED_EXT); gl.beginQuery(ext.TIME_ELAPSED_EXT, qRest); }
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      shadowHook = null;
      const calls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
      const read = async (q) => {
        for (let n = 0; n < 5000; n++) {
          await tick();
          if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
            const v = gl.getParameter(ext.GPU_DISJOINT_EXT) ? NaN : gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
            gl.deleteQuery(q);
            return v;
          }
        }
        return NaN;
      };
      const shadow = await read(qShadow), rest = await read(qRest);
      return { cpu, gpu: shadow + rest, byTag: { shadow, rest }, calls, triangles };
    },
    /** Frame cost without GPU timers: render n poses back to back (pipelined), sync once, wall / n. */
    async throughput(poses) {
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (const p of poses) {
        world.setPose(p);
        if (post) composer.render(); else renderer.render(scene, camera);
        await tick();
      }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // blocks until the GPU has finished everything
      return (performance.now() - t0) / poses.length;
    },
    /** Timer-independent cross-check: wall time from render() until a 1-pixel readPixels returns (GPU idle). */
    async latency(pose) {
      world.setPose(pose);
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      if (post) composer.render(); else renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return performance.now() - t0;
    },
  };
}
