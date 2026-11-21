// Rebuilds public/assets/cars from the original Sketchfab GLB downloads (see public/assets/cars/CREDITS.txt).
// Not part of the game build. Needs: npm i --no-save @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 meshoptimizer@0.21 sharp@0.33
// Usage: node scripts/process-car-models.mjs <folder with the 8 .glb files> public/assets/cars
// Writes <key>/<key>.gltf (full, player car) and <key>/<key>_lod.gltf (traffic: no interior/suspension/badges,
// meshopt-simplified, wheels simplified harder), WebP textures deduplicated across cars into tex/.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, dedup, prune, weld, simplify, simplifyPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
const [src, out] = process.argv.slice(2);
const CARS = { kiri: 'kiri_86_-_low_poly_model', fairheaven: 'fairheaven_lt_80_-_low_poly_model', riverside: 'riverside_88_-_low_poly_model', wagon: 'fairheaven_sw_84_-_low_poly_model', taxi: 'canyon_75_taxi_-_low_poly_model', cop: 'fairheaven_lt_80_cop_cruiser_-_low_poly_model', van: 'shvan_92_-_low_poly_model', truck: 'lct_3000_07-_low_poly_model' };
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(out, 'tex'), { recursive: true });
const tex = async (doc) => doc.transform(dedup(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 80 }));
for (const [key, file] of Object.entries(CARS)) {
  // full detail (player car)
  let doc = await io.read(path.join(src, file + '.glb'));
  await tex(doc);
  await doc.transform(prune());
  fs.mkdirSync(path.join(out, key), { recursive: true });
  await io.write(path.join(out, key, key + '.gltf'), doc);
  // traffic LOD: no interior / suspension / steering wheel, simplified
  doc = await io.read(path.join(src, file + '.glb'));
  for (const n of doc.getRoot().listNodes()) if (/Interior|Steering|Suspension|Badges/i.test(n.getName())) n.dispose();
  await tex(doc);
  await doc.transform(prune(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.4, error: 0.0015 }), prune());
  // wheels are drawn 4x per car: simplify them much harder (they sit in the arches and spin)
  for (const n of doc.getRoot().listNodes()) if (/Wheel/i.test(n.getName()) && n.getMesh()) for (const prim of n.getMesh().listPrimitives()) simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: 0.22, error: 0.012, lockBorder: false });
  await io.write(path.join(out, key, key + '_lod.gltf'), doc);
}
// dedupe images across all cars into tex/<hash>.webp
let saved = 0;
for (const key of Object.keys(CARS)) for (const f of fs.readdirSync(path.join(out, key)).filter((f) => f.endsWith('.gltf'))) {
  const gp = path.join(out, key, f); const j = JSON.parse(fs.readFileSync(gp));
  for (const im of j.images || []) {
    const ip = path.join(out, key, decodeURIComponent(im.uri));
    if (!fs.existsSync(ip)) continue;
    const data = fs.readFileSync(ip);
    const h = crypto.createHash('md5').update(data).digest('hex').slice(0, 12) + path.extname(ip);
    const dst = path.join(out, 'tex', h);
    if (fs.existsSync(dst)) saved += data.length; else fs.writeFileSync(dst, data);
    im.uri = '../tex/' + h;
  }
  fs.writeFileSync(gp, JSON.stringify(j));
}
for (const key of Object.keys(CARS)) for (const f of fs.readdirSync(path.join(out, key))) if (!/\.(gltf|bin)$/.test(f)) fs.rmSync(path.join(out, key, f));
console.log('deduped', saved >> 20, 'MB');
