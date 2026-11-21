// The real game as a contender: loaded in a same-origin iframe (index.html, untouched), its animation loop stopped,
// then stepped one frame at a time through window.__dev with the camera forced onto the prototype's path.
// Two contenders share the iframe:
//   game-scene: GPU timer around the composer's RenderPass only (shadow map + the full scene, no post)
//   game-full:  GPU timer around post.composer.render (scene + GTAO/meter/bloom/final/SMAA as configured)
// Nothing is saved: the game stays in its menu state, settings are overridden in memory only.
import { WIDTH, HEIGHT, SHADOW_MAP, SHADOW_EXT, tick } from './common.js';

export async function createGameContender(iframe, data) {
  iframe.src = '/index.html';
  await new Promise((r) => (iframe.onload = r));
  const win = iframe.contentWindow;
  for (let i = 0; i < 1200 && !(win.__dev && win.__game); i++) await new Promise((r) => setTimeout(r, 100));
  if (!win.__dev) throw new Error('game did not finish loading (window.__dev missing)');
  const dev = win.__dev, g = dev.game;
  g.renderer.setAnimationLoop(null); // we drive frames
  const fixSize = () => {
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(WIDTH, HEIGHT, false);
    g.camera.aspect = WIDTH / HEIGHT;
    g.post.setSize();
  };
  g.resize = fixSize; // keep window resizes / settings from changing the size mid-bench
  fixSize();
  g.env.setShadowQuality(SHADOW_MAP, SHADOW_EXT); // match the prototype (Medium); in memory only
  g.env.setWeather('clear', true);
  if (g.settings.get('dynamicRes') !== false) g.updateDynamicResolution = () => {};

  const gl = g.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let pose = null, mode = 'full', query = null, cpu = 0;
  const placeCamera = () => {
    const c = g.camera;
    c.position.set(...pose.cam);
    c.lookAt(...pose.look);
    c.fov = 62; c.updateProjectionMatrix();
    c.updateMatrixWorld();
  };
  const begin = () => { query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query); return performance.now(); };
  const end = (t0) => { cpu = performance.now() - t0; gl.endQuery(ext.TIME_ELAPSED_EXT); };
  const postRender = g.post.render.bind(g.post);
  g.post.render = (dt, o) => {
    placeCamera();
    g.city.cull.update(g.camera.position, g.settings.quality.drawMul); // cull from the forced camera
    if (mode !== 'full') return postRender(dt, o); // 'scene' times inside RenderPass; 'none' times nothing
    const t0 = begin(); postRender(dt, o); end(t0);
  };
  const rp = g.post.renderPass, rpRender = rp.render.bind(rp);
  rp.render = (...a) => { if (mode !== 'scene') return rpRender(...a); const t0 = begin(); rpRender(...a); end(t0); };

  const frame = async (m, p) => {
    mode = m; pose = p;
    g.env.time = 14; g.env.timeSpeed = 0;
    dev.teleport(p.focus[0], p.focus[2], p.heading, 0.6);
    g.last = win.performance.now() - 1000 / 60; // the iframe clock has its own time origin
    query = null;
    g.frame();
    const info = g.renderer.info.render;
    const calls = info.calls, triangles = info.triangles;
    let gpu = NaN;
    if (query) {
      for (let n = 0; n < 5000; n++) {
        await tick();
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
          break;
        }
      }
      gl.deleteQuery(query);
    }
    return { cpu, gpu, calls, triangles };
  };
  const q = g.settings.quality;
  const info = { preset: g.settings.get('quality'), bloom: g.settings.get('bloom'), ao: g.settings.get('ao'), drawMul: q.drawMul, lights: q.streetLights, buffer: [g.renderer.domElement.width, g.renderer.domElement.height] };
  console.log('[proto] game contender', info);
  /** Whole game frame (simulation + render), n poses pipelined, one readPixels sync at the end: wall / n. */
  const throughput = async (poses) => {
    mode = 'none';
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (const p of poses) {
      pose = p;
      g.env.time = 14; g.env.timeSpeed = 0;
      dev.teleport(p.focus[0], p.focus[2], p.heading, 0.6);
      g.last = win.performance.now() - 1000 / 60; // the iframe clock has its own time origin
      g.frame();
      await tick();
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return (performance.now() - t0) / poses.length;
  };
  return [
    { name: 'game-scene', info, frame: (p) => frame('scene', p) },
    { name: 'game-full', info, frame: (p) => frame('full', p), throughput },
  ];
}
