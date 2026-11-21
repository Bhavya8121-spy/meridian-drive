# WebGPU (three r170 `WebGPURenderer`) for Meridian Drive — findings

**Recommendation: no-go for now.** On the same scene and the same camera path, three r170's WebGPU renderer was
**no faster on the GPU** (within ±10% at native resolution, about 18% faster only on the bloom-heavy 3200×1800 street
case). It was **about 3–4× slower on the CPU** per draw call. The game is already CPU-heavy (about 14 ms, with 9 ms
of that in draw submission), so a port would make frames slower. The port would also take about 3–5 weeks, I hit 3
correctness bugs in r170's WebGPU path while prototyping, and WebGPU is still missing on Linux Firefox, Android
Firefox and Safari before 26. Re-run this bench (below) after a three.js upgrade before reconsidering.

Everything here was measured in this session; the raw numbers are in [`results.json`](results.json).

## Setup

- **Machine:** Apple M4 (integrated GPU) on macOS, Chrome 156 (the Claude desktop browser pane, hidden while
  measuring). WebGL goes through ANGLE → Metal and WebGPU through Dawn → Metal. three.js r170. Drawing buffer
  1600×900 unless noted (`?res=2` gives 3200×1800).
- **Prototype** ([`webgpu.html`](webgpu.html)). It builds one scene from `src/world/layout.js` twice: once with the
  classic `WebGLRenderer` and once with `WebGPURenderer`. Only the materials differ: a GLSL `onBeforeCompile`
  facade versus the same facade written as a TSL node graph.
  - Buildings: 611, as instanced unit boxes chunked per style and 400 m cell (like the game).
  - Cars: 853, from the imported glTF traffic LOD kits (`gltfCars.js`), as one instanced mesh per part and 100 m
    chunk, culled at 150 m. The player car uses the full-detail model.
  - Ground and roads use the Poly Haven photo textures.
  - Lighting: one directional light with a 2048 PCF-soft shadow over ±75 m (the Medium preset), hemisphere light,
    fog, AgX tone mapping.
  - Draws: 372 on the street, 454 in the aerial view, with 1.39 M / 1.09 M triangles. Both backends issue the same
    draws to within ±1. Both render the same image: compare [street](shots/street-chase.jpg),
    [east turn](shots/street-east.jpg) and [aerial](shots/aerial.jpg), with WebGL on the left and WebGPU on the right
    (WebGPU is read back linear, so it looks brighter).
- **Camera path:** 180 fixed poses. The first 126 follow a chase camera north up the x=0 arterial and turn east on
  z=300 ("street"). The last 54 orbit over downtown ("aerial").
- **Real game:** `?game=1` loads `index.html` unchanged in an iframe and stops its loop. The prototype then drives
  `window.__dev` frames with the camera forced onto the same path, which you can see in [this shot](shots/game-same-path.jpg).
  It runs on the user's Medium preset, overridden in memory only: bloom on, AO off, 2048 shadow, nothing saved.
- **Method:** contenders run interleaved round by round, with the order rotated each round, and every figure is a
  median.
- **Metrics:**
  - `CPU`: main-thread time inside `render()`.
  - `frame ms`: pipelined throughput. 30 poses are rendered back to back, then one GPU sync, then wall time ÷ 30.
    It is the same method on both backends and does not depend on GPU timers.
  - GPU timers: the WebGL timer wraps the whole frame (`EXT_disjoint_timer_query_webgl2`). On WebGPU, timestamp
    queries are injected into every render pass.

### Why the WebGPU timestamps are not used

On this GPU the summed WebGPU per-pass timestamps are not usable. With the bloom chain they add up to 35 ms
(15 passes at about 2 ms each, including 1/32-resolution mips) while the same frames pipeline at 7.8 ms each, which
is impossible. An empty pass calibrates to 0 ms, so this is not a fixed timer floor. Apple's tiled GPU overlaps
passes and their begin/end intervals overlap. The WebGL timer also over-reads compared with throughput (6.7 ms
against 4.4 ms). All cross-backend GPU conclusions below therefore use **frame ms**.

## Results

### Same scene, both backends

Frame ms is shown as street / aerial.

| Run (1600×900 unless noted) | WebGL frame ms | WebGPU frame ms | WebGL CPU | WebGPU CPU |
|---|---|---|---|---|
| A3: scene only | **4.4 / 3.7** | 7.4 / 7.7 | 2.1 | 6.3 |
| B3: scene + half-res bloom + output pass | 8.0 / 7.0 | 7.8 / 7.5 | 2.1 | 7.2 |
| E1: same as B3, interleaved with the game | **6.3 / 5.2** | 8.5 / 7.7 | 2.3 | 8.0 |
| C1: 3200×1800, scene only (GPU-bound) | **10.6 / 6.2** | 11.3 / 10.9 | 2.6 | 7.6 |
| C2: 3200×1800, scene + bloom (GPU-bound) | 17.3 / 11.3 | **14.2 / 11.3** | 4.5 | 8.0 |
| D1: `split=3`, chunks a third the size (455 / 652 draws) | **5.1 / 4.6** | 9.4 / 9.5 | 3.2 / 3.8 | 9.7 / 13.5 |

Repeatability: the CPU figures in A1, A2 and B2 match these (WebGL 2.5–2.8 ms, WebGPU 7.5–8.8 ms).

- **CPU, the opposite of the hoped-for win.** Each draw costs the main thread about **6.5 µs in WebGL** and about
  **25 µs in r170 WebGPU** (D1 against A3, aerial, 454 → 652 draws). In r170, the per-object work in TSL/`RenderObject`
  (node frame updates, monitors, bindings) outweighs WebGPU's cheaper API calls. This is a property of three r170,
  not of WebGPU: the prototype issues the same draws, with no render bundles in either backend.
- **GPU: parity.** With the CPU taken out (3200×1800), the plain scene is within 7% on the street. WebGPU's bloom
  chain is about 18% cheaper on the street case. The aerial cases tie or are CPU-limited. r170 WebGPU always renders
  into a half-float target plus an output pass when tone mapping is on. That costs time in the scene-only runs but
  is free once a post chain exists, as it does in the game.

### The real game, same path and session (E1)

| | Value |
|---|---|
| Draws / triangles | 485–576 / 2.3–2.6 M |
| CPU in `post.render` | 4.2 ms |
| GPU timer, scene + shadow pass only | 13.0 ms |
| GPU timer, whole composer | 21.3 ms |
| Whole game frame, pipelined (simulation + render) | **12.8 / 12.5 ms** |

On the same timer, the prototype's scene with post costs 8.2 ms, about 40% of the game's composer. The rest is the
prewar facade shader, props, trees and the final pass (CAS + FXAA + grade).

**Projection for the game on r170 WebGPU:**

- GPU stays about the same, within ±10%.
- Draw submission would grow from about 4 ms to about 12–14 ms (485–576 draws at about 25 µs each). That pushes the
  CPU frame from about 14 ms to over 20 ms.

**Net: slower.** The fidelity side gains nothing unless the port is used to add things that need compute. The
features that matter for fidelity (PBR, shadows, GTAO, bloom, SMAA, PMREM) all exist in both backends.

## What blocks a port: inventory and TSL equivalents

| Piece | What it does today | TSL / WebGPU equivalent | Effort |
|---|---|---|---|
| `patchWet` (`render/materials.js`), on about 12 ground and marking materials | Injects world position and normal varyings. Puddle-map sampling, darker albedo, roughness override, normal flattening plus rain-ripple normals, all at `#include` splice points. | `colorNode` / `roughnessNode` / `normalNode` built from `positionWorld`, `texture()` and a ripple `Fn`. Shared `WORLD` uniforms become TSL `uniform()`s. | 1–2 days |
| `makeFacadeMaterial` (older facade) | Window grid, storefronts and lit windows. | Done in the prototype (`scene-webgpu.js`, about 40 lines). | 0.5 day |
| Prewar facade (`render/buildingMaterial.js`): about 170 lines of `FRAG_BODY` plus roughness, metalness, normal and emissive patches, and a `lights_fragment_maps` splice | Recovers base and top from `instanceMatrix`. Parallax windows, interior mapping, `farDetail` footprint filtering with derivatives. The "canyon" patch scales `radiance` **inside the lighting model**. | Node graph with `dFdx`/`fwidth` and per-instance attributes (or `instanceIndex` + buffer) for base and top. The canyon term needs a custom `LightingModel` or an `envNode` built from `reflectVector`. It has no splice point, which makes it the hardest piece. | 4–7 days, including visual matching |
| `patchSway` | Vertex wind sway | `positionNode` | 0.5 day |
| `fadeMaterial` (`world/batching.js`) | Clones any material and adds per-instance distance plus a dithered (IGN) discard on top of the other patches. `onBeforeRender` mirrors runtime colour and emissive. | A wrapper that composes onto existing nodes, using `screenCoordinate` and `If(...).discard()` in the material's output or alpha path. Node composition is cleaner than string splicing here. | 1 day |
| `environment.js` | three `Sky`, a cloud/star dome `ShaderMaterial` (about 40 lines), rain streaks (VS + FS), a city-HDRI blend sphere for the reflection capture, `PMREMGenerator` | r170 ships `SkyMesh` (TSL). The others become `NodeMaterial`s with `fragmentNode`/`positionNode`. Use the node-based PMREM. | 2–3 days |
| Other `ShaderMaterial`s: sparks, headlight beams, showroom | Small effects | Small to port, but **sparks use `THREE.Points` with `gl_PointSize`, and WebGPU has 1-px points only**, so they need instanced quads. | 1 day |
| Post (`render/postfx.js`): `EffectComposer` with GTAO, `MeterPass`, UnrealBloom, `FinalShader` (AgX, CAS, FXAA, grade) and SMAA | Merged into one final pass for cost. | `PostProcessing`, `pass()`, `GTAONode`, `BloomNode`, `SMAANode`/`FXAANode` (all in r170), plus `FinalShader` as one TSL `Fn` using `agxToneMapping`. The meter can keep `readRenderTargetPixelsAsync`, or become a compute reduction (a real WebGPU win, but a small one). | 3–5 days |
| WebGL-specific glue | Dev tools (`toDataURL` captures, `gl.finish` bench), `WebGLRenderTarget`/`DepthTexture` setup, `renderer.compile`, `info.render.calls`, timer queries | Equivalents exist, but canvas readback is stale in a hidden pane (see below), so `__dev.capture` needs a render-target readback. | 1–2 days |
| Visual parity, bug workarounds and perf tuning | | See the r170 issues below | 1–2 weeks |

Total: about **3–5 weeks**. Upgrading three.js first (r170 is from October 2024) is probably required and has its
own migration cost.

### r170 WebGPU issues hit while prototyping (porting risk)

1. **A 1-instance `InstancedMesh` shares compiled state with plain meshes.**
   - Cause: `RenderObject.getMaterialCacheKey()` adds `object.uuid` only when `count > 1`. An `InstancedMesh` with
     one instance therefore shares a `NodeBuilderState` with plain `Mesh`es whose material values are equal.
   - Effect: one of them draws with the other's program. In the prototype the player car's body, glass and lamps
     were invisible and parked cars rendered as wheels only. No validation error was raised.
   - Exposure: the game's chunked batching produces 1-instance chunks all the time.
   - Workaround in the prototype: pad every batch to at least 2 instances, with the extra one at zero scale. I did
     this for both backends to keep the comparison fair.
   - Side effect: every `count > 1` batch gets its own node build, because the uuid is part of the key.
2. **The node frame counter only advances in the renderer's internal `requestAnimationFrame` loop**
   (`Animation.js`). Several renders per rAF, or renders in a hidden pane, see a stale `frameId`. The game's
   `setAnimationLoop` is fine, but `__dev.step()`'s multi-frame stepping would not be. The prototype calls
   `nodeFrame.update()` itself.
3. **`MeshBasicNodeMaterial.clone()` drops the colour** (it comes back `ffffff`). `fadeMaterial` relies on `clone()`.
4. Practicalities, not bugs:
   - In a hidden pane, `toDataURL`/`drawImage` of a WebGPU canvas returns the last *presented* frame.
   - Timestamp queries are unusable for per-pass costs on Apple GPUs (see Setup).
   - The renderer always renders through a half-float target plus an output pass when tone mapping is on.

## Browser support

Status per the [gpuweb implementation-status wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
(edited May 2026) and [web.dev, November 2025](https://web.dev/blog/webgpu-supported-major-browsers):

- **Chrome / Edge:** desktop since 113 (Windows, macOS, ChromeOS), Android 12+ since 121 (Qualcomm/ARM; Imagination
  GPUs from 139). Linux was still listed as in progress.
- **Safari:** macOS Tahoe 26, iOS / iPadOS / visionOS 26. Nothing before 26.
- **Firefox:** Windows since 141, Apple Silicon macOS 26+ since 145, all macOS since 147. **Linux is not shipped**
  (expected in 2026). Android is off by default.

A port would therefore still need a WebGL path. three's `WebGPURenderer` can fall back to its own WebGL2 backend,
but that runs the same TSL/node CPU path, which is the part measured as slower here. In practice that means keeping
two renderers.

## What would change the answer

- **A newer three.js whose WebGPU CPU cost per draw is at or below WebGL's.** Render bundles and the `static`
  object flags were maturing after r170. To re-check, point `scene-webgpu.js` at the new build and re-run `?game=1`
  and `?split=3`. The interleaved bench and throughput metric are renderer-agnostic.
- **Wanting compute:** GPU-driven culling with indirect draws (which would also cut the 9 ms submit cost), GPU
  particles or rain, a compute luminance histogram. These are real WebGPU-only wins. They are features to design
  for, not a renderer swap.
- **Cheaper levers available today, on WebGL:**
  - Cut draw calls. Submission costs about 6.5 µs per draw here and the game issues about 500 per frame.
    Bigger chunks for static batches, `BatchedMesh` for parked-car parts, and fewer shadow casters would help.
  - Spend the GPU budget where the game's 13 ms scene pass goes (the facade shader and overdraw), not on the API.

## Running it

The dev server must be running (`npm run dev`).

| URL (`http://localhost:5173/prototype/webgpu.html…`) | What it does |
|---|---|
| no parameters | Prototype WebGL vs WebGPU. Click "Run bench" / "Run bench + post", or call `__proto.runBench({ rounds, post })`. |
| `?game=1` | Adds the real game, measured as `game-scene` and `game-full`. Nothing is saved. |
| `?res=2` | 3200×1800 (GPU-bound) |
| `?split=3` | Smaller chunks, for more draws |
| `?autorun&post=1&rounds=4` | Starts the bench on load |

`__proto.snapshot(i)` returns a side-by-side JPEG of pose `i`. It uses render-target readback, so it works in a
hidden pane.

Files (all under `prototype/`; nothing in `src/` was changed):

- `common.js`: data, camera path, shared scene builder, stats
- `scene-webgl.js`, `scene-webgpu.js`: the two backends with their timers and throughput
- `game-bench.js`: the iframe contender
- `bloom-node.js`: r170's `BloomNode`, with imports pointed at the WebGPU build
- `facade-params.js`
- `results.json`, `shots/`
