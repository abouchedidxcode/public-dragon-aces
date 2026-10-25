#!/usr/bin/env node
// Encounter benchmark: a scripted room of 8 bots (no humans), simulated headlessly. Measures how quickly and how
// often dragons meet, so map-size changes can be compared on numbers instead of feel.
//   node tools/encounter-bench.mjs [seconds=240] [seeds=6] [bots=8]
// Metrics (all averaged over the seeds):
//   firstDmg / firstKill  seconds from the start until the first hit / first kill by weapon (crashes don't count)
//   nearest               mean distance (m) from each living dragon to its nearest hostile, sampled once a second
//   engaged               share of samples where a dragon has a hostile inside 500 m (inside its firing envelope)
//   contact               mean seconds from (re)spawning until a hostile is inside 500 m ("how long until I find someone")
//   killsPerMin           kills by weapons or abilities per minute across the room
//   crashesPerMin         bot crashes + out-of-bounds deaths per minute
//   visual                mean seconds a hostile pair stays continuously within VISUAL m of each other (one "look")
//   closing               mean closing speed (m/s) of hostile pairs between 150 and 600 m apart (head-on merges are high)
//   fleeting              share of those looks that last under 2 s (a dot, a blur, gone)
//   headOn                share of hostile pairs 150-600 m apart that fly nose to nose (merging, not turning)
//   ttk                   mean seconds from a victim's first hit (this life) to its death, weapon and ability kills
//   approach              mean seconds a foe takes from 800 m (a dot) to VISUAL m (a dragon): short means it pops up
//   lastLook              mean seconds the killer had been continuously within VISUAL m of its victim before the kill
// With pilot: true one of the dragons is a scripted stand-in for a human (flies at the nearest foe with full throttle,
// boosts to close, fires when lined up: how a new player flies). pVisual / pFleeting / pClosing / pHeadOn are the
// same metrics for the pairs that include it (what a player sees), pKills / pDeaths its score per minute.
import { Room } from '../shared/room.js';
import { vdist, vdot } from '../shared/math.js';
import { forwardOf, steerToward, stepFlight } from '../shared/flight.js';
import { BREEDS, WEAPONS } from '../shared/constants.js';
import { clamp, vnorm } from '../shared/math.js';

const _fa = [0, 0, 0], _fb = [0, 0, 0];

const VISUAL = 300; // m: inside this a dragon reads as a dragon on screen, not a dot

// The human stand-in: lead pursuit of the nearest foe, full throttle, boost to close, fire when the nose is on.
const _pd = [0, 0, 0], _pt = [0, 0, 0];
function flyPilot(room, e, dt, input) {
  const s = e.fs;
  let tgt = null, bd = Infinity;
  for (const o of room.ents.values()) {
    if (o === e || !o.alive) continue;
    const d = vdist(o.fs.p, s.p);
    if (d < bd) { bd = d; tgt = o; }
  }
  const fwd = forwardOf(s.q, _fa);
  let fire = false;
  input.boost = false;
  if (tgt) {
    _pt[0] = tgt.fs.p[0] - s.p[0]; _pt[1] = tgt.fs.p[1] - s.p[1]; _pt[2] = tgt.fs.p[2] - s.p[2];
    const lead = clamp(bd / (BREEDS[e.breed].fbSpeed + s.speed), 0, 2);
    for (let i = 0; i < 3; i++) _pd[i] = _pt[i] + tgt.fs.vel[i] * lead;
    vnorm(_pd, _pd);
    fire = bd < 600 && vdot(_pd, fwd) > Math.cos(0.05) && room.ms - e.lastShot > WEAPONS.fireball.cooldown * 1000;
    input.boost = bd > 450 && s.stamina > 0.3;
  } else { _pd[0] = -s.p[0]; _pd[1] = 0; _pd[2] = -s.p[2]; vnorm(_pd, _pd); }
  // a player pulls up from the ground and turns back from the edge
  const ground = s.p[1] - room.world.floorAt(s.p[0] + s.vel[0] * 2, s.p[2] + s.vel[2] * 2);
  if (ground < 150) { _pd[1] = Math.max(_pd[1], 0.6); vnorm(_pd, _pd); }
  if (Math.hypot(s.p[0], s.p[2]) > room.world.castleSite.radius + 1100) { _pd[0] -= s.p[0] * 0.001; _pd[2] -= s.p[2] * 0.001; vnorm(_pd, _pd); }
  steerToward(s, _pd, input, 1.2);
  input.throttle = 1;
  stepFlight(s, input, dt, BREEDS[e.breed]);
  e.flags = s.boosting ? 2 : 0;
  if (room.world.solidAt(s.p, 2.5)) { room.kill(e, null, 'crash'); return; }
  if (fire && room.phase === 'battle') { e.lastShot = room.ms; room.botFire(e); }
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

export function runEncounter({ seed = 1, seconds = 240, bots = 8, pilot = false } = {}) {
  const room = new Room({ seed, bots: false });
  const events = [];
  room.broadcast = (m) => { events.push(m); };
  room.send = () => {};
  room.endMatch = () => {}; // one long battle: the bench measures encounters, not match flow (kill limits)
  let me = null;
  const pInput = { pitch: 0, roll: 0, yaw: 0, throttle: 1, boost: false, brake: false, dodge: 0 };
  if (pilot) { me = room.createEnt({ name: 'Pilot', breed: 'ember' }); room.spawn(me, false); me.awaitSpawn = null; }
  for (let i = 0; i < bots - (pilot ? 1 : 0); i++) room.addBot();
  const pLooks = [];
  let pClose = 0, pCloseN = 0, pHead = 0, pKills = 0, pDeaths = 0, pCrashes = 0;
  const born = new Map(); // id -> seconds it spawned, until it first meets a hostile
  for (const e of room.ents.values()) born.set(e.id, 0);
  const contacts = [];
  const step = 1 / 30;
  let nnSum = 0, nnN = 0, engaged = 0;
  let firstDmg = null, firstKill = null, kills = 0, crashes = 0;
  const near = new Map(); // "a,b" -> seconds the pair came within VISUAL m (while it stays there)
  const inbound = new Map(); // "a,b" -> seconds the pair came within 800 m
  const approaches = [], pApproaches = [];
  const looks = [];
  let closeSum = 0, closeN = 0, headOn = 0;
  const firstHit = new Map(); // victim id -> seconds of its first hit this life
  const ttks = [], lastLooks = [];
  for (let t = 0, k = 0; t < seconds; t += step, k++) {
    room.ms += step * 1000;
    if (me && me.alive) flyPilot(room, me, step, pInput);
    room.tick(step);
    if (me) me.awaitSpawn = null;
    if (k % 3 === 0) {
      // pairs within visual range, sampled at 10 Hz
      const alive = [...room.ents.values()].filter((e) => e.alive);
      const now = room.ms / 1000;
      const seen = new Set(), live = new Set();
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i], b = alive[j];
          if (!room.hostile(a, b)) continue;
          const d = vdist(a.fs.p, b.fs.p);
          const key = a.id < b.id ? `${a.id},${b.id}` : `${b.id},${a.id}`;
          live.add(key);
          if (d < VISUAL) {
            seen.add(key);
            if (!near.has(key)) {
              near.set(key, now);
              if (inbound.has(key)) (a === me || b === me ? pApproaches : approaches).push(now - inbound.get(key));
            }
            inbound.delete(key);
          } else if (d < 800) { if (!inbound.has(key) && !near.has(key)) inbound.set(key, now); }
          else inbound.delete(key);
          if (d > 150 && d < 600) {
            const rv = [(b.fs.p[0] - a.fs.p[0]) / d, (b.fs.p[1] - a.fs.p[1]) / d, (b.fs.p[2] - a.fs.p[2]) / d];
            const cl = (a.fs.vel[0] - b.fs.vel[0]) * rv[0] + (a.fs.vel[1] - b.fs.vel[1]) * rv[1] + (a.fs.vel[2] - b.fs.vel[2]) * rv[2];
            const fa = forwardOf(a.fs.q, _fa), fb = forwardOf(b.fs.q, _fb);
            const ho = vdot(fa, rv) > 0.8 && -vdot(fb, rv) > 0.8;
            if (a === me || b === me) { pClose += cl; pCloseN++; if (ho) pHead++; }
            else { closeSum += cl; closeN++; if (ho) headOn++; }
          }
        }
      }
      for (const key of inbound.keys()) if (!live.has(key)) inbound.delete(key);
      for (const [key, t0] of near) {
        if (seen.has(key)) continue;
        const [x, y] = key.split(',').map(Number);
        (me && (x === me.id || y === me.id) ? pLooks : looks).push(now - t0);
        near.delete(key);
      }
    }
    if (k % 30 === 0) {
      const alive = [...room.ents.values()].filter((e) => e.alive);
      for (const a of alive) {
        let nn = Infinity;
        for (const b of alive) if (a !== b && room.hostile(a, b)) nn = Math.min(nn, vdist(a.fs.p, b.fs.p));
        if (nn < Infinity) { nnSum += nn; nnN++; if (nn < 500) engaged++; }
        if (nn < 500 && born.has(a.id)) { contacts.push(room.ms / 1000 - born.get(a.id)); born.delete(a.id); }
      }
    }
    for (const m of events) {
      if (m.t === 'spawn') born.set(m.id, room.ms / 1000);
      if (m.t === 'dmg' && firstDmg === null) firstDmg = room.ms / 1000;
      if (m.t === 'dmg' && m.n > 0 && !firstHit.has(m.v)) firstHit.set(m.v, room.ms / 1000);
      if (m.t === 'kill') {
        if (m.k === 'crash' || m.k === 'bounds') { if (me && m.v === me.id) pCrashes++; else crashes++; }
        else {
          kills++;
          if (firstKill === null) firstKill = room.ms / 1000;
          if (firstHit.has(m.v)) ttks.push(room.ms / 1000 - firstHit.get(m.v));
          const key = m.a < m.v ? `${m.a},${m.v}` : `${m.v},${m.a}`;
          lastLooks.push(near.has(key) ? room.ms / 1000 - near.get(key) : 0);
        }
        firstHit.delete(m.v);
        if (me && m.v === me.id) pDeaths++;
        else if (me && m.a === me.id) pKills++;
      }
    }
    events.length = 0;
  }
  return {
    firstDmg: firstDmg ?? seconds, firstKill: firstKill ?? seconds,
    contact: contacts.reduce((a, b) => a + b, 0) / Math.max(1, contacts.length),
    nearest: nnSum / Math.max(1, nnN), engaged: engaged / Math.max(1, nnN),
    killsPerMin: (kills * 60) / seconds, crashesPerMin: (crashes * 60) / seconds,
    ...(me ? {
      pApproach: mean(pApproaches), pVisual: mean(pLooks), pFleeting: pLooks.filter((x) => x < 2).length / Math.max(1, pLooks.length), pClosing: pClose / Math.max(1, pCloseN),
      pHeadOn: pHead / Math.max(1, pCloseN), pKills: (pKills * 60) / seconds, pDeaths: (pDeaths * 60) / seconds, pCrashes: (pCrashes * 60) / seconds,
    } : {}),
    approach: mean(approaches), visual: mean(looks), fleeting: looks.filter((x) => x < 2).length / Math.max(1, looks.length), headOn: headOn / Math.max(1, closeN), closing: closeSum / Math.max(1, closeN), ttk: mean(ttks), lastLook: mean(lastLooks),
  };
}

export function measureEncounters({ seconds = 240, seeds = 6, bots = 8, pilot = false } = {}) {
  const runs = [];
  for (let s = 1; s <= seeds; s++) runs.push(runEncounter({ seed: s * 101, seconds, bots, pilot }));
  const avg = {};
  for (const k of Object.keys(runs[0])) avg[k] = runs.reduce((a, r) => a + r[k], 0) / runs.length;
  return { avg, runs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { avg, runs } = measureEncounters({ seconds: Number(process.argv[2]) || 240, seeds: Number(process.argv[3]) || 6, bots: Number(process.argv[4]) || 8, pilot: !!process.env.PILOT });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, +v.toFixed(3)])), null, 1));
  if (process.env.RUNS) console.log(runs.map((r) => JSON.stringify(r)).join('\n'));
}
