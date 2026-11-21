import { describe, it, expect } from 'vitest';
import { buildLayout, signalState, SURF, nearestLanePoint, gridLine } from '../src/world/layout.js';

const L = buildLayout(1337);

describe('city layout', () => {
  it('is deterministic for a seed', () => {
    const L2 = buildLayout(1337);
    expect(L2.buildings.length).toBe(L.buildings.length);
    expect(L2.paths.length).toBe(L.paths.length);
    expect(L2.buildings[10]).toEqual(L.buildings[10]);
  });

  it('has a connected lane graph with no dead ends', () => {
    for (const p of L.paths) {
      expect(p.len).toBeGreaterThan(0.5);
      expect(p.next.length).toBeGreaterThan(0);
      for (const n of p.next) expect(L.paths[n]).toBeDefined();
    }
  });

  it('lane endpoints connect continuously to their successors', () => {
    for (const p of L.paths) {
      const end = p.pts[p.pts.length - 1];
      for (const n of p.next) {
        const s = L.paths[n].pts[0];
        const gap = Math.hypot(end[0] - s[0], end[1] - s[1], end[2] - s[2]);
        expect(gap).toBeLessThan(0.05);
      }
    }
  });

  it('never shows green to both axes of a signalised intersection', () => {
    const signals = L.intersections.filter((i) => i.type === 'signal');
    expect(signals.length).toBeGreaterThan(10);
    for (const I of signals) {
      for (let t = 0; t < 120; t += 0.25) {
        const x = signalState(I, 'x', t), z = signalState(I, 'z', t);
        expect(x !== 'red' && z !== 'red').toBe(false);
      }
    }
  });

  it('classifies surfaces sensibly', () => {
    expect(L.surfaceAt(gridLine(4), 37)).toBe(SURF.ROAD);           // on an arterial
    expect(L.surfaceAt(520, 200)).toBe(SURF.HIGHWAY);                // on the ring expressway
    expect(L.surfaceAt(2000, 0)).toBe(SURF.GROUND);                  // outside the raster
  });

  it('keeps buildings off the roads', () => {
    for (const b of L.buildings) {
      if (b.y0 > 0) continue;
      expect(L.surfaceAt(b.x, b.z)).not.toBe(SURF.ROAD);
    }
  });

  it('finds the nearest lane for vehicle resets', () => {
    const p = nearestLanePoint(L, -170, 6);
    expect(Math.abs(p.z - 5.25)).toBeLessThan(0.5);
  });
});
