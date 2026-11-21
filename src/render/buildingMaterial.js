// Prewar facade shader. Buildings are instanced unit boxes (base at y=0, height 1) scaled per
// instance, so the vertex shader can recover each building's base and top from instanceMatrix.
// The fragment shader then composes, per wall pixel:
//   base (stone, storefronts with sign band)  |  shaft (brick/stone, window bays, piers)  |  top (stone band)
// Windows are recessed with a parallax offset (visible reveals), have mullions, blinds, AC units,
// a fake room interior behind the glass (interior mapping), sills/lintels and grime streaks.
import * as THREE from 'three';
import { WORLD } from './materials.js';

/**
 * mode: 0 masonry, 1 glass curtain wall, 2 plain (no openings)
 * win: [marginX, marginBottom, marginTop, arch] as fractions of the bay/floor cell
 * panes: mullion grid inside each window
 */
export const BUILDING_STYLES = {
  prewar: { mode: 0, wall: 'brick', wallScale: 1.1, stone: [0.86, 0.82, 0.74], bayW: 2.2, floorH: 3.5, baseH: 7.4, topH: 4.2, pier: 3, win: [0.2, 0.22, 0.13, 0], panes: [1, 2], glass: [0.06, 0.07, 0.08], glassMetal: 0.35, store: 1, ac: 0.16, recess: 0.24, trim: 1, lit: 0.28, rough: 0.85 },
  limestone: { mode: 0, wall: 'stone', wallScale: 3.0, stone: [0.82, 0.79, 0.72], bayW: 2.5, floorH: 3.6, baseH: 7.6, topH: 3.6, pier: 0, win: [0.22, 0.24, 0.12, 0], panes: [2, 2], glass: [0.05, 0.06, 0.07], glassMetal: 0.4, store: 1, ac: 0.12, recess: 0.28, trim: 0, lit: 0.25, rough: 0.82 },
  loft: { mode: 0, wall: 'stone', wallScale: 3.0, stone: [0.78, 0.76, 0.7], bayW: 3.1, floorH: 4.3, baseH: 4.8, topH: 2.6, pier: 1, win: [0.13, 0.16, 0.1, 0.25], panes: [2, 2], glass: [0.07, 0.08, 0.09], glassMetal: 0.3, store: 1, ac: 0.1, recess: 0.2, trim: 0, lit: 0.32, rough: 0.7 },
  tenement: { mode: 0, wall: 'brick', wallScale: 1.1, stone: [0.8, 0.77, 0.7], bayW: 2.1, floorH: 3.05, baseH: 3.3, topH: 1.8, pier: 0, win: [0.26, 0.25, 0.15, 0], panes: [1, 2], glass: [0.05, 0.055, 0.06], glassMetal: 0.25, store: 0.5, ac: 0.24, recess: 0.2, trim: 1, lit: 0.42, rough: 0.88 },
  brownstone: { mode: 0, wall: 'stone', wallScale: 3.0, stone: [0.5, 0.38, 0.31], bayW: 2.3, floorH: 3.3, baseH: 3.3, topH: 1.4, pier: 0, win: [0.25, 0.22, 0.12, 0.15], panes: [1, 2], glass: [0.05, 0.05, 0.055], glassMetal: 0.25, store: 0, ac: 0.18, recess: 0.26, trim: 0, lit: 0.45, rough: 0.85 },
  factory: { mode: 0, wall: 'brick', wallScale: 1.1, stone: [0.7, 0.68, 0.64], bayW: 4.2, floorH: 4.6, baseH: 4.6, topH: 2.2, pier: 1, win: [0.15, 0.14, 0.1, 0.3], panes: [5, 6], glass: [0.12, 0.13, 0.13], glassMetal: 0.2, store: 0, ac: 0, recess: 0.18, trim: 0, lit: 0.18, rough: 0.9 },
  glass: { mode: 1, wall: 'stone', wallScale: 3.0, stone: [0.24, 0.25, 0.27], bayW: 1.6, floorH: 3.9, baseH: 0, topH: 0, pier: 0, win: [0.035, 0.05, 0.0, 0], panes: [1, 1], glass: [0.07, 0.1, 0.12], glassMetal: 0.9, store: 0, ac: 0, recess: 0.05, trim: 0, lit: 0.22, rough: 0.35 },
  plain: { mode: 2, wall: 'stone', wallScale: 3.0, stone: [0.6, 0.6, 0.6], bayW: 3, floorH: 100, baseH: 0, topH: 0, pier: 0, win: [0.5, 0.5, 0.5, 0], panes: [1, 1], glass: [0.1, 0.1, 0.1], glassMetal: 0, store: 0, ac: 0, recess: 0, trim: 0, lit: 0, rough: 0.8 },
  metal: { mode: 2, wall: 'stone', wallScale: 3.0, stone: [0.62, 0.64, 0.66], bayW: 3, floorH: 100, baseH: 0, topH: 0, pier: 0, win: [0.5, 0.5, 0.5, 0], panes: [1, 1], glass: [0.1, 0.1, 0.1], glassMetal: 0, store: 0, ac: 0, recess: 0, trim: 0, lit: 0, rough: 0.45, metal: 0.75 },
};

/** Per-instance tint palettes (brick colours etc). */
export const STYLE_TINTS = {
  prewar: [[0.86, 0.66, 0.5], [0.95, 0.82, 0.64], [0.72, 0.42, 0.32], [0.8, 0.72, 0.62], [0.62, 0.48, 0.4]],
  limestone: [[1, 1, 1], [0.95, 0.93, 0.88], [1.04, 1.0, 0.92], [0.88, 0.86, 0.82]],
  loft: [[1, 1, 1], [0.92, 0.9, 0.84], [0.82, 0.84, 0.86], [1.02, 0.96, 0.86]],
  tenement: [[0.78, 0.42, 0.32], [0.7, 0.36, 0.28], [0.86, 0.6, 0.45], [0.6, 0.45, 0.38], [0.82, 0.5, 0.36]],
  brownstone: [[1, 1, 1], [0.9, 0.88, 0.9], [1.08, 1.0, 0.95]],
  factory: [[0.5, 0.45, 0.42], [0.62, 0.38, 0.3], [0.7, 0.6, 0.5], [0.45, 0.42, 0.42], [0.66, 0.44, 0.34]],
  glass: [[0.9, 0.95, 1.0], [0.8, 0.9, 0.95], [0.95, 0.95, 0.95]],
  plain: [[1, 1, 1], [0.85, 0.85, 0.85]],
  metal: [[1, 1, 1], [0.9, 0.92, 0.95]],
};

const FRAG_HEAD = /* glsl */`
uniform float uMode; uniform vec3 uStone; uniform float uBayW; uniform float uFloorH; uniform float uBaseH; uniform float uTopH;
uniform float uPier; uniform vec4 uWin; uniform vec2 uPanes; uniform vec3 uGlass; uniform float uGlassMetal; uniform float uStore;
uniform float uAC; uniform float uRecess; uniform float uTrim; uniform float uLitProb; uniform float uRough; uniform float uMetal;
uniform sampler2D uWallMap; uniform sampler2D uWallNormal; uniform float uWallScale; uniform sampler2D uStoneMap; uniform sampler2D uStoneNormal;
uniform float uWallNorm; uniform float uStoneNorm;
varying float vY0; varying float vTop;
float inRect(vec2 p, vec2 a, vec2 b) { return step(a.x, p.x) * step(p.x, b.x) * step(a.y, p.y) * step(p.y, b.y); }
float inWin(vec2 p, vec2 a, vec2 b, float arch) {
  float r = inRect(p, a, b);
  if (arch > 0.0) {
    // segmental / round arch: carve the top corners
    float hw = (b.x - a.x) * 0.5;
    float ah = min(hw, (b.y - a.y) * arch);
    float cy = b.y - ah;
    if (p.y > cy) { vec2 q = vec2((p.x - (a.x + hw)) / hw, (p.y - cy) / ah); r *= step(dot(q, q), 1.0); }
  }
  return r;
}
`;

const FRAG_BODY = /* glsl */`
  vec3 fN = normalize(vWNormal);
  float isWall = step(abs(fN.y), 0.5);
  vec3 fT = normalize(vec3(-fN.z, 0.0, fN.x));
  vec2 fc = vec2(dot(vWPos.xz, fT.xz), vWPos.y);
  float yRel = vWPos.y - vY0;
  float yTop = vTop - vWPos.y;
  float baseH = vY0 < 1.0 ? uBaseH : 0.0;
  vec3 Vw = normalize(cameraPosition - vWPos);
  vec3 vt = vec3(dot(Vw, fT), Vw.y, max(dot(Vw, fN), 0.08));
  float winMask = 0.0, reveal = 0.0, acMask = 0.0, frameMask = 0.0, blindMask = 0.0, trimMask = 0.0, lit = 0.0, stoneMask = 0.0, shopMask = 0.0;
  float wh = 0.0;
  vec2 cid = vec2(0.0);
  vec3 interior = vec3(0.0);
  vec3 tint = diffuseColor.rgb;
  vec3 wallTex = texture2D(uWallMap, fc / uWallScale).rgb;
  vec3 stoneTex = texture2D(uStoneMap, fc / 3.0).rgb;
  // photo-scanned maps: keep their luminance detail, take hue from the per-building tint / stone colour
  if (uWallNorm > 0.0) wallTex = vec3(dot(wallTex, vec3(0.2126, 0.7152, 0.0722))) * uWallNorm;
  if (uStoneNorm > 0.0) stoneTex = vec3(dot(stoneTex, vec3(0.2126, 0.7152, 0.0722))) * uStoneNorm;
  vec3 wallCol;
  vec3 wallBase = vec3(0.0);
  // metres per pixel: when a window bay is only a few pixels wide, its detail aliases into moiré
  float footprint = max(length(fwidth(fc)), 1e-4);
  float farDetail = smoothstep(0.1, 0.4, footprint);
  if (isWall < 0.5) {
    wallCol = vec3(0.17, 0.17, 0.165) * (0.7 + 0.6 * texture2D(uStoneMap, vWPos.xz * 0.21).r);
  } else {
    float inBase = step(yRel, baseH) * step(0.01, baseH);
    float inTop = step(yTop, uTopH) * step(0.01, uTopH);
    stoneMask = max(inBase, inTop);
    wallCol = mix(wallTex * tint, stoneTex * uStone, stoneMask);
    wallBase = wallCol;
    if (uMode > 1.5) {
      // plain: no openings
    } else if (uMode > 0.5) {
      // modern curtain wall
      vec2 cell = vec2(fc.x / uBayW, yRel / uFloorH);
      cid = floor(cell); vec2 f = fract(cell);
      winMask = step(uWin.x, f.x) * step(f.x, 1.0 - uWin.x) * step(uWin.y, f.y);
      wh = hash12(cid * 1.37 + floor(vWPos.xz / 61.0) * 7.13 + fN.xz * 3.1);
      interior = uGlass * (0.75 + 0.5 * wh);
      wallCol = uStone * tint;
    } else if (inBase > 0.5 && (uStore > 0.5 || (uStore > 0.25 && hash12(floor(vWPos.xz / 40.0)) > 0.5))) {
      // ---- base: rusticated stone, storefronts ----
      wallCol = stoneTex * uStone * (1.0 - 0.18 * step(fract(yRel / 0.62), 0.06));
      {
        float shopW = 4.2;
        float sx = fc.x / shopW; float bay = floor(sx); float fx = fract(sx);
        vec2 cm = vec2(fx * shopW, yRel);
        float topY = min(baseH - 1.6, 3.7);
        vec2 a = vec2(0.35, 0.45), b = vec2(shopW - 0.35, topY);
        float door = step(0.66, hash12(vec2(bay, 3.0) + floor(vWPos.xz / 97.0)));
        if (door > 0.5) a.y = 0.02;
        cid = vec2(bay, -7.0);
        if (inRect(cm, a, b) > 0.5) {
          vec2 p = cm - vt.xy / vt.z * 0.35;
          if (inRect(p, a, b) > 0.5) {
            winMask = 1.0; shopMask = 1.0;
            vec2 q = (p - a) / (b - a);
            frameMask = max(step(abs(q.x - 0.5), 0.012), step(q.y, 0.04));
            // shop interior (interior mapping): a lit box room behind the glass with shelving on the
            // back and side walls, a light floor and ceiling panels. Rays are traced against the room planes.
            float hs = hash12(vec2(bay, 11.0) + floor(vWPos.xz / 89.0));
            float D = 5.5, ceilY = topY + 0.3;
            vec3 rd = vec3(-vt.x, -vt.y, vt.z);
            float tB = D / rd.z;
            float tS = rd.x > 0.0 ? (shopW - 0.05 - cm.x) / rd.x : (cm.x - 0.05) / max(-rd.x, 1e-4);
            float tV = rd.y < 0.0 ? (cm.y - 0.05) / max(-rd.y, 1e-4) : (ceilY - cm.y) / max(rd.y, 1e-4);
            float t = min(tB, min(tS, tV));
            vec3 h = vec3(cm.x + rd.x * t, cm.y + rd.y * t, rd.z * t);
            vec3 wallC = mix(vec3(0.42, 0.36, 0.3), vec3(0.62, 0.6, 0.56), hs);
            float fade = 1.0 - 0.6 * smoothstep(0.0, D, h.z);
            if (t == tV && rd.y < 0.0) {
              interior = mix(vec3(0.32, 0.29, 0.25), vec3(0.42, 0.42, 0.4), fract(hs * 5.3)) * (0.9 + 0.1 * step(0.5, fract(h.x * 1.6 + floor(h.z * 1.6) * 0.5)));
            } else if (t == tV) {
              float panel = step(abs(fract(h.z / 1.4) - 0.5), 0.18) * step(abs(h.x - shopW * 0.5), shopW * 0.3);
              interior = vec3(0.5, 0.49, 0.47) + panel * vec3(2.2, 2.1, 1.9);
            } else {
              // wall coordinate along the wall (x on the back wall, depth on the side walls)
              float u = t == tB ? h.x : h.z;
              float row = floor((h.y - 0.25) / 0.42);
              float onShelf = step(0.25, h.y) * step(h.y, min(2.35, ceilY - 0.5)) * step(0.15, hs);
              float item = hash12(vec2(floor(u / 0.22), row) + bay * 3.1);
              vec3 goods = mix(vec3(0.5, 0.45, 0.38), vec3(0.32, 0.36, 0.42), item) * (0.6 + 0.6 * fract(item * 13.7));
              float board = step(fract((h.y - 0.25) / 0.42), 0.08);
              float gap = step(fract(u / 0.22), 0.12);
              vec3 shelfC = mix(goods, vec3(0.16, 0.13, 0.1), max(board, gap * 0.6));
              interior = mix(wallC * (t == tB ? 1.0 : 0.85), shelfC, onShelf);
            }
            interior *= fade * mix(0.32, 0.5, hs);
            // window display: a dark counter/plinth band just behind the glass at the bottom
            interior *= 1.0 - 0.6 * step(cm.y + rd.y * (0.6 / rd.z), 0.75) * step(0.6 / rd.z, t);
          } else reveal = 1.0;
        }
        // dark sign band above the shop window
        float band = step(topY + 0.1, yRel) * step(yRel, min(baseH - 0.55, topY + 0.95));
        wallCol = mix(wallCol, vec3(0.06, 0.065, 0.07), band);
        trimMask = band;
      }
    } else if (inTop > 0.5) {
      // ---- top: stone frieze with horizontal mouldings ----
      float m = step(fract(yTop / 1.1), 0.12);
      wallCol *= 1.0 - 0.25 * m;
    } else {
      // ---- shaft window bays (also used for a shop-less base, as one tall ground floor) ----
      float fh = inBase > 0.5 ? baseH : uFloorH;
      if (inBase > 0.5) wallCol = stoneTex * uStone * (1.0 - 0.18 * step(fract(yRel / 0.62), 0.06));
      float bx = fc.x / uBayW; float bay = floor(bx); float fx = fract(bx);
      float fy_ = inBase > 0.5 ? yRel / fh : (yRel - baseH) / uFloorH; float flo = inBase > 0.5 ? -1.0 : floor(fy_); float fy = fract(fy_);
      cid = vec2(bay, flo);
      vec2 cm = vec2(fx * uBayW, fy * fh);
      vec2 a = vec2(uWin.x * uBayW, inBase > 0.5 ? 1.0 : uWin.y * uFloorH), b = vec2((1.0 - uWin.x) * uBayW, fh - (inBase > 0.5 ? 0.5 : uWin.z * uFloorH));
      float isPier = (uPier > 0.5 && mod(bay, uPier) < 0.5) ? 1.0 : 0.0;
      // piers: wider masonry strip between bay groups (no window in that bay's left margin)
      if (isPier > 0.5 && fx < 0.18) wallCol *= 0.86;
      wh = hash12(cid * 1.37 + floor(vWPos.xz / 61.0) * 7.13 + fN.xz * 3.1);
      if (inWin(cm, a, b, uWin.w) > 0.5) {
        vec2 p = cm - vt.xy / vt.z * uRecess;
        if (inWin(p, a, b, uWin.w) > 0.5) {
          winMask = 1.0;
          vec2 q = (p - a) / (b - a);
          vec2 pane = fract(q * uPanes);
          float fw = 0.035 * max(uPanes.x, uPanes.y) * 0.6 + 0.02;
          frameMask = max(max(step(pane.x, fw), step(1.0 - fw, pane.x)), max(step(pane.y, fw), step(1.0 - fw, pane.y)));
          frameMask = max(frameMask, max(step(q.x, 0.03), step(0.97, q.x)));
          // blinds / curtains drawn from the top
          float bl = wh > 0.62 ? fract(wh * 7.31) * 0.6 : -1.0;
          blindMask = step(1.0 - bl, q.y);
          // fake room behind the glass: floor, back wall, ceiling
          vec2 p2 = cm - vt.xy / vt.z * 3.2;
          vec3 roomTint = mix(vec3(0.95, 0.9, 0.82), vec3(0.8, 0.86, 0.95), step(0.6, fract(wh * 3.7)));
          float floorZ = step(p2.y, a.y - 0.4), ceilZ = step(b.y + 0.5, p2.y);
          interior = roomTint * mix(0.11, 0.2, ceilZ) * (1.0 - 0.5 * floorZ);
          interior *= 0.75 + 0.5 * hash12(floor(p2 * 1.3) + cid);
        } else reveal = 1.0;
        // window air-conditioner hanging in the lower sash (outer plane, so it pops out)
        float hac = hash12(cid * 1.91 + 9.3 + floor(vWPos.xz / 53.0));
        if (hac < uAC) {
          float mid = (a.x + b.x) * 0.5;
          vec2 a0 = vec2(mid - 0.34, a.y + 0.02), a1 = vec2(mid + 0.34, a.y + 0.42);
          if (inRect(cm, a0, a1) > 0.5) { acMask = 1.0; winMask = 0.0; reveal = 0.0; frameMask = step(fract((cm.x - a0.x) * 18.0), 0.35) * step(cm.y, a1.y - 0.08); }
        }
      }
      // sills and lintels
      float sill = inRect(cm, vec2(a.x - 0.1, a.y - 0.13), vec2(b.x + 0.1, a.y));
      float lintel = inRect(cm, vec2(a.x - 0.12, b.y), vec2(b.x + 0.12, b.y + 0.24)) * (1.0 - step(0.01, uWin.w));
      trimMask = max(sill, lintel * uTrim);
      wallCol = mix(wallCol, stoneTex * uStone * 1.05, trimMask);
      // dirt streaks running down from the sills
      float streak = step(a.x, cm.x) * step(cm.x, b.x) * (1.0 - smoothstep(a.y - 1.4, a.y - 0.13, cm.y) * 0.0) * step(cm.y, a.y - 0.13);
      streak *= smoothstep(a.y - 1.6, a.y - 0.13, cm.y) * (0.5 + 0.5 * sin(cm.x * 23.0 + wh * 9.0));
      wallCol *= 1.0 - 0.18 * streak;
      wallCol = mix(wallCol, wallCol * 0.42, reveal);
    }
    // grime gradient toward the pavement
    wallCol *= mix(0.62, 1.0, smoothstep(0.0, 2.8, vWPos.y));
  }
  // compose
  vec3 col = wallCol;
  vec3 glassCol = mix(interior + uGlass * 0.6, uGlass * 0.5, shopMask);
  col = mix(col, glassCol, winMask);
  col = mix(col, vec3(0.5, 0.46, 0.4), blindMask * winMask);
  col = mix(col, uMode > 0.5 ? vec3(0.2, 0.21, 0.22) : vec3(0.12, 0.11, 0.1), frameMask * winMask);
  col = mix(col, vec3(0.62, 0.62, 0.6) * (0.85 + 0.3 * frameMask), acMask);
  // far away: replace per-window detail with its area-average (pre-filtered, no shimmer)
  if (isWall > 0.5 && uMode < 1.5) {
    vec3 avg = mix(wallBase * 0.8, uGlass * 0.9 + vec3(0.03), uMode > 0.5 ? 0.8 : 0.32);
    col = mix(col, avg, farDetail);
  }
  diffuseColor.rgb = col;
  float glassOnly = winMask * (1.0 - frameMask) * (1.0 - blindMask) * (1.0 - farDetail);
  lit = step(1.0 - uLitProb, hash12(cid * 2.71 + floor(vWPos.xz / 53.0) * 3.7 + fN.xz)) * winMask;
  lit = max(lit, shopMask * step(0.25, hash12(cid + 2.0)));
`;

export function makeBuildingMaterial(styleName, tex) {
  const st = BUILDING_STYLES[styleName];
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: st.rough, metalness: st.metal || 0 });
  const wallTex = st.wall === 'brick' ? tex.brickN : tex.stone;
  const u = {
    uMode: { value: st.mode }, uStone: { value: new THREE.Color(...st.stone) }, uBayW: { value: st.bayW }, uFloorH: { value: st.floorH },
    uBaseH: { value: st.baseH }, uTopH: { value: st.topH }, uPier: { value: st.pier }, uWin: { value: new THREE.Vector4(...st.win) },
    uPanes: { value: new THREE.Vector2(...st.panes) }, uGlass: { value: new THREE.Color(...st.glass) }, uGlassMetal: { value: st.glassMetal },
    uStore: { value: st.store }, uAC: { value: st.ac }, uRecess: { value: st.recess }, uTrim: { value: st.trim }, uLitProb: { value: st.lit },
    uRough: { value: st.rough }, uMetal: { value: st.metal || 0 },
    uWallMap: { value: wallTex.map }, uWallNormal: { value: wallTex.normalMap }, uWallScale: { value: wallTex.photoSize || st.wallScale }, uWallNorm: { value: wallTex.norm || 0 }, uStoneNorm: { value: tex.stone.norm || 0 },
    uStoneMap: { value: tex.stone.map }, uStoneNormal: { value: tex.stone.normalMap },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WORLD, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNormal; varying float vY0; varying float vTop;')
      .replace('#include <project_vertex>', /* glsl */`#include <project_vertex>
      {
        vec4 wp = vec4(transformed, 1.0); vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp; wn = mat3(instanceMatrix) * wn;
          vY0 = instanceMatrix[3][1]; vTop = vY0 + length(instanceMatrix[1].xyz);
        #else
          vY0 = 0.0; vTop = 30.0;
        #endif
        wp = modelMatrix * wp;
        vWPos = wp.xyz; vWNormal = normalize(mat3(modelMatrix) * wn);
      }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNormal;
        uniform float uTime; uniform float uWet; uniform float uNight; uniform float uRain;
        float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        ${FRAG_HEAD}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_BODY)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
        roughnessFactor = uRough * (0.85 + 0.3 * wallTex.r);
        roughnessFactor = mix(roughnessFactor, 0.04 + wh * 0.06 + shopMask * 0.04, glassOnly);
        roughnessFactor = mix(roughnessFactor, 0.75, blindMask * winMask);
        roughnessFactor = mix(roughnessFactor, 0.5, acMask);
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35 + 0.05, uWet * isWall * step(vWPos.y, 4.0));`)
      .replace('#include <metalnessmap_fragment>', /* glsl */`#include <metalnessmap_fragment>
        metalnessFactor = mix(uMetal, mix(uGlassMetal, 0.12, shopMask), glassOnly) * isWall + acMask * 0.3;`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
        if (isWall > 0.5 && winMask < 0.5 && acMask < 0.5 && uMode < 0.5) {
          vec3 nm = (stoneMask > 0.5 || trimMask > 0.5) ? texture2D(uStoneNormal, fc / 3.0).xyz : texture2D(uWallNormal, fc / uWallScale).xyz;
          nm = nm * 2.0 - 1.0;
          vec3 pw = fT * nm.x + vec3(0.0, 1.0, 0.0) * nm.y;
          normal = normalize(normal + (viewMatrix * vec4(pw, 0.0)).xyz * 0.9);
        }`)
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        {
          vec3 warm = mix(vec3(1.0, 0.66, 0.36), vec3(0.85, 0.9, 1.0), step(0.75, hash12(cid + 5.3)));
          // lit windows stay individual far longer than daytime detail (sparse lights are the night city);
          // only once a bay is a few pixels wide do they become their area-average glow
          float tiny = smoothstep(0.3, 0.8, footprint);
          float winGlass = winMask * (1.0 - frameMask) * (1.0 - blindMask);
          float glow = (winGlass + blindMask * winMask * 0.7) * lit * (1.0 - tiny);
          totalEmissiveRadiance += warm * glow * uNight * (0.3 + 0.3 * hash12(cid + 1.7)) * (1.0 - shopMask);
          totalEmissiveRadiance += vec3(1.0, 0.72, 0.45) * tiny * uLitProb * 0.03 * isWall * step(uMode, 1.5) * (1.0 - stoneMask) * uNight;
          // shop interiors are lit all day (warm at night), seen through clear glass
          // at night exposure adapts ~2.4x brighter, so emission drops; closed shops (unlit) go nearly dark
          totalEmissiveRadiance += interior * glassOnly * shopMask * mix(0.9, 0.42, uNight) * mix(vec3(1.0), warm * (0.08 + 1.1 * lit), uNight);
        }`)
      .replace('#include <lights_fragment_maps>', /* glsl */`#include <lights_fragment_maps>
        #if defined( RE_IndirectSpecular )
        {
          // street canyon: a window's near-horizontal reflection sees the facades across the street, not sky
          vec3 rr = reflect(-Vw, fN);
          float canyon = mix(0.18 + 0.22 * wh, 1.0, smoothstep(0.08, 0.6, rr.y));
          radiance *= mix(1.0, canyon, winMask * isWall);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => 'bld_' + styleName;
  return mat;
}
