const suffixes = {
  work: ['Exchange', 'Works', 'Medical Center', 'Design Offices', 'Research Center', 'Market Hall'],
  coffee: ['Coffee Roasters', 'Bakery', 'Tea House'],
  leisure: ['Cinema', 'Gallery', 'Bookshop', 'Recreation Center'],
  nightlife: ['Social Club', 'Music Hall', 'Late Lounge'],
  home: ['Apartments', 'Residences', 'Court'],
};
const avenues = ['Alder', 'Birch', 'Cedar', 'Foundry', 'Meridian', 'Orchard', 'Park', 'Union', 'Willow'];
const streets = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
const label = (r) => r.axis === 'x' ? `${streets[r.line]} Street` : `${avenues[r.line]} Avenue`;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function pointOnRoad(r, p) {
  return r.axis === 'x'
    ? { x: Math.max(r.a.x, Math.min(r.b.x, p.x)), z: r.a.z }
    : { x: r.a.x, z: Math.max(r.a.z, Math.min(r.b.z, p.z)) };
}

export function buildCareerCity(layout) {
  const roads = layout.roads;
  const links = layout.intersections.map(() => []);
  const stops = [];
  const types = ['work', 'home', 'coffee', 'work', 'leisure', 'home', 'nightlife', 'work'];
  const gasRoads = new Set([10, 27, 43, 60, 77, 98, 116, 133]);
  const evRoads = new Set([17, 36, 55, 72, 93, 113, 128, 140]);
  roads.forEach((r, i) => {
    links[r.a.id].push(r.b);
    links[r.b.id].push(r.a);
    for (const side of [-1, 1]) {
      const axisIndex = r.axis === 'x' ? r.a.i : r.a.j;
      const address = `${100 * (axisIndex + 1) + (side > 0 ? 52 : 47)} ${label(r)}`;
      const type = i === 71 && side === 1 ? 'base' : gasRoads.has(i) && side === 1 ? 'fuel' : evRoads.has(i) && side === -1 ? 'charge' : types[(i + (side === 1 ? 3 : 0) + Math.floor(i / 8)) % types.length];
      const center = { x: (r.a.x + r.b.x) / 2, z: (r.a.z + r.b.z) / 2 };
      const offset = (p, d) => r.axis === 'x' ? { x: p.x, z: p.z + side * d } : { x: p.x + side * d, z: p.z };
      const names = suffixes[type];
      const name = type === 'base' ? 'Driver’s Apartment & Garage' : type === 'fuel' ? `Meridian Fuel · ${label(r)}` : type === 'charge' ? `Meridian Charge · ${label(r)}` : `${avenues[(i + axisIndex) % 9]} ${names[(i + axisIndex) % names.length]}`;
      stops.push({
        id: stops.length, type, name, address, road: r, side, center,
        ...offset(center, r.half - 1.65),
        walk: offset(center, r.half + Math.min(1.25, r.sw / 2)),
        entrance: offset(center, r.half + r.sw - 0.15),
      });
    }
  });
  const nameCounts = new Map();
  for (const stop of stops) nameCounts.set(stop.name, (nameCounts.get(stop.name) ?? 0) + 1);
  for (const stop of stops) if (nameCounts.get(stop.name) > 1) stop.name += ` · ${stop.address}`;
  const stations = stops.filter((s) => s.type === 'fuel');
  const chargers = stops.filter((s) => s.type === 'charge');
  const home = stops.find((s) => s.type === 'base');

  function route(from, stop) {
    let road, start, nearest = Infinity;
    for (const r of roads) {
      const p = pointOnRoad(r, from);
      const d = distance(from, p);
      if (d < nearest) { start = p; road = r; nearest = d; }
    }
    const nodes = layout.intersections;
    const cost = nodes.map(() => Infinity);
    const previous = nodes.map(() => -1);
    const open = new Set(nodes.map((n) => n.id));
    for (const n of [road.a, road.b]) cost[n.id] = distance(start, n);
    while (open.size) {
      let best = -1;
      for (const id of open) if (best < 0 || cost[id] < cost[best]) best = id;
      open.delete(best);
      for (const n of links[best]) {
        const next = cost[best] + distance(n, nodes[best]);
        if (next < cost[n.id]) { cost[n.id] = next; previous[n.id] = best; }
      }
    }
    const a = stop.road.a, b = stop.road.b;
    const end = cost[a.id] + distance(a, stop.center) < cost[b.id] + distance(b, stop.center) ? a : b;
    const path = [];
    if (road !== stop.road) {
      for (let id = end.id; id >= 0; id = previous[id]) path.unshift(nodes[id]);
    }
    return [start, ...path, stop.center, stop];
  }
  const crosswalks = layout.props.crosswalks.map((walk) => ({
    ...walk, intersection: layout.intersections[walk.inter],
  })).filter((walk) => walk.intersection.type === 'signal');
  return { stops, stations, chargers, crosswalks, home, route };
}

export function routeDistance(points) {
  let meters = 0;
  for (let i = 1; i < points.length; i++) meters += distance(points[i - 1], points[i]);
  return meters;
}
