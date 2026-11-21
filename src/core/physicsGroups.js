// Rapier collision groups. A pair interacts only if each one's membership is in the other's filter.
// Encoded as (membership << 16) | filter.
export const G = {
  WORLD: 1,   // static city geometry (default for colliders created without groups)
  PLAYER: 2,  // the player's chassis
  NPC: 4,     // traffic, wrecks and parked cars
  DEBRIS: 8,  // knocked-over props
  PROP: 16,   // breakable street furniture that is still standing
};

export const groups = (member, filter) => (((member & 0xffff) << 16) | (filter & 0xffff)) >>> 0;

export const GROUPS = {
  player: groups(G.PLAYER, G.WORLD | G.NPC | G.DEBRIS | G.PROP),
  npc: groups(G.NPC, G.WORLD | G.PLAYER | G.NPC | G.DEBRIS | G.PROP),
  debris: groups(G.DEBRIS, G.WORLD | G.PLAYER | G.NPC | G.DEBRIS),
  prop: groups(G.PROP, G.PLAYER | G.NPC | G.DEBRIS),
  // query filters (membership "all")
  wheelRay: groups(0xffff, G.WORLD),               // suspension only rides on the city, never on debris/props
  cameraRay: groups(0xffff, G.WORLD),
  // Player casts use PLAYER membership so they only see colliders that collide with the player
  // (e.g. not the NPC wheel spheres, which only touch the WORLD).
  crumpleCast: groups(G.PLAYER, G.WORLD | G.NPC),  // fixed obstacles and wrecked cars the crumple model cushions
  contactCast: groups(G.PLAYER, G.NPC | G.PROP),   // things that react when the player is about to hit them
};
