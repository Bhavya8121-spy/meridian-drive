# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Meridian Drive: an open-world city driving game in the browser. Three.js (WebGL, r170) for rendering, Rapier (`@dimforge/rapier3d-compat`, WASM) for physics, Vite for dev/build, Vitest for tests. The city, cars, and audio are procedural. Nearby pedestrians use licensed GLB character models. Attribution is in public/assets/people/CREDITS.txt. (Unreal Engine was the original ask; it was not installed and the disk was too small, so the browser stack was chosen.)

## Commands

```bash
npm run dev                          # Vite dev server on :5173
npm run build                        # production build to dist/
npm test                             # all Vitest tests (headless physics + layout)
npx vitest run tests/vehicle.test.js # one file
npx vitest run -t "handbrake"        # tests matching a name
```

## Architecture

**Data first, rendering second.** `src/world/layout.js` is pure data and has no Three.js or Rapier imports. From a seed (1337) it produces the whole world: grid roads, the ring expressway, the east boulevard with its overpass, the roundabout, the tunnel, city blocks and buildings, prop placements, the traffic lane graph (`paths` with `next` links, intersections with signal timing), and a 1 m surface raster (`surfaceAt`). The vehicle uses the raster for tyre friction and the HUD uses it for the minimap. `src/world/cityBuilder.js` turns this data into meshes and static colliders. Change world content in the layout, not in the builder.

**Batching and culling.** Everything static goes through `src/world/batching.js`:
- `InstanceBatches` makes one InstancedMesh per (kind, chunk). Chunks are 400 m, or a custom size per batch.
- `StripBins` handles roads and markings.
- `MergeBins` merges arbitrary geometry.

All three register with `CullRegistry`, which distance-culls per chunk each frame. Static colliders are streamed by `city.updateStreaming(pos)`, which enables only colliders within about 220 m. Rapier's per-step cost scales with enabled collider count (all ~5k enabled ≈ 2.4 ms/step at 120 Hz).

**Vehicle.** `src/vehicle/vehiclePhysics.js` is a raycast-suspension car on a Rapier rigid body. Suspension, anti-roll, Pacejka-style lateral force with a friction circle, drivetrain and automatic gearbox, TCS/ABS/stability, and aero are all applied as impulses each fixed step (1/120 s, `FIXED_DT` in `game.js`). Local frame: **+Z forward, +Y up, +X is the car's left**. Steering input +1 means turn right. Specs and the arcade/balanced/simulation presets are in `specs.js`. Arcade and Balanced enable *drift assist* (`VehiclePhysics.driftStep`): a slip-angle PD controller applied as yaw torque that holds the slide at `steer × driftAngle`, straightens the car when the wheel is centred, caps slip near 60° and keeps entry speed up while sliding; outside a drift it only pulls the car straight beyond `gripSlip`. Simulation has no assist. `node scripts/handling-bench.mjs` prints lane-change / full-lock / drift numbers; `tests/drift.test.js` guards them. `playerCar.js` links physics to visuals: it interpolates between physics steps and drives lights, wheels, headlight beams, and skid marks. `carModel.js` builds bodies by lofting super-ellipse cross-sections. The player/NPC body shell (`buildShell`) is a loft of per-station key points (K0 bottom … K9 top centre); paint, side glass, windscreen and roof are assigned per segment, and lights, shut lines and the DRL are cut from or placed on that same surface (`surfaceStrip`, key points), so they always sit on the body. Keep interior parts behind the windscreen base (they poke through the cowl otherwise). `lod` 0 is the player car with interior, 1 is moving NPCs, 2 is parked cars.

**Imported car models** (`src/vehicle/gltfCars.js`; CC BY 4.0, Daniel Zhabotinsky — credits in `public/assets/cars/CREDITS.txt` and on the main menu, which the licence requires). Eight glTFs (`CAR_MODELS`: taxi, kiri, fairheaven, riverside, wagon, van, truck, cop, with traffic weights) are loaded at startup (`loadCarKits`), normalised into the car frame (front found from the headlight meshes, centred on the wheelbase, ground at the tyre bottoms) and split by mesh/material name into the procedural slots: `paint` (instance-coloured, or a livery texture for taxi/cop), `glass`, `lightF`/`lightR` (unlit `MeshBasicMaterial`, brightness via instance colour), textured body parts, and one wheel template (wheel *positions* come from all four wheel meshes; some files duplicate wheel names). Traffic and parked cars use `<key>_lod.gltf`; the player's hatch/sedan/suv use the full model (`PLAYER_MODELS`; the sport car stays procedural), and `bodyOverride()` → `BODY_OVERRIDES` in `career/vehicles.js` makes `vehicleSpec()` put the physics wheels where the model's are. Parked cars draw the model within 95 m (its own 80 m-chunk `InstanceBatches`, parts merged per material, only the paint casts shadows) and the procedural lod-2 body beyond, cross-dissolved with `fadeMaterial(..., fadeIn)`. Without the assets everything falls back to the procedural cars. `scripts/process-car-models.mjs` rebuilds the assets from the original downloads.

**Collisions** (`src/core/physicsGroups.js` defines the Rapier groups: WORLD, PLAYER, NPC, DEBRIS, PROP). Three mechanisms keep crashes smooth:
- *Crumple model* (`VehiclePhysics.crumpleStep`): a shape cast of the chassis along its velocity; within 0.75 m of a **fixed** obstacle it decelerates the car (≤90 g, through the centre of mass) so it reaches the wall at 2.8 m/s instead of stopping in one 8 ms step. Movable bodies are left to the solver (its inelastic contact conserves momentum; stacking a cushion impulse on a near-zero gap injected energy). Never apply it at the shape-cast witness point — that is not in a usable frame and produced 400 m/s explosions.
- *Hit prediction* (`Game.predictHits`, before each player step): a short cast ahead turns traffic into dynamic wrecks (`traffic.wreck`), parked cars into pooled wrecks (`traffic.convertParked`), and street furniture faster than its `breakSpeed` into debris (`city.breakProp`) *before* contact, so momentum is exchanged rather than hitting an immovable kinematic/static body.
- Chassis colliders are rounded, low-friction (Min combine) and non-restitutive, so the car slides along walls. Wheel rays and the camera only query WORLD, so debris and props never lift the suspension.
`node scripts/crash-bench.mjs` prints peak g / rebound / spin for standard crash scenarios; `tests/collision.test.js` guards them.

**Traffic** (`src/traffic/traffic.js`). This is a pooled set of kinematic Rapier bodies following `layout.paths` with IDM car-following. They obey `signalState()` and stop signs, yield to cars already inside an intersection, and react to the player. A hit car switches to a dynamic body in the `wreck` state: frictionless wheel spheres plus a simple tyre model in `wreckStep()` (lateral grip, braking, yaw damping), hazard lights, and it is recycled after ~30 s out of range. They render as one InstancedMesh per body type and part. Parked cars are static chunked instances.

**Buildings** use the prewar facade shader in `src/render/buildingMaterial.js` (styles: `prewar`, `limestone`, `loft`, `tenement`, `brownstone`, `factory`, `glass`, `plain`, `metal`). Each building is an instanced unit box scaled per instance; the vertex shader recovers the building's base and top from `instanceMatrix`, so the fragment shader can split the facade into a stone base (storefronts with a sign band, only when the building starts at ground level), a window shaft and a stone top band. Windows are faked in the shader: parallax-recessed openings with reveals, mullions, blinds, AC units, a fake room interior, and sills/lintels. Geometry details are added in `cityBuilder.js` from per-building flags set in `layout.js` (`cornice`, `fe` fire escape, `tank` water tank); awnings are placed on the street-facing facade at the shader's 4.2 m shop-bay grid. Street clutter (`props.clutter`), road works (`props.construction`) and decals (`props.decals`, one 4×4 atlas in `textures.js` → `DECAL`) are planned in `planStreetDetail()`.

**Shaders** are patches on Three's built-in materials via `onBeforeCompile` in `src/render/materials.js`, not custom ShaderMaterials:
- `patchWet` handles wet roads, puddles, and rain ripples.
- `makeFacadeMaterial` draws procedural windows, storefronts, and lit windows at night.
- `patchSway` animates vegetation.

They all share the `WORLD` uniforms (`uTime`, `uWet`, `uNight`, `uRain`, `uWind`). Set those uniforms rather than individual materials.

**Art direction (grounded realism).** Tone mapping is AgX with a restrained grade (contrast 1.1, saturation 1.08). Keep colours low-chroma: foliage, grass and props use olive/muted values (neon greens and saturated primaries were what made it read as "toy"). Shop windows use interior mapping (a ray-traced box room with shelving and ceiling panels, emitted rather than lit) and window reflections are darkened toward the horizon (`canyon` in `buildingMaterial.js`), because a street-facing window reflects the facades opposite, not open sky.

**Photo textures (CC0, Poly Haven; `public/assets/textures/CREDITS.txt`).** `src/render/photoTextures.js` loads scanned colour/normal/roughness sets before the material library is built (`createMaterialLibrary(aniso, photo)`); if loading fails the procedural textures in `textures.js` are used. `applyPhotoSet(material, set, uvMetres)` sets the repeat from the layout's UV scale (roads 6 m per UV unit, slabs 4 m, lawns 7 m) and each set's physical size (`PHOTO_SETS`). Facades use the brick scan as luminance only, normalised to the procedural brick's mean (`uWallNorm`), so per-building tints still colour it; stone stays procedural (the plain scans lost the block shading). Two 1K HDRIs (`Environment.setCityHdris`) replace the horizon and below in the reflection capture while the live sky stays above, so cars and windows reflect a street at any time of day. Photo maps use anisotropy ≤ 8 (16× on the 2K ground maps cost 1–2 ms).

**Distance rendering.** Instanced batches with `maxDist < 2000` get a per-instance dithered fade (`fadeMaterial` in `batching.js`) between 72% and 94% of `maxDist × cull multiplier`, so instances dissolve before `CullRegistry` hides their chunk; the clone mirrors runtime colour/emissive changes of its base material. Facade windows are pre-filtered by screen footprint (`farDetail`): once a bay is a few pixels wide it blends to the area average (and an average night glow) instead of aliasing. Lit windows at night use a later threshold (`tiny`), so the night city stays sparse points of light rather than glowing walls.

**Environment** (`src/world/environment.js`) owns the time of day, weather blending, the Sky with the cloud/star dome, fog, rain, lightning, the PMREM environment map, and a pooled set of SpotLights that are reassigned to the nearest lamp positions. The pool size is fixed by the quality preset, because changing the light count recompiles every shader.

**Post-processing** (`src/render/postfx.js`) runs: RenderPass → optional GTAO → luminance meter (auto exposure) → bloom (internal chain at half resolution) → one `FinalShader` pass (AgX tone mapping, FXAA on edges, contrast-adaptive sharpening via `setSharpness`, colour grade) → SMAA on Ultra only. Each full-screen pass cost 4–5 ms at 1536×1152 on the integrated GPU we measured, so keep post work merged into that one pass. Its tone-mapping functions are three's copied under a `pp_` prefix: three injects its own into ShaderMaterials that draw to the screen, and the original names collide. Motion blur and depth of field were removed on purpose: the picture read as blurry. Every quality preset renders at full window resolution (`renderScale` 1, HiDPI via `pixelRatioCap`); dynamic resolution never goes below 80%; `settingsVersion` 2 migrates old saves off sub-native render scales. One non-obvious constraint:
- The composer's second render target needs its *own* DepthTexture. A cloned DepthTexture shares a GPU texture, which turns motion-blur depth sampling into a feedback loop and renders black.

**Rules and the phone.** `src/career/road-rules.js` only fines speeding, and only on city streets (`speedLimitAt`: inside the grid, not the ring or the boulevard deck; the HUD sign hides elsewhere). Red lights, stop signs and crash liability claims were removed; crashes still wear the car. The driver phone (`src/career/dispatch-ui.js`, `.ph-*` styles) is a handset with a status bar and a fixed dock of apps (Rides, Navigate, Wallet, Car, Garage); ride requests also show as a card with the phone closed (1 accept / 2 decline), Tab cycles apps and P toggles it. Phone buttons cancel `mousedown` so they never take focus (Space would otherwise press them). The Wallet lists `profile.ledger`, filled by `Career.trackLedger()` on every save.

`src/game.js` wires everything together: the loading sequence, the fixed-step loop, the `menu`/`drive`/`paused` states, and applying settings (`src/core/settings.js`, persisted to localStorage). `src/ui/` holds the DOM HUD, minimap, and menus. `src/audio/audio.js` is a fully synthesised Web Audio engine; it starts on the Drive click because browsers require a user gesture.

## Performance notes

Measured bottlenecks and the rules that came out of them (press F3 in game for the per-section frame breakdown from `Game.mark()`):
- **It is already WebGL 2 + WebAssembly**: three r170 is WebGL 2 only, Rapier is Wasm. The SIMD Rapier build (0.15) measured only ~2% faster per step on a city-sized world, so it isn't used. Measure GPU time with `EXT_disjoint_timer_query_webgl2` around `post.composer.render`; the GPU clock in a hidden/background pane swings 2×, so compare variants interleaved in the same session (A, B, A, B), not across runs.
- Physics cost is Rapier's step with ~700–1000 enabled colliders (`STREAM_R` = 130 m in `game.js`); traffic bodies don't use CCD unless wrecked; at most 3 catch-up steps per frame (more turns a slow frame into a spiral).
- Shadow casting is limited to what can be inside the ±75 m shadow map: distant parked bodies don't cast. Traffic `InstancedMesh.count` follows the highest active slot and idle body types are hidden (each part is a draw call).
- **Never read GPU pixels synchronously.** The auto-exposure meter uses `readRenderTargetPixelsAsync` every 15 frames; a synchronous readback stalled every 6th frame by ~80 ms.
- **Triangle count drives frame time, not resolution** — everything is drawn twice (main + shadow pass) and chunk-level instancing draws whole 400 m chunks. Keep repeated props low-poly (trees ≈ 300 tris, fire-escape floor ≈ 150 with alpha-tested railings). Check `renderer.info.render.triangles` (target ≈ 3–4 M/frame including shadows).
- Thin props (poles, signals, barriers, bus shelters) don't cast shadows; each caster is an extra draw call in the shadow pass.
- Pooled spot lights cost every lit fragment; keep the per-quality counts small (2/4/6/10). Changing the count recompiles all shaders.
- Dynamic resolution (`Game.updateDynamicResolution`, setting `dynamicRes`) drops the pixel ratio when frames exceed ~18.5 ms and creeps back up at vsync.
- Avoid per-frame/per-step allocations in hot loops (traffic, `predictHits`, HUD); reuse temporaries.

## Verifying in a browser

In dev builds, `window.__dev` (`src/dev.js`) exposes:
- `step(secs, ['KeyW', ...])` advances frames while holding keys.
- `teleport(x, z, heading, y)`.
- `bench()` reports median frame ms, draw calls, and triangles.
- `capture(name)` POSTs the canvas to the Vite dev middleware in `vite.config.js`, which writes `captures/<name>.jpg`.

Use these when the browser window is hidden: requestAnimationFrame is paused there, so the game loop and normal screenshots stall. Teleporting onto the ramp needs `y = boulevardY(x)`, or the car spawns under the deck. Career mode drives the clock (`env.time = career.time`, from `profile.hours`, autosaved every 4 s): for night captures override it without touching the save, e.g. `Object.defineProperty(game.career, 'time', { get: () => 22, configurable: true })`, then `delete game.career.time`.
