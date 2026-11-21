// The prototype's simple facade (both backends implement exactly this, one in GLSL, one in TSL):
// window grid per bay/floor, storefront band at street level, per-window glass tint, lit windows at night,
// wall/glass roughness + metalness split. It stands in for the game's 170-line prewar facade shader.
export function facadeParams(st) {
  const glass = st.glass || [0.06, 0.07, 0.08];
  const win = st.win || [0.2, 0.2, 0.15, 0];
  return {
    stone: st.stone || [0.7, 0.7, 0.7],
    glass,
    bayW: st.bayW || 3,
    floorH: st.floorH || 3.5,
    margin: [win[0], win[1], win[2]],
    store: st.store ? 1 : 0,
    lit: st.lit ?? 0.3,
    rough: st.rough ?? 0.8,
    metal: st.metal || 0,
    glassMetal: st.glassMetal ?? 0.3,
  };
}
export const NIGHT = 0.0; // daytime capture; the emissive path is still evaluated
