// Game-wide tuning shared by the client, the bots and the authoritative room.

export const MAX_PLAYERS = 10; // dragons in one sky (humans + bots); bots top a room up to 6 (shared/room.js BOT_TARGET)
export const TICK_HZ = 30; // room simulation (bots, bot fireballs, timers)
export const SNAPSHOT_HZ = 20; // world snapshots sent to clients
export const CLIENT_SEND_HZ = 20; // own-dragon state sent by each client
export const INTERP_DELAY = 0.12; // s of buffering for remote dragons

// The battle area is a 1.65 km disc around the castle at (0, 0): the Citadel, the moat and the inner face of the
// mountain ring, whose crests and the coast beyond frame it. Encounter maths (6-10 dragons, 60-190 m/s, guns
// effective inside ~500 m): the first 4.2 km disc gave 1.1 km between neighbours at 12 dragons and a 30 s search for
// the next fight; 2.2 km halved that; 1.65 km with 6 dragons keeps the same density as 2.2 km had with 8-10 (about
// 1.4 km2 each), so fewer dragons does not mean emptier skies (tools/encounter-bench.mjs).
export const WORLD = {
  seed: 1871,
  radius: 1650, // battle area (m); outside it you have OUT_OF_BOUNDS_TIME to return
  ceiling: 1700, // air gets thin above this
  terrainHalf: 3600, // terrain is generated over [-half, half]; beyond the radius it is scenery (islands, open sea)
  sea: 0,
};
export const OUT_OF_BOUNDS_TIME = 8;

// Where dragons (re)appear. Candidates lie on a ring between these fractions of WORLD.radius; with other dragons
// alive the best candidate is the one closest to `near` metres from the nearest of them (never closer than `clear`).
// (The ring sits outside the Citadel's no-spawn zone, castle radius + 500 m = 1040 m, and inside the edge warning.)
export const SPAWN = { ringMin: 0.64, ringMax: 0.8, near: [550, 950], clear: 420, minAlt: 380, maxAlt: 1250 };

export const MATCH = {
  duration: 8 * 60, // s
  // With 6 dragons an 8-minute bot match makes about 6.4 kills a minute: the FFA leader ends on 7-19 kills (median
  // 13) and the winning TDM flight on 21-30, so these limits are reachable by a good pilot and usually decide TDM
  // (30 with 8 dragons was never reached in FFA). More humans in the room make them come sooner.
  killLimit: 15,
  tdmKillLimit: 20, // team kills that win a Team Deathmatch
  resultsTime: 14, // s of scoreboard between matches
  respawnTime: 4.5,
  spawnProtect: 3,
};

// healing shrines floating above each sky island
export const SHRINE = { heal: 40, recharge: 25, radius: 22 };

export const SCORE = { kill: 100, assist: 50, crashPenalty: 0, firstBlood: 50, revenge: 25 };

// Game modes. Public skies alternate FFA and TDM; private skies pick one when they are created.
export const MODES = {
  ffa: { name: 'Free-for-all', blurb: 'Every dragon for itself. First to 15 kills.' },
  tdm: { name: 'Team Deathmatch', blurb: 'Gold flight against Crimson flight. First to 20 team kills.' },
};
export const MODE_IDS = Object.keys(MODES);
export const TEAMS = [
  { name: 'Gold', color: '#ffc247' },
  { name: 'Crimson', color: '#ff4a52' },
];

// Kill streak rewards and comebacks (all enforced by the room).
export const STREAK = {
  blaze: { at: 3, duration: 15, fireCooldown: 0.7, heat: 0.6 }, // 3 kills: faster, cooler fireballs
  surge: { at: 5, heal: 0.4 }, // 5 kills: heal 40% and the ability is ready
  lord: { at: 7, duration: 20, damage: 1.2 }, // 7 kills: +20% damage
  bountyAt: 4, // from this streak on, you carry a bounty
  bounty: { base: 50, perKill: 25, max: 250 },
  leaderBounty: { amount: 40, minKills: 6, lead: 3 }, // FFA: a runaway leader is worth extra
  droughtDeaths: 3, // this many deaths in a row without a kill earns a Second Wind spawn
  secondWind: { blaze: 10, shield: 5 }, // s
  killCooldownCut: 4, // s taken off the ability cooldown per kill
  assistCooldownCut: 2,
};

// Status effect numbers shared by the room and the player's own flight.
export const STATUS = {
  chill: { turn: 0.55, speed: 0.85 }, // flight multipliers while chilled
  corrode: 1.2, // damage taken multiplier while corroded
  armor: 0.7, // damage taken multiplier under Rime Armor
};

// One signature ability per breed (key R / gamepad X). Cooldown s. All damage is applied by the room.
export const ABILITIES = {
  ember: {
    id: 'inferno', name: 'Inferno Wake', cooldown: 24,
    blurb: 'Leave a napalm trail behind you for 4.5 s. Pursuers burn.',
    duration: 4.5, drop: 0.3, life: 4, radius: 22, dps: 24, burn: { dur: 2.5, dps: 11 },
  },
  frost: {
    id: 'nova', name: 'Frost Nova', cooldown: 22,
    blurb: 'Freezing shockwave. Foes nearby take damage and turn slowly; you gain Rime Armor.',
    radius: 210, damage: 18, chill: 4, armor: 4, windup: 0.45,
  },
  storm: {
    id: 'chain', name: 'Chain Lightning', cooldown: 16,
    blurb: 'A bolt leaps to the foe in front of you and arcs on to others.',
    range: 480, cone: 0.5, jump: 280, damage: [22, 15, 10], windup: 0.3,
  },
  venom: {
    id: 'acid', name: 'Acid Cloud', cooldown: 17,
    blurb: 'Spit a lingering cloud ahead. Foes inside are poisoned and take extra damage.',
    ahead: 120, radius: 76, life: 8, dps: 19, windup: 0.6, poison: { dur: 4, dps: 9 }, corrode: 4,
  },
};

// How big dragons are drawn (client/js/render/dragon.js scales the model by this). Bigger than life-size so a foe
// reads as a dragon, not a dot, at fighting range; the hitbox below is scaled with it so shots and visuals agree.
export const DRAGON_SCALE = 1.4;
// Dragon body: hits are tested against an ellipsoid in the dragon's local frame (x = half wingspan).
export const HITBOX = [8.5 * DRAGON_SCALE, 3.2 * DRAGON_SCALE, 8.5 * DRAGON_SCALE];

export const WEAPONS = {
  fireball: { cooldown: 0.28, heat: 9, life: 2.4, radius: 1.6 },
  breath: { range: 62, cone: 0.24, heatPerSec: 34, tick: 0.1 },
  seeker: { cooldown: 9, heat: 25, life: 6, speed: 175, turn: 2.3, radius: 2, lockTime: 1.1, lockRange: 800, lockCone: 0.38, damage: 46 },
  heat: { max: 100, regen: 22, delay: 0.55, overheatRecover: 40 },
  dodge: { duration: 0.75, cooldown: 2.6, stamina: 0.22, breakRange: 140 },
};

// Four breeds. Damage and speed numbers are applied on the server too, so they cannot be spoofed.
export const BREEDS = {
  ember: {
    name: 'Ember Drake',
    blurb: 'Balanced fire-breather. Hot fireballs, steady wings.',
    hp: 100, speed: 1.0, turn: 1.0,
    fbDamage: 20, fbSpeed: 270, breathDps: 58,
  },
  frost: {
    name: 'Frost Wyrm',
    blurb: 'Armoured and heavy. Shrugs off hits, turns wide.',
    hp: 125, speed: 0.93, turn: 0.9,
    fbDamage: 23, fbSpeed: 245, breathDps: 52,
  },
  storm: {
    name: 'Storm Wyvern',
    blurb: 'Fastest in the sky. Lightning-quick bolts, thin hide.',
    hp: 84, speed: 1.09, turn: 1.12,
    fbDamage: 16, fbSpeed: 330, breathDps: 44,
  },
  venom: {
    name: 'Venom Serpent',
    blurb: 'Agile brawler. Weaker spit, devastating acid breath.',
    hp: 100, speed: 0.98, turn: 1.06,
    fbDamage: 16, fbSpeed: 255, breathDps: 76,
  },
};
export const BREED_IDS = Object.keys(BREEDS);

// Entity flag bits carried in snapshots.
export const F = {
  BREATH: 1,
  BOOST: 2,
  DODGE: 4,
  DEAD: 8,
  SHIELD: 16, // spawn protection
  BRAKE: 32,
  OUT: 64, // out of bounds
};

export const BOT_NAMES = [
  'Vermithrax', 'Ashcrown', 'Skarleth', 'Nightglaive', 'Emberfang', 'Morrowind', 'Quillback', 'Tharvex',
  'Sablewing', 'Gorehorn', 'Cinderjaw', 'Vexoria', 'Halcyra', 'Duskmaw', 'Pyrelith', 'Stormtalon',
  'Iskarra', 'Wyrmgrave', 'Fennix', 'Obsidrax', 'Brimscale', 'Ravenfire', 'Scorchbane', 'Velkhar',
];
