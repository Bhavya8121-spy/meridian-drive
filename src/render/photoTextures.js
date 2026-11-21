// Photo-scanned PBR materials and HDRIs (CC0, Poly Haven — see public/assets/textures/CREDITS.txt).
// Loaded before the material library is built; on any failure the procedural textures stay in use.
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

const BASE = 'assets/textures/';

/** id -> physical size of one texture repeat in metres */
export const PHOTO_SETS = {
  asphalt: { id: 'asphalt_02', size: 3 },
  pavers: { id: 'concrete_pavement', size: 1.5 },
  concrete: { id: 'concrete_floor_worn_001', size: 3 },
  grass: { id: 'leafy_grass', size: 2 },
  brick: { id: 'red_brick', size: 1.4 },
  bark: { id: 'bark_brown_02', size: 1 },
};

/** Mean linear luminance of an image (sampled on a tiny canvas). */
function meanLuma(image) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
  return s / 256;
}

export async function loadPhotoTextures(maxAniso = 8) {
  const loader = new THREE.TextureLoader();
  const load = async (file, srgb) => {
    const t = await loader.loadAsync(BASE + file);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(maxAniso, 8); // 16x on 2K ground maps cost ~1–2 ms of texture bandwidth for little gain
    return t;
  };
  const out = {};
  await Promise.all(Object.entries(PHOTO_SETS).map(async ([key, { id, size }]) => {
    const [map, normalMap, roughnessMap] = await Promise.all([load(`${id}_col.jpg`, true), load(`${id}_nor.jpg`, false), load(`${id}_rough.jpg`, false)]);
    out[key] = { map, normalMap, roughnessMap, size, luma: meanLuma(map.image) };
  }));
  return out;
}

/** Day and night city HDRIs (equirectangular, linear). Optional: resolves to null if missing. */
export async function loadCityHdris() {
  try {
    const rgbe = new RGBELoader();
    const [day, night] = await Promise.all([rgbe.loadAsync(BASE + 'urban_street_04_1k.hdr'), rgbe.loadAsync(BASE + 'hansaplatz_1k.hdr')]);
    for (const t of [day, night]) { t.mapping = THREE.EquirectangularReflectionMapping; t.wrapS = THREE.RepeatWrapping; }
    return { day, night };
  } catch (e) {
    console.warn('city HDRIs unavailable', e);
    return null;
  }
}

/** Apply a photo set's maps to a material, with the repeat chosen so that `uvMetres` world metres per UV unit holds. */
export function applyPhotoSet(material, set, uvMetres, { normalScale = 1, keepColor = false } = {}) {
  const r = uvMetres / set.size;
  for (const k of ['map', 'normalMap', 'roughnessMap']) {
    const t = set[k].clone();
    t.repeat.set(r, r);
    t.needsUpdate = true;
    material[k] = t;
  }
  material.normalScale = new THREE.Vector2(normalScale, normalScale);
  material.roughness = 1;
  if (!keepColor) material.color?.set(0xffffff);
  material.needsUpdate = true;
  return material;
}
