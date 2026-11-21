import { CITY } from '../world/layout.js';

export const SPEED_LIMIT = 80;

/** City streets (the street grid, not the ring expressway or the elevated boulevard) carry the speed limit. */
export function speedLimitAt(position) {
  return Math.max(Math.abs(position.x), Math.abs(position.z)) <= CITY.half + 6 && (position.y ?? 0) < 3 ? SPEED_LIMIT : null;
}

/**
 * Road enforcement is deliberately light: only speeding on city streets is fined (debounced, at most one ticket
 * per 8 s). Red lights, stop signs and crash claims were removed so the city can be driven freely.
 */
export class RoadRules {
  constructor() { this.reset(); }

  reset() {
    this.previous = null;
    this.speeding = 0;
    this.ticketIn = 0;
  }

  update(dt, position, heading, speedKmh, signalTime, charge) {
    this.previous = { x: position.x, z: position.z };
    this.ticketIn = Math.max(0, this.ticketIn - dt);
    const limit = speedLimitAt(position);
    this.speeding = limit && speedKmh > limit + 0.5 ? this.speeding + dt : 0;
    if (this.speeding >= 0.85 && this.ticketIn === 0) {
      this.ticketIn = 8;
      charge('Speeding', 9);
    }
  }
}

export function impactInvoice(kind, strength) {
  const scale = Math.min(1, Math.max(0, strength));
  if (kind === 'pedestrian') return { label: 'Pedestrian incident', cost: Math.round(28 + 25 * scale), wear: 0.035 + 0.09 * scale };
  if (kind === 'vehicle') return { label: 'Vehicle damage claim', cost: Math.round(7 + 28 * scale), wear: 0.02 + 0.12 * scale };
  return { label: 'Property damage claim', cost: Math.round(3 + 16 * scale), wear: 0.015 + 0.10 * scale };
}
