// Contender B: three r170 WebGPURenderer, the same scene with the facade written as a TSL node graph.
// GPU time: our own WebGPU timestamp queries, injected into every render pass of the frame (three's built-in
// trackTimestamp only times one render context at a time and drops the shadow pass), summed per frame.
import * as W from '/node_modules/three/build/three.webgpu.js';
import { Fn, uniform, vec2, vec3, float, positionWorld, normalWorld, step, abs, dot, floor, fract, mix, smoothstep, normalize, pass } from '/node_modules/three/build/three.webgpu.js';
import { bloom } from './bloom-node.js';
import { buildScene, WIDTH, HEIGHT, tick } from './common.js';
import { facadeParams, NIGHT } from './facade-params.js';

const uNight = uniform(NIGHT);
const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

function facadeMaterial(name, st) {
  const P = facadeParams(st);
  const mat = new W.MeshStandardNodeMaterial({ color: 0xffffff, roughness: P.rough, metalness: P.metal });
  const uStone = uniform(new W.Color(...P.stone)), uGlass = uniform(new W.Color(...P.glass));
  const uBayW = uniform(P.bayW), uFloorH = uniform(P.floorH), uMargin = uniform(new W.Vector3(...P.margin));
  const uStore = uniform(P.store), uLit = uniform(P.lit), uRough = uniform(P.rough), uMetal = uniform(P.metal), uGlassMetal = uniform(P.glassMetal);

  // shared sub-graph; TSL de-duplicates identical nodes, so color/roughness/metal/emissive reuse one evaluation
  const wp = positionWorld, fN = normalize(normalWorld);
  const isWall = float(1).sub(step(0.5, abs(fN.y)));
  const fc = vec2(dot(wp.xz, vec2(fN.z.negate(), fN.x)), wp.y);
  const cell = fc.div(vec2(uBayW, uFloorH));
  const cid = floor(cell), f = fract(cell);
  const winGrid = step(uMargin.x, f.x).mul(step(f.x, uMargin.x.oneMinus())).mul(step(uMargin.y, f.y)).mul(step(f.y, uMargin.z.oneMinus()));
  const sx = fract(fc.x.div(4.2));
  const shop = uStore.mul(step(fc.y, 4.4));
  const storefront = step(0.07, sx).mul(step(sx, 0.93)).mul(step(0.35, fc.y)).mul(step(fc.y, 3.5));
  const win = mix(winGrid, storefront, shop).mul(isWall);
  const wh = hash12(cid.mul(1.37).add(floor(wp.xz.div(61)).mul(7.13)));
  const brick = hash12(floor(fc.mul(vec2(4, 13)))).mul(0.3).add(0.85);
  const wallCol = mix(vec3(0.3, 0.3, 0.29).mul(brick), uStone.mul(brick).mul(mix(0.55, 1.0, smoothstep(0.1, 2.6, fc.y))), isWall);
  const glassCol = uGlass.mul(wh.mul(0.5).add(0.75));

  mat.colorNode = mix(wallCol, glassCol, win); // instance tint is multiplied in by NodeMaterial
  mat.roughnessNode = mix(uRough.mul(brick), wh.mul(0.06).add(0.05), win);
  mat.metalnessNode = mix(uMetal, uGlassMetal, win).mul(isWall);
  const lit = step(uLit.oneMinus(), hash12(cid.mul(2.71).add(floor(wp.xz.div(53)).mul(3.7)).add(fN.xz)));
  const warm = mix(vec3(1.0, 0.68, 0.38), vec3(0.8, 0.88, 1.0), step(0.72, hash12(cid.add(5.3))));
  mat.emissiveNode = warm.mul(win.mul(lit).mul(uNight).mul(0.55));
  mat.name = 'proto_facade_' + name;
  return mat;
}

/** Times every render/compute pass between begin() and end() with timestamp queries. */
class PassTimer {
  constructor(device, max = 64) {
    this.device = device; this.max = max; this.n = 0; this.active = false; this.tags = [];
    this.qs = device.createQuerySet({ type: 'timestamp', count: max * 2 });
    this.resolveBuf = device.createBuffer({ size: max * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBuf = device.createBuffer({ size: max * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const self = this, orig = GPUCommandEncoder.prototype.beginRenderPass;
    if (!orig.__protoTimed) {
      GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
        const t = window.__passTimer;
        if (t && t.active && t.n < t.max && !desc.timestampWrites) {
          desc = { ...desc, timestampWrites: { querySet: t.qs, beginningOfPassWriteIndex: t.n * 2, endOfPassWriteIndex: t.n * 2 + 1 } };
          const c = desc.colorAttachments?.filter(Boolean) || [];
          t.tags[t.n] = c.length === 0 ? 'shadow' : desc.depthStencilAttachment ? 'scene' : 'fullscreen';
          t.n++;
        }
        return orig.call(this, desc);
      };
      GPUCommandEncoder.prototype.beginRenderPass.__protoTimed = true;
    }
    window.__passTimer = self;
  }
  begin() { this.n = 0; this.active = true; }
  async end() {
    this.active = false;
    const n = this.n;
    if (!n) return { sum: NaN, span: NaN, passes: 0 };
    const enc = this.device.createCommandEncoder();
    enc.resolveQuerySet(this.qs, 0, n * 2, this.resolveBuf, 0);
    enc.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, n * 16);
    this.device.queue.submit([enc.finish()]);
    await this.readBuf.mapAsync(GPUMapMode.READ, 0, n * 16);
    const t = new BigUint64Array(this.readBuf.getMappedRange(0, n * 16).slice(0));
    this.readBuf.unmap();
    let sum = 0, lo = Infinity, hi = -Infinity;
    const per = [];
    for (let i = 0; i < n; i++) {
      const a = Number(t[i * 2]), b = Number(t[i * 2 + 1]);
      per.push(b > a ? (b - a) / 1e6 : 0);
      if (b > a) sum += b - a;
      lo = Math.min(lo, a); hi = Math.max(hi, b);
    }
    const byTag = {};
    per.forEach((v, i) => { byTag[this.tags[i]] = (byTag[this.tags[i]] || 0) + v; });
    return { sum: sum / 1e6, span: (hi - lo) / 1e6, passes: n, per, byTag };
  }
  /** Timestamp floor on this GPU: one empty 64x64 clear pass, timed the same way. */
  async calibrate(runs = 30) {
    const tex = this.device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const out = [];
    for (let i = 0; i < runs; i++) {
      this.begin();
      const enc = this.device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }).end();
      this.device.queue.submit([enc.finish()]);
      out.push((await this.end()).sum);
    }
    tex.destroy();
    return out.sort((a, b) => a - b)[runs >> 1];
  }
}

export async function createWebGPU(canvas, data, opts = {}) {
  const renderer = new W.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  await renderer.init();
  if (renderer.backend.isWebGLBackend) throw new Error('WebGPU unavailable: three fell back to its WebGL2 backend');
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.toneMapping = W.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = W.PCFSoftShadowMap;
  const device = renderer.backend.device;
  window.__gpuErrors = [];
  device.addEventListener('uncapturederror', (e) => { if (window.__gpuErrors.length < 20) window.__gpuErrors.push(e.error.message); });
  const timer = device.features.has('timestamp-query') ? new PassTimer(device) : null;

  const loader = new W.TextureLoader();
  const load = async (f, srgb) => { const t = await loader.loadAsync('assets/textures/' + f); t.colorSpace = srgb ? W.SRGBColorSpace : W.NoColorSpace; t.wrapS = t.wrapT = W.RepeatWrapping; t.anisotropy = 8; return t; };
  const sets = {};
  for (const [k, id] of [['asphalt', 'asphalt_02'], ['concrete', 'concrete_pavement']]) {
    const [map, normalMap, roughnessMap] = await Promise.all([load(id + '_col.jpg', true), load(id + '_nor.jpg', false), load(id + '_rough.jpg', false)]);
    sets[k] = { map, normalMap, roughnessMap };
  }
  const texCache = new Map();
  const mats = {
    facade: facadeMaterial,
    ground: (k) => new W.MeshStandardNodeMaterial({ ...sets[k], roughness: 1, color: k === 'asphalt' ? 0xc8c8c8 : 0xb2b6ba }),
    std: (o) => new W.MeshStandardNodeMaterial({ color: o.color, roughness: o.roughness, metalness: o.metalness ?? 0, map: o.map || null, alphaTest: o.alphaTest || 0 }),
    basic: (o) => new W.MeshBasicNodeMaterial(o),
    // re-wrap a texture from the 'three' module copy (glTF car textures) for this renderer
    texture: (src) => {
      if (texCache.has(src.uuid)) return texCache.get(src.uuid);
      const t = new W.Texture(src.image);
      t.flipY = src.flipY; t.colorSpace = src.colorSpace; t.wrapS = src.wrapS; t.wrapT = src.wrapT; t.anisotropy = 4;
      t.needsUpdate = true;
      texCache.set(src.uuid, t);
      return t;
    },
  };
  const world = buildScene(W, mats, data, opts);
  const { scene, camera } = world;

  // optional post chain: scene pass -> half-res bloom -> output transform (AgX + sRGB), mirroring the WebGL side
  const postFx = new W.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  const bloomNode = bloom(sceneColor, 0.16, 0.28, 1.1);
  const bs = bloomNode.setSize.bind(bloomNode);
  bloomNode.setSize = (w, h) => bs(Math.round(w / 2), Math.round(h / 2));
  postFx.outputNode = sceneColor.add(bloomNode);

  let post = false, snapRT = null;
  return {
    name: 'webgpu', renderer, world,
    setPost(v) { post = v; },
    /** Render a pose into a render target and read it back (canvas readback is stale in a hidden pane). Linear RGBA8. */
    async readback(pose, w = 512, h = 288) {
      snapRT ||= new W.RenderTarget(w, h);
      world.setPose(pose);
      renderer._nodes.nodeFrame.update();
      renderer.setRenderTarget(snapRT);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      return renderer.readRenderTargetPixelsAsync(snapRT, 0, 0, w, h);
    },
    async frame(pose) {
      world.setPose(pose);
      // r170 advances its node frame only from its own requestAnimationFrame loop; we render several frames per
      // task (and rAF stops in a hidden pane), so advance it here or per-frame uniform updates are skipped
      renderer._nodes.nodeFrame.update();
      renderer.info.frame = renderer._nodes.nodeFrame.frameId;
      renderer.info.reset();
      timer?.begin();
      const t0 = performance.now();
      if (post) postFx.render(); else renderer.render(scene, camera);
      const cpu = performance.now() - t0;
      const info = renderer.info.render;
      const calls = info.drawCalls, triangles = info.triangles;
      const g = timer ? await timer.end() : { sum: NaN, span: NaN, passes: 0 };
      return { cpu, gpu: g.sum, gpuSpan: g.span, passes: g.passes, perPass: g.per, byTag: g.byTag, calls, triangles };
    },
    calibrate: () => timer?.calibrate(),
    /** Frame cost without GPU timers: render n poses back to back (pipelined), wait for the GPU queue, wall / n. */
    async throughput(poses) {
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      for (const p of poses) {
        world.setPose(p);
        renderer._nodes.nodeFrame.update();
        if (post) postFx.render(); else renderer.render(scene, camera);
        await tick();
      }
      await device.queue.onSubmittedWorkDone();
      return (performance.now() - t0) / poses.length;
    },
    /** Timer-independent cross-check: wall time from render() until the GPU queue has drained. */
    async latency(pose) {
      world.setPose(pose);
      renderer._nodes.nodeFrame.update();
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      if (post) postFx.render(); else renderer.render(scene, camera);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    },
  };
}
