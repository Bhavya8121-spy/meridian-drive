// Bench orchestrator: builds the same city twice (classic WebGLRenderer, WebGPURenderer + TSL) and optionally
// embeds the real game in an iframe, then walks every contender along one fixed camera path, interleaved
// round by round (A, B, C, A, B, C ... with the order rotated each round), because the GPU clock of a
// background pane swings ~2x between runs. Frames are rendered one at a time (no pipelining) so each GPU timer
// belongs to exactly one frame. Results: window.__results, and the table on the page.
import { loadData, median, pct, round2, tick, WIDTH, HEIGHT } from './common.js';
import { createWebGL } from './scene-webgl.js';
import { createWebGPU } from './scene-webgpu.js';
import { createGameContender } from './game-bench.js';

const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; console.log('[proto]', s); };
const params = new URLSearchParams(location.search);

async function main() {
  status('building layout + loading car kits…');
  const data = await loadData();
  const split = +(params.get('split') || 1);
  for (const id of ['cgl', 'cgpu']) { $(id).width = WIDTH; $(id).height = HEIGHT; }
  status('building WebGL scene…');
  const gl = await createWebGL($('cgl'), data, { split });
  status('building WebGPU scene…');
  let gpu = null;
  try { gpu = await createWebGPU($('cgpu'), data, { split }); } catch (e) { console.error(e); status('WebGPU failed: ' + e.message); }
  const contenders = [gl, gpu].filter(Boolean);
  if (params.has('game')) {
    document.body.classList.add('game');
    status('loading the game in the iframe…');
    contenders.push(...(await createGameContender($('game'), data)));
  }
  window.__proto = { data, contenders, runBench, playPath, snapshot, split };
  status(`ready · ${data.L.buildings.length} buildings, ${data.cars.length} cars, ${data.path.length} poses, split ${split} · ${contenders.map((c) => c.name).join(', ')}`);
  for (const c of contenders) await c.frame(data.path[10]);
  $('run').onclick = () => runBench({ post: false });
  $('runPost').onclick = () => runBench({ post: true });
  $('play').onclick = () => playPath();
  if (params.has('autorun')) runBench({ post: params.get('post') === '1', rounds: +(params.get('rounds') || 4) });
}

/** Render pose i on every contender and return one side-by-side JPEG data URL (works in a hidden pane). */
async function snapshot(i, width = 512) {
  const { data } = window.__proto;
  const contenders = window.__proto.contenders.filter((c) => c.renderer);
  const h = Math.round(width * HEIGHT / WIDTH);
  const out = document.createElement('canvas');
  out.width = width * contenders.length; out.height = h;
  const g = out.getContext('2d');
  for (let k = 0; k < contenders.length; k++) {
    const c = contenders[k];
    await c.frame(data.path[i]);
    if (c.readback) {
      const px = await c.readback(data.path[i], width, h); // linear: apply a display gamma for the preview
      const img = g.createImageData(width, h);
      for (let j = 0; j < px.length; j++) img.data[j] = (j & 3) === 3 ? 255 : 255 * Math.pow(px[j] / 255, 1 / 2.2);
      g.putImageData(img, k * width, 0);
    } else {
      c.renderer.render(c.world.scene, c.world.camera);
      g.drawImage(c.renderer.domElement, k * width, 0, width, h); // WebGL: same task as the render reads this frame
    }
  }
  return out.toDataURL('image/jpeg', 0.7);
}

/** Render every pose once on every contender (visual check, warms pipelines). */
async function playPath(stride = 3) {
  const { data, contenders } = window.__proto;
  for (let i = 0; i < data.path.length; i += stride) for (const c of contenders) { await c.frame(data.path[i]); await tick(); }
}

/**
 * opts: rounds (default 4), post (bloom + output chain on both prototype renderers), only (contender names),
 * stride (use every n-th pose). Returns per-contender medians over all frames and per-round medians.
 */
async function runBench(opts = {}) {
  const { rounds = 4, post = false, only = null, stride = 1 } = opts;
  const { data, contenders: all } = window.__proto;
  const contenders = all.filter((c) => !only || only.includes(c.name));
  for (const c of contenders) c.setPost?.(post);
  const poses = data.path.filter((_, i) => i % stride === 0);
  status(`warm-up (${contenders.length} contenders)…`);
  for (const c of contenders) for (const p of poses) await c.frame(p);
  const rec = Object.fromEntries(contenders.map((c) => [c.name, []]));
  const perRound = Object.fromEntries(contenders.map((c) => [c.name, []]));
  for (let r = 0; r < rounds; r++) {
    const order = contenders.map((_, i) => contenders[(i + r) % contenders.length]);
    for (const c of order) {
      status(`round ${r + 1}/${rounds} · ${c.name}`);
      const frames = [];
      for (let i = 0; i < poses.length; i++) {
        const f = await c.frame(poses[i]);
        frames.push({ ...f, seg: poses[i].seg, round: r });
      }
      rec[c.name].push(...frames);
      perRound[c.name].push(round2(median(frames.map((f) => f.gpu))));
    }
  }
  const latency = Object.fromEntries(contenders.filter((c) => c.latency).map((c) => [c.name, []]));
  if (opts.latency !== false) {
    for (let r = 0; r < 2; r++) for (const c of contenders.filter((c) => c.latency)) {
      status(`latency cross-check ${r + 1}/2 · ${c.name}`);
      for (let i = 0; i < poses.length; i += 2) latency[c.name].push(await c.latency(poses[i]));
    }
  }
  // throughput: n pipelined frames per sample, interleaved, 3 rounds
  const thr = Object.fromEntries(contenders.filter((c) => c.throughput).map((c) => [c.name, { street: [], aerial: [] }]));
  if (opts.throughput !== false) {
    for (let r = 0; r < 3; r++) for (const c of contenders.filter((c) => c.throughput)) {
      status(`throughput ${r + 1}/3 · ${c.name}`);
      for (const seg of ['street', 'aerial']) {
        const ps = poses.filter((p) => p.seg === seg);
        for (let k = 0; k + 30 <= ps.length; k += 30) thr[c.name][seg].push(await c.throughput(ps.slice(k, k + 30)));
      }
    }
  }
  const summary = {};
  for (const [name, frames] of Object.entries(rec)) {
    const by = (seg) => frames.filter((f) => !seg || f.seg === seg);
    const s = (arr, k) => round2(median(arr.map((f) => f[k]).filter(Number.isFinite)));
    summary[name] = {
      gpuMedian: s(by(), 'gpu'), gpuP90: round2(pct(by().map((f) => f.gpu).filter(Number.isFinite), 0.9)),
      gpuStreet: s(by('street'), 'gpu'), gpuAerial: s(by('aerial'), 'gpu'),
      cpuMedian: s(by(), 'cpu'), cpuStreet: s(by('street'), 'cpu'), cpuAerial: s(by('aerial'), 'cpu'),
      callsStreet: s(by('street'), 'calls'), callsAerial: s(by('aerial'), 'calls'),
      trisStreet: Math.round(median(by('street').map((f) => f.triangles))), trisAerial: Math.round(median(by('aerial').map((f) => f.triangles))),
      gpuPerRound: perRound[name], frames: frames.length,
      latencyMedian: latency[name]?.length ? round2(median(latency[name])) : undefined,
      frameMsStreet: thr[name] ? round2(median(thr[name].street)) : undefined,
      frameMsAerial: thr[name] ? round2(median(thr[name].aerial)) : undefined,
    };
    if (frames[0]?.byTag) {
      const tags = [...new Set(frames.flatMap((f) => Object.keys(f.byTag || {})))];
      summary[name].gpuByPassType = Object.fromEntries(tags.map((t) => [t, round2(median(frames.map((f) => f.byTag?.[t] ?? 0)))]));
    }
    if (frames[0]?.perPass) {
      const n = median(frames.map((f) => f.perPass.length));
      summary[name].gpuPerPass = Array.from({ length: n }, (_, k) => round2(median(frames.filter((f) => f.perPass.length === n).map((f) => f.perPass[k]))));
    }
  }
  const result = { when: new Date().toISOString(), post, rounds, split: window.__proto.split, size: [WIDTH, HEIGHT], ua: navigator.userAgent, summary };
  (window.__results ||= []).push(result);
  showTable(result);
  status(`done · ${rounds} rounds × ${poses.length} poses · post ${post}`);
  return result;
}

function showTable({ summary, post, split }) {
  const cols = [['gpuMedian', 'GPU ms (med)'], ['gpuP90', 'GPU p90'], ['gpuStreet', 'GPU street'], ['gpuAerial', 'GPU aerial'], ['cpuMedian', 'CPU submit ms'], ['cpuStreet', 'CPU street'], ['cpuAerial', 'CPU aerial'], ['callsStreet', 'draws street'], ['callsAerial', 'draws aerial'], ['trisStreet', 'tris street'], ['frameMsStreet', 'frame ms street (pipelined)'], ['frameMsAerial', 'frame ms aerial (pipelined)'], ['latencyMedian', 'render→idle ms'], ['gpuByPassType', 'GPU by pass type'], ['gpuPerRound', 'GPU per round']];
  const head = `<tr><th>post ${post} · split ${split}</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr>`;
  const rows = Object.entries(summary).map(([n, s]) => `<tr><td>${n}</td>${cols.map(([k]) => `<td>${Array.isArray(s[k]) ? s[k].join(' / ') : s[k] && typeof s[k] === 'object' ? Object.entries(s[k]).map(([a, b]) => a + ' ' + b).join(', ') : s[k] ?? ''}</td>`).join('')}</tr>`).join('');
  $('results').insertAdjacentHTML('afterbegin', head + rows);
}

main().catch((e) => { console.error(e); status('error: ' + e.message); });
