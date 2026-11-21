import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function buildStationModels(scene, city, physics) {
  const paint = (color, metalness = 0) => new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.55 });
  const materials = {
    porcelain: paint(0xdce0db, 0.22), rubber: paint(0x171b1e), concrete: paint(0x93928b),
    fuel: paint(0xbf3831, 0.25), charge: paint(0x216d82, 0.25), yellow: paint(0xf0bb43),
    screen: new THREE.MeshBasicMaterial({ color: 0xafe5ed }),
    canopyLight: new THREE.MeshBasicMaterial({ color: 0xffeed4 }),
  };
  function model(electric) {
    const shapes = new Map();
    function add(g, material, x, y, z) {
      const list = shapes.get(material) ?? [];
      g.translate(x, y, z);
      list.push(g.index ? g.toNonIndexed() : g);
      shapes.set(material, list);
    }
    const box = (w, h, d, mat, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
    const style = electric ? 'charge' : 'fuel';
    box(3.7, 0.14, 0.95, 'concrete', 0, 0.07, 0.15);
    box(electric ? 0.55 : 0.92, 1.38, 0.48, 'porcelain', 0, 0.81, 0);
    box(electric ? 0.60 : 1.01, 0.17, 0.53, style, 0, 1.52, 0);
    box(electric ? 0.28 : 0.56, 0.44, 0.04, 'rubber', 0, 1.08, 0.25);
    box(electric ? 0.20 : 0.43, 0.17, 0.025, 'screen', 0, 1.16, 0.28);
    box(0.1, 0.08, 0.035, 'canopyLight', 0.07, 0.91, 0.275);
    for (const side of [-1, 1]) {
      const x = side * 1.34;
      add(new THREE.CylinderGeometry(0.07, 0.07, 0.84, 9), 'yellow', x, 0.49, 0.30);
      if (!electric) box(0.14, 2.75, 0.14, 'porcelain', x, 1.48, -0.24);
      if (electric && side < 0) continue;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.32, 1.36, 0.13), new THREE.Vector3(side * 0.60, 0.92, 0.20),
        new THREE.Vector3(side * 0.65, 0.35, 0.23), new THREE.Vector3(side * 0.48, 0.40, 0.25),
        new THREE.Vector3(side * 0.35, 0.91, 0.25),
      ]);
      add(new THREE.TubeGeometry(curve, 12, 0.028, 6, false), 'rubber', 0, 0, 0);
      box(0.09, 0.20, 0.11, 'rubber', side * 0.35, 0.96, 0.26);
    }
    if (!electric) {
      box(4.4, 0.23, 1.68, 'porcelain', 0, 2.90, 0);
      box(4.4, 0.16, 1.72, style, 0, 3.06, 0);
      box(2.1, 0.035, 0.22, 'canopyLight', 0, 2.77, 0.14);
    }
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 512; signCanvas.height = 128;
    const ctx = signCanvas.getContext('2d');
    ctx.fillStyle = electric ? '#166377' : '#a73230';
    ctx.fillRect(0, 0, 512, 128);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 50px sans-serif';
    ctx.fillText(electric ? 'EV CHARGING' : 'MERIDIAN FUEL', 256, 78, 474);
    const map = new THREE.CanvasTexture(signCanvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(electric ? 1.36 : 2.10, electric ? 0.34 : 0.22),
      new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }));
    sign.position.set(0, electric ? 1.79 : 3.03, electric ? 0.13 : 0.87);
    const group = new THREE.Group();
    for (const [key, list] of shapes) group.add(new THREE.Mesh(mergeGeometries(list), materials[key]));
    group.add(sign);
    return group;
  }
  const gas = model(false), electric = model(true);
  for (const stop of [...city.stations, ...city.chargers]) {
    const charging = stop.type === 'charge';
    const group = (charging ? electric : gas).clone();
    const { road, walk } = stop;
    group.position.set(walk.x, 0.15, walk.z);
    group.rotation.y = road.axis === 'x' ? (stop.side > 0 ? Math.PI : 0) : -stop.side * Math.PI / 2;
    scene.add(group);
    if (physics) {
      const { RAPIER, world, registerStatic, cull } = physics;
      cull.add(group, walk.x, walk.z, 220, 0);
      const half = charging ? 0.36 : 0.5;
      const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(half, 0.73, half)
        .setTranslation(walk.x, 0.88, walk.z));
      registerStatic(collider, walk.x, walk.z, 2);
    }
  }
}
