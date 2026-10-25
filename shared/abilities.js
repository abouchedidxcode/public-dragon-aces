// Signature breed abilities, resolved by the room. Clients only ask ("abil"); the room checks the cooldown
// and the dragon's last known position, decides who is affected and broadcasts what happened, so nothing a
// client says can add damage. Every damage source here goes through room.damage(), which also enforces
// spawn protection, friendly fire and the status multipliers.
//
// Most abilities have a short, readable wind-up so everyone can see them coming and react:
//   inferno  instant (the trail is the telegraph)
//   nova     0.45 s charge, a ring converges on the caster; fly out of the radius to escape it
//   chain    0.30 s charge, the target is locked and warned; a barrel roll at the last moment dodges the bolt
//   acid     0.60 s spit, a marker shows where the cloud will land
// Each broadcasts { t:'abil', a, k, ph:'charge', w } when it starts and a second event when it lands.
import { ABILITIES, STATUS } from './constants.js';
import { forwardOf } from './flight.js';
import { vdist } from './math.js';

const r1 = (x) => Math.round(x * 10) / 10;
const pt = (p) => [r1(p[0]), r1(p[1]), r1(p[2])];

// is the straight line between a and b free of terrain and sky islands?
function lineClear(world, a, b) {
  const d = vdist(a, b);
  const n = Math.max(1, Math.ceil(d / 35));
  const p = [0, 0, 0];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    p[0] = a[0] + (b[0] - a[0]) * t; p[1] = a[1] + (b[1] - a[1]) * t; p[2] = a[2] + (b[2] - a[2]) * t;
    if (world.solidAt(p)) return false;
  }
  return true;
}

// Returns true when the ability started (cooldown spent). A cast with nothing to hit is refused and free.
export function castAbility(room, e) {
  if (!e.alive || room.phase !== 'battle' || e.awaitSpawn || room.ms < e.abilReady) return false;
  const A = ABILITIES[e.breed];
  let ok = false;
  switch (A.id) {
    case 'inferno': ok = inferno(room, e, A); break;
    case 'nova': ok = nova(room, e, A); break;
    case 'chain': ok = chain(room, e, A); break;
    case 'acid': ok = acid(room, e, A); break;
  }
  if (!ok) {
    room.send(e, { t: 'abilno', k: A.id });
    return false;
  }
  e.abilReady = room.ms + A.cooldown * 1000;
  e.shieldUntil = Math.min(e.shieldUntil, room.ms); // acting drops spawn protection, like firing
  return true;
}

// Ember: for a few seconds the dragon sheds napalm puffs behind it (dropped from room.tickAbilities).
function inferno(room, e, A) {
  e.trailUntil = room.ms + A.duration * 1000;
  e.trailAcc = A.drop; // drop the first puff at once
  room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'fire', p: pt(e.fs.p), d: pt(forwardOf(e.fs.q)), dur: A.duration, cd: A.cooldown });
  return true;
}

// Frost: a freezing shockwave around the caster after a short charge. Hostile dragons still in range when it
// releases are hurt and chilled (slower, wider turns). The caster wears Rime Armor from the start of the charge.
function nova(room, e, A) {
  room.grant(e, 'armor', A.armor);
  room.casts.push({ at: room.ms + A.windup * 1000, e, k: A.id });
  room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'charge', p: pt(e.fs.p), r: A.radius, w: A.windup, cd: A.cooldown });
  return true;
}

function novaBlast(room, e, A) {
  const hits = [];
  for (const v of room.ents.values()) {
    if (!v.alive || !room.hostile(e, v) || vdist(v.fs.p, e.fs.p) > A.radius) continue;
    hits.push(v.id);
    room.damage(v, e, A.damage, 'nova', 0, v.fs.p);
    room.grant(v, 'chill', A.chill);
  }
  room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'fire', p: pt(e.fs.p), r: A.radius, hits, cd: A.cooldown });
}

// Storm: lock the foe nearest the nose (inside a wide cone); the bolt strikes after a short charge and then
// arcs on to the closest others. The locked dragon is warned and can dodge with a barrel roll.
function chain(room, e, A) {
  const fwd = forwardOf(e.fs.q);
  const o = e.fs.p;
  let first = null, bestScore = Infinity;
  for (const v of room.ents.values()) {
    if (!v.alive || !room.canTarget(e, v) || v.shieldUntil > room.ms) continue;
    const dx = v.fs.p[0] - o[0], dy = v.fs.p[1] - o[1], dz = v.fs.p[2] - o[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > A.range || d < 8) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) / d)));
    if (ang > A.cone) continue;
    const score = ang * 500 + d * 0.3;
    if (score < bestScore && lineClear(room.world, o, v.fs.p)) { bestScore = score; first = v; }
  }
  if (!first) return false;
  room.casts.push({ at: room.ms + A.windup * 1000, e, k: A.id, tgt: first });
  room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'charge', tgt: first.id, w: A.windup, cd: A.cooldown });
  room.send(first, { t: 'abilwarn', k: A.id, a: e.id, w: A.windup });
  return true;
}

function chainStrike(room, e, A, first) {
  const o = e.fs.p;
  const dodged = room.ms - (first.lastDodge || 0) < 450;
  const gone = !first.alive || vdist(o, first.fs.p) > A.range * 1.25 || !lineClear(room.world, o, first.fs.p);
  if (dodged || gone) {
    // the bolt misses: the caster gets part of the cooldown back
    e.abilReady -= A.cooldown * 400;
    room.send(e, { t: 'abilcd', cd: room.abilCd(e) });
    room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'miss', path: [pt(o), pt(first.fs.p)], hits: [], tgt: first.id, dodged: !!dodged && first.alive });
    return;
  }
  const path = [pt(o)], hits = [];
  let cur = first;
  for (let i = 0; i < A.damage.length && cur; i++) {
    path.push(pt(cur.fs.p));
    hits.push(cur.id);
    room.damage(cur, e, A.damage[i], 'chain', 0, cur.fs.p);
    let next = null, nd = A.jump;
    for (const v of room.ents.values()) {
      if (!v.alive || hits.includes(v.id) || !room.canTarget(e, v) || v.shieldUntil > room.ms) continue;
      const d = vdist(v.fs.p, cur.fs.p);
      if (d < nd && lineClear(room.world, cur.fs.p, v.fs.p)) { nd = d; next = v; }
    }
    cur = next;
  }
  room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'fire', path, hits, cd: A.cooldown });
}

// Venom: spit a cloud ahead of the nose; it lands after a short flight.
function acid(room, e, A) {
  const fwd = forwardOf(e.fs.q);
  const p = [e.fs.p[0] + fwd[0] * A.ahead, e.fs.p[1] + fwd[1] * A.ahead, e.fs.p[2] + fwd[2] * A.ahead];
  room.casts.push({ at: room.ms + A.windup * 1000, e, k: A.id, p, survive: true });
  room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'charge', o: pt(e.fs.p), p: pt(p), r: A.radius, w: A.windup, cd: A.cooldown });
  return true;
}

// Called every room tick: release wind-ups that are due.
export function resolveCasts(room) {
  if (!room.casts.length) return;
  for (let i = room.casts.length - 1; i >= 0; i--) {
    if (room.phase !== 'battle') return; // a blast below may score the winning kill, which empties room.casts
    const c = room.casts[i];
    if (c.at > room.ms) continue;
    room.casts.splice(i, 1);
    const e = c.e;
    if (room.phase !== 'battle' || !room.ents.has(e.id) || (!e.alive && !c.survive)) continue; // downed mid-charge: cancelled
    const A = ABILITIES[c.k === 'inferno' ? 'ember' : { nova: 'frost', chain: 'storm', acid: 'venom' }[c.k]];
    if (c.k === 'nova') novaBlast(room, e, A);
    else if (c.k === 'chain') chainStrike(room, e, A, c.tgt);
    else if (c.k === 'acid') {
      const z = room.addZone('acid', e, c.p, A.radius, A.life, A.dps);
      room.broadcast({ t: 'abil', a: e.id, k: A.id, ph: 'fire', p: pt(c.p), r: A.radius, life: A.life, z: z.id, cd: A.cooldown });
    }
  }
}

// Called by the room every 0.25 s: zone damage and lingering burn/poison, one damage event per victim and kind.
export function tickZones(room, dt) {
  const ms = room.ms;
  room.zones = room.zones.filter((z) => z.until > ms);
  const acc = new Map(); // victim -> { nap, acid, napBy, acidBy }
  for (const z of room.zones) {
    const owner = room.ents.get(z.owner) || null;
    for (const v of room.ents.values()) {
      if (!v.alive || v.shieldUntil > ms) continue;
      if (owner ? !room.hostile(owner, v) : z.team >= 0 && v.team === z.team) continue;
      if (vdist(v.fs.p, z.p) > z.r + 4) continue;
      let r = acc.get(v);
      if (!r) acc.set(v, (r = { nap: 0, acid: 0, napBy: null, acidBy: null }));
      if (z.k === 'nap') {
        if (z.dps > r.nap) { r.nap = z.dps; r.napBy = owner; }
        v.st.burn = ms + ABILITIES.ember.burn.dur * 1000;
        v.burnBy = z.owner;
      } else {
        if (z.dps > r.acid) { r.acid = z.dps; r.acidBy = owner; }
        v.st.poison = ms + ABILITIES.venom.poison.dur * 1000;
        v.poisonBy = z.owner;
        room.grant(v, 'corrode', ABILITIES.venom.corrode);
      }
    }
  }
  // lingering burn and poison once out of the zone
  for (const v of room.ents.values()) {
    if (!v.alive) continue;
    const r = acc.get(v) || (acc.set(v, { nap: 0, acid: 0, napBy: null, acidBy: null }), acc.get(v));
    if (v.st.burn > ms && !r.nap) { r.nap = ABILITIES.ember.burn.dps; r.napBy = room.ents.get(v.burnBy) || null; }
    if (v.st.poison > ms && !r.acid) { r.acid = ABILITIES.venom.poison.dps; r.acidBy = room.ents.get(v.poisonBy) || null; }
  }
  for (const [v, r] of acc) {
    if (r.nap) room.damage(v, r.napBy, r.nap * dt, 'nap', 0, null);
    if (r.acid) room.damage(v, r.acidBy, r.acid * dt, 'acid', 0, null);
  }
}

export const chilledBreeds = {};
// flight numbers for a chilled dragon (cached per breed so the hot loop allocates nothing)
export function chilled(id, breed) {
  return chilledBreeds[id] || (chilledBreeds[id] = { ...breed, turn: breed.turn * STATUS.chill.turn, speed: breed.speed * STATUS.chill.speed });
}
