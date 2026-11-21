import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { disposeCarModel } from '../vehicle/carModel.js';
import { createVehicleModel } from '../vehicle/gltfCars.js';

export class Showroom {
  constructor(materials) {
    this.materials = materials;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(33, 1, 0.1, 60);
    this.angle = 0.88;
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 7.4), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying vec2 vUv; void main(){ vec2 p = (vUv - 0.5) * vec2(2.05, 1.9); gl_FragColor = vec4(0.025, 0.04, 0.055, (1.0 - smoothstep(0.15, 0.82, length(p))) * 0.74); }',
    }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.shadow);
  }

  attach(host, car, color) {
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      } catch {
        host.textContent = car.name;
        return;
      }
      const renderer = this.renderer;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.04;
      const room = new RoomEnvironment();
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.scene.environment = pmrem.fromScene(room, 0.05).texture;
      room.dispose();
      pmrem.dispose();

      const key = new THREE.DirectionalLight(0xf7eadb, 2.6);
      key.position.set(-4, 8, 5);
      const rim = new THREE.DirectionalLight(0x96c8ff, 1.9);
      rim.position.set(1, 5, -7);
      this.scene.add(key, rim, new THREE.HemisphereLight(0xd7e8fa, 0x3b4d5b, 1.2));
      const floor = new THREE.GridHelper(30, 30, 0x587482, 0x314956);
      floor.position.y = -0.02;
      this.scene.add(floor);

      const canvas = renderer.domElement;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.addEventListener('pointerdown', (event) => {
        this.drag = event.clientX;
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (!canvas.hasPointerCapture(event.pointerId)) return;
        this.angle -= (event.clientX - this.drag) * 0.012;
        this.drag = event.clientX;
        this.render();
      });
      this.resize = new ResizeObserver(() => this.render());
    }
    this.resize.disconnect();
    if (this.model) disposeCarModel(this.model);
    this.model = createVehicleModel(this.materials, car.type, car.type === 'hatch' ? 0.20 : 0.25, Boolean(car.battery));
    this.model.materials.paint.color.set(color);
    this.model.materials.glass.opacity = 0.65;
    this.model.materials.glass.envMapIntensity = 0.75;
    this.scene.add(this.model.root);
    this.host = host;
    host.append(this.renderer.domElement);
    this.resize.observe(host);
    this.render();
  }

  render() {
    const width = this.host?.clientWidth, height = this.host?.clientHeight;
    if (!width || !height) return;
    const radius = Math.max(6.5, 7.4 / (width / height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(Math.sin(this.angle) * radius, 2.60, Math.cos(this.angle) * radius);
    this.camera.lookAt(0, 0.65, 0);
    this.renderer.setSize(width, height, false);
    this.renderer.render(this.scene, this.camera);
  }

  detach() {
    this.resize?.disconnect();
    if (this.model) disposeCarModel(this.model);
    this.model = null;
    this.host = null;
  }
}
