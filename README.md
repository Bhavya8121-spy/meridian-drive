# Meridian Drive

An open-world city driving game that runs in the browser.

**Play:** https://bhavya8121-spy.github.io/meridian-drive/

Drive a procedurally generated city with a grid of streets, a ring expressway, a boulevard overpass, a roundabout and a tunnel. The city has traffic, parked cars, pedestrians, day/night and weather. Career mode gives you ride requests on an in-car phone.

## Tech

- [three.js](https://threejs.org) (WebGL 2) for rendering, with custom shader patches for facades, wet roads and vegetation
- [Rapier](https://rapier.rs) (WebAssembly) for physics, with a raycast-suspension vehicle model
- Synthesised Web Audio engine
- [Vite](https://vitejs.dev) for dev and build, [Vitest](https://vitest.dev) for tests

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm test
npm run build
```

`prototype/` holds a WebGL vs WebGPU renderer benchmark. Open `/prototype/webgpu.html` on the dev server; the results are in `prototype/WEBGPU-FINDINGS.md`.

## Credits

- Car models by Daniel Zhabotinsky, CC BY 4.0. See `public/assets/cars/CREDITS.txt`.
- Pedestrian models by Quaternius, CC0. See `public/assets/people/CREDITS.txt`.
- Photo textures and HDRIs from Poly Haven, CC0. See `public/assets/textures/CREDITS.txt`.
