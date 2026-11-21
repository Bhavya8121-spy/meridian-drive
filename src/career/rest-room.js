import * as THREE from 'three';

export class RestRoom {
  constructor(scene) {
    const root = new THREE.Group();
    root.position.y = 1200;
    root.visible = false;
    scene.add(root);
    this.root = root;

    const box = (size, p, color) => {
      const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.30, roughness: 0.95 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...p);
      root.add(mesh);
      return mesh;
    };
    box([6, 0.12, 5], [0, -0.06, 0], 0x312826);
    box([6, 3, 0.12], [0, 1.5, -2.45], 0x555a6b);
    box([0.12, 3, 5], [-2.95, 1.5, 0], 0x414655);
    box([1.52, 0.30, 2.45], [0, 0.32, -0.85], 0x382c24);
    box([1.55, 0.65, 0.13], [0, 0.63, -2.11], 0x554139);
    box([1.5, 0.18, 2.35], [0, 0.56, -0.85], 0xb1a995);
    box([1.56, 0.20, 1.66], [0, 0.71, -0.47], 0x385c79);
    box([1.52, 0.19, 0.14], [0, 0.73, -1.22], 0x5c8299);
    box([0.67, 0.12, 0.38], [-0.2, 0.70, -1.79], 0xc9bca9);
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xbf8b6a, emissive: 0x603829, emissiveIntensity: 0.45 }));
    face.scale.set(0.83, 0.71, 1.11);
    face.position.set(-0.2, 0.82, -1.72);
    root.add(face);
    box([0.57, 0.63, 0.57], [1.20, 0.32, -1.62], 0x574038);
    box([0.27, 0.32, 0.27], [1.20, 0.90, -1.62], 0xe3bd86).material.emissiveIntensity = 1.2;

  }

  show(camera, elapsed) {
    this.root.visible = true;
    camera.position.set(2.63 - Math.max(0, elapsed - 1.8) * 0.12, 1202.18, 1.46);
    camera.lookAt(0, 1200.75, -1.17);
  }

  hide() { this.root.visible = false; }
}
