// One battle: up to MAX_PLAYERS dragons (humans + bots) in one sky. Authoritative for health, kills,
// scores, respawns, match timing, bot flight and bot fireballs. Each client flies its own dragon and
// claims its own hits; the room checks every claim against what it knows before applying damage.
//
// Runs unchanged in the Cloudflare Durable Object and in the browser (offline practice), so it only uses
// plain JS: a conn is { send(stringOrArrayBuffer) } and messages come in through room.message().
import { ABILITIES, BOT_NAMES, BREEDS, BREED_IDS, DRAGON_SCALE, F, MATCH, MAX_PLAYERS, MODES, SCORE, SHRINE, SNAPSHOT_HZ, STATUS, STREAK, TICK_HZ, WEAPONS, WORLD } from './constants.js';
import { castAbility, chilled, resolveCasts, tickZones } from './abilities.js';
import { createBrain, thinkBot } from './bots.js';
import { sweepDragon, distToRay, homeSeeker } from './combat.js';
import { createFlightState, forwardOf, stepFlight, MAX_SPEED } from './flight.js';
import { qlook, rng, vdist, vnorm } from './math.js';
import { decodeState, encodeSnapshot, MSG_STATE } from './protocol.js';
import { createWorld } from './world.js';

let sharedWorld = null;
const getWorld = () => sharedWorld || (sharedWorld = createWorld(WORLD.seed));

const BOT_TARGET = 6; // keep at least this many dragons in the sky (Team Deathmatch: half of it a side, 3 v 3)
const ASSIST_WINDOW = 15000;
const CREDIT_WINDOW = 10000; // crashing shortly after being hit gives the attacker the kill
const ZONE_TICK = 0.25; // s between zone / burn / poison damage ticks
const MAX_ZONES = 80;
const MEDALS = { firstblood: 'First Blood', revenge: 'Revenge', closecall: 'Close Call', sniper: 'Sniper', bounty: 'Bounty Hunter', shutdown: 'Shutdown' };

export const cleanName = (s) =>
  String(s || '').replace(/[^\p{L}\p{N} _.\-']/gu, '').trim().slice(0, 16) || 'Dragon';

export class Room {
  // mode: 'ffa' | 'tdm'. A room with a playlist (public skies) alternates FFA and TDM, one match each.
  constructor({ code = 'LOCAL', isPublic = true, bots = true, seed = Date.now(), mode = 'ffa', playlist = false } = {}) {
    this.code = code;
    this.isPublic = isPublic;
    this.mode = MODES[mode] ? mode : 'ffa';
    this.playlist = !!playlist;
    this.zones = []; // lingering napalm / acid clouds
    this.casts = []; // ability wind-ups waiting to release
    this.zoneSeq = 0;
    this.zoneAcc = 0;
    this.teamKills = [0, 0];
    this.firstBlood = false;
    this.result = null;
    this.botsEnabled = bots;
    this.world = getWorld();
    this.rand = rng(seed >>> 0);
    this.teamAxis = this.rand() * Math.PI * 2; // TDM: team 0 spawns on this side of the arena, team 1 opposite
    this.ents = new Map();
    this.nextId = 1;
    this.t0 = Date.now();
    this.ms = 0;
    this.snapAcc = 0;
    this.botAcc = 0;
    this.shots = []; // server-simulated bot fireballs
    this.seekers = []; // seekers chasing bots, flown here only so the bot can see them coming and roll
    this.phase = 'battle';
    this.phaseEnds = MATCH.duration * 1000;
    this.matchNo = 1;
    this.lastBoard = null;
    this.shrines = this.world.shrines.map(() => 0); // ms when each shrine is ready again
    // Dev mode (offline practice only: the page sets these on its own in-browser room; nothing on the wire can).
    //   skill: null | 0..1 bot skill for every bot   bots: null | how many dragons to keep in the sky
    //   ghost: bots cannot see humans               god: humans take no damage
    //   holdFire: bots fly but never attack         free: humans have no seeker or ability cooldowns
    this.dev = { skill: null, bots: null, ghost: false, god: false, holdFire: false, free: false };
  }

  get humans() {
    let n = 0;
    for (const e of this.ents.values()) if (!e.isBot) n++;
    return n;
  }
  get size() {
    return this.ents.size;
  }
  // can a new human join? (bots make room for them)
  get open() {
    return this.humans < MAX_PLAYERS;
  }
  get tdm() {
    return this.mode === 'tdm';
  }
  get killLimit() {
    return this.tdm ? MATCH.tdmKillLimit : MATCH.killLimit;
  }

  // Can a damage or effect source hurt this victim? (no friendly fire in Team Deathmatch)
  hostile(a, v) {
    return a !== v && !(this.tdm && a.team === v.team);
  }

  // can `a` pick `v` as a target? Like hostile(), except that in dev mode's ghost setting bots cannot see humans
  canTarget(a, v) {
    return this.hostile(a, v) && !(this.dev.ghost && a.isBot && !v.isBot);
  }

  botTarget() {
    return this.dev.bots ?? BOT_TARGET;
  }

  allocId() {
    for (let i = 0; i < 255; i++) {
      const id = ((this.nextId + i - 1) % 255) + 1;
      if (!this.ents.has(id)) {
        this.nextId = (id % 255) + 1;
        return id;
      }
    }
    return 0;
  }

  createEnt({ name, breed, conn = null, isBot = false }) {
    const id = this.allocId();
    const e = {
      id, name, breed: BREEDS[breed] ? breed : 'ember', nextBreed: null, isBot, conn, team: -1,
      fs: createFlightState([0, 800, 0], [0, 0, 0, 1]),
      hp: 100, alive: false, deadUntil: 0, shieldUntil: 0,
      kills: 0, deaths: 0, score: 0, streak: 0, assists: 0, dmgDealt: 0, abilDmg: 0, bestStreak: 0, medals: {},
      drought: 0, lastKiller: 0, bounty: 0, abilReady: 0, trailUntil: 0, trailAcc: 0,
      st: {}, burnBy: 0, poisonBy: 0, // status effects: name -> room ms when it ends
      flags: 0, dmgLog: new Map(), lastShot: -1e9, lastSeeker: -1e9,
      shots: new Map(), burnAt: new Map(), lastStateAt: 0, awaitSpawn: null, outFor: 0,
      brain: isBot ? createBrain(rng(Math.floor(this.rand() * 1e9)), 0.3 + this.rand() * 0.6) : null,
      ping: 0,
    };
    this.ents.set(id, e);
    return e;
  }

  publicEnt(e) {
    return { id: e.id, name: e.name, breed: e.breed, bot: e.isBot, team: e.team, bounty: e.bounty, kills: e.kills, deaths: e.deaths, score: e.score, hp: Math.ceil(e.hp), alive: e.alive };
  }

  // --- connection lifecycle -------------------------------------------------------------------------
  join(conn, { name, breed } = {}) {
    if (!this.open) return null;
    const team = this.tdm ? this.teamForHuman() : -1;
    // a bot gives up its seat if the sky is full
    if (this.ents.size >= MAX_PLAYERS) this.removeBot(team);
    const e = this.createEnt({ name: cleanName(name), breed, conn });
    if (!e.id) return null;
    e.team = team;
    this.spawn(e, false);
    this.send(e, {
      t: 'welcome', you: e.id, code: this.code, isPublic: this.isPublic, ms: this.ms,
      match: this.matchInfo(), ents: [...this.ents.values()].map((x) => this.publicEnt(x)),
      shrines: this.shrines.map((t) => Math.max(0, t - this.ms)),
      zones: this.zones.map((z) => this.zoneInfo(z)),
      spawn: { p: e.fs.p, q: e.fs.q }, cd: this.abilCd(e),
    });
    this.broadcast({ t: 'join', e: this.publicEnt(e) }, e);
    this.balanceBots();
    return e;
  }

  leave(e, rebalance = true) {
    if (!this.ents.has(e.id)) return;
    this.ents.delete(e.id);
    this.zones = this.zones.filter((z) => z.owner !== e.id);
    this.broadcast({ t: 'leave', id: e.id });
    if (rebalance) this.balanceBots();
  }

  // --- teams ----------------------------------------------------------------------------------------
  teamSize(team, humansOnly = false) {
    let n = 0;
    for (const e of this.ents.values()) if (e.team === team && (!humansOnly || !e.isBot)) n++;
    return n;
  }

  // humans are split evenly; ties go to the flight with fewer dragons in total, then a coin flip
  teamForHuman() {
    const h0 = this.teamSize(0, true), h1 = this.teamSize(1, true);
    if (h0 !== h1) return h0 < h1 ? 0 : 1;
    const t0 = this.teamSize(0), t1 = this.teamSize(1);
    if (t0 !== t1) return t0 < t1 ? 0 : 1;
    return this.rand() < 0.5 ? 0 : 1;
  }

  // New match in TDM: best scores of the last match are split between the flights, bots even out the rest.
  reassignTeams() {
    if (!this.tdm) {
      for (const e of this.ents.values()) e.team = -1;
      return;
    }
    const humans = [...this.ents.values()].filter((e) => !e.isBot).sort((a, b) => b.score - a.score);
    const bots = [...this.ents.values()].filter((e) => e.isBot);
    const sizes = [0, 0];
    const snake = [0, 1, 1, 0];
    humans.forEach((e, i) => { e.team = snake[i % 4]; sizes[e.team]++; });
    for (const e of bots) {
      const t = sizes[0] !== sizes[1] ? (sizes[0] < sizes[1] ? 0 : 1) : (this.rand() < 0.5 ? 0 : 1);
      e.team = t;
      sizes[t]++;
    }
  }

  balanceBots() {
    const humans = this.humans;
    if (this.tdm) {
      // equal flights: each fills up to the larger human side (at least half of BOT_TARGET)
      const perTeam = this.botsEnabled && humans > 0
        ? Math.min(MAX_PLAYERS / 2, Math.max(this.botTarget() / 2, this.teamSize(0, true), this.teamSize(1, true)))
        : 0;
      for (const t of [0, 1]) {
        const want = Math.max(0, perTeam - this.teamSize(t, true));
        const bots = () => this.teamSize(t) - this.teamSize(t, true);
        while (bots() < want && this.ents.size < MAX_PLAYERS) this.addBot(t);
        while (bots() > want) this.removeBot(t);
      }
      return;
    }
    const want = this.botsEnabled && humans > 0 ? Math.max(0, Math.min(this.botTarget() - humans, MAX_PLAYERS - humans)) : 0;
    let bots = this.ents.size - humans;
    while (bots < want) {
      this.addBot();
      bots++;
    }
    while (bots > want) {
      this.removeBot();
      bots--;
    }
  }

  addBot(team = -1) {
    const used = new Set([...this.ents.values()].map((e) => e.name));
    const pool = BOT_NAMES.filter((n) => !used.has(n));
    const name = pool.length ? pool[Math.floor(this.rand() * pool.length)] : `Wyrm ${this.nextId}`;
    const breed = BREED_IDS[Math.floor(this.rand() * BREED_IDS.length)];
    const e = this.createEnt({ name, breed, isBot: true });
    if (!e.id) return;
    e.team = this.tdm ? team : -1;
    this.spawn(e, false);
    this.broadcast({ t: 'join', e: this.publicEnt(e) });
  }

  removeBot(team = -1) {
    let pick = null;
    for (const e of this.ents.values()) {
      if (!e.isBot || (team >= 0 && this.tdm && e.team !== team)) continue;
      if (!pick || (!e.alive && pick.alive) || e.score < pick.score) pick = e;
    }
    if (!pick && team >= 0) return this.removeBot(-1);
    if (pick) this.leave(pick, false);
  }

  // --- spawning -------------------------------------------------------------------------------------
  spawn(e, announce = true) {
    if (e.nextBreed) {
      e.breed = e.nextBreed;
      e.nextBreed = null;
    }
    const others = [...this.ents.values()].filter((x) => x !== e && x.alive).map((x) => x.fs.p);
    let p = this.world.spawnPoint(this.rand, others);
    // Team Deathmatch: each flight starts on its own side of the arena
    for (let i = 0; i < 4 && this.tdm && !this.onTeamSide(p, e.team); i++) p = this.world.spawnPoint(this.rand, others);
    if (this.tdm && !this.onTeamSide(p, e.team)) {
      // mirror the point across the line that splits the arena
      const ax = Math.cos(this.teamAxis), az = Math.sin(this.teamAxis);
      const k = 2 * (p[0] * ax + p[2] * az);
      const mx = p[0] - ax * k, mz = p[2] - az * k;
      p = [mx, Math.max(p[1], this.world.clearAltitude(mx, mz)), mz];
    }
    const toCentre = vnorm([0, 0, 0], [-p[0], -80, -p[2]]);
    const q = qlook([0, 0, 0, 1], toCentre);
    e.fs = createFlightState(p, q);
    e.fs.vel = [toCentre[0] * 75, toCentre[1] * 75, toCentre[2] * 75];
    e.hp = BREEDS[e.breed].hp;
    e.alive = true;
    e.shieldUntil = this.ms + MATCH.spawnProtect * 1000;
    e.dmgLog.clear();
    e.outFor = 0;
    e.st = {};
    e.trailUntil = 0;
    // fresh out of the egg: the signature ability needs a few seconds before it is ready
    e.abilReady = Math.max(e.abilReady, this.ms + 5000);
    let bonus = '';
    if (e.drought >= STREAK.droughtDeaths) {
      // comeback: a few deaths in a row earn a Second Wind (longer protection, hot fireballs, ability ready)
      e.drought = 0;
      bonus = 'wind';
      e.shieldUntil = this.ms + STREAK.secondWind.shield * 1000;
      e.abilReady = this.ms;
    }
    e.awaitSpawn = e.isBot ? null : { p, until: this.ms + 4000 };
    if (announce) this.broadcast({ t: 'spawn', id: e.id, breed: e.breed, hp: e.hp, p, q, bonus });
    if (bonus) this.grant(e, 'blaze', STREAK.secondWind.blaze);
    if (announce) this.send(e, { t: 'abilcd', cd: this.abilCd(e) });
  }

  onTeamSide(p, team) {
    const side = p[0] * Math.cos(this.teamAxis) + p[2] * Math.sin(this.teamAxis);
    return team === 0 ? side > 0 : side < 0;
  }

  // --- statuses and zones ---------------------------------------------------------------------------
  // seconds until the ability can be used again
  abilCd(e) {
    return Math.max(0, Math.round((e.abilReady - this.ms) / 100) / 10);
  }

  cutCooldown(e, secs) {
    e.abilReady = Math.max(this.ms, e.abilReady - secs * 1000);
    this.send(e, { t: 'abilcd', cd: this.abilCd(e) });
  }

  // give a status for `secs`; tells everyone unless it is already running with most of its time left
  grant(e, k, secs) {
    const until = this.ms + secs * 1000;
    const fresh = !(e.st[k] > this.ms + secs * 500);
    e.st[k] = Math.max(e.st[k] || 0, until);
    if (fresh) this.broadcast({ t: 'st', id: e.id, k, d: secs });
  }

  zoneInfo(z) {
    return { id: z.id, k: z.k, o: z.owner, team: z.team, p: z.p, r: z.r, life: Math.max(0, (z.until - this.ms) / 1000) };
  }

  addZone(k, owner, p, r, life, dps) {
    const z = { id: ++this.zoneSeq, k, owner: owner.id, team: owner.team, p: [p[0], p[1], p[2]], r, until: this.ms + life * 1000, dps };
    this.zones.push(z);
    if (this.zones.length > MAX_ZONES) this.zones.shift();
    this.broadcast({ t: 'zone', ...this.zoneInfo(z) });
    return z;
  }

  // --- messages -------------------------------------------------------------------------------------
  message(e, data) {
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (bytes && bytes[0] === MSG_STATE) this.onState(e, decodeState(bytes));
      return;
    }
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'fire': return this.onFire(e, m);
      case 'hit': return this.onHit(e, m);
      case 'burn': return this.onBurn(e, m);
      case 'lock': return this.onLock(e, m);
      case 'abil': return void castAbility(this, e);
      case 'evade': return this.onEvade(e, m);
      case 'crash': return this.onCrash(e, m);
      case 'shrine': return this.takeShrine(e, m.i | 0, 60);
      case 'breed':
        if (BREEDS[m.breed]) {
          if (!e.alive) e.breed = m.breed;
          else e.nextBreed = m.breed;
          this.send(e, { t: 'breedq', breed: m.breed });
        }
        return;
      case 'ping':
        this.send(e, { t: 'pong', c: m.c, ms: this.ms });
        if (Number.isFinite(m.rtt)) e.ping = Math.max(0, Math.min(2000, m.rtt));
        return;
    }
  }

  onState(e, st) {
    if (!st || !e.alive) return;
    const now = this.ms;
    if (e.awaitSpawn) {
      // ignore stale states from the previous life until the client has teleported to its spawn
      if (vdist(st.p, e.awaitSpawn.p) > 400 && now < e.awaitSpawn.until) return;
      e.awaitSpawn = null;
    } else {
      // movement sanity check: no teleporting
      const dt = Math.max(0.02, (now - e.lastStateAt) / 1000);
      const maxMove = MAX_SPEED * 1.25 * dt + 60;
      if (vdist(st.p, e.fs.p) > maxMove) return;
    }
    e.lastStateAt = now;
    const s = e.fs;
    const dt = 1 / 20;
    s.vel[0] = (st.p[0] - s.p[0]) / dt * 0.5 + s.vel[0] * 0.5;
    s.vel[1] = (st.p[1] - s.p[1]) / dt * 0.5 + s.vel[1] * 0.5;
    s.vel[2] = (st.p[2] - s.p[2]) / dt * 0.5 + s.vel[2] * 0.5;
    s.p = st.p;
    s.q = st.q;
    s.speed = Math.min(st.speed, MAX_SPEED * 1.2);
    s.throttle = st.throttle;
    e.flags = (e.flags & (F.DEAD | F.SHIELD)) | (st.flags & (F.BREATH | F.BOOST | F.DODGE | F.BRAKE | F.OUT));
    if (st.flags & F.DODGE) e.lastDodge = now;
  }

  onFire(e, m) {
    if (!e.alive || this.phase !== 'battle') return;
    const o = this.vec(m.o), d = this.vec(m.d);
    if (!o || !d || vdist(o, e.fs.p) > 60) return;
    vnorm(d, d);
    const s = m.s | 0;
    const breed = BREEDS[e.breed];
    if (m.k === 'sk') {
      if (this.ms - e.lastSeeker < WEAPONS.seeker.cooldown * 900 && !this.dev.free) return;
      e.lastSeeker = this.ms;
      const v = this.ents.get(m.v | 0);
      const shot = { k: 'sk', o, d, at: this.ms, v: v ? v.id : 0, used: false, evaded: false };
      e.shots.set(s, shot);
      if (v && v.isBot && this.seekers.length < 40) {
        // will this bot try to roll out of the way? Better pilots read it more often
        const sp = WEAPONS.seeker.speed + Math.min(e.fs.speed, MAX_SPEED) * 0.5;
        const sees = this.rand() < 0.1 + 0.45 * v.brain.skill;
        this.seekers.push({ a: e, s, shot, v, p: o.slice(), vel: [d[0] * sp, d[1] * sp, d[2] * sp], sees, rollAt: 0.25 + this.rand() * 0.6 });
      }
      this.broadcast({ t: 'fire', a: e.id, k: 'sk', s, o, d, v: v ? v.id : 0, sp: WEAPONS.seeker.speed }, e);
    } else {
      const rate = e.st.blaze > this.ms ? STREAK.blaze.fireCooldown : 1;
      if (this.ms - e.lastShot < WEAPONS.fireball.cooldown * 800 * rate) return;
      e.lastShot = this.ms;
      const sp = breed.fbSpeed + Math.max(0, Math.min(e.fs.speed, MAX_SPEED));
      e.shots.set(s, { k: 'fb', o, d, at: this.ms, sp, used: false });
      this.broadcast({ t: 'fire', a: e.id, k: 'fb', s, o, d, sp }, e);
    }
    e.shieldUntil = Math.min(e.shieldUntil, this.ms); // firing drops spawn protection
    if (e.shots.size > 64) {
      for (const [k, sh] of e.shots) if (this.ms - sh.at > 8000) e.shots.delete(k);
    }
  }

  onHit(e, m) {
    const shot = e.shots.get(m.s | 0);
    const v = this.ents.get(m.v | 0);
    const p = this.vec(m.p);
    if (!shot || shot.used || !v || v === e || !v.alive || !p || !this.hostile(e, v)) return;
    const age = (this.ms - shot.at) / 1000;
    // the victim has to have been near the claimed point (generous for latency and interpolation)
    const slack = 45 + v.fs.speed * (0.25 + Math.min(0.5, (e.ping + v.ping) / 2000));
    if (vdist(p, v.fs.p) > slack) return;
    let dmg;
    if (shot.k === 'fb') {
      if (age > WEAPONS.fireball.life + 0.6) return;
      const { dist, along } = distToRay(p, shot.o, shot.d);
      if (dist > 25 || along > shot.sp * (age + 0.5) + 30) return;
      dmg = BREEDS[e.breed].fbDamage;
    } else {
      if (shot.evaded || age > WEAPONS.seeker.life + 0.6 || (shot.v && shot.v !== v.id)) return;
      if (v.lastDodge && this.ms - v.lastDodge < 400) return; // rolled out of the way at the last moment
      dmg = WEAPONS.seeker.damage;
    }
    shot.used = true;
    this.damage(v, e, dmg, shot.k, m.s | 0, p);
  }

  onBurn(e, m) {
    if (!e.alive || !(e.flags & F.BREATH)) return;
    const v = this.ents.get(m.v | 0);
    if (!v || v === e || !v.alive || !this.hostile(e, v)) return;
    if (vdist(v.fs.p, e.fs.p) > WEAPONS.breath.range + 45) return;
    const last = e.burnAt.get(v.id) || 0;
    const dt = Math.min(0.25, (this.ms - last) / 1000);
    if (dt < 0.08) return;
    e.burnAt.set(v.id, this.ms);
    this.damage(v, e, BREEDS[e.breed].breathDps * dt, 'br', 0, null);
  }

  onLock(e, m) {
    const v = this.ents.get(m.v | 0);
    if (v && v !== e && !v.isBot && this.hostile(e, v)) this.send(v, { t: 'lock', a: e.id, on: !!m.on });
  }

  onEvade(e, m) {
    const a = this.ents.get(m.a | 0);
    const shot = a && a.shots.get(m.s | 0);
    if (!shot || shot.k !== 'sk' || shot.v !== e.id || !(e.flags & F.DODGE || this.ms - (e.lastDodge || 0) < 800)) return;
    shot.evaded = true;
    this.broadcast({ t: 'evade', a: a.id, s: m.s | 0, v: e.id });
  }

  onCrash(e, m) {
    if (!e.alive) return;
    this.kill(e, null, m.why === 'bounds' ? 'bounds' : 'crash');
  }

  // drink from a shrine: the room checks the dragon is really there and the shrine is charged
  takeShrine(e, i, slack) {
    const p = this.world.shrines[i];
    if (!p || !e.alive || this.phase !== 'battle' || this.shrines[i] > this.ms) return false;
    const max = BREEDS[e.breed].hp;
    if (e.hp >= max || vdist(p, e.fs.p) > SHRINE.radius + slack) return false;
    e.hp = Math.min(max, e.hp + SHRINE.heal);
    this.shrines[i] = this.ms + SHRINE.recharge * 1000;
    this.broadcast({ t: 'shrine', i, by: e.id, hp: Math.ceil(e.hp), readyIn: SHRINE.recharge * 1000 });
    return true;
  }

  vec(a) {
    return Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? [a[0], a[1], a[2]] : null;
  }

  // --- damage and kills ----------------------------------------------------------------------------
  damage(v, a, amount, kind, shot, p) {
    if (!v.alive || this.phase !== 'battle') return;
    if (a && a !== v && !this.hostile(a, v)) return; // no friendly fire
    if (v.shieldUntil > this.ms || (this.dev.god && !v.isBot)) amount = 0;
    if (amount > 0) {
      if (v.st.corrode > this.ms) amount *= STATUS.corrode;
      if (v.st.armor > this.ms) amount *= STATUS.armor;
      if (a && a.st.amp > this.ms) amount *= STREAK.lord.damage;
    }
    amount = Math.min(amount, v.hp > 0 ? v.hp + 0.01 : amount);
    v.hp -= amount;
    if (a && a !== v) {
      const log = v.dmgLog.get(a.id) || { amt: 0, at: 0 };
      log.amt += amount;
      log.at = this.ms;
      v.dmgLog.set(a.id, log);
      a.dmgDealt += amount;
      if (kind !== 'fb' && kind !== 'br' && kind !== 'sk') a.abilDmg += amount;
    }
    this.broadcast({ t: 'dmg', v: v.id, a: a ? a.id : 0, n: Math.round(amount * 10) / 10, hp: Math.max(0, Math.ceil(v.hp)), k: kind, s: shot, p });
    if (v.hp <= 0) this.kill(v, a, kind);
  }

  kill(v, a, kind) {
    if (!v.alive) return;
    v.alive = false;
    v.hp = 0;
    v.deaths++;
    v.drought++;
    const endedStreak = v.streak;
    v.streak = 0;
    v.trailUntil = 0;
    v.deadUntil = this.ms + MATCH.respawnTime * 1000;
    // a crash shortly after being hit counts for whoever hit you last
    if (!a) {
      let best = null;
      for (const [id, log] of v.dmgLog) if (this.ms - log.at < CREDIT_WINDOW && (!best || log.at > best.at)) best = { id, at: log.at };
      if (best) a = this.ents.get(best.id) || null;
    }
    let assist = 0;
    for (const [id, log] of v.dmgLog) {
      if (a && id === a.id) continue;
      const x = this.ents.get(id);
      if (x && this.ms - log.at < ASSIST_WINDOW && log.amt >= BREEDS[v.breed].hp * 0.3) {
        x.score += SCORE.assist;
        x.assists++;
        this.cutCooldown(x, STREAK.assistCooldownCut);
        assist = id;
        break;
      }
    }
    const medals = [];
    const bounty = v.bounty;
    v.bounty = 0;
    let reward = '';
    if (a && a !== v) {
      a.kills++;
      a.streak++;
      a.drought = 0;
      a.bestStreak = Math.max(a.bestStreak, a.streak);
      a.score += SCORE.kill;
      if (this.tdm && a.team >= 0) this.teamKills[a.team]++;
      if (!this.firstBlood) {
        this.firstBlood = true;
        a.score += SCORE.firstBlood;
        medals.push('firstblood');
      }
      if (a.lastKiller === v.id) {
        a.lastKiller = 0;
        a.score += SCORE.revenge;
        medals.push('revenge');
      }
      v.lastKiller = a.id;
      if (bounty) {
        a.score += bounty;
        medals.push('bounty');
      }
      if (endedStreak >= STREAK.blaze.at) medals.push('shutdown');
      if (a.hp < BREEDS[a.breed].hp * 0.2) medals.push('closecall');
      if ((kind === 'fb' || kind === 'sk') && vdist(a.fs.p, v.fs.p) > 650) medals.push('sniper');
      for (const m of medals) a.medals[m] = (a.medals[m] || 0) + 1;
      this.cutCooldown(a, STREAK.killCooldownCut);
      reward = this.streakReward(a);
    }
    this.broadcast({
      t: 'kill', v: v.id, a: a && a !== v ? a.id : 0, k: kind, assist, streak: a ? a.streak : 0,
      med: medals, bounty, rw: reward, ts: this.tdm ? this.teamKills : null,
      vs: { kills: v.kills, deaths: v.deaths, score: v.score },
      as: a ? { kills: a.kills, deaths: a.deaths, score: a.score } : null,
      xs: assist ? { id: assist, score: this.ents.get(assist).score } : null,
      p: v.fs.p, vel: v.fs.vel,
    });
    this.updateBounties();
    if (this.phase !== 'battle') return;
    if (this.tdm ? this.teamKills.some((k) => k >= MATCH.tdmKillLimit) : a && a.kills >= MATCH.killLimit) this.endMatch();
  }

  // Kill streak rewards: 3 = Blazing fireballs, 5 = Surge (heal + ability ready), 7 = Dragonlord (+20% damage).
  streakReward(a) {
    const n = a.streak;
    if (n === STREAK.blaze.at) {
      this.grant(a, 'blaze', STREAK.blaze.duration);
      return 'blaze';
    }
    if (n === STREAK.surge.at) {
      const max = BREEDS[a.breed].hp;
      a.hp = Math.min(max, a.hp + max * STREAK.surge.heal);
      a.abilReady = this.ms;
      this.send(a, { t: 'abilcd', cd: 0 });
      this.grant(a, 'blaze', STREAK.blaze.duration);
      this.broadcast({ t: 'heal', id: a.id, hp: Math.ceil(a.hp) });
      return 'surge';
    }
    if (n === STREAK.lord.at) {
      this.grant(a, 'amp', STREAK.lord.duration);
      this.grant(a, 'blaze', STREAK.lord.duration);
      return 'lord';
    }
    return '';
  }

  // Bounties: dragons on a 4+ streak, and in FFA a runaway leader, are worth extra to whoever downs them.
  updateBounties() {
    let lead = null, second = 0;
    if (!this.tdm) {
      for (const e of this.ents.values()) {
        if (!lead || e.kills > lead.kills) { if (lead) second = Math.max(second, lead.kills); lead = e; } else second = Math.max(second, e.kills);
      }
    }
    const B = STREAK.bounty, L = STREAK.leaderBounty;
    for (const e of this.ents.values()) {
      let amt = 0;
      if (e.alive && e.streak >= STREAK.bountyAt) amt = Math.min(B.max, B.base + (e.streak - STREAK.bountyAt + 1) * B.perKill);
      if (e.alive && e === lead && e.kills >= L.minKills && e.kills - second >= L.lead) amt = Math.max(amt, L.amount);
      if (amt !== e.bounty) {
        e.bounty = amt;
        this.broadcast({ t: 'bounty', id: e.id, amt });
      }
    }
  }

  // --- match flow ----------------------------------------------------------------------------------
  matchInfo() {
    return {
      phase: this.phase, endsIn: Math.max(0, this.phaseEnds - this.ms), killLimit: this.killLimit, no: this.matchNo, board: this.lastBoard,
      mode: this.mode, teams: this.tdm ? this.teamKills : null, result: this.phase === 'results' ? this.result : null,
    };
  }

  board() {
    const rows = [...this.ents.values()]
      .map((e) => ({
        id: e.id, name: e.name, breed: e.breed, bot: e.isBot, team: e.team, kills: e.kills, deaths: e.deaths, score: e.score,
        assists: e.assists, dmg: Math.round(e.dmgDealt), best: e.bestStreak, medals: { ...e.medals }, awards: [], abil: Math.round(e.abilDmg),
      }))
      .sort((x, y) => y.score - x.score || y.kills - x.kills || x.deaths - y.deaths);
    const award = (key, min, title) => {
      let best = null;
      for (const r of rows) if (r[key] >= min && (!best || r[key] > best[key])) best = r;
      if (best) best.awards.push(title);
    };
    award('kills', 3, 'Top Ace');
    award('dmg', 150, 'Heavy Hitter');
    award('assists', 2, 'Wingman');
    award('best', 3, 'Streak Master');
    award('abil', 60, 'Spellfire');
    return rows;
  }

  endMatch() {
    this.phase = 'results';
    this.phaseEnds = this.ms + MATCH.resultsTime * 1000;
    this.lastBoard = this.board();
    this.result = null;
    if (this.tdm) {
      const [g, c] = this.teamKills;
      this.result = { winner: g === c ? -1 : g > c ? 0 : 1, teams: [g, c] };
    }
    this.shots.length = 0;
    this.zones.length = 0;
    this.casts.length = 0;
    this.broadcast({ t: 'match', ...this.matchInfo() });
  }

  startMatch() {
    this.phase = 'battle';
    this.phaseEnds = this.ms + MATCH.duration * 1000;
    this.matchNo++;
    // public skies alternate FFA and Team Deathmatch
    if (this.playlist) this.mode = this.matchNo % 2 === 0 ? 'tdm' : 'ffa';
    this.teamKills = [0, 0];
    this.teamAxis = this.rand() * Math.PI * 2;
    this.firstBlood = false;
    this.result = null;
    this.reassignTeams();
    this.balanceBots();
    for (const e of this.ents.values()) {
      e.kills = 0; e.deaths = 0; e.score = 0; e.streak = 0; e.assists = 0; e.dmgDealt = 0; e.abilDmg = 0; e.bestStreak = 0;
      e.medals = {}; e.drought = 0; e.lastKiller = 0; e.bounty = 0; e.abilReady = 0;
      this.spawn(e, true);
    }
    this.shrines = this.shrines.map(() => 0);
    this.broadcast({ t: 'match', ...this.matchInfo(), ents: [...this.ents.values()].map((x) => this.publicEnt(x)), shrines: this.shrines });
  }

  // --- simulation ----------------------------------------------------------------------------------
  // Advance by wall-clock time; call often (the platform calls it from a setInterval).
  update() {
    const ms = Date.now() - this.t0;
    let dtMs = Math.min(250, ms - this.ms);
    if (dtMs <= 0) return;
    this.ms = ms;
    this.botAcc += dtMs;
    this.snapAcc += dtMs;
    const step = 1000 / TICK_HZ;
    while (this.botAcc >= step) {
      this.botAcc -= step;
      this.tick(step / 1000);
    }
    if (this.snapAcc >= 1000 / SNAPSHOT_HZ) {
      this.snapAcc %= 1000 / SNAPSHOT_HZ;
      this.snapshot();
    }
  }

  tick(dt) {
    if (this.ms > this.phaseEnds) {
      if (this.phase === 'battle') this.endMatch();
      else this.startMatch();
    }
    for (const e of this.ents.values()) {
      if (!e.alive) {
        if (this.ms >= e.deadUntil && this.phase === 'battle') this.spawn(e, true);
        continue;
      }
      if (e.isBot) this.tickBot(e, dt);
      // humans who stop sending (tab hidden etc.) are frozen in place; kick truly dead connections elsewhere
      let f = e.flags & ~(F.DEAD | F.SHIELD);
      if (e.shieldUntil > this.ms) f |= F.SHIELD;
      e.flags = f;
    }
    this.tickShots(dt);
    this.tickSeekers(dt);
    this.tickAbilities(dt);
  }

  // Seekers chasing bots, flown with the same guidance as the client. A bot that has seen one coming
  // barrel-rolls when it closes in, which breaks the lock just like a player's roll.
  tickSeekers(dt) {
    for (let i = this.seekers.length - 1; i >= 0; i--) {
      const m = this.seekers[i];
      const { v, shot } = m;
      if (shot.used || shot.evaded || !v.alive || !m.a.alive || (this.ms - shot.at) / 1000 > WEAPONS.seeker.life) {
        this.seekers.splice(i, 1);
        continue;
      }
      const dist = homeSeeker(m.p, m.vel, v.fs.p, v.fs.vel, dt, WEAPONS.seeker.turn);
      m.p[0] += m.vel[0] * dt; m.p[1] += m.vel[1] * dt; m.p[2] += m.vel[2] * dt;
      if (this.world.solidAt(m.p)) { // it hit the ground or the castle: nothing left to dodge
        this.seekers.splice(i, 1);
        continue;
      }
      // roll once the seeker is this many seconds out (a little early or late, by luck)
      const eta = dist / Math.hypot(m.vel[0], m.vel[1], m.vel[2]);
      if (m.sees && eta < m.rollAt && v.fs.dodge <= 0) v.brain.rollFor = { dir: this.rand() < 0.5 ? -1 : 1, shot: m };
    }
  }

  // napalm trails drop puffs behind their owner; zones and lingering burn/poison tick four times a second
  tickAbilities(dt) {
    if (this.phase !== 'battle') return;
    resolveCasts(this);
    for (const e of this.ents.values()) {
      if (e.trailUntil <= this.ms) continue;
      if (!e.alive) { e.trailUntil = 0; continue; }
      e.trailAcc += dt;
      if (e.trailAcc < ABILITIES.ember.drop) continue;
      e.trailAcc = 0;
      const f = forwardOf(e.fs.q);
      const A = ABILITIES.ember;
      this.addZone('nap', e, [e.fs.p[0] - f[0] * 10, e.fs.p[1] - f[1] * 10, e.fs.p[2] - f[2] * 10], A.radius, A.life, A.dps);
    }
    this.zoneAcc += dt;
    if (this.zoneAcc >= ZONE_TICK) {
      tickZones(this, this.zoneAcc);
      this.zoneAcc = 0;
    }
  }

  tickBot(e, dt) {
    if (this.dev.skill !== null) e.brain.skill = this.dev.skill;
    else if (e.brain.baseSkill !== undefined) e.brain.skill = e.brain.baseSkill;
    let { input, fire, breath, ability } = thinkBot(e, this, dt);
    if (this.dev.holdFire) fire = breath = ability = false;
    if (this.phase !== 'battle') {
      input.throttle = 0.5;
    }
    const breed = BREEDS[e.breed];
    const roll = e.brain.rollFor;
    if (roll) input.dodge = roll.dir;
    stepFlight(e.fs, input, dt, e.st.chill > this.ms ? chilled(e.breed, breed) : breed);
    if (roll) {
      e.brain.rollFor = null;
      const sh = roll.shot.shot;
      // the roll started (stamina and cooldown allowing) with the seeker inside break range: it misses
      if (e.fs.dodge > 0 && !sh.used && vdist(roll.shot.p, e.fs.p) < WEAPONS.dodge.breakRange) {
        sh.evaded = true;
        this.broadcast({ t: 'evade', a: roll.shot.a.id, s: roll.shot.s, v: e.id });
      }
    }
    if (ability) castAbility(this, e);
    let f = 0;
    if (breath && this.phase === 'battle') f |= F.BREATH;
    if (e.fs.boosting) f |= F.BOOST;
    if (e.fs.dodge > 0) {
      f |= F.DODGE;
      e.lastDodge = this.ms;
    }
    e.flags = f;
    if (this.world.solidAt(e.fs.p, 2)) {
      this.kill(e, null, 'crash');
      return;
    }
    if (Math.hypot(e.fs.p[0], e.fs.p[2]) > WORLD.radius + 600) {
      this.kill(e, null, 'bounds');
      return;
    }
    if (this.phase !== 'battle') return;
    if (fire) this.botFire(e);
    if (breath) this.botBreath(e, dt);
    for (let i = 0; i < this.world.shrines.length; i++) {
      if (vdist(this.world.shrines[i], e.fs.p) < SHRINE.radius + 4) this.takeShrine(e, i, 4);
    }
  }

  botFire(e) {
    const breed = BREEDS[e.breed];
    const d = forwardOf(e.fs.q);
    const m = 9 * DRAGON_SCALE, up = 0.6 * DRAGON_SCALE; // the mouth, so a bot's fireball leaves its jaws on screen
    const o = [e.fs.p[0] + d[0] * m, e.fs.p[1] + d[1] * m + up, e.fs.p[2] + d[2] * m];
    const sp = breed.fbSpeed + e.fs.speed;
    e.shotSeq = ((e.shotSeq || 0) + 1) & 0xffff;
    const s = e.shotSeq;
    this.shots.push({ a: e.id, s, p: o, d, sp, life: WEAPONS.fireball.life, dmg: breed.fbDamage });
    e.shieldUntil = Math.min(e.shieldUntil, this.ms);
    this.broadcast({ t: 'fire', a: e.id, k: 'fb', s, o, d, sp });
  }

  botBreath(e, dt) {
    const d = forwardOf(e.fs.q);
    for (const v of this.ents.values()) {
      if (v === e || !v.alive || !this.hostile(e, v)) continue;
      const dx = v.fs.p[0] - e.fs.p[0], dy = v.fs.p[1] - e.fs.p[1], dz = v.fs.p[2] - e.fs.p[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > WEAPONS.breath.range + 6 * DRAGON_SCALE) continue; // from the bigger jaws to the bigger body
      const cos = (dx * d[0] + dy * d[1] + dz * d[2]) / (dist || 1);
      if (cos < Math.cos(WEAPONS.breath.cone + 0.12)) continue;
      e.burnAcc = (e.burnAcc || 0) + dt;
      if (e.burnAcc >= WEAPONS.breath.tick) {
        this.damage(v, e, BREEDS[e.breed].breathDps * e.burnAcc, 'br', 0, null);
        e.burnAcc = 0;
      }
    }
  }

  tickShots(dt) {
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const sh = this.shots[i];
      a[0] = sh.p[0]; a[1] = sh.p[1]; a[2] = sh.p[2];
      b[0] = a[0] + sh.d[0] * sh.sp * dt; b[1] = a[1] + sh.d[1] * sh.sp * dt; b[2] = a[2] + sh.d[2] * sh.sp * dt;
      sh.life -= dt;
      let done = sh.life <= 0;
      if (!done) {
        const shooter = this.ents.get(sh.a);
        for (const v of this.ents.values()) {
          if (v.id === sh.a || !v.alive || (shooter && !this.hostile(shooter, v))) continue;
          const t = sweepDragon(a, b, v.fs.p, v.fs.q, WEAPONS.fireball.radius);
          if (t >= 0) {
            const hitP = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
            this.damage(v, this.ents.get(sh.a) || null, sh.dmg, 'fb', sh.s, hitP);
            // that kill may have ended the match, which empties this.shots under the loop
            if (this.phase !== 'battle') return;
            done = true;
            break;
          }
        }
      }
      if (!done && this.world.solidAt(b)) done = true;
      if (done) this.shots.splice(i, 1);
      else sh.p = [b[0], b[1], b[2]];
    }
  }

  snapshot() {
    if (!this.humans) return;
    const list = [];
    for (const e of this.ents.values()) {
      if (!e.alive) e.flags |= F.DEAD;
      list.push(e);
    }
    const buf = encodeSnapshot(this.ms, list);
    for (const e of this.ents.values()) if (e.conn) e.conn.send(buf);
  }

  // --- output --------------------------------------------------------------------------------------
  send(e, msg) {
    if (e.conn) e.conn.send(JSON.stringify(msg));
  }

  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const e of this.ents.values()) if (e.conn && e !== except) e.conn.send(text);
  }
}
