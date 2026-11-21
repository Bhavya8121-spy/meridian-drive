// Material library: PBR materials with shader patches for wet surfaces, procedural facades,
// wind-animated vegetation and car paint. All patches share one set of world uniforms.
import * as THREE from 'three';
import * as TX from './textures.js';
import { BUILDING_STYLES, makeBuildingMaterial } from './buildingMaterial.js';
import { applyPhotoSet } from './photoTextures.js';

/** Mean linear luminance of a texture's image (DataTexture bytes, canvas or image). */
function textureLuma(t) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  let d = t.image?.data;
  if (!d) {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d'); g.drawImage(t.image, 0, 0, 16, 16); d = g.getImageData(0, 0, 16, 16).data;
  }
  let s = 0, n = 0;
  const step = Math.max(4, Math.floor(d.length / 4 / 4096) * 4);
  for (let i = 0; i < d.length; i += step) { s += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]); n++; }
  return s / n;
}

export const WORLD = {
  uTime: { value: 0 },
  uWet: { value: 0 },
  uNight: { value: 0 },
  uWind: { value: 1 },
  uRain: { value: 0 },
  uPuddleMap: { value: null },
};

const GLSL_COMMON = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNormal;
uniform float uTime;
uniform float uWet;
uniform float uNight;
uniform float uWind;
uniform float uRain;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

function injectCommon(shader, extraUniforms = {}) {
  Object.assign(shader.uniforms, WORLD, extraUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + GLSL_COMMON)
    .replace('#include <project_vertex>', /* glsl */`#include <project_vertex>
    {
      vec4 wp = vec4(transformed, 1.0);
      vec3 wn = objectNormal;
      #ifdef USE_INSTANCING
        wp = instanceMatrix * wp;
        wn = mat3(instanceMatrix) * wn;
      #endif
      wp = modelMatrix * wp;
      vWPos = wp.xyz;
      vWNormal = normalize(mat3(modelMatrix) * wn);
    }`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL_COMMON);
}

/** Wetness: darker albedo, glossier surface, flat mirror-like puddles. */
const WET_MAP = /* glsl */`
  float puddle = 0.0;
  {
    float pn = texture2D(uPuddleMap, vWPos.xz * 0.021).r * 0.75 + texture2D(uPuddleMap, vWPos.xz * 0.093 + 0.37).r * 0.25;
    puddle = smoothstep(0.56, 0.66, pn) * smoothstep(0.3, 0.95, uWet) * uPuddleAmt;
    diffuseColor.rgb *= mix(1.0, 0.5, uWet * uWetAmt);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55 + vec3(0.004, 0.005, 0.006), puddle);
  }
`;
const WET_ROUGH = /* glsl */`
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.28 + 0.04, uWet * uWetAmt);
  roughnessFactor = mix(roughnessFactor, 0.02, puddle);
`;
const WET_NORMAL = /* glsl */`
  normal = normalize(mix(normal, nonPerturbedNormal, puddle * 0.97));
  if (puddle > 0.01 && uRain > 0.01) {
    // animated rain ripples on puddles
    vec2 cell = floor(vWPos.xz * 1.6);
    vec2 f = fract(vWPos.xz * 1.6) - 0.5;
    float h = hash12(cell);
    float t = fract(uTime * 0.9 + h);
    float d = length(f + (vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5) * 0.5);
    float ring = sin((d - t * 0.5) * 60.0) * (1.0 - t) * smoothstep(0.5 * t + 0.05, 0.5 * t - 0.05, d);
    vec3 rip = vec3(f.x, 0.0, f.y) * ring * 0.6 * uRain * puddle;
    normal = normalize(normal + (viewMatrix * vec4(rip, 0.0)).xyz);
  }
`;

export function patchWet(material, { wetAmt = 1, puddles = 1 } = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    prev?.(shader, r);
    injectCommon(shader, { uWetAmt: { value: wetAmt }, uPuddleAmt: { value: puddles } });
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uPuddleMap;\nuniform float uWetAmt;\nuniform float uPuddleAmt;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WET_MAP)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + WET_ROUGH)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + WET_NORMAL);
  };
  material.customProgramCacheKey = () => `wet${wetAmt}_${puddles}`;
  return material;
}

/** Procedural building facade: windows per floor, storefronts, roofs, lit windows at night. */
export const FACADE_STYLES = {
  glass:     { wall: [0.22, 0.23, 0.25], glass: [0.07, 0.11, 0.13], floorH: 3.9, winW: 1.55, margin: [0.035, 0.05], wallRough: 0.35, wallMetal: 0.85, glassMetal: 0.9, lit: 0.32, store: 0, detail: 0.15, ribs: 0, band: [0, 999] },
  office:    { wall: [0.66, 0.64, 0.6], glass: [0.05, 0.07, 0.085], floorH: 3.6, winW: 2.8, margin: [0.17, 0.2], wallRough: 0.85, wallMetal: 0.0, glassMetal: 0.55, lit: 0.3, store: 1, detail: 0.9, ribs: 0, band: [0, 999] },
  shop:      { wall: [0.82, 0.78, 0.7], glass: [0.06, 0.07, 0.08], floorH: 3.3, winW: 2.5, margin: [0.24, 0.25], wallRough: 0.9, wallMetal: 0.0, glassMetal: 0.2, lit: 0.4, store: 1, detail: 0.8, ribs: 0, band: [0, 999] },
  brick:     { wall: [1.0, 1.0, 1.0], glass: [0.05, 0.06, 0.07], floorH: 3.0, winW: 2.7, margin: [0.3, 0.27], wallRough: 0.9, wallMetal: 0.0, glassMetal: 0.2, lit: 0.45, store: 0, detail: 1.0, ribs: 0, band: [0, 999], brick: 1 },
  house:     { wall: [0.85, 0.82, 0.76], glass: [0.05, 0.06, 0.07], floorH: 2.9, winW: 3.3, margin: [0.32, 0.3], wallRough: 0.8, wallMetal: 0.0, glassMetal: 0.15, lit: 0.5, store: 0, detail: 0.6, ribs: 0, band: [0, 6.2] },
  warehouse: { wall: [0.6, 0.62, 0.63], glass: [0.12, 0.14, 0.15], floorH: 8.0, winW: 3.0, margin: [0.12, 0.8], wallRough: 0.55, wallMetal: 0.7, glassMetal: 0.2, lit: 0.25, store: 0, detail: 0.5, ribs: 1, band: [5.5, 7.5] },
  roofunit:  { wall: [0.55, 0.56, 0.57], glass: [0.1, 0.1, 0.1], floorH: 100, winW: 3, margin: [0.5, 0.5], wallRough: 0.6, wallMetal: 0.6, glassMetal: 0, lit: 0, store: 0, detail: 0.5, ribs: 1, band: [9999, 9999] },
  stack:     { wall: [0.62, 0.6, 0.58], glass: [0.1, 0.1, 0.1], floorH: 100, winW: 3, margin: [0.5, 0.5], wallRough: 0.9, wallMetal: 0.0, glassMetal: 0, lit: 0, store: 0, detail: 1.0, ribs: 0, band: [9999, 9999] },
  tank:      { wall: [0.78, 0.79, 0.8], glass: [0.1, 0.1, 0.1], floorH: 100, winW: 3, margin: [0.5, 0.5], wallRough: 0.45, wallMetal: 0.8, glassMetal: 0, lit: 0, store: 0, detail: 0.4, ribs: 1, band: [9999, 9999] },
};

export function makeFacadeMaterial(styleName, tex) {
  const st = FACADE_STYLES[styleName];
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: st.wallRough, metalness: st.wallMetal });
  const u = {
    uWall: { value: new THREE.Color(...st.wall) },
    uGlass: { value: new THREE.Color(...st.glass) },
    uFloorH: { value: st.floorH }, uWinW: { value: st.winW },
    uMargin: { value: new THREE.Vector2(...st.margin) },
    uWallRough: { value: st.wallRough }, uWallMetal: { value: st.wallMetal }, uGlassMetal: { value: st.glassMetal },
    uLitProb: { value: st.lit }, uStore: { value: st.store }, uDetailAmt: { value: st.detail }, uRibs: { value: st.ribs },
    uBand: { value: new THREE.Vector2(...st.band) },
    uDetail: { value: st.brick ? tex.brick.map : tex.concrete.map },
    uDetailScale: { value: st.brick ? 0.25 : 0.12 },
    uPuddleMap: WORLD.uPuddleMap,
  };
  mat.onBeforeCompile = (shader) => {
    injectCommon(shader, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        uniform vec3 uWall; uniform vec3 uGlass; uniform float uFloorH; uniform float uWinW; uniform vec2 uMargin;
        uniform float uWallRough; uniform float uWallMetal; uniform float uGlassMetal; uniform float uLitProb;
        uniform float uStore; uniform float uDetailAmt; uniform float uRibs; uniform vec2 uBand;
        uniform sampler2D uDetail; uniform float uDetailScale;`)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        vec3 fN = normalize(vWNormal);
        float isWall = step(abs(fN.y), 0.5);
        vec2 fc = vec2(dot(vWPos.xz, vec2(-fN.z, fN.x)), vWPos.y);
        vec3 det = texture2D(uDetail, (isWall > 0.5 ? fc : vWPos.xz) * uDetailScale).rgb;
        vec3 wallCol = uWall * diffuseColor.rgb * mix(vec3(1.0), det / 0.55, uDetailAmt);
        float winMask = 0.0; vec2 cid = vec2(0.0);
        if (isWall > 0.5) {
          vec2 cell = vec2(fc.x / uWinW, fc.y / uFloorH);
          cid = floor(cell); vec2 f = fract(cell);
          winMask = step(uMargin.x, f.x) * step(f.x, 1.0 - uMargin.x) * step(uMargin.y, f.y) * step(f.y, 1.0 - uMargin.y * 0.55);
          winMask *= step(uBand.x, fc.y) * step(fc.y, uBand.y);
          if (uStore > 0.5 && fc.y < 4.4) {
            float sx = fract(fc.x / 4.2);
            cid = vec2(floor(fc.x / 4.2), -7.0);
            winMask = step(0.07, sx) * step(sx, 0.93) * step(0.35, fc.y) * step(fc.y, 3.5);
            wallCol = mix(wallCol, vec3(0.08, 0.085, 0.09), step(3.5, fc.y) * step(fc.y, 4.4)); // signage band
          }
          wallCol *= mix(0.55, 1.0, smoothstep(0.1, 2.6, fc.y)); // grime near the ground
        } else {
          wallCol = vec3(0.3, 0.3, 0.29) * det / 0.55; // roof membrane / gravel
        }
        float wh = hash12(cid * 1.37 + floor(vWPos.xz / 61.0) * 7.13 + fN.xz * 3.1);
        vec3 glassCol = uGlass * (0.75 + 0.5 * wh);
        diffuseColor.rgb = mix(wallCol, glassCol, winMask);`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
        roughnessFactor = mix(uWallRough * (0.8 + 0.4 * det.r), 0.03 + wh * 0.06, winMask);`)
      .replace('#include <metalnessmap_fragment>', /* glsl */`#include <metalnessmap_fragment>
        metalnessFactor = mix(uWallMetal, uGlassMetal, winMask) * isWall;`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
        if (uRibs > 0.5 && isWall > 0.5) {
          vec3 T = (viewMatrix * vec4(-fN.z, 0.0, fN.x, 0.0)).xyz;
          normal = normalize(normal + T * cos(fc.x * 31.4) * 0.45);
        }`)
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        {
          float lit = step(1.0 - uLitProb, hash12(cid * 2.71 + floor(vWPos.xz / 53.0) * 3.7 + fN.xz));
          vec3 warm = mix(vec3(1.0, 0.68, 0.38), vec3(0.8, 0.88, 1.0), step(0.72, hash12(cid + 5.3)));
          float flick = 0.75 + 0.5 * hash12(cid + 1.7);
          totalEmissiveRadiance += winMask * lit * uNight * warm * flick * 0.55;
        }`);
  };
  mat.customProgramCacheKey = () => 'facade_' + styleName;
  return mat;
}

/** Wind sway for foliage (vertex displacement above a height threshold). */
export function patchSway(material, { start = 1.5, amp = 0.02, freq = 1.6 } = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    prev?.(shader, r);
    if (!shader.vertexShader.includes('varying vec3 vWPos')) injectCommon(shader);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float hgt = max(0.0, position.y - ${start.toFixed(2)});
        float ph = uTime * ${freq.toFixed(2)} + ip.x * 0.37 + ip.z * 0.21;
        float gust = 0.6 + 0.4 * sin(uTime * 0.31 + ip.x * 0.01);
        transformed.x += (sin(ph) + 0.35 * sin(ph * 2.7 + position.z)) * hgt * ${amp.toFixed(4)} * uWind * gust;
        transformed.z += (cos(ph * 0.83) + 0.35 * sin(ph * 3.1 + position.x)) * hgt * ${amp.toFixed(4)} * 0.7 * uWind * gust;
      }`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + `sway${start}_${amp}`;
  return material;
}

export function createMaterialLibrary(maxAniso = 8, photo = null) {
  const tex = {
    asphalt: TX.makeAsphalt(1024),
    pavers: TX.makeConcretePavers(512, 4),
    concrete: TX.makeConcrete(512),
    grass: TX.makeGrass(512),
    brick: TX.makeBrick(512),
    puddle: TX.makeNoiseTex(256, 4, 5, 901),
    wear: TX.makeNoiseTex(256, 32, 4, 333),
    flake: TX.makeFlakeNormal(256),
    leaves: TX.makeLeafCluster(),
    blades: TX.makeGrassBlades(),
    skid: TX.makeSkidTex(),
    chain: TX.makeChainLink(),
    tire: TX.makeTireTex(),
  };
  tex.chain.wrapS = tex.chain.wrapT = THREE.RepeatWrapping;
  for (const k of Object.keys(tex)) {
    const t = tex[k];
    for (const tt of t.isTexture ? [t] : Object.values(t)) if (tt?.isTexture) tt.anisotropy = maxAniso;
  }
  WORLD.uPuddleMap.value = tex.puddle;

  const std = (o) => new THREE.MeshStandardMaterial(o);
  const M = {};
  M.asphalt = patchWet(std({ map: tex.asphalt.map, roughnessMap: tex.asphalt.roughnessMap, normalMap: tex.asphalt.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 1 }));
  M.highway = patchWet(std({ map: tex.asphalt.map, roughnessMap: tex.asphalt.roughnessMap, normalMap: tex.asphalt.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.95, color: 0xe6e6e6 }));
  M.pavers = patchWet(std({ map: tex.pavers.map, roughnessMap: tex.pavers.roughnessMap, normalMap: tex.pavers.normalMap, roughness: 1 }), { wetAmt: 0.8, puddles: 0.5 });
  M.concrete = patchWet(std({ map: tex.concrete.map, roughnessMap: tex.concrete.roughnessMap, normalMap: tex.concrete.normalMap, roughness: 1 }), { wetAmt: 0.8, puddles: 0.4 });
  M.curb = patchWet(std({ map: tex.concrete.map, normalMap: tex.concrete.normalMap, roughness: 0.85, color: 0xd8d6d0 }), { wetAmt: 0.8, puddles: 0 });
  M.grass = patchWet(std({ map: tex.grass.map, normalMap: tex.grass.normalMap, roughness: 0.95 }), { wetAmt: 0.5, puddles: 0 });
  M.yard = patchWet(std({ map: tex.concrete.map, normalMap: tex.concrete.normalMap, roughness: 1, color: 0x9a948a }), { wetAmt: 0.9, puddles: 1 });
  if (photo) {
    // photo-scanned ground: UV units are world metres / uvScale as laid out in cityBuilder (roads 6 m, slabs 4 m, lawns 7 m)
    applyPhotoSet(M.asphalt, photo.asphalt, 6, { normalScale: 0.9 });
    M.asphalt.color.set(0xc8c8c8);
    applyPhotoSet(M.highway, photo.asphalt, 6, { normalScale: 0.7, keepColor: true });
    applyPhotoSet(M.pavers, photo.pavers, 4);
    M.pavers.color.set(0xb2b6ba); // NYC flags are grey concrete; cool the scan's warm cast
    applyPhotoSet(M.concrete, photo.concrete, 4);
    applyPhotoSet(M.curb, photo.concrete, 4, { keepColor: true });
    applyPhotoSet(M.yard, photo.concrete, 4, { keepColor: true });
    applyPhotoSet(M.grass, photo.grass, 7);
    M.grass.color.set(0xbcc6a6); // the scan is a lush lawn; pull it toward the muted city palette
  }
  M.markWhite = patchWet(std({ color: 0xe9e9e4, roughness: 0.6, alphaMap: tex.wear, alphaTest: 0.32, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { wetAmt: 0.6, puddles: 0.6 });
  M.markYellow = patchWet(std({ color: 0xe0a92a, roughness: 0.6, alphaMap: tex.wear, alphaTest: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { wetAmt: 0.6, puddles: 0.6 });

  // vehicles
  M.paint = new THREE.MeshPhysicalMaterial({
    color: 0xb0121b, metalness: 0.48, roughness: 0.31, clearcoat: 0.92, clearcoatRoughness: 0.115,
    normalMap: tex.flake, normalScale: new THREE.Vector2(0.035, 0.035), envMapIntensity: 0.9,
  });
  M.npcPaint = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.4, clearcoat: 0.9, clearcoatRoughness: 0.06 });
  M.carGlass = new THREE.MeshPhysicalMaterial({ color: 0x030507, metalness: 0.0, roughness: 0.04, transparent: true, opacity: 0.84, envMapIntensity: 0.75, side: THREE.DoubleSide, depthWrite: false, specularIntensity: 0.8 });
  M.npcGlass = new THREE.MeshStandardMaterial({ color: 0x0c1014, metalness: 0.6, roughness: 0.06, envMapIntensity: 1.4 });
  M.trim = std({ color: 0x101112, roughness: 0.55, metalness: 0.2 });
  M.chrome = std({ color: 0xd8dde3, roughness: 0.12, metalness: 1 });
  M.rim = new THREE.MeshPhysicalMaterial({ color: 0x9da3aa, roughness: 0.22, metalness: 1, clearcoat: 0.6, clearcoatRoughness: 0.1 });
  M.tire = std({ color: 0x1b1b1c, map: tex.tire, roughness: 0.92, metalness: 0 });
  M.disc = std({ color: 0x6d6f73, roughness: 0.38, metalness: 1 });
  M.caliper = std({ color: 0xc8a018, roughness: 0.35, metalness: 0.3 });
  M.interior = std({ color: 0x17171a, roughness: 0.75, metalness: 0 });
  M.leather = std({ color: 0x2a1a14, roughness: 0.6, metalness: 0 });
  M.alu = std({ color: 0x8a8d91, roughness: 0.3, metalness: 1 });
  M.headLens = std({ color: 0x1a1d22, emissive: 0xf4f6ff, emissiveIntensity: 0.05, roughness: 0.1, metalness: 0.2 });
  M.drl = std({ color: 0x222222, emissive: 0xe8f0ff, emissiveIntensity: 3.0, roughness: 0.2 });
  M.tail = std({ color: 0x2a0303, emissive: 0xff1a0d, emissiveIntensity: 0.8, roughness: 0.2 });
  M.indicator = std({ color: 0x2a1a03, emissive: 0xff8a00, emissiveIntensity: 0, roughness: 0.2 });
  M.reverse = std({ color: 0x202020, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 });
  // NPC lights use per-instance colour (brightness encoded in the colour) on unlit materials
  M.npcLightF = new THREE.MeshBasicMaterial({ color: 0xffffff });
  M.npcLightR = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // props
  M.metalPole = std({ color: 0x4a4f55, roughness: 0.45, metalness: 0.85 });
  M.darkMetal = std({ color: 0x23262a, roughness: 0.5, metalness: 0.7 });
  M.galv = std({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.9 });
  M.wood = std({ color: 0x66533f, roughness: 0.88 });
  M.woodDark = std({ color: 0x4a3524, roughness: 0.9 });
  M.plasticGreen = std({ color: 0x24442d, roughness: 0.6 });
  M.lampHead = std({ color: 0x34383c, roughness: 0.54, metalness: 0.45 });
  M.streetLens = std({ color: 0xe1e6ec, emissive: 0xffdfad, emissiveIntensity: 0, roughness: 0.32 });
  M.signalBox = std({ color: 0x1b1d1f, roughness: 0.6, metalness: 0.2 });
  M.signalLamp = new THREE.MeshBasicMaterial({ color: 0xffffff });
  M.sign = std({ color: 0xffffff, roughness: 0.4, metalness: 0.1 });
  M.shelterGlass = new THREE.MeshPhysicalMaterial({ color: 0xc8d6de, roughness: 0.05, transparent: true, opacity: 0.25, depthWrite: false });
  M.jersey = patchWet(std({ map: tex.concrete.map, normalMap: tex.concrete.normalMap, roughness: 0.9, color: 0xcfcac2 }), { wetAmt: 0.7, puddles: 0 });
  M.chain = std({ map: tex.chain, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.8, color: 0xbfc4c8 });
  M.container = std({ color: 0xffffff, roughness: 0.6, metalness: 0.5 });
  M.hydrant = std({ color: 0xb8231b, roughness: 0.5, metalness: 0.3 });
  M.bin = std({ color: 0x2e3b33, roughness: 0.6, metalness: 0.5 });
  M.tunnel = patchWet(std({ map: tex.concrete.map, normalMap: tex.concrete.normalMap, roughness: 0.75, color: 0xbdb7ae }), { wetAmt: 0, puddles: 0 });
  M.tunnelTile = std({ color: 0xd9dcd8, roughness: 0.25, metalness: 0.05, side: THREE.DoubleSide });
  M.tunnelLamp = std({ color: 0x222, emissive: 0xfff0d8, emissiveIntensity: 4 });
  M.bridge = patchWet(std({ map: tex.concrete.map, normalMap: tex.concrete.normalMap, roughness: 0.9, color: 0xb9b4ad }), { wetAmt: 0.6, puddles: 0 });
  M.hill = std({ map: tex.grass.map, normalMap: tex.grass.normalMap, roughness: 0.95, color: 0xb2b5a4, side: THREE.DoubleSide });
  M.mountain = std({ color: 0x59625a, roughness: 1 });

  // vegetation
  M.bark = patchSway(std({ color: 0x4a3a2c, roughness: 0.95 }), { start: 2.5, amp: 0.006 });
  M.leaves = patchSway(std({ map: tex.leaves, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, color: 0xffffff }), { start: 1.5, amp: 0.022 });
  M.leavesFill = patchSway(std({ color: 0x23361a, roughness: 0.9 }), { start: 1.5, amp: 0.02 });
  M.grassBlades = patchSway(std({ map: tex.blades, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 }), { start: 0.05, amp: 0.12, freq: 2.4 });

  // facades
  M.facade = {};
  for (const s of Object.keys(FACADE_STYLES)) M.facade[s] = makeFacadeMaterial(s, tex);
  M.roofTiles = std({ color: 0x5a3b30, roughness: 0.8, map: tex.concrete.map });

  // skid marks
  M.skid = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9, alphaMap: tex.skid, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });

  // ---- prewar city set ----
  tex.brickN = TX.makeBrickNeutral(512);
  tex.stone = TX.makeStone(512);
  if (photo) {
    // facades take luminance from the scans, normalised to the procedural maps' mean so the tint palettes still hold
    const swap = (procedural, set) => ({ map: set.map, normalMap: set.normalMap, photoSize: set.size, norm: textureLuma(procedural.map) / Math.max(1e-3, set.luma) });
    tex.brickN = swap(tex.brickN, photo.brick);
    // (the procedural stone keeps its block-by-block shading, which the plain stone scans lacked)
    for (const m of [M.jersey, M.tunnel, M.bridge]) applyPhotoSet(m, photo.concrete, 4, { keepColor: true });
    M.bark.map = photo.bark.map.clone(); M.bark.map.repeat.set(1, 2.5); M.bark.map.needsUpdate = true;
    M.bark.normalMap = photo.bark.normalMap.clone(); M.bark.normalMap.repeat.set(1, 2.5); M.bark.normalMap.needsUpdate = true;
    M.bark.color.set(0x9a9288); M.bark.needsUpdate = true;
  }
  tex.decals = TX.makeDecalAtlas();
  tex.signs = TX.makeSignAtlas();
  tex.leafSparse = [TX.makeLeafSparse(7, 85), TX.makeLeafSparse(11, 70), TX.makeLeafSparse(13, 95)];
  for (const t of [tex.decals, tex.signs, ...tex.leafSparse]) t.anisotropy = maxAniso;
  M.bld = {};
  for (const s of Object.keys(BUILDING_STYLES)) M.bld[s] = makeBuildingMaterial(s, tex);
  M.cornice = std({ map: tex.stone.map, normalMap: tex.stone.normalMap, roughness: 0.85, color: 0xffffff });
  M.iron = std({ color: 0x1c1d1f, roughness: 0.55, metalness: 0.75 });
  tex.railing = TX.makeStripes('rgba(0,0,0,0)', '#ffffff', 10, false);
  tex.railing.wrapS = tex.railing.wrapT = THREE.RepeatWrapping;
  tex.railing.repeat.set(3, 1);
  M.railing = std({ color: 0x1c1d1f, map: tex.railing, alphaTest: 0.62, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.75 });
  M.tankWood = std({ color: 0x6b5139, roughness: 0.9, map: tex.concrete.map });
  M.orange = std({ color: 0xe0571c, roughness: 0.55 });
  M.whitePlastic = std({ color: 0xe8e8e2, roughness: 0.5 });
  M.stripe = std({ map: TX.makeStripes('#e0571c', '#f0efe8', 4), roughness: 0.5 });
  M.umbrella = std({ map: TX.makeStripes('#f2c230', '#2b6cb3', 3, false), roughness: 0.6, side: THREE.DoubleSide });
  M.cardboard = std({ color: 0xa47b4f, roughness: 0.9 });
  M.tarp = std({ color: 0xbdb3a0, roughness: 0.95, map: tex.concrete.map, side: THREE.DoubleSide });
  M.trashBag = std({ color: 0x0c0c0d, roughness: 0.28, metalness: 0.1 });
  M.drum = std({ color: 0xffffff, roughness: 0.45, metalness: 0.35 });
  M.rubber = std({ color: 0x141414, roughness: 0.9 });
  M.pallet = std({ color: 0x8d7558, roughness: 0.9, map: tex.concrete.map });
  M.brickStack = std({ map: tex.brickN.map, color: 0xb0553e, roughness: 0.9 });
  M.soil = std({ color: 0x2a2119, roughness: 1, map: tex.concrete.map });
  M.awning = std({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide });
  M.signText = std({ map: tex.signs, transparent: true, alphaTest: 0.35, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1 });
  M.decal = patchWet(std({ map: tex.decals, transparent: true, depthWrite: false, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), { wetAmt: 0.7, puddles: 0 });
  M.newsBox = std({ color: 0xffffff, roughness: 0.4, metalness: 0.3 });
  M.leavesSparse = tex.leafSparse.map((t) => patchSway(std({ map: t, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.78, color: 0xffffff }), { start: 1.5, amp: 0.02 }));

  return { tex, M };
}
