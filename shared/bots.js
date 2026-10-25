// AI dragons. They fly with the same flight model and autopilot as players and only "see" what the
// room knows. Each brain picks a target, leads its shots, breaks off when chased and keeps clear of terrain.
import { ABILITIES, BREEDS, STREAK, WORLD, WEAPONS } from './constants.js';
import { forwardOf, steerToward } from './flight.js';
import { clamp, vdot, vlen, vnorm } from './math.js';
import { avoid as castleAvoid, pickGate, gateAim, gateOffset, near as castleNear, CASTLE } from './castle.js';

// can this bot pick v as a target? (rooms in dev mode can hide humans; test stand-ins only have hostile())
const sees = (room, bot, v) => (room.canTarget ? room.canTarget(bot, v) : room.hostile(bot, v));

export function createBrain(rand, skill) {
  return {
    skill, // 0..1
    baseSkill: skill, // what it was born with (dev mode can override skill and hand it back)
    target: 0,
    retargetIn: 0,
    evadeFor: 0,
    evadeDir: [0, 1, 0],
    wander: null,
    fireCd: 0,
    aimJitter: [0, 0, 0],
    jitterIn: 0,
    breathFor: 0,
    abilIn: 2 + rand() * 2, // s until the next "should I use my ability?" check
    gate: null, // a run through one of the citadel's arches: { gate, sign }
    gateFor: 0,
    gateIn: 1,
    exitFor: 0,
    castleMemo: { dir: [0, 0, 0], until: 0 }, // the way round the citadel it is currently committed to
    rand,
  };
}

// Should this bot use its breed ability right now? Checked a few times a second once it is ready.
function wantAbility(bot, room, tgt, d, off) {
  const b = bot.brain;
  const A = ABILITIES[bot.breed];
  const s = bot.fs;
  const luck = 0.45 + 0.5 * b.skill;
  switch (bot.breed) {
    case 'ember': {
      // a dragon on our tail: shed napalm
      for (const e of room.ents.values()) {
        if (e === bot || !e.alive || !sees(room, bot, e)) continue;
        _to[0] = s.p[0] - e.fs.p[0]; _to[1] = s.p[1] - e.fs.p[1]; _to[2] = s.p[2] - e.fs.p[2];
        const dist = vlen(_to);
        if (dist > 330 || dist < 1) continue;
        const theirFwd = forwardOf(e.fs.q, _ahead);
        if (vdot(theirFwd, _to) / dist > 0.82 && -vdot(_fwd, _to) / dist > 0.15) return b.rand() < luck;
      }
      return false;
    }
    case 'frost': {
      let n = 0;
      for (const e of room.ents.values()) {
        if (e === bot || !e.alive || !sees(room, bot, e) || e.shieldUntil > room.ms) continue;
        if (Math.hypot(e.fs.p[0] - s.p[0], e.fs.p[1] - s.p[1], e.fs.p[2] - s.p[2]) < A.radius * 0.8) n++;
      }
      return n >= 2 || (n === 1 && (bot.hp < BREEDS[bot.breed].hp * 0.65 || b.rand() < 0.4));
    }
    case 'storm':
      return !!tgt && d < A.range * 0.9 && off < 0.2 && tgt.shieldUntil <= room.ms && b.rand() < luck + 0.2;
    case 'venom':
      return !!tgt && d > 90 && d < 260 && off < 0.3 && tgt.shieldUntil <= room.ms && b.rand() < luck;
  }
  return false;
}

// Pursuit tuning. BOT_CRUISE is the throttle a bot flies at inside 700 m of its target (about 82 m/s level).
const BOT_CRUISE = 0.55;
// A head-on merge: aspect (cos of the foe's nose off the line to us) above this, between near and far metres. The
// bot offsets its line by d * 0.3 (clamped to offset), flies at `throttle`, and jousts instead with chance joust * skill.
const MERGE = { aspect: 0.55, near: 110, far: 1000, offset: [80, 220], throttle: 0.35, joust: 0.3 };

const _fwd = [0, 0, 0], _to = [0, 0, 0], _dir = [0, 0, 0], _ahead = [0, 0, 0], _cdir = [0, 0, 0], _off = [0, 0];

// Terrain planner. The mountain ring is a wall of ridges and gorges, so sampling the path three times is not enough:
// a crest can fall between the samples and a wall is not something to climb over, it is something to turn from. Look
// along the wanted heading at several distances, work out the climb that would clear everything on it, and when that
// is steeper than a dragon can manage, try headings further and further off to either side. Writes the chosen
// direction into `desired`; returns 0 when the wanted heading is fine, up to 1 for a hard avoidance.
const PROBES = [70, 140, 215, 300, 400];
// The mountain ring starts rising RING_R m from the centre (shared/world.js). Since the arena's edge was pulled in to
// cut through it, bots spend half their time over it and turn back above it: there they plan RING_AIR[0] m more
// clearance and keep RING_AIR[1] m more air below them. 8 bots for 48 room-minutes: 0.42 crashes a minute without
// this (0.60 with the old pursuit), 0.08 with it; the 2.2 km map had 0.23.
const RING_R = 1120;
const RING_AIR = [120, 160];
const SWERVE = [0.4, 0.8, 1.2, 1.7, 2.4]; // radians off the wanted heading, tried on the side the bot already favours first
const CLIMB_OK = 0.3; // tan of the steepest climb a bot will plan on (a dragon bleeds speed above ~20 degrees)
function planTerrain(bot, s, world, desired, now) {
  const b = bot.brain;
  // a dragon in a dive needs room to pull out; over the mountain ring (which the arena's edge cuts through, so bots
  // turn back above it) keep more air under the wings
  const margin = 80 + Math.max(0, -s.vel[1]) * 0.8 + (Math.hypot(s.p[0], s.p[2]) > RING_R ? RING_AIR[0] : 0);
  const sc = clamp(s.speed / 100, 0.75, 1.7);
  let hx = desired[0], hz = desired[2];
  let hl = Math.hypot(hx, hz);
  const vl = Math.hypot(s.vel[0], s.vel[2]) || 1;
  if (hl < 0.05) { hx = s.vel[0]; hz = s.vel[2]; hl = vl; }
  hx /= hl; hz /= hl;
  // a dragon cannot turn on the spot: judge the heading it will really be flying over the next moment, which is
  // the wanted one only when it is nearly there already
  const vx = s.vel[0] / vl, vz = s.vel[2] / vl;
  const ang = Math.acos(clamp(hx * vx + hz * vz, -1, 1));
  if (ang > 0.45) {
    const side = hx * vz - hz * vx > 0 ? -1 : 1; // which way round from the velocity to the wanted heading
    const c = Math.cos(0.45), sn = Math.sin(0.45) * side;
    hx = vx * c - vz * sn; hz = vx * sn + vz * c;
  }
  const need = (cx, cz) => {
    let worst = -Infinity;
    for (let i = 0; i < PROBES.length; i++) {
      const d = PROBES[i] * sc;
      const req = (world.floorAt(s.p[0] + cx * d, s.p[2] + cz * d) + margin - s.p[1]) / d;
      if (req > worst) worst = req;
    }
    return worst;
  };
  // the climb the wanted direction already asks for (as a slope), so we only ever add to it
  const wantSlope = desired[1] / hl;
  const n0 = need(hx, hz);
  let cx = hx, cz = hz, n = n0, avoid = 0;
  if (n0 > CLIMB_OK) {
    // blocked: keep last time's swerve while it still works (no flip-flopping), else look for a way round
    const turnTo = (a) => {
      const ca = Math.cos(a), sa = Math.sin(a);
      return [hx * ca - hz * sa, hx * sa + hz * ca];
    };
    let pick = null;
    if (b.swerveA && b.swerveUntil > now) {
      const c = turnTo(b.swerveA), nn = need(c[0], c[1]);
      if (nn <= CLIMB_OK) pick = { c, n: nn, a: b.swerveA };
    }
    if (!pick) {
      const side = b.swerveSide || (b.rand() < 0.5 ? -1 : 1);
      let bestN = n0, bestA = 0;
      for (let i = 0; i < SWERVE.length && !pick; i++) {
        for (const sg of [side, -side]) {
          const a = SWERVE[i] * sg, c = turnTo(a), nn = need(c[0], c[1]);
          if (nn < bestN - 0.02) { bestN = nn; bestA = a; }
          if (nn <= CLIMB_OK * 0.8) { pick = { c, n: nn, a }; break; }
        }
      }
      if (!pick && bestA) pick = { c: turnTo(bestA), n: bestN, a: bestA };
      if (pick) { b.swerveA = pick.a; b.swerveSide = Math.sign(pick.a); b.swerveUntil = now + 0.9; }
    }
    if (pick) { cx = pick.c[0]; cz = pick.c[1]; n = pick.n; avoid = Math.min(1, 0.4 + Math.abs(pick.a) * 0.3); }
    else avoid = 0.4;
  } else b.swerveA = 0;
  const slope = Math.max(wantSlope, Math.min(n + 0.12, 0.7));
  if (avoid === 0 && slope <= wantSlope + 0.02) return 0;
  desired[0] = cx; desired[2] = cz; desired[1] = slope;
  vnorm(desired, desired);
  return avoid || clamp((slope - wantSlope) * 0.5, 0.1, 0.4);
}

// steer toward the nearest charged shrine within range; true if there is one
function seekShrine(bot, room, desired, range = 800) {
  if (bot.hp >= BREEDS[bot.breed].hp) return false;
  const p = bot.fs.p;
  let best = -1, bd = range;
  room.world.shrines.forEach((q, i) => {
    if (room.shrines[i] > room.ms) return;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d < bd) { bd = d; best = i; }
  });
  if (best < 0) return false;
  const q = room.world.shrines[best];
  const rock = room.world.sky[best]; // the citadel's shrines (after the sky islands') have none: avoidance steers around the stone
  const hd = rock ? Math.hypot(p[0] - rock.x, p[2] - rock.z) || 1 : 1;
  let tx = q[0], ty = q[1], tz = q[2];
  if (!rock) {
    // straight in
  } else if (p[1] < q[1] - 8 && hd < rock.r * 2.2) {
    // under or beside the rock: climb up outside it before cutting in over the top
    tx = rock.x + ((p[0] - rock.x) / hd) * rock.r * 2.0;
    tz = rock.z + ((p[2] - rock.z) / hd) * rock.r * 2.0;
    ty = q[1] + 45;
  } else if (hd > rock.r * 2.2) ty = q[1] + 12;
  desired[0] = tx - p[0]; desired[1] = ty - p[1]; desired[2] = tz - p[2];
  vnorm(desired, desired);
  return true;
}

/**
 * Decide this tick's controls for a bot.
 * Returns { input, fire: bool, breath: bool, ability: bool } (input is reused per bot).
 */
export function thinkBot(bot, room, dt) {
  const b = bot.brain;
  const s = bot.fs;
  const world = room.world;
  const breed = BREEDS[bot.breed];
  const input = bot.input || (bot.input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, boost: false, brake: false, dodge: 0 });
  input.dodge = 0;
  input.boost = false;
  input.brake = false;
  b.fireCd -= dt;
  b.retargetIn -= dt;
  b.jitterIn -= dt;
  forwardOf(s.q, _fwd);

  // --- choose a target
  let tgt = room.ents.get(b.target);
  if (!tgt || !tgt.alive || !sees(room, bot, tgt) || b.retargetIn <= 0) {
    b.retargetIn = 1.2 + b.rand() * 1.5;
    let best = null, bestScore = Infinity;
    for (const e of room.ents.values()) {
      if (e === bot || !e.alive || !sees(room, bot, e)) continue;
      _to[0] = e.fs.p[0] - s.p[0]; _to[1] = e.fs.p[1] - s.p[1]; _to[2] = e.fs.p[2] - s.p[2];
      const d = vlen(_to);
      const ahead = vdot(_to, _fwd) / (d || 1);
      let score = d * (1.6 - ahead * 0.6);
      if (e.shieldUntil > room.ms) score += 1500;
      if (e.id === b.target) score *= 0.7; // stick with the current target
      if (!e.isBot) score *= 0.85; // humans are more interesting
      if (score < bestScore) { bestScore = score; best = e; }
    }
    b.target = best ? best.id : 0;
    tgt = best;
  }

  let fire = false, breath = false, ability = false;
  let tgtDist = 0, tgtOff = 1;
  const desired = _dir;
  let throttle = 0.7;
  let sharp = 0.75 + b.skill * 0.5;

  if (b.jitterIn <= 0) {
    b.jitterIn = 0.4 + b.rand() * 0.6;
    const err = (1 - b.skill) * 0.06 + 0.008;
    b.aimJitter[0] = (b.rand() - 0.5) * err;
    b.aimJitter[1] = (b.rand() - 0.5) * err;
    b.aimJitter[2] = (b.rand() - 0.5) * err;
  }

  // --- evade when someone sits on our tail
  if (b.evadeFor <= 0) {
    for (const e of room.ents.values()) {
      if (e === bot || !e.alive || !sees(room, bot, e)) continue;
      _to[0] = s.p[0] - e.fs.p[0]; _to[1] = s.p[1] - e.fs.p[1]; _to[2] = s.p[2] - e.fs.p[2];
      const d = vlen(_to);
      if (d > 420 || d < 1) continue;
      const theirFwd = forwardOf(e.fs.q, _ahead);
      const aimAtMe = vdot(theirFwd, _to) / d;
      const behindMe = vdot(_fwd, _to) / d; // they are behind us (_to points from them to us)
      if (aimAtMe > 0.94 && behindMe > 0.3 && b.rand() < dt * (0.6 + (1 - bot.hp / breed.hp) * 1.6)) {
        b.evadeFor = 1.2 + b.rand() * 1.8;
        const side = b.rand() < 0.5 ? -1 : 1;
        // break turn: hard to one side and a little up or down
        const r = [s.q[0], s.q[1], s.q[2], s.q[3]];
        const right = [1 - 2 * (r[1] * r[1] + r[2] * r[2]), 2 * (r[0] * r[1] + r[2] * r[3]), 2 * (r[0] * r[2] - r[1] * r[3])];
        b.evadeDir = vnorm([0, 0, 0], [right[0] * side + _fwd[0] * 0.2, (b.rand() - 0.4) * 0.8, right[2] * side + _fwd[2] * 0.2]);
        if (b.skill > 0.45 && d < 180) input.dodge = side;
        break;
      }
    }
  }

  // near the citadel a pilot with a dragon on its tail dives for one of its arches: the pursuer has to follow it
  // through the stone (checked a few times a second, and only close to the castle)
  b.gateIn -= dt;
  if (!b.gate && b.gateIn <= 0) {
    b.gateIn = 0.35 + b.rand() * 0.3;
    if (castleNear(s.p[0], s.p[2], CASTLE.radius + 1000)) {
      for (const e of room.ents.values()) {
        if (e === bot || !e.alive || !room.hostile(e, bot) || (room.dev && room.dev.ghost && !e.isBot)) continue;
        _to[0] = s.p[0] - e.fs.p[0]; _to[1] = s.p[1] - e.fs.p[1]; _to[2] = s.p[2] - e.fs.p[2];
        const d = vlen(_to);
        if (d > 420 || d < 20) continue;
        if (vdot(forwardOf(e.fs.q, _ahead), _to) / d > 0.9 && vdot(_fwd, _to) / d > 0.3 && b.rand() < 0.2 + 0.7 * b.skill) {
          const run = pickGate(s.p, s.vel, b.rand());
          if (run) { b.gate = run; b.gateFor = 9; }
          break;
        }
      }
    }
  }

  if (b.gate) {
    b.gateFor -= dt;
    const togo = gateAim(b.gate.gate, b.gate.sign, s.p, desired);
    throttle = 0.85; // fast enough to shake the pursuer, slow enough to hold the line through the opening
    sharp = 1.7;
    // through (or lost it): back to normal flying. Give up early if the line-up is hopeless (too high, too wide).
    const g = b.gate.gate;
    if (togo < -(g.len / 2 + 70) || togo > 1100 || b.gateFor <= 0) {
      if (togo < -(g.len / 2 + 70)) b.exitFor = 2.2; // through: pull up and away, the courtyard is crowded
      b.gate = null;
    }
    else if (togo > g.len / 2 + 40) {
      gateOffset(g, s.p, _off);
      if (Math.abs(_off[0]) > g.hw * 0.8 + togo * 0.3 || Math.abs(_off[1]) > g.hh * 0.6 + togo * 0.25 || _off[1] < -g.hh * 0.6) b.gate = null;
    }
  } else if (b.evadeFor > 0) {
    b.evadeFor -= dt;
    desired[0] = b.evadeDir[0]; desired[1] = b.evadeDir[1]; desired[2] = b.evadeDir[2];
    throttle = 1;
    // break hard at flying speed (a tighter circle the attacker can follow and see); boost away only when hurt
    input.boost = s.stamina > 0.3 && bot.hp < breed.hp * 0.5;
    sharp = 1.4;
  } else if (bot.hp < breed.hp * 0.45 && seekShrine(bot, room, desired, 1100)) {
    throttle = 1;
    input.boost = s.stamina > 0.6;
  } else if (tgt) {
    // lead pursuit
    _to[0] = tgt.fs.p[0] - s.p[0]; _to[1] = tgt.fs.p[1] - s.p[1]; _to[2] = tgt.fs.p[2] - s.p[2];
    const d = vlen(_to);
    const shotSpeed = breed.fbSpeed + s.speed;
    const lead = clamp(d / shotSpeed, 0, 2.5) * (0.6 + 0.4 * b.skill);
    const tv = tgt.fs.vel;
    desired[0] = _to[0] + tv[0] * lead;
    desired[1] = _to[1] + tv[1] * lead;
    desired[2] = _to[2] + tv[2] * lead;
    vnorm(desired, desired);
    desired[0] += b.aimJitter[0]; desired[1] += b.aimJitter[1]; desired[2] += b.aimJitter[2];
    vnorm(desired, desired);
    const off = Math.acos(clamp(vdot(desired, _fwd), -1, 1)); // how far the shot solution is off the nose
    const closing = vdot(_to, s.vel) / (d || 1) - vdot(_to, tv) / (d || 1);
    // Fights should happen where the pilot can see them. A head-on joust at two dragons' top speed is a dot, a blur
    // and a corpse, so a bot meeting a foe nose to nose eases off and offsets its line to pass a wing-length or two
    // to the side, then turns in behind (a lead turn). Now and then a good pilot takes the head-on shot anyway.
    const aspect = -vdot(forwardOf(tgt.fs.q, _ahead), _to) / (d || 1); // 1: its nose points straight at us
    const facing = vdot(_fwd, _to) / (d || 1);
    const merge = aspect > MERGE.aspect && facing > 0.3 && d > MERGE.near && d < MERGE.far;
    if (merge) {
      if (b.mergeWith !== tgt.id) {
        b.mergeWith = tgt.id;
        b.mergeSide = b.rand() < 0.5 ? -1 : 1;
        b.joust = b.rand() < MERGE.joust * b.skill;
      }
      if (!b.joust) {
        const hl = Math.hypot(_to[0], _to[2]) || 1;
        const side = clamp(d * 0.3, MERGE.offset[0], MERGE.offset[1]) * b.mergeSide;
        desired[0] = _to[0] - (_to[2] / hl) * side;
        desired[1] = _to[1];
        desired[2] = _to[2] + (_to[0] / hl) * side;
        vnorm(desired, desired);
      }
      throttle = MERGE.throttle;
    } else {
      if (aspect < 0.3) b.mergeWith = 0;
      throttle = d > 700 ? 0.9 : BOT_CRUISE;
      // closing from behind: match its speed and sit on its tail instead of overshooting through it
      if (d < 420 && closing > 12) throttle = clamp(BOT_CRUISE - (closing - 12) / 45, 0.1, BOT_CRUISE);
    }
    // boost only to chase down a foe that is getting away, never to ram one that is coming at us
    if (d > 1000 && s.stamina > 0.5 && !merge && closing < 40) input.boost = true;
    input.brake = d < 160 && closing > 35;
    const fireCone = 0.05 + (1 - b.skill) * 0.04;
    if (d < 560 && off < fireCone && b.fireCd <= 0 && tgt.shieldUntil <= room.ms) {
      fire = true;
      b.fireCd = WEAPONS.fireball.cooldown * (1.6 + (1 - b.skill) * 2.4) * (bot.st.blaze > room.ms ? STREAK.blaze.fireCooldown : 1) + b.rand() * 0.4;
    }
    tgtDist = d; tgtOff = off;
    if (d < WEAPONS.breath.range * 0.9 && off < 0.3 && tgt.shieldUntil <= room.ms) b.breathFor = 0.5;
  } else if (!seekShrine(bot, room, desired)) {
    // wander between waypoints
    if (!b.wander || Math.hypot(b.wander[0] - s.p[0], b.wander[2] - s.p[2]) < 300) {
      // somewhere over the land or the fjords: 250-700 m above the ground, under the ceiling
      const a = b.rand() * Math.PI * 2, d = (0.15 + b.rand() * 0.6) * WORLD.radius;
      const wx = Math.cos(a) * d, wz = Math.sin(a) * d;
      b.wander = [wx, Math.min(world.floorAt(wx, wz) + 250 + b.rand() * 450, WORLD.ceiling - 350), wz];
    }
    desired[0] = b.wander[0] - s.p[0]; desired[1] = b.wander[1] - s.p[1]; desired[2] = b.wander[2] - s.p[2];
    vnorm(desired, desired);
  }
  if (b.breathFor > 0) {
    b.breathFor -= dt;
    breath = true;
  }
  b.abilIn -= dt;
  if (b.abilIn <= 0 && room.phase === 'battle' && room.ms >= bot.abilReady) {
    b.abilIn = 0.25 + b.rand() * 0.35;
    ability = wantAbility(bot, room, tgt, tgtDist, tgtOff);
  }

  // --- stay inside the arena and under the ceiling
  const r = Math.hypot(s.p[0], s.p[2]);
  if (r > WORLD.radius - 300) {
    const w = clamp((r - (WORLD.radius - 300)) / 260, 0, 1);
    desired[0] = desired[0] * (1 - w) - (s.p[0] / r) * w;
    desired[2] = desired[2] * (1 - w) - (s.p[2] / r) * w;
    vnorm(desired, desired);
  }
  if (s.p[1] > WORLD.ceiling - 200) desired[1] = Math.min(desired[1], -0.2);

  // --- terrain and sky-rock avoidance
  let danger = 0;
  // (not on a run through one of the Citadel's arches: that dive ends a few dozen metres over the courtyard floor, which
  // the planner would take for a mountain to clear; the run is only started within about 950 m of the Citadel, over land
  // that lies far below the courtyard, and the clearance check below still applies)
  const avoid = b.gate ? 0 : planTerrain(bot, s, world, desired, room.ms / 1000);
  if (avoid > 0) {
    sharp = Math.max(sharp, 1.1 + avoid * 0.6);
    throttle = 1; // keep the speed up through the turn
    if (s.stamina > 0.45) input.boost = true;
  }
  for (const tAhead of [0.6, 1.4, 2.6]) {
    _ahead[0] = s.p[0] + s.vel[0] * tAhead;
    _ahead[1] = s.p[1] + s.vel[1] * tAhead;
    _ahead[2] = s.p[2] + s.vel[2] * tAhead;
    const clearance = _ahead[1] - world.floorAt(_ahead[0], _ahead[2]);
    const need = b.gate ? 24 : 90; // on a run through an arch the courtyard floor is only a few dozen metres below
    if (clearance < need) danger = Math.max(danger, clamp((need - clearance) / need, 0, 1) * (1.2 - tAhead * 0.15));
    const rock = world.hitSkyRock(_ahead, 40);
    if (rock) {
      // steer around: away from the rock's centre
      const away = vnorm([0, 0, 0], [s.p[0] - rock.x, (s.p[1] - rock.y) + rock.r * 0.5, s.p[2] - rock.z]);
      desired[0] = desired[0] * 0.2 + away[0]; desired[1] = desired[1] * 0.2 + away[1]; desired[2] = desired[2] * 0.2 + away[2];
      vnorm(desired, desired);
      sharp = 1.5;
    }
  }
  // ruins, sea stacks: probe the flight path one, two and three seconds ahead (cheap cylinder tests, no height lookups)
  for (const tAhead of [1.0, 2.0, 3.0]) {
    _ahead[0] = s.p[0] + s.vel[0] * tAhead;
    _ahead[1] = s.p[1] + s.vel[1] * tAhead;
    _ahead[2] = s.p[2] + s.vel[2] * tAhead;
    const prop = world.hitLandmark(_ahead, 55);
    if (prop) {
      // go over it if there is room, and swing sideways, away from its centre
      const ax = s.p[0] - prop.x, az = s.p[2] - prop.z;
      const al = Math.hypot(ax, az) || 1;
      desired[0] = desired[0] * 0.3 + (ax / al) * 0.9;
      desired[2] = desired[2] * 0.3 + (az / al) * 0.9;
      desired[1] = Math.max(desired[1], 0.35);
      vnorm(desired, desired);
      sharp = Math.max(sharp, 1.6);
      breath = false;
      break;
    }
  }
  // rock rings: bots never thread them (a human can). Keep a sphere round each one clear, like a sky rock.
  for (const a of world.arches) {
    let hit = false;
    for (const tAhead of [0.7, 1.6, 2.8]) {
      const dx = s.p[0] + s.vel[0] * tAhead - a.x, dy = s.p[1] + s.vel[1] * tAhead - a.y, dz = s.p[2] + s.vel[2] * tAhead - a.z;
      if (Math.hypot(dx, dy, dz) < a.R + a.t + 70) { hit = true; break; }
    }
    if (!hit) continue;
    const away = vnorm([0, 0, 0], [s.p[0] - a.x, s.p[1] - a.y + 15, s.p[2] - a.z]);
    desired[0] = desired[0] * 0.2 + away[0]; desired[1] = desired[1] * 0.2 + away[1]; desired[2] = desired[2] * 0.2 + away[2];
    vnorm(desired, desired);
    sharp = Math.max(sharp, 1.6);
    breath = false;
    break;
  }
  if (b.exitFor > 0) {
    b.exitFor -= dt;
    desired[1] = Math.max(desired[1], 0.34);
    vnorm(desired, desired);
    throttle = 1;
  }
  // the citadel: probe the path and take the nearest clear heading around, or through, the stone
  const urg = castleAvoid(s.p, s.vel, desired, _cdir, b.gate ? 7 : 40, b.castleMemo, room.ms);
  if (urg > 0) {
    const k = clamp(0.7 + urg * 0.3, 0, 1);
    desired[0] = desired[0] * (1 - k) + _cdir[0] * k;
    desired[1] = desired[1] * (1 - k) + _cdir[1] * k;
    desired[2] = desired[2] * (1 - k) + _cdir[2] * k;
    vnorm(desired, desired);
    sharp = Math.max(sharp, 1.4 + urg * 0.7);
    throttle = Math.max(throttle, 0.85);
    breath = false;
  }
  const ground = s.p[1] - world.floorAt(s.p[0], s.p[2]);
  const comfy = b.gate ? 24 : r > RING_R ? 140 + RING_AIR[1] : 140;
  if (ground < comfy) danger = Math.max(danger, (comfy - ground) / comfy);
  if (danger > 0) {
    desired[1] = Math.max(desired[1], 0.25 + danger * 0.9);
    vnorm(desired, desired);
    sharp = Math.max(sharp, 1 + danger);
    throttle = 1;
    breath = false;
  }

  steerToward(s, desired, input, sharp);
  input.throttle = throttle;
  return { input, fire, breath, ability };
}
