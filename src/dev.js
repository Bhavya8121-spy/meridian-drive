// Dev-only automation helpers (window.__dev), used for scripted verification in a browser whose
// window may be hidden (requestAnimationFrame paused). Not included in production builds.
export function installDevTools(game) {
  const key = (codes, type) => codes.forEach((c) => window.dispatchEvent(new KeyboardEvent(type, { code: c })));
  const frame = () => { game.last = performance.now() - 1000 / 60; game.frame(); };
  window.__dev = {
    game,
    /** Advance the game `secs` seconds at 60 fps while holding the given key codes. */
    step(secs, codes = []) {
      key(codes, 'keydown');
      for (let i = 0; i < Math.round(secs * 60); i++) frame();
      key(codes, 'keyup');
      const P = game.player.phys, p = game.player.pos;
      return { kmh: +(P.speed * 3.6).toFixed(1), gear: P.gear, rpm: Math.round(P.rpm), pos: [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)], damage: +P.damage.toFixed(2), upsideDown: P.isUpsideDown() };
    },
    press(code) { key([code], 'keydown'); frame(); key([code], 'keyup'); frame(); },
    /** Render one frame and save the canvas to ./captures/<name>.jpg via the Vite dev endpoint. */
    async capture(name) {
      frame();
      const url = game.renderer.domElement.toDataURL('image/jpeg', 0.85);
      await fetch('/__capture?name=' + encodeURIComponent(name), { method: 'POST', body: url });
      return url.length;
    },
    teleport(x, z, heading = 0, y = 0.5) { game.player.reset({ x, y, z }, heading); game.rig.yaw = heading; game.city.updateStreaming({ x, z }, 220); },
    /** Median CPU+GPU frame time over n frames (gl.finish forces GPU completion). */
    bench(n = 30) {
      const gl = game.renderer.getContext(), ts = [];
      for (let i = 0; i < n; i++) { const t = performance.now(); frame(); gl.finish(); ts.push(performance.now() - t); }
      ts.sort((a, b) => a - b);
      const info = game.renderer.info.render;
      return { medianMs: +ts[n >> 1].toFixed(2), calls: info.calls, triangles: info.triangles };
    },
  };
}
