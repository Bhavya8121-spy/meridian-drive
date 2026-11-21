// Persistent user settings with change notifications.
export const QUALITY = {
// Resolution: every preset renders at full window size; pixelRatioCap limits Retina/HiDPI supersampling.
// (Rendering below 1 CSS pixel and upscaling was the main cause of the blurry picture.)
  low:    { label: 'Low',    renderScale: 0.9,  pixelRatioCap: 1,   shadowMap: 1024, shadowExtent: 60,  ao: false, bloom: true, streetLights: 2,  traffic: 18, drawMul: 0.6, grass: false },
  medium: { label: 'Medium', renderScale: 1.0,  pixelRatioCap: 1.5, shadowMap: 2048, shadowExtent: 75,  ao: false, bloom: true, streetLights: 4,  traffic: 24, drawMul: 0.72, grass: true },
  high:   { label: 'High',   renderScale: 1.0,  pixelRatioCap: 2,   shadowMap: 4096, shadowExtent: 95,  ao: false, bloom: true, streetLights: 6, traffic: 36, drawMul: 1.0, grass: true },
  ultra:  { label: 'Ultra',  renderScale: 1.0,  pixelRatioCap: 2,   shadowMap: 4096, shadowExtent: 120, ao: true,  bloom: true, streetLights: 10, traffic: 48, drawMul: 1.25, grass: true },
};

const DEFAULTS = {
  quality: 'medium',
  ao: false, bloom: true, renderScale: QUALITY.medium.renderScale, dynamicRes: true, settingsVersion: 2,
  trafficDensity: 1,
  masterVolume: 0.8, engineVolume: 0.9, sfxVolume: 0.8, ambienceVolume: 0.6,
  drivingPreset: 'balanced', units: 'kmh', steerSensitivity: 1,
  timeOfDay: 17.2, timeSpeed: 1, weather: 'clear',
  paint: '#b0121b', showFps: false,
};

const KEY = 'meridian-drive-settings-v1';

export class Settings {
  constructor() {
    this.data = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
      // v2: motion blur removed and sub-native render scales retired (they made the picture blurry)
      if ((this.data.settingsVersion || 1) < 2) {
        this.data.renderScale = (QUALITY[this.data.quality] || QUALITY.medium).renderScale;
        delete this.data.motionBlur;
        this.data.settingsVersion = 2;
        localStorage.setItem(KEY, JSON.stringify(this.data));
      }
    } catch { /* storage unavailable */ }
    this.listeners = new Set();
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    if (this.data[k] === v) return;
    this.data[k] = v;
    if (k === 'quality') {
      const q = QUALITY[v];
      this.data.ao = q.ao; this.data.bloom = q.bloom; this.data.renderScale = q.renderScale;
    }
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
    for (const l of this.listeners) l(k, v);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  get quality() { return QUALITY[this.data.quality] || QUALITY.medium; }
}
