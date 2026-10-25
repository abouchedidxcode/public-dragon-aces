// Flight harness for the citadel tests: one bot (the real thinkBot + flight model) flies at a dummy on the far side of
// the castle, optionally with a pursuer glued to its tail. Used by castle.test.mjs and handy for debugging.
import { createWorld } from '../shared/world.js';
import * as castle from '../shared/castle.js';
import { CASTLE } from '../shared/castle.js';
import { BREEDS } from '../shared/constants.js';
import { createBrain, thinkBot } from '../shared/bots.js';
import { createFlightState, stepFlight } from '../shared/flight.js';
import { qlook, rng } from '../shared/math.js';

export const world = createWorld();
export const Y = CASTLE.y0;

// the real world's colliders without its mountains: isolates what the citadel does to a bot's flight
export const flatWorld = Object.create(world);
flatWorld.floorAt = () => Y; // one big plateau at the courtyard's level
flatWorld.height = () => Y;
flatWorld.hitSkyRock = () => null;
flatWorld.hitLandmark = () => null;
flatWorld.solidAt = (p, pad = 0) => (p[1] - pad < Y ? true : !!castle.hit(p, pad));

// ---------------------------------------------------------------------------------------------- bots
// A stripped-down room: one bot chasing a stationary dummy placed on the far side of the citadel, so the straight
// line to it crosses the stone. The same flights are repeated over open sea as the control.
function fakeRoom(w) {
  // the pursuer (id 3) is a threat to the bot but not a target for it: the bot should keep flying at the dummy
  return { world: w, ents: new Map(), hostile: (a, v) => !(a.id === 1 && v.id === 3), ms: 0, phase: 'battle', shrines: w.shrines.map(() => 0) };
}

export function flight({ w, start, aim, seed, skill = 0.7, chaser = null, secs = 28, castleOn = true, trace = null }) {
  const rand = rng(seed);
  const room = fakeRoom(w);
  const dir = [aim[0] - start[0], aim[1] - start[1], aim[2] - start[2]];
  const dl = Math.hypot(...dir);
  const h = dir.map((x) => x / dl);
  const bot = { id: 1, isBot: true, alive: true, breed: 'ember', hp: 100, st: {}, shieldUntil: 0, abilReady: 1e9, brain: createBrain(rand, skill) };
  bot.fs = createFlightState(start, qlook([0, 0, 0, 1], h));
  bot.fs.vel = [h[0] * 90, h[1] * 90, h[2] * 90];
  const dummy = { id: 2, isBot: false, alive: true, breed: 'ember', hp: 100, st: {}, shieldUntil: 0, fs: createFlightState(aim, [0, 0, 0, 1]) };
  room.ents.set(1, bot);
  room.ents.set(2, dummy);
  if (chaser) {
    const c = { id: 3, isBot: false, alive: true, breed: 'ember', hp: 100, st: {}, shieldUntil: 0, fs: createFlightState([0, 0, 0], [0, 0, 0, 1]) };
    room.ents.set(3, c);
    bot._chaser = c;
  }
  const dt = 1 / 30;
  let crashed = null, threaded = null, minDist = 1e9, ran = false;
  for (let k = 0; k < secs * 30; k++) {
    if (bot._chaser) {
      // a pursuer glued 230 m behind the bot, pointing at it
      const f = [bot.fs.vel[0], bot.fs.vel[1], bot.fs.vel[2]];
      const fl = Math.hypot(...f) || 1;
      const c = bot._chaser.fs;
      c.p = [bot.fs.p[0] - (f[0] / fl) * 230, bot.fs.p[1] - (f[1] / fl) * 230, bot.fs.p[2] - (f[2] / fl) * 230];
      c.q = qlook([0, 0, 0, 1], [f[0] / fl, f[1] / fl, f[2] / fl]);
      c.vel = f;
    }
    room.ms += dt * 1000;
    const { input } = thinkBot(bot, room, dt);
    if (bot.brain.gate) ran = true;
    if (trace) trace(k, bot);
    stepFlight(bot.fs, input, dt, BREEDS.ember);
    const p = bot.fs.p;
    minDist = Math.min(minDist, Math.hypot(p[0] - aim[0], p[1] - aim[1], p[2] - aim[2]));
    if (castleOn) {
      const c = castle.hit(p, 2);
      if (c) { crashed = { t: k * dt, id: c.id, p: [...p] }; break; }
      if (!threaded) {
        for (const g of castle.gates()) {
          const rx = p[0] - g.p[0], rz = p[2] - g.p[2];
          const along = rx * g.dir[0] + rz * g.dir[1];
          const lat = rx * -g.dir[1] + rz * g.dir[0];
          if (Math.abs(along) < g.len / 2 && Math.abs(lat) < g.hw && p[1] > g.p[1] - g.hh && p[1] < g.p[1] + g.hh) threaded = g.id;
        }
      }
    }
    if (w.solidAt(p, 2) && !castle.hit(p, 2)) {
      // the massif's plateau and cliffs belong to the citadel; the mountains around it are the old terrain problem
      const zone = Math.hypot(p[0] - CASTLE.x, p[2] - CASTLE.z) < CASTLE.plateau + 140;
      crashed = { t: k * dt, id: zone ? 'massif' : 'terrain', p: [...p] };
      break;
    }
  }
  return { crashed, threaded, minDist, ran };
}

export function sweep(chaser, skill, n = 48, arc = [0, Math.PI * 2], alts = [40, 600], opts = {}) {
  let castleCrash = 0, otherCrash = 0, threaded = 0, passes = 0, ran = 0;
  const detail = [];
  for (let i = 0; i < n; i++) {
    if (opts.only != null && opts.only !== i) continue;
    const r = rng(1000 + i);
    const bearing = arc[0] + (i / n) * (arc[1] - arc[0]) + r() * 0.05;
    const alt = Y + alts[0] + r() * (alts[1] - alts[0]);
    const D = opts.D || 1500;
    const sx = CASTLE.x + Math.cos(bearing) * D, sz = CASTLE.z + Math.sin(bearing) * D;
    const off = (r() - 0.5) * 360; // lateral offset of the target line
    const ex = CASTLE.x - Math.cos(bearing) * 900 - Math.sin(bearing) * off, ez = CASTLE.z - Math.sin(bearing) * 900 + Math.cos(bearing) * off;
    const res = flight({ w: opts.w || world, start: [sx, alt, sz], aim: [ex, alt + (r() - 0.5) * 200, ez], seed: 7 + i, skill, chaser, trace: opts.trace, secs: opts.secs || 28 });
    passes++;
    if (res.crashed) {
      if (res.crashed.id === 'terrain') otherCrash++;
      else { castleCrash++; detail.push([i, res.crashed.id, Math.round(res.crashed.t), res.crashed.p.map(Math.round)]); }
    }
    if (res.threaded) threaded++;
    if (res.ran) ran++;
  }
  return { castleCrash, otherCrash, threaded, passes, ran, detail };
}

