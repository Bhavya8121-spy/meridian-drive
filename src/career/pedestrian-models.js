import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const variants = ['casual', 'hoodie', 'formal'];
const MAX_DETAILED = 9;

export class PedestrianModels {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.loaded = false;
    const loader = new GLTFLoader();
    Promise.all(variants.map((name) => loader.loadAsync(import.meta.env.BASE_URL + `assets/people/${name}.glb`)))
      .then((assets) => {
        for (let i = 0; i < MAX_DETAILED; i++) {
          const source = assets[i % assets.length];
          const model = clone(source.scene);
          model.visible = false;
          const mixer = new THREE.AnimationMixer(model);
          const still = mixer.clipAction(THREE.AnimationClip.findByName(source.animations, 'Idle_Neutral'));
          const walk = mixer.clipAction(THREE.AnimationClip.findByName(source.animations, 'Walk'));
          still.play();
          walk.play();
          mixer.setTime(i * 0.21);
          this.pool.push({ model, mixer, still, walk });
          scene.add(model);
        }
        this.loaded = true;
      }).catch((error) => console.warn('Pedestrian models could not load', error));
  }

  begin(dt) {
    this.dt = dt;
    this.cursor = 0;
  }

  place(person, near) {
    if (!this.loaded || !near || this.cursor >= this.pool.length) return false;
    const item = this.pool[this.cursor++];
    item.model.visible = true;
    item.model.position.set(person.x, person.y, person.z);
    item.model.rotation.y = person.heading;
    item.still.setEffectiveWeight(person.walking ? 0 : 1);
    item.walk.setEffectiveWeight(person.walking ? 1 : 0);
    item.mixer.update(this.dt);
    return true;
  }

  finish() {
    for (let i = this.cursor; i < this.pool.length; i++) this.pool[i].model.visible = false;
  }
}
