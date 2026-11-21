const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const bearing = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const distance = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

export function navigationCue(position, heading, route, target) {
  if (!target) return { arrow: '↑', title: 'No active route', detail: 'Choose a ride or service stop' };
  const remaining = distance(position, target);
  if (remaining < 12) return { arrow: '●', title: 'Pull over', detail: target.address };
  const next = route.find((point) => distance(position, point) >= 7) ?? target;
  const angle = wrap(bearing(position, next) - heading);
  return {
    arrow: Math.abs(angle) > 2.5 ? '↶' : angle > 0.45 ? '←' : angle < -0.45 ? '→' : '↑',
    title: Math.abs(angle) > 2.5 ? 'Turn around when safe' : angle > 0.45 ? 'Bear left' : angle < -0.45 ? 'Bear right' : 'Continue ahead',
    detail: `${Math.max(10, Math.round(remaining / 10) * 10)} m · ${target.address}`,
  };
}
