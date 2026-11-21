import * as THREE from 'three';
import { SPEED_LIMIT } from './road-rules.js';

export function addSpeedSigns(scene, layout) {
  const roads = layout.roads.filter((road, index) => (index + Math.floor(index / 16)) % 8 === 3);
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f2eb';
  ctx.fillRect(0, 0, 128, 160);
  ctx.strokeStyle = '#25303a';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, 120, 152);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#172029';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('LIMIT', 64, 33);
  ctx.font = 'bold 68px sans-serif';
  ctx.fillText(SPEED_LIMIT, 64, 105);
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText('KM/H', 64, 137);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.62, 0.775),
    new THREE.MeshStandardMaterial({ map, roughness: 0.58 }), roads.length * 2);
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025, 0.032, 2.45, 7),
    new THREE.MeshStandardMaterial({ color: 0x737d80, metalness: 0.5, roughness: 0.65 }), roads.length * 2);
  const object = new THREE.Object3D();
  let i = 0;
  for (const road of roads) {
    const xAxis = road.axis === 'x';
    for (const direction of [-1, 1]) {
      const x = (road.a.x + road.b.x) / 2 + direction * (xAxis ? -17 : -(road.half + 0.65));
      const z = (road.a.z + road.b.z) / 2 + direction * (xAxis ? road.half + 0.65 : -17);
      object.rotation.y = xAxis ? -direction * Math.PI / 2 : direction > 0 ? Math.PI : 0;
      object.position.set(x, 1.375, z);
      object.updateMatrix();
      pole.setMatrixAt(i, object.matrix);
      object.position.set(x - (xAxis ? 0.03 * direction : 0), 2.18, z - (xAxis ? 0 : 0.03 * direction));
      object.updateMatrix();
      face.setMatrixAt(i++, object.matrix);
    }
  }
  face.computeBoundingSphere();
  pole.computeBoundingSphere();
  scene.add(face, pole);
}
