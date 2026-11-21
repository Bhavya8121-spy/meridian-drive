import * as THREE from 'three';

export function createNavDisplay(params) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 266;
  const ctx = canvas.getContext('2d');
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.145),
    new THREE.MeshBasicMaterial({ map, toneMapped: false }));
  screen.name = 'infotainment';
  screen.position.set(0.025, params.belt + 0.045, params.cabinZ1 - 0.392);
  screen.rotation.set(0.15, Math.PI + 0.11, 0, 'YXZ');
  let lastUpdate = -Infinity;

  function draw(time, cue, minimap) {
    if (time - lastUpdate < 140) return;
    lastUpdate = time;
    ctx.fillStyle = '#0c1725';
    ctx.fillRect(0, 0, 512, 266);
    ctx.fillStyle = '#263649';
    ctx.fillRect(12, 14, 216, 239);
    if (minimap) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(17, 19, 206, 229, 13);
      ctx.clip();
      ctx.drawImage(minimap, 17, 19, 206, 229);
      ctx.restore();
    }
    ctx.fillStyle = '#84d4ff';
    ctx.font = 'bold 104px sans-serif';
    ctx.fillText(cue.arrow, 246, 137);
    ctx.fillStyle = '#f3faff';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(cue.title, 249, 181, 244);
    ctx.fillStyle = '#a9bbd1';
    ctx.font = '20px sans-serif';
    ctx.fillText(cue.detail, 249, 223, 244);
    map.needsUpdate = true;
  }
  return { screen, draw };
}
