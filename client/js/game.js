// One battle from the player's seat: flies the local dragon, renders everyone else from snapshots, runs
// weapons and effects, and turns room events into HUD feedback.
import * as THREE from 'three';
import { ABILITIES, BREEDS, CLIENT_SEND_HZ, DRAGON_SCALE, F, HITBOX, INTERP_DELAY, MATCH, MODES, OUT_OF_BOUNDS_TIME, SHRINE, STREAK, TEAMS, WEAPONS, WORLD } from '../../shared/constants.js';
import { chilled } from '../../shared/abilities.js';
import { createFlightState, forwardOf, stepFlight, steerToward } from '../../shared/flight.js';
import { homeSeeker, sweepDragon } from '../../shared/combat.js';
import { encodeState } from '../../shared/protocol.js';
import { DragonView, BREED_LOOK } from './render/dragon.js';
import { breedColor, esc } from './hud.js';
import { Feel } from './feel.js';
import { LensDirector, lensPref } from './render/lens.js';
import { ThreatDetector } from './threats.js';

const STREAKS = { 2: 'Double Kill', 3: 'Triple Kill', 4: 'Rampage', 5: 'ACE', 7: 'Sky Tyrant', 10: 'Dragonlord' };
const KILL_VERB = { fb: 'fireballed', br: 'roasted', sk: 'seeker', nova: 'froze', chain: 'zapped', nap: 'torched', acid: 'dissolved', crash: 'crashed', bounds: 'fled the battle' };
const MEDAL_NAMES = { firstblood: 'First Blood', revenge: 'Revenge', closecall: 'Close Call', sniper: 'Sniper', bounty: 'Bounty Hunter', shutdown: 'Shutdown' };
const REWARDS = {
  blaze: ['BLAZING', `Fireballs fly faster and run cooler for ${STREAK.blaze.duration} s`],
  surge: ['SURGE', 'Healed, and your ability is ready'],
  lord: ['DRAGONLORD', `+20% damage for ${STREAK.lord.duration} s`],
};
const DOT_KINDS = new Set(['br', 'nap', 'acid']); // damage over time: light hurt feedback
const ZERO = new THREE.Vector3();
const FROST_PAL = [[0.85, 0.97, 1.0], [0.35, 0.75, 1.0], [0.1, 0.3, 0.8]];

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const arr = (v) => [v.x, v.y, v.z];
const LOS_Q = [0, 0, 0], LOS_O = { x: 0, y: 0, z: 0 }; // lensBlocked scratch

export class Game {
  constructor({ world3d, world, audio, input, hud, conn, welcome, onLeave }) {
    this.w3 = world3d;
    this.world = world;
    this.w3.fx.setFloor((x, z) => world.floorAt(x, z));
    this.audio = audio;
    this.input = input;
    this.hud = hud;
    this.conn = conn;
    this.onLeave = onLeave;
    this.ents = new Map();
    this.meId = welcome.you;
    this.code = welcome.code;
    this.isPublic = welcome.isPublic;
    this.match = welcome.match;
    this.matchEndsAt = performance.now() + welcome.match.endsIn;
    this.projectiles = [];
    this.shotSeq = 0;
    this.sendAcc = 0;
    this.seq = 0;
    this.time = 0;
    this.lockedBy = new Set();
    this.lock = { ent: null, t: 0, locked: false, sent: 0 };
    this.lensDir = new LensDirector(); // which far dragons get a magnifier lens (render/lens.js)
    this.threats = new ThreatDetector(); // hostiles lining up a shot at you (threats.js)
    this.heat = 0;
    this.overheated = false;
    this.fireCd = 0;
    this.seekerCd = 0;
    this.burnAcc = 0;
    this.outTime = 0;
    this.shake = 0;
    this.hurtFlash = 0;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.feel = new Feel(this); // chase / death / respawn camera, hit-stop, slow motion, rumble (client/js/feel.js)
    this.freeLook = new THREE.Vector2();
    this.firingVis = 0;
    this.deadTimer = 0;
    this.killer = null;
    this.paused = false;
    this.warnBeep = 0;
    this.mode = welcome.match.mode || 'ffa';
    this.teamKills = welcome.match.teams || [0, 0];
    this.abilCd = welcome.cd || 0; // seconds until the breed ability is ready
    this.abilAsk = 0;
    this.zones = []; // napalm / acid clouds (visual copies of the room's)
    this.rings = []; // expanding nova rings
    this.bolts = []; // chain lightning arcs
    this.charges = []; // wind-up telegraphs (nova rings closing in, lightning charging)
    this.spits = []; // acid globs in flight with their landing markers
    this.abilWarn = null;
    for (const e of welcome.ents) this.addEnt(e);
    for (const z of welcome.zones || []) this.addZone(z);
    (welcome.shrines || []).forEach((ms, i) => this.w3.shrines.setReady(i, ms));
    this.shrineAsk = 0;
    this.me = this.ents.get(this.meId);
    this.spawnMe(welcome.spawn.p, welcome.spawn.q);
    this.hud.show(true);
    document.getElementById('room-tag').textContent = this.isPublic ? 'Public sky' : `Private sky · code ${this.code}`;
    document.getElementById('pause-code').textContent = this.isPublic ? '' : `Friends can join with code ${this.code}`;
    if (!this.isPublic && !this.conn.local) this.hud.message(`Private sky <b>${this.code}</b>: share the code with friends`, 6);
    else this.hud.message(this.input.isTouch ? 'Drag to point at a dragon, then hold <b>Fire</b>' : 'Hold the mouse on a dragon to line up, then fire!', 4);
  }

  // ---------------------------------------------------------------- entities
  addEnt(info) {
    let e = this.ents.get(info.id);
    if (!e) {
      e = {
        id: info.id, buf: [], view: new DragonView(info.breed, undefined, DRAGON_SCALE), pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
        vel: new THREE.Vector3(), speed: 0, throttle: 0.6, flags: 0, prevQ: new THREE.Quaternion(), yawRate: 0, pitchRate: 0,
        hurt: 0, corpse: null, glow: 0, st: {}, team: -1, bounty: 0,
      };
      e.view.root.visible = false;
      this.w3.scene.add(e.view.root);
      this.ents.set(info.id, e);
    }
    Object.assign(e, { name: info.name, breed: info.breed, bot: info.bot, kills: info.kills, deaths: info.deaths, score: info.score, hp: info.hp, alive: info.alive, team: info.team ?? -1, bounty: info.bounty || 0 });
    e.view.setBreed(info.breed);
    if (e.id !== this.meId) {
      e.view.onFlap = (amp) => this.audio.flap(amp * 0.8, e.pos);
    }
    return e;
  }

  removeEnt(id) {
    const e = this.ents.get(id);
    if (!e) return;
    this.w3.scene.remove(e.view.root);
    e.view.dispose();
    this.ents.delete(id);
  }

  // ---------------------------------------------------------------- teams and statuses
  get tdm() {
    return this.mode === 'tdm';
  }

  isAlly(e) {
    return this.tdm && e !== this.me && e.team === this.me.team;
  }

  // bracket / radar / killfeed colour: the flight in Team Deathmatch, the breed otherwise
  colorOf(e) {
    return this.tdm && TEAMS[e.team] ? TEAMS[e.team].color : breedColor(e.breed);
  }

  has(e, k) {
    return (e.st[k] || 0) > this.time;
  }

  // flight numbers for the local dragon (a chilled dragon is slower and turns wide)
  flightBreed(breed) {
    return this.has(this.me, 'chill') ? chilled(this.me.breed, breed) : breed;
  }

  spawnMe(p, q) {
    const fs = createFlightState(p, q);
    const f = forwardOf(q);
    fs.vel = [f[0] * 75, f[1] * 75, f[2] * 75];
    this.fs = fs;
    this.me.alive = true;
    this.me.hp = BREEDS[this.me.breed].hp;
    this.me.corpse = null;
    this.me.view.root.visible = true;
    this.me.view.setBreed(this.me.breed);
    this.aimYaw = Math.atan2(-f[0], -f[2]);
    this.aimPitch = Math.asin(Math.max(-1, Math.min(1, f[1])));
    this.heat = 0;
    this.overheated = false;
    this.outTime = 0;
    this.lockedBy.clear();
    this.lock = { ent: null, t: 0, locked: false, sent: 0 };
    this.me.pos.set(...p);
    this.camPos.set(p[0] - f[0] * 30, p[1] + 8, p[2] - f[2] * 30);
    this.me.view.onFlap = (amp) => this.audio.flap(amp);
    this.feel.spawn();
    document.getElementById('respawn').classList.add('hidden');
    document.getElementById('breed-tag').textContent = `${this.me.name} · ${BREEDS[this.me.breed].name}`;
    document.getElementById('breed-tag').style.color = breedColor(this.me.breed);
  }

  aimDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.aimPitch);
    return out.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
  }

  // ---------------------------------------------------------------- network events
  onSnapshot(snap) {
    for (const s of snap.ents) {
      const e = this.ents.get(s.id);
      if (!e) continue;
      if (s.id === this.meId) {
        e.hp = s.hp;
        e.flags = s.flags;
        continue;
      }
      e.buf.push({ t: snap.ms, p: s.p, q: s.q, speed: s.speed, throttle: s.throttle, flags: s.flags });
      if (e.buf.length > 30) e.buf.shift();
      e.hp = s.hp;
      if (!(s.flags & F.DEAD) && !e.alive && !e.corpse) e.alive = true;
    }
  }

  onMessage(m) {
    switch (m.t) {
      case 'join': {
        this.addEnt(m.e);
        if (!m.e.bot) this.hud.killFeed(`<b>${esc(m.e.name)}</b> <span class="how">took flight</span>`);
        break;
      }
      case 'leave': {
        const e = this.ents.get(m.id);
        if (e && !e.bot) this.hud.killFeed(`<b>${esc(e.name)}</b> <span class="how">left the sky</span>`);
        this.removeEnt(m.id);
        break;
      }
      case 'fire': return this.onRemoteFire(m);
      case 'dmg': return this.onDamage(m);
      case 'kill': return this.onKill(m);
      case 'spawn': {
        const e = this.ents.get(m.id);
        if (!e) return;
        e.breed = m.breed;
        e.view.setBreed(m.breed);
        e.hp = m.hp;
        e.alive = true;
        e.corpse = null;
        e.buf.length = 0;
        e.st = {};
        if (m.id === this.meId) {
          if (m.bonus === 'wind') this.hud.banner('SECOND WIND', 2.4), this.hud.message('Protected for a few seconds, with hot fireballs and your ability ready', 3.5);
          this.spawnMe(m.p, m.q);
        }
        else {
          e.pos.set(...m.p);
          e.quat.set(...m.q);
          e.view.root.visible = true;
        }
        break;
      }
      case 'lock': {
        if (m.on) {
          if (!this.lockedBy.has(m.a)) this.audio.warning('lock');
          this.lockedBy.add(m.a);
        } else this.lockedBy.delete(m.a);
        break;
      }
      case 'evade': {
        const pr = this.projectiles.find((p) => p.a === m.a && p.s === m.s);
        if (pr) pr.evaded = true;
        if (m.v === this.meId) this.hud.banner('Evaded!', 1.2);
        else if (m.a === this.meId) {
          const v = this.ents.get(m.v);
          this.hud.message(`${v ? esc(v.name) : 'They'} rolled out of your seeker`, 1.6);
        }
        break;
      }
      case 'match': {
        this.match = m;
        this.mode = m.mode || 'ffa';
        this.teamKills = m.teams || [0, 0];
        this.matchEndsAt = performance.now() + m.endsIn;
        if (m.phase === 'results') {
          this.audio.roar(null, 0.8);
          this.zones.length = 0;
        } else {
          this.hud.results(false);
          if (m.ents) for (const e of m.ents) this.addEnt(e);
          this.zones.length = 0;
          this.charges.length = 0;
          this.spits.length = 0;
          for (const e of this.ents.values()) { e.st = {}; e.bounty = 0; }
          const me = this.me;
          this.hud.banner(this.tdm ? `Team Deathmatch: you fly for ${TEAMS[me.team] ? TEAMS[me.team].name : '?'}` : 'New Battle', 2.6);
          if (m.shrines) m.shrines.forEach((t, i) => this.w3.shrines.setReady(i, 0));
        }
        break;
      }
      case 'abil': return this.onAbility(m);
      case 'abilno': {
        this.abilAsk = 0;
        this.hud.message(m.k === 'chain' ? 'Chain Lightning: no foe in front of you' : 'Nothing to hit', 1.4);
        break;
      }
      case 'abilcd':
        this.abilCd = m.cd;
        break;
      case 'abilwarn': {
        // we are the target of a charging Chain Lightning
        this.warn(`LIGHTNING LOCKED ON · ${this.input.isTouch ? 'TAP ROLL' : 'BARREL ROLL (Q/E)'}`, m.w + 0.25);
        this.audio.warning('bolt');
        break;
      }
      case 'zone':
        this.addZone(m);
        break;
      case 'st': {
        const e = this.ents.get(m.id);
        if (!e) break;
        e.st[m.k] = this.time + m.d;
        if (m.id === this.meId) this.onMyStatus(m.k, m.d);
        break;
      }
      case 'bounty': {
        const e = this.ents.get(m.id);
        if (!e) break;
        e.bounty = m.amt;
        if (m.amt && m.id !== this.meId) this.hud.killFeed(`<span class="how">Bounty</span> <b style="color:${this.colorOf(e)}">${esc(e.name)}</b> <span class="how">is worth ${m.amt} points</span>`);
        else if (m.amt) this.hud.message(`You carry a <b>${m.amt}</b> point bounty! Stay alive`, 3);
        break;
      }
      case 'heal': {
        const e = this.ents.get(m.id);
        if (e) {
          e.hp = m.hp;
          this.w3.fx.heal(e.id === this.meId ? this.me.pos : e.pos, e.vel);
        }
        break;
      }
      case 'shrine': {
        this.w3.shrines.setReady(m.i, m.readyIn);
        const e = this.ents.get(m.by);
        if (e) {
          e.hp = m.hp;
          this.w3.fx.heal(e.id === this.meId ? this.me.pos : e.pos, e.vel);
        }
        if (m.by === this.meId) {
          this.hud.banner(`+${SHRINE.heal} Ember Shrine`, 1.6);
          this.audio.heal();
        }
        break;
      }
      case 'breedq':
        this.hud.message(`You'll fly as a <b>${BREEDS[m.breed].name}</b> after your next respawn`, 3);
        break;
    }
  }

  onRemoteFire(m) {
    const e = this.ents.get(m.a);
    if (!e || m.a === this.meId) return;
    const pal = BREED_LOOK[e.breed].fire;
    const o = new THREE.Vector3(...m.o);
    const d = new THREE.Vector3(...m.d).normalize();
    this.projectiles.push({
      a: m.a, s: m.s, k: m.k, own: false, p: o, v: d.multiplyScalar(m.sp), life: m.k === 'sk' ? WEAPONS.seeker.life : WEAPONS.fireball.life,
      target: m.v || 0, pal, evaded: false, warned: false,
    });
    e.firing = 0.25;
    if (m.k === 'sk') this.audio.seeker(o);
    else this.audio.fireball(o);
  }

  // ---------------------------------------------------------------- abilities
  addZone(z) {
    if (this.zones.some((q) => q.id === z.id)) return;
    const owner = this.ents.get(z.o);
    this.zones.push({ id: z.id, k: z.k, p: new THREE.Vector3(...z.p), r: z.r, life: z.life, max: z.life, pal: BREED_LOOK[owner ? owner.breed : z.k === 'nap' ? 'ember' : 'venom'].fire });
  }

  // The room says a breed ability started ("charge": a telegraphed wind-up) or landed ("fire"/"miss").
  // fx.abilityCast(kind, phase, at, msg, pal, breed) is an optional hook for richer visuals.
  onAbility(m) {
    const e = this.ents.get(m.a);
    if (!e) return;
    const fx = this.w3.fx;
    const pal = BREED_LOOK[e.breed].fire;
    const mine = m.a === this.meId;
    if (mine && m.cd !== undefined) {
      this.abilCd = m.cd;
      this.abilAsk = 0;
    }
    const ph = m.ph || 'fire';
    const at = new THREE.Vector3(...(m.p || (m.path && m.path[0]) || [e.pos.x, e.pos.y, e.pos.z]));
    if (fx.abilityCast) fx.abilityCast(m.k, ph, at, m, pal, e.breed, e, (id) => this.ents.get(id));
    const inside = !mine && !this.isAlly(e) && this.me.alive && this.me.pos.distanceTo(e.pos) < (m.r || 0);
    switch (m.k) {
      case 'inferno':
        fx.explosion(at, pal, 1.3, e.vel);
        this.audio.ability('inferno', 'fire', mine ? null : at);
        if (mine) this.hud.banner('INFERNO WAKE', 1.4);
        break;
      case 'nova':
        if (ph === 'charge') {
          // a ring closes in on the caster: get out of it (or be somewhere else when it releases)
          this.charges.push({ k: 'nova', ent: e, r: m.r, t: 0, dur: m.w, pal });
          this.audio.ability('nova', 'charge', mine ? null : e.pos);
          if (mine) this.hud.banner('FROST NOVA', 1.2);
          else if (inside) this.warn('FROST NOVA: FLY OUT OF THE RING', m.w + 0.3);
        } else {
          this.rings.push({ p: at, r: m.r, t: 0, dur: 0.6, pal });
          fx.explosion(at, pal, 0.9);
          this.audio.ability('nova', 'fire', mine ? null : at);
          if ((m.hits || []).includes(this.meId)) this.shake = Math.min(1.2, this.shake + 0.5);
        }
        break;
      case 'chain':
        if (ph === 'charge') {
          this.charges.push({ k: 'chain', ent: e, tgt: this.ents.get(m.tgt), t: 0, dur: m.w, pal });
          this.audio.ability('chain', 'charge', mine ? null : e.pos);
          if (mine) this.hud.banner('CHAIN LIGHTNING', 1.2);
        } else {
          const path = m.path.map((q) => new THREE.Vector3(...q));
          this.bolts.push({ path, t: 0, pal, miss: ph === 'miss' });
          if (ph === 'miss') {
            this.audio.ability('chain', 'miss', mine ? null : at);
            if (m.dodged && this.ents.get(m.tgt) === this.me) this.hud.banner('Evaded!', 1.2);
            else if (mine) this.hud.message(m.dodged ? 'Dodged: part of the cooldown is back' : 'The bolt missed', 1.6);
            fx.explosion(path[path.length - 1], pal, 0.3);
          } else {
            for (const q of path.slice(1)) fx.explosion(q, pal, 0.5);
            this.audio.ability('chain', 'fire', mine ? null : at);
            for (const q of path.slice(1)) this.audio.impact(q);
            if (mine) this.hud.banner(m.hits.length > 1 ? `CHAIN x${m.hits.length}` : 'CHAIN LIGHTNING', 1.4);
            if (m.hits.includes(this.meId)) this.shake = Math.min(1.2, this.shake + 0.6);
          }
        }
        break;
      case 'acid':
        if (ph === 'charge') {
          // a glob arcs out of the mouth to where the cloud will land; a marker shows the radius
          this.spits.push({ from: new THREE.Vector3(...m.o), to: at, r: m.r, t: 0, dur: m.w, pal });
          this.audio.ability('acid', 'charge', mine ? null : e.pos);
          if (mine) this.hud.banner('ACID CLOUD', 1.2);
          else if (this.me.alive && !this.isAlly(e) && this.me.pos.distanceTo(at) < m.r + 40) this.warn('ACID INCOMING: LEAVE THE MARKER', m.w + 0.4);
        } else {
          fx.explosion(at, pal, 0.9);
          this.audio.ability('acid', 'fire', at);
        }
        break;
    }
  }

  // a short amber ability warning in the lock-warning slot (updateHud shows it when nothing more urgent is up)
  warn(text, secs) {
    this.abilWarn = { text, t: secs };
  }

  onMyStatus(k, d) {
    const text = { chill: ['CHILLED', 'Slowed and turning wide'], corrode: ['CORRODED', 'You take more damage'], armor: ['RIME ARMOR', 'You take less damage'], blaze: ['BLAZING', 'Faster, cooler fireballs'], amp: ['DRAGONLORD', '+20% damage'] }[k];
    if (!text) return;
    if (k === 'chill' || k === 'corrode') this.hud.message(`<b>${text[0]}</b> ${text[1]} for ${Math.round(d)} s`, 1.8);
    if (k === 'chill') this.audio.chill();
  }

  // lingering clouds, nova rings and lightning arcs, drawn with the shared particle effects
  updateAbilityFx(dt) {
    const fx = this.w3.fx;
    const camPos = this.w3.camera.position;
    const rich = !!fx.abilityCast; // fx.js draws charges, spits, rings and bolts itself
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.life -= dt;
      if (z.life <= 0) { this.zones.splice(i, 1); continue; }
      if (z.p.distanceToSquared(camPos) > 2400 * 2400) continue;
      if (fx.abilityZone) { fx.abilityZone(z.k, z.p, z.r, z.pal, dt, z.life / z.max); continue; }
      if (Math.random() < Math.min(1, dt * 18)) {
        const q = v2.set((Math.random() - 0.5) * z.r * 1.4, (Math.random() - 0.3) * z.r * 0.6, (Math.random() - 0.5) * z.r * 1.4).add(z.p);
        fx.fireballTrail(q, ZERO, z.pal, dt, z.k === 'nap' ? 2 : 1.6);
        if (z.k === 'acid' && Math.random() < 0.15) fx.smokePuff(q, ZERO, 0.1, 9);
      }
    }
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      c.t += dt;
      if (c.t > c.dur || !c.ent.alive) { this.charges.splice(i, 1); continue; }
      if (rich) continue;
      const k = c.t / c.dur;
      const base = c.ent.id === this.meId ? this.me.pos : c.ent.pos;
      if (c.k === 'nova') {
        // converging ring, brighter as it closes
        const rad = c.r * (1 - 0.8 * k);
        for (let j = 0; j < 16; j++) {
          const a = (j / 16) * Math.PI * 2 + c.t * 3;
          const q = v2.set(Math.cos(a) * rad, (Math.random() - 0.5) * 4, Math.sin(a) * rad).add(base);
          fx.fireballTrail(q, ZERO, FROST_PAL, dt, 1.2 + k * 1.6);
        }
        fx.embers(base, ZERO, FROST_PAL, dt * 4);
      } else {
        // sparks gather at the caster, and crackle around the locked target
        for (let j = 0; j < 3; j++) {
          const q = v2.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14).add(base);
          fx.fireballTrail(q, ZERO, c.pal, dt, 1 + k * 1.5);
        }
        if (c.tgt && c.tgt.alive) {
          const tp = c.tgt.id === this.meId ? this.me.pos : c.tgt.pos;
          for (let j = 0; j < 2; j++) {
            const a = Math.random() * Math.PI * 2;
            const q = v3.set(Math.cos(a) * 14, (Math.random() - 0.5) * 8, Math.sin(a) * 14).add(tp);
            fx.fireballTrail(q, ZERO, c.pal, dt, 1.2);
          }
          fx.light(tp, c.pal[1], 20 + k * 30);
        }
      }
    }
    for (let i = this.spits.length - 1; i >= 0; i--) {
      const sp = this.spits[i];
      sp.t += dt;
      if (sp.t > sp.dur) { this.spits.splice(i, 1); continue; }
      if (rich) continue;
      const k = sp.t / sp.dur;
      const q = v2.copy(sp.from).lerp(sp.to, k);
      q.y += Math.sin(k * Math.PI) * 14; // lobbed
      fx.fireballTrail(q, ZERO, sp.pal, dt, 1.8);
      // landing marker on the cloud's rim
      for (let j = 0; j < 8; j++) {
        const a = (j / 8) * Math.PI * 2 + sp.t * 2;
        const m = v3.set(Math.cos(a) * sp.r * 0.9, 0, Math.sin(a) * sp.r * 0.9).add(sp.to);
        if (Math.random() < 0.5) fx.fireballTrail(m, ZERO, sp.pal, dt, 0.9);
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      if (r.t > r.dur) { this.rings.splice(i, 1); continue; }
      if (rich) continue;
      const rad = r.r * Math.min(1, r.t / r.dur * 1.2);
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2 + r.t * 2;
        const q = v2.set(Math.cos(a) * rad, (Math.random() - 0.5) * 6, Math.sin(a) * rad).add(r.p);
        fx.fireballTrail(q, ZERO, FROST_PAL, dt, 2.2);
      }
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += dt;
      if (b.t > 0.4) { this.bolts.splice(i, 1); continue; }
      if (rich) continue;
      for (let s = 1; s < b.path.length; s++) {
        const a = b.path[s - 1], c = b.path[s];
        const n = Math.max(2, Math.ceil(a.distanceTo(c) / 18));
        for (let k = 0; k <= n; k++) {
          const q = v2.copy(a).lerp(c, k / n);
          q.x += (Math.random() - 0.5) * 7; q.y += (Math.random() - 0.5) * 7; q.z += (Math.random() - 0.5) * 7;
          fx.fireballTrail(q, ZERO, b.pal, 0.02, 1.4);
        }
      }
      fx.light(b.path[b.path.length - 1], b.pal[1], 50);
    }
  }

  // glow and sparks around dragons under a status effect
  statusFx(e, dt) {
    const fx = this.w3.fx;
    if (fx.status) {
      for (const k of ['chill', 'armor', 'burn', 'poison', 'corrode', 'blaze', 'amp']) if (this.has(e, k)) fx.status(e.id, e, k, dt);
      return;
    }
    if (this.has(e, 'chill') || this.has(e, 'armor')) fx.embers(e.pos, e.vel, FROST_PAL, dt * 2.5);
    if (this.has(e, 'burn')) { fx.embers(e.pos, e.vel, BREED_LOOK.ember.fire, dt * 3); if (Math.random() < dt * 8) fx.smokePuff(e.pos, e.vel, 0.1, 5); }
    if (this.has(e, 'poison') || this.has(e, 'corrode')) fx.embers(e.pos, e.vel, BREED_LOOK.venom.fire, dt * 2.5);
    if (this.has(e, 'blaze') || this.has(e, 'amp')) fx.embers(e.pos, e.vel, BREED_LOOK[e.breed].fire, dt * 3);
  }

  useAbility() {
    if (this.abilAsk > 0) return;
    const A = ABILITIES[this.me.breed];
    if (this.abilCd > 0) {
      this.hud.message(`${A.name} recharging (${this.abilCd.toFixed(1)}s)`, 1);
      return;
    }
    this.abilAsk = 0.5; // the room answers with an "abil" event (or "abilno")
    this.conn.send({ t: 'abil' });
  }

  onDamage(m) {
    const v = this.ents.get(m.v);
    const a = this.ents.get(m.a);
    if (v && (m.k === 'nap' || m.k === 'acid')) v.st[m.k === 'nap' ? 'burn' : 'poison'] = this.time + 0.6;
    if (v) {
      v.hp = m.hp;
      v.hurt = Math.max(v.hurt || 0, DOT_KINDS.has(m.k) ? 0.2 : 1); // burns and poison ticks only blush
    }
    const p = m.p ? new THREE.Vector3(...m.p) : v ? v.pos.clone() : null;
    // remove the projectile that hit, with an explosion (our own already exploded locally)
    if (m.s && m.a !== this.meId) {
      const i = this.projectiles.findIndex((pr) => pr.a === m.a && pr.s === m.s);
      if (i >= 0) {
        const pr = this.projectiles[i];
        this.w3.fx.explosion(p || pr.p, pr.pal, pr.k === 'sk' ? 1.3 : 0.7);
        this.feel.explosion(p || pr.p, pr.k === 'sk' ? 0.5 : 0.3);
        this.audio.impact(p || pr.p, pr.k === 'sk');
        this.projectiles.splice(i, 1);
      }
    }
    if (m.v === this.meId && m.n > 0) {
      const dot = DOT_KINDS.has(m.k);
      this.hurtFlash = Math.min(0.85, this.hurtFlash + (dot ? 0.06 : 0.4));
      this.feel.hurt(m, a);
      this.audio.hurt(dot);
      if (a && !dot) {
        // direction to the attacker relative to where we look (not for burns and acid: they tick for seconds)
        const to = v1.copy(a.pos).sub(this.me.pos);
        const yawTo = Math.atan2(-to.x, -to.z);
        this.hud.damageFrom(-(yawTo - this.aimYaw), a.id);
      }
    }
    if (m.a === this.meId && v && m.n > 0) {
      if (!DOT_KINDS.has(m.k) || (this.time - (this.lastBurnMark || 0)) > 0.25) {
        this.hud.hitMarker(false);
        this.audio.hitMarker();
        this.lastBurnMark = this.time;
      }
      this.hud.damageNumber(p || v.pos, m.n, m.k === 'sk' || m.k === 'chain');
      this.feel.dealt(m);
    }
    if (v && m.n > 0) {
      // burning: breath sets the target alight for a moment; hits scatter sparks and scales
      const pal = BREED_LOOK[a ? a.breed : 'ember'].fire;
      const at = p || v.pos;
      if (m.k === 'br') this.w3.fx.hitSpark(at, pal, undefined, 'br');
      else if (m.a !== this.meId) this.w3.fx.hitSpark(at, pal, undefined, m.k);
      this.w3.fx.ignite(v.id, v.id === this.meId ? this.me : v, pal, m.k === 'br' ? 1.2 : m.k === 'sk' ? 3 : 1.8, a ? a.breed : undefined);
    }
  }

  onKill(m) {
    const v = this.ents.get(m.v);
    const a = this.ents.get(m.a);
    if (m.ts) this.teamKills = m.ts;
    if (v) {
      Object.assign(v, m.vs);
      v.alive = false;
      v.hp = 0;
      v.st = {};
      v.bounty = 0;
      // our own crash already started its wreck locally
      if (!(v.id === this.meId && v.corpse)) this.startCorpse(v, m.p, m.vel, m.k);
    }
    if (a && m.as) Object.assign(a, m.as);
    if (m.xs) {
      const x = this.ents.get(m.xs.id);
      if (x) x.score = m.xs.score;
      if (m.xs.id === this.meId) this.hud.message('Assist +50', 1.5);
    }
    const name = (e) => (e ? `<b style="color:${this.colorOf(e)}">${esc(e.name)}</b>` : '');
    const how = m.k === 'crash' || m.k === 'bounds' ? (a ? 'forced down' : KILL_VERB[m.k]) : KILL_VERB[m.k] || 'downed';
    const mine = m.a === this.meId || m.v === this.meId;
    if (a) this.hud.killFeed(`${name(a)}<span class="how">${how}</span>${name(v)}`, mine);
    else this.hud.killFeed(`${name(v)}<span class="how">${how}</span>`, mine);
    if (m.a === this.meId && m.v !== this.meId) {
      this.hud.hitMarker(true);
      const streak = STREAKS[m.streak];
      this.hud.banner(streak || `Slain ${v ? v.name : ''}`, 2.2);
      this.audio.roar(null, 1, 0.7);
      this.feel.kill();
      this.onMyKillExtras(m);
    } else if (a && a.id !== this.meId && v && v.id !== this.meId) {
      this.audio.roar(a.pos, 0.97 + Math.random() * 0.1); // the victor bellows somewhere out there
      // medals and streak rewards of other dragons show in the feed
      if ((m.med && m.med.length) || m.rw) {
        const bits = (m.med || []).map((x) => MEDAL_NAMES[x]).concat(m.rw ? [REWARDS[m.rw][0]] : []);
        this.hud.killFeed(`<span class="how">${esc(a.name)}</span> <b>${bits.join(' · ')}</b>`);
      }
    }
    if (m.v === this.meId) {
      this.feel.death();
      this.audio.death();
      this.killer = a && a !== v ? a : null;
      this.deadTimer = MATCH.respawnTime;
      this.lockedBy.clear();
      this.sendLock(null);
      const r = document.getElementById('respawn');
      r.classList.remove('hidden');
    this.hud.hideHints();
      this.hud.hideHints();
      r.innerHTML = `<h2>${this.killer ? `Slain by ${esc(this.killer.name)}` : m.k === 'bounds' ? 'Lost beyond the storm' : 'You crashed'}</h2><p id="respawn-t"></p>`;
    }
  }

  // medals, bounty and streak rewards for our own kill
  onMyKillExtras(m) {
    const lines = (m.med || []).map((x) => MEDAL_NAMES[x]);
    if (m.bounty) lines.push(`Bounty +${m.bounty}`);
    if (lines.length) this.hud.message(lines.map((l) => `<b>${l}</b>`).join(' · '), 2.6);
    if (m.rw) {
      const [title, text] = REWARDS[m.rw];
      this.hud.banner(title, 2.4);
      this.hud.message(text, 3);
      this.audio.heal();
    }
  }

  startCorpse(e, p, vel, kind) {
    const pos = p ? new THREE.Vector3(...p) : e.pos.clone();
    if (e.id === this.meId) pos.set(...this.fs.p);
    const velocity = vel ? new THREE.Vector3(...vel) : e.vel.clone();
    if (e.id === this.meId) velocity.set(...this.fs.vel);
    const quat = e.id === this.meId ? new THREE.Quaternion(...this.fs.q) : e.quat.clone();
    const pal = BREED_LOOK[e.breed].fire;
    const crashed = kind === 'crash' || kind === 'bounds';
    this.w3.fx.explosion(pos, pal, crashed ? 1.6 : 1.2, velocity);
    this.feel.explosion(pos, crashed ? 1.1 : 0.9);
    this.audio.explosion(pos, 1.2);
    e.corpse = { p: pos, v: velocity, q: quat, spin: new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 3), t: 0, landed: crashed };
    e.view.root.visible = !crashed;
    if (crashed && this.world.floorAt(pos.x, pos.z) <= 0.5 && pos.y < 30) {
      this.w3.fx.splash(new THREE.Vector3(pos.x, 0, pos.z), 1.4);
      this.audio.splash(pos);
    }
  }

  // ---------------------------------------------------------------- frame
  update(dt) {
    dt = this.feel.tick(dt); // hit-stop freezes the simulation for a few frames
    this.time += dt;
    const c = this.input.read();
    if (c.escape && this.onPause) this.onPause();
    this.hud.scoreboard(c.scoreboard && this.match.phase === 'battle', this.ents, this.meId, { mode: this.mode, teams: this.teamKills });
    if (this.match.phase === 'results') this.hud.results(true, this.match.board, this.meId, Math.max(0, (this.matchEndsAt - performance.now()) / 1000), { mode: this.mode, teams: this.teamKills, result: this.match.result });

    const me = this.me;
    const breed = BREEDS[me.breed];
    // aim
    if (!this.paused) {
      if (c.freeLook) {
        this.freeLook.x = THREE.MathUtils.clamp(this.freeLook.x - c.aimDx, -2.8, 2.8);
        this.freeLook.y = THREE.MathUtils.clamp(this.freeLook.y - c.aimDy, -1.2, 1.2);
      } else {
        this.aimYaw -= c.aimDx;
        this.aimPitch = THREE.MathUtils.clamp(this.aimPitch - c.aimDy, -1.45, 1.45);
        this.freeLook.multiplyScalar(Math.exp(-8 * dt));
      }
    }
    const aim = this.aimDir(this._aim || (this._aim = new THREE.Vector3()));

    if (me.alive) this.flyMe(dt, c, aim, breed);
    else this.updateDead(dt);

    this.updateRemotes(dt);
    this.updateProjectiles(dt);
    this.updateAbilityFx(dt);
    this.updateCamera(dt, aim);
    this.updateLock(dt, aim, c);
    this.updateHud(dt, aim);
    if (me.alive) this.sendState(dt);
  }

  flyMe(dt, c, aim, breed) {
    const fs = this.fs;
    const me = this.me;
    const input = this.flightInput || (this.flightInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6, boost: false, brake: false, dodge: 0 });
    // the results screen keeps you flying but disarmed
    steerToward(fs, [aim.x, aim.y, aim.z], input, 1.15);
    if (c.roll) input.roll = c.roll;
    // wings spool up and down instead of snapping
    const tt = c.throttleUp ? 1 : c.throttleDown ? 0.08 : 0.62;
    if (this.throttleCmd === undefined) this.throttleCmd = tt;
    this.throttleCmd += (tt - this.throttleCmd) * (1 - Math.exp(-(tt > this.throttleCmd ? 5 : 7) * dt));
    input.throttle = this.throttleCmd;
    input.brake = c.throttleDown;
    input.boost = c.boost;
    if (c.dodge && fs.dodge <= 0 && fs.dodgeCd <= 0 && fs.stamina >= WEAPONS.dodge.stamina) this.audio.dodge();
    input.dodge = c.dodge;
    stepFlight(fs, input, dt, this.flightBreed(breed));
    me.pos.set(...fs.p);
    me.quat.set(...fs.q);
    me.vel.set(...fs.vel);
    me.speed = fs.speed;
    me.yawRate = me.yawRate * 0.9 + (input.yaw + input.roll * 0.4) * 0.1;
    me.pitchRate = me.pitchRate * 0.9 + input.pitch * 0.1;

    // weapons
    const battle = this.match.phase === 'battle';
    this.fireCd -= dt;
    this.seekerCd = Math.max(0, this.seekerCd - dt);
    const breathing = battle && c.breath && !this.overheated;
    const blaze = this.has(me, 'blaze'); // kill streak reward: faster, cooler fireballs
    this.abilCd = Math.max(0, this.abilCd - dt);
    this.abilAsk = Math.max(0, this.abilAsk - dt);
    if (battle && c.ability) this.useAbility();
    if (breathing) this.heat += WEAPONS.breath.heatPerSec * dt;
    if (battle && c.fire && !this.overheated && this.fireCd <= 0 && !breathing) {
      this.fireCd = WEAPONS.fireball.cooldown * (blaze ? STREAK.blaze.fireCooldown : 1);
      this.heat += WEAPONS.fireball.heat * (blaze ? STREAK.blaze.heat : 1);
      this.fireBall(aim, breed);
    }
    if (battle && c.seeker) {
      if (this.lock.locked && this.seekerCd <= 0 && !this.overheated) {
        this.seekerCd = WEAPONS.seeker.cooldown;
        this.heat += WEAPONS.seeker.heat;
        this.fireSeeker(this.lock.ent);
      } else if (this.seekerCd > 0) this.hud.message(`Seeker recharging (${this.seekerCd.toFixed(1)}s)`, 1);
      else this.hud.message('Hold your aim on a dragon to lock on first', 1.5);
    }
    if (this.heat >= WEAPONS.heat.max) {
      this.heat = WEAPONS.heat.max;
      if (!this.overheated) this.audio.overheat();
      this.overheated = true;
    }
    this.heatIdle = c.fire || breathing ? 0 : (this.heatIdle || 0) + dt;
    if (this.heatIdle > WEAPONS.heat.delay) this.heat = Math.max(0, this.heat - WEAPONS.heat.regen * dt * (this.overheated ? 1.3 : 1));
    if (this.overheated && this.heat <= WEAPONS.heat.overheatRecover) this.overheated = false;
    this.breathing = breathing;
    if (breathing) this.doBreath(dt, breed);
    this.firingVis = Math.max(0, this.firingVis - dt);

    // fly through a charged shrine to heal
    this.shrineAsk -= dt;
    if (this.shrineAsk <= 0 && me.hp < breed.hp) {
      const sh = this.w3.shrines;
      for (let i = 0; i < sh.items.length; i++) {
        if (sh.ready(i) && sh.items[i].p.distanceTo(me.pos) < SHRINE.radius + 2) {
          this.conn.send({ t: 'shrine', i });
          this.shrineAsk = 0.4;
          break;
        }
      }
    }

    // crashes: terrain, sea and sky rocks
    if (this.world.solidAt(fs.p, 2.5)) {
      this.crash('crash');
      return;
    }
    // leaving the arena
    const r = Math.hypot(fs.p[0], fs.p[2]);
    if (r > WORLD.radius) {
      this.outTime += dt;
      if (this.outTime > OUT_OF_BOUNDS_TIME) {
        this.crash('bounds');
        return;
      }
    } else this.outTime = Math.max(0, this.outTime - dt * 2);

    // animation and effects
    const view = me.view;
    view.root.position.copy(me.pos);
    view.root.quaternion.copy(me.quat);
    const local = v1.copy(aim).applyQuaternion(q1.copy(me.quat).invert());
    view.animate(dt, {
      throttle: input.throttle, boost: fs.boosting, brake: fs.braking, breath: breathing, firing: this.firingVis > 0,
      yawRate: me.yawRate * 2, pitchRate: me.pitchRate * 2, lookYaw: Math.atan2(local.x, -local.z) * 0.8,
      lookPitch: Math.atan2(local.y, Math.hypot(local.x, local.z)) * 0.6, dive: fs.vel[1] < -60, dead: false,
    });
    this.dragonFx(me, dt, breathing, fs.boosting, input.throttle);
    if (this.overheated) this.w3.fx.steam(view.mouthWorld(v2), me.vel, dt);
    if (me.flags & F.SHIELD) this.w3.fx.embers(me.pos, me.vel, BREED_LOOK[me.breed].fire, dt);
  }

  crash(why) {
    if (!this.me.alive) return;
    this.conn.send({ t: 'crash', why });
    this.me.alive = false;
    this.startCorpse(this.me, null, null, why);
    this.deadTimer = MATCH.respawnTime;
    this.killer = null;
    this.feel.death();
    this.audio.death();
    this.shake = 1.5;
    const r = document.getElementById('respawn');
    r.classList.remove('hidden');
    r.innerHTML = `<h2>${why === 'bounds' ? 'Lost beyond the storm' : 'You crashed'}</h2><p id="respawn-t"></p>`;
  }

  fireBall(aim, breed) {
    const me = this.me;
    const fwd = v1.set(...forwardOf(this.fs.q));
    // fireballs fly along the nose, nudged up to 3 degrees toward the aim / lock lead
    const dir = fwd.clone();
    const target = this.lock.ent && this.lock.lead ? v2.copy(this.lock.lead).sub(me.pos).normalize() : aim;
    const ang = dir.angleTo(target);
    if (ang < 0.12) dir.copy(target);
    else if (ang < 0.35) dir.lerp(target, 0.05 / ang).normalize();
    const o = me.view.mouthWorld(new THREE.Vector3()).addScaledVector(dir, 2);
    const sp = breed.fbSpeed + this.fs.speed;
    const s = (this.shotSeq = (this.shotSeq + 1) & 0xffff);
    this.projectiles.push({ a: this.meId, s, k: 'fb', own: true, p: o, v: dir.clone().multiplyScalar(sp), life: WEAPONS.fireball.life, pal: BREED_LOOK[me.breed].fire, target: 0 });
    this.conn.send({ t: 'fire', k: 'fb', s, o: arr(o), d: arr(dir) });
    this.audio.fireball();
    this.firingVis = 0.18;
    this.w3.fx.explosion(o, BREED_LOOK[me.breed].fire, 0.18, me.vel);
  }

  fireSeeker(target) {
    const me = this.me;
    const dir = v1.copy(target.pos).sub(me.pos).normalize();
    const fwd = v2.set(...forwardOf(this.fs.q));
    dir.lerp(fwd, 0.5).normalize();
    const o = me.view.mouthWorld(new THREE.Vector3()).addScaledVector(dir, 2);
    const s = (this.shotSeq = (this.shotSeq + 1) & 0xffff);
    this.projectiles.push({ a: this.meId, s, k: 'sk', own: true, p: o, v: dir.clone().multiplyScalar(WEAPONS.seeker.speed + this.fs.speed * 0.5), life: WEAPONS.seeker.life, pal: BREED_LOOK[me.breed].fire, target: target.id });
    this.conn.send({ t: 'fire', k: 'sk', s, o: arr(o), d: arr(dir), v: target.id });
    this.audio.seeker();
    this.firingVis = 0.3;
    this.lock.t = 0;
    this.lock.locked = false;
  }

  doBreath(dt, breed) {
    const me = this.me;
    const fwd = v1.set(...forwardOf(this.fs.q));
    const mouth = me.view.mouthWorld(v2);
    this.w3.fx.breath(mouth, fwd, me.vel, BREED_LOOK[me.breed].fire, dt);
    this.burnAcc += dt;
    if (this.burnAcc < WEAPONS.breath.tick) return;
    this.burnAcc = 0;
    for (const e of this.ents.values()) {
      if (e.id === this.meId || !e.alive || this.isAlly(e)) continue;
      const to = v3.copy(e.pos).sub(mouth);
      const d = to.length();
      if (d > WEAPONS.breath.range + HITBOX[0]) continue;
      const ang = to.angleTo(fwd);
      if (ang > WEAPONS.breath.cone + Math.atan2(HITBOX[0] * 0.7, d)) continue;
      this.conn.send({ t: 'burn', v: e.id });
    }
  }

  dragonFx(e, dt, breathing, boosting, throttle) {
    const view = e.view;
    view.root.updateMatrixWorld(true);
    const lit = this.w3.terrain.sunlit(e.pos.x, e.pos.y, e.pos.z);
    e.glow += ((breathing ? 1 : e.firing > 0 ? 0.6 : 0) - e.glow) * Math.min(1, dt * 10);
    e.hurt = Math.max(0, e.hurt - dt * 4);
    view.setLight(lit, e.glow, e.hurt);
    // wingtip vapour in hard manoeuvres and fast flight
    const g = Math.min(1, Math.abs(e.pitchRate) * 0.8 + Math.abs(e.yawRate) * 0.3);
    const vap = Math.max(0, Math.min(1, (e.speed - 110) / 60)) * 0.5 + Math.max(0, g - 0.35) * 0.9 * Math.min(1, e.speed / 80) + (boosting ? 0.25 : 0);
    if (vap > 0.12) {
      view.tipsWorld(v1, v2);
      this.w3.trails.feed(`${e.id}R`, v1, Math.min(1, vap), dt);
      this.w3.trails.feed(`${e.id}L`, v2, Math.min(1, vap), dt);
    }
    this.statusFx(e, dt);
    // wounded dragons smoke
    const maxHp = BREEDS[e.breed].hp;
    this.w3.fx.wound(e.id, e.pos, e.vel, e.quat, BREED_LOOK[e.breed].fire, e.hp / maxHp, dt);
  }

  updateDead(dt) {
    this.deadTimer -= dt;
    const t = document.getElementById('respawn-t');
    if (t) t.textContent = this.deadTimer > 0 ? `Back in the air in ${Math.ceil(this.deadTimer)}...` : 'Waiting for the sky to clear...';
  }

  updateCorpse(e, dt) {
    const c = e.corpse;
    c.t += dt;
    if (!c.landed) {
      c.v.y -= 9.8 * dt;
      c.v.multiplyScalar(Math.exp(-0.3 * dt));
      c.p.addScaledVector(c.v, dt);
      q1.setFromEuler(new THREE.Euler(c.spin.x * dt, c.spin.y * dt, c.spin.z * dt));
      c.q.multiply(q1);
      this.w3.fx.corpse(c.p, c.v, BREED_LOOK[e.breed].fire, dt);
      const floor = this.world.floorAt(c.p.x, c.p.z);
      if (c.p.y < floor + 2 || this.world.hitSkyRock([c.p.x, c.p.y, c.p.z], 2)) {
        c.landed = true;
        e.view.root.visible = false;
        if (floor <= 0.5) {
          this.w3.fx.splash(new THREE.Vector3(c.p.x, 0, c.p.z), 1.2);
          this.audio.splash(c.p);
        } else {
          this.w3.fx.explosion(c.p, BREED_LOOK[e.breed].fire, 1.4);
          this.audio.explosion(c.p, 1.3);
        }
      }
    }
    e.view.root.position.copy(c.p);
    e.view.root.quaternion.copy(c.q);
    if (e.view.root.visible) e.view.animate(dt, { throttle: 0, dead: true });
  }

  updateRemotes(dt) {
    const renderT = this.conn.serverNow() - (this.conn.local ? 60 : INTERP_DELAY * 1000 + Math.min(80, this.conn.rtt * 0.25));
    let remoteBreath = 0, remoteBreathAt = null;
    for (const e of this.ents.values()) {
      if (e.corpse) {
        this.updateCorpse(e, dt * this.feel.vis); // wrecks fall in slow motion during the kill cam
        if (e.id === this.meId) continue;
        if (e.alive) e.corpse = null;
        continue;
      }
      if (e.id === this.meId) continue;
      if (!e.alive) {
        e.view.root.visible = false;
        continue;
      }
      if (!this.interpolate(e, renderT)) {
        e.view.root.visible = false;
        continue;
      }
      e.view.root.visible = true;
      const dist = e.pos.distanceTo(this.camera ? this.camera.position : this.me.pos);
      e.view.setFar(dist > 140 * DRAGON_SCALE); // the decimated mesh once the dragon is small on screen
      e.view.root.position.copy(e.pos);
      e.view.root.quaternion.copy(e.quat);
      // angular rates for the tail and wing animation
      q1.copy(e.prevQ).invert().multiply(e.quat);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(q1.w)));
      const axis = v1.set(q1.x, q1.y, q1.z).normalize();
      const rate = dt > 0 ? ang / dt : 0;
      e.yawRate = e.yawRate * 0.85 + (axis.y * rate) * -0.15;
      e.pitchRate = e.pitchRate * 0.85 + (axis.x * rate) * 0.15;
      e.prevQ.copy(e.quat);
      e.firing = Math.max(0, (e.firing || 0) - dt);
      if (this.me.alive) this.audio.trackPassBy(e.id, e.pos, dt); // a dragon rushing past close by whooshes
      const breathing = !!(e.flags & F.BREATH);
      if (dist < 2500) {
        e.view.animate(dt, {
          throttle: e.throttle, boost: !!(e.flags & F.BOOST), brake: !!(e.flags & F.BRAKE), breath: breathing, firing: e.firing > 0,
          yawRate: e.yawRate, pitchRate: e.pitchRate, dive: e.vel.y < -60, dead: false,
        });
        this.dragonFx(e, dt, breathing, !!(e.flags & F.BOOST), e.throttle);
      }
      if (breathing) {
        e.view.root.updateMatrixWorld(true);
        const mouth = e.view.mouthWorld(v2);
        this.w3.fx.breath(mouth, v1.set(0, 0, -1).applyQuaternion(e.quat), e.vel, BREED_LOOK[e.breed].fire, dt);
        if (60 / (60 + dist) > remoteBreath) { remoteBreath = 60 / (60 + dist); remoteBreathAt = e.pos; }
      }
      if (e.flags & F.SHIELD && Math.random() < 0.5) this.w3.fx.embers(e.pos, e.vel, BREED_LOOK[e.breed].fire, dt);
    }
    this.remoteBreath = remoteBreath;
    this.remoteBreathAt = remoteBreathAt;
  }

  interpolate(e, t) {
    const b = e.buf;
    if (!b.length) return false;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > t) i--;
    const s1 = b[i];
    const s0 = i > 0 ? b[i - 1] : null;
    if (s0 && t >= s0.t && t <= s1.t) {
      const span = Math.max(1, s1.t - s0.t);
      const k = (t - s0.t) / span;
      // Hermite with velocities along the noses
      const f0 = v1.set(0, 0, -1).applyQuaternion(q1.set(...s0.q)).multiplyScalar(s0.speed * span / 1000);
      const f1 = v2.set(0, 0, -1).applyQuaternion(q1.set(...s1.q)).multiplyScalar(s1.speed * span / 1000);
      const k2 = k * k, k3 = k2 * k;
      const h00 = 2 * k3 - 3 * k2 + 1, h10 = k3 - 2 * k2 + k, h01 = -2 * k3 + 3 * k2, h11 = k3 - k2;
      const prev = v3.copy(e.pos);
      e.pos.set(
        h00 * s0.p[0] + h10 * f0.x + h01 * s1.p[0] + h11 * f1.x,
        h00 * s0.p[1] + h10 * f0.y + h01 * s1.p[1] + h11 * f1.y,
        h00 * s0.p[2] + h10 * f0.z + h01 * s1.p[2] + h11 * f1.z,
      );
      e.quat.set(...s0.q).slerp(q1.set(...s1.q), k);
      e.speed = s0.speed + (s1.speed - s0.speed) * k;
      e.throttle = s1.throttle;
      e.flags = s1.flags;
      e.vel.set(0, 0, -1).applyQuaternion(e.quat).multiplyScalar(e.speed);
      if (prev.distanceToSquared(e.pos) > 400 * 400) e.prevQ.copy(e.quat);
    } else {
      // extrapolate briefly past the newest snapshot
      const ahead = Math.min(0.25, Math.max(0, (t - s1.t) / 1000));
      e.quat.set(...s1.q);
      e.vel.set(0, 0, -1).applyQuaternion(e.quat).multiplyScalar(s1.speed);
      e.pos.set(...s1.p).addScaledVector(e.vel, ahead);
      e.speed = s1.speed;
      e.throttle = s1.throttle;
      e.flags = s1.flags;
    }
    return true;
  }

  updateProjectiles(dt) {
    const fx = this.w3.fx;
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      if (pr.life <= 0) {
        fx.smokePuff(pr.p, pr.v, 0.2, 4);
        this.projectiles.splice(i, 1);
        continue;
      }
      // seekers home on their target (ours toward what we see, theirs toward us exactly)
      if (pr.k === 'sk' && !pr.evaded) {
        const tgt = this.ents.get(pr.target);
        if (tgt && tgt.alive) {
          const tp = tgt.id === this.meId ? this.me.pos : tgt.pos;
          const tv = tgt.id === this.meId ? this.me.vel : tgt.vel;
          const sv = (pr.sv || (pr.sv = [0, 0, 0]));
          sv[0] = pr.v.x; sv[1] = pr.v.y; sv[2] = pr.v.z;
          homeSeeker(arr(pr.p), sv, arr(tp), arr(tv), dt, WEAPONS.seeker.turn);
          pr.v.set(sv[0], sv[1], sv[2]);
          if (tgt.id === this.meId) {
            const d = pr.p.distanceTo(this.me.pos);
            if (this.fs.dodge > 0 && d < WEAPONS.dodge.breakRange && !pr.evadeSent) {
              pr.evadeSent = true;
              pr.evaded = true;
              this.conn.send({ t: 'evade', s: pr.s, a: pr.a });
            }
          }
        }
      }
      a[0] = pr.p.x; a[1] = pr.p.y; a[2] = pr.p.z;
      pr.p.addScaledVector(pr.v, dt);
      b[0] = pr.p.x; b[1] = pr.p.y; b[2] = pr.p.z;
      fx.fireballTrail(pr.p, pr.v, pr.pal, dt, pr.k === 'sk' ? 1.6 : 1, undefined, pr.k);
      fx.light(pr.p, pr.pal[1], pr.k === 'sk' ? 30 : 18);
      if (pr.own) {
        let hit = null, ht = 2;
        for (const e of this.ents.values()) {
          if (e.id === this.meId || !e.alive || !e.view.root.visible || this.isAlly(e)) continue;
          if (pr.k === 'sk' && pr.target && e.id !== pr.target && !pr.evaded) continue;
          const t = sweepDragon(a, b, arr(e.pos), [e.quat.x, e.quat.y, e.quat.z, e.quat.w], pr.k === 'sk' ? WEAPONS.seeker.radius : WEAPONS.fireball.radius);
          if (t >= 0 && t < ht) { ht = t; hit = e; }
        }
        if (hit) {
          const hp = new THREE.Vector3(a[0] + (b[0] - a[0]) * ht, a[1] + (b[1] - a[1]) * ht, a[2] + (b[2] - a[2]) * ht);
          this.conn.send({ t: 'hit', s: pr.s, v: hit.id, p: arr(hp) });
          fx.explosion(hp, pr.pal, pr.k === 'sk' ? 1.3 : 0.7, hit.vel);
          fx.hitSpark(hp, pr.pal, undefined, pr.k);
          this.audio.impact(hp, pr.k === 'sk');
          hit.hurt = 1;
          this.projectiles.splice(i, 1);
          continue;
        }
      }
      if (this.world.solidAt(b)) {
        const water = this.world.height(b[0], b[2]) < 0 && b[1] < 2;
        if (water) {
          fx.splash(new THREE.Vector3(b[0], 0, b[2]), 0.4);
        } else fx.explosion(pr.p, pr.pal, 0.6);
        this.audio.impact(pr.p, pr.k === 'sk');
        this.projectiles.splice(i, 1);
      }
    }
  }

  updateLock(dt, aim, c) {
    const me = this.me;
    const lk = this.lock;
    if (!me.alive || this.match.phase !== 'battle') {
      if (lk.ent) this.sendLock(null);
      lk.ent = null;
      lk.t = 0;
      lk.locked = false;
      return;
    }
    // best candidate: nearest to the aim inside the cone and range, not hidden in a cloud, and in sight (no lock
    // through mountains, sky rocks or the Citadel: the same throttled line-of-sight test the lenses use)
    let best = null, bestAng = WEAPONS.seeker.lockCone;
    const los = this._losTest || (this._losTest = (p) => this.lensBlocked(p));
    for (const e of this.ents.values()) {
      if (e.id === this.meId || !e.alive || !e.view.root.visible || e.flags & F.SHIELD || this.isAlly(e)) continue;
      const to = v1.copy(e.pos).sub(me.pos);
      const d = to.length();
      if (d > WEAPONS.seeker.lockRange || d < 30) continue;
      if (this.w3.clouds.density(e.pos) > 0.15) continue;
      const ang = to.angleTo(aim);
      if (ang < bestAng && !this.lensDir.occluded(e.id, e.pos, los)) { bestAng = ang; best = e; }
    }
    if (best !== lk.ent) {
      if (lk.locked) this.sendLock(null);
      lk.ent = best;
      lk.t = 0;
      lk.locked = false;
    }
    if (best) {
      lk.t += dt;
      if (!lk.locked && lk.t >= WEAPONS.seeker.lockTime) {
        lk.locked = true;
        this.sendLock(best);
      }
      const d = best.pos.distanceTo(me.pos);
      const tt = d / (BREEDS[me.breed].fbSpeed + this.fs.speed);
      lk.lead = (lk.lead || new THREE.Vector3()).copy(best.pos).addScaledVector(best.vel, tt);
    }
  }

  sendLock(ent) {
    const id = ent ? ent.id : 0;
    if (id === this.lock.sent) return;
    if (this.lock.sent) this.conn.send({ t: 'lock', v: this.lock.sent, on: false });
    if (id) this.conn.send({ t: 'lock', v: id, on: true });
    this.lock.sent = id;
  }

  updateCamera(dt, aim) {
    this.feel.camera(dt, aim); // client/js/feel.js
  }

  updateHud(dt, aim) {
    const me = this.me;
    const fs = this.fs;
    const hud = this.hud;
    hud.tick(dt);
    const inCloud = this.w3.clouds.density(this.w3.camera.position);
    this.inCloud = inCloud;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.5);
    const g = this.w3.grade.uniforms;
    g.whiteout.value = Math.min(0.85, inCloud * 1.6);
    const lowHp = me.alive ? Math.max(0, 1 - me.hp / (BREEDS[me.breed].hp * 0.3)) : 0;
    g.damage.value = Math.min(0.9, this.hurtFlash + lowHp * (0.18 + 0.1 * Math.sin(this.time * 6)));
    g.boost.value += ((fs.boosting && me.alive ? 1 : 0) - g.boost.value) * Math.min(1, dt * 5);

    hud.updateGauges({
      hp: me.hp, maxHp: BREEDS[me.breed].hp, stamina: fs.stamina, heat: this.heat, overheated: this.overheated,
      speed: fs.speed, alt: fs.p[1], throttle: fs.throttle, seekerCd: this.seekerCd, locked: this.lock.locked, inCloud,
    });
    // timer and leader
    const left = Math.max(0, (this.matchEndsAt - performance.now()) / 1000);
    hud.text('timer', this.match.phase === 'battle' ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}` : 'Results');
    let lead = null;
    for (const e of this.ents.values()) if (!lead || e.kills > lead.kills) lead = e;
    const limit = this.match.killLimit || MATCH.killLimit;
    hud.text('leader', this.tdm
      ? `${TEAMS[me.team] ? `You fly for ${TEAMS[me.team].name}` : ''} · first to ${limit} team kills`
      : lead ? `${lead.id === this.meId ? 'You lead' : `${lead.name} leads`} · ${lead.kills}/${limit} kills` : '');
    this.updateModeHud();
    hud.text('net-tag', this.conn.local ? 'Offline practice' : `${this.ents.size} dragons · ${Math.round(this.conn.rtt)} ms`);
    hud.toggle('click-hint', 'show', !this.input.locked && !this.input.isTouch && !this.paused);

    // threats: hostiles close by whose nose points at you (bots never lock on; threats.js)
    const tm = this._threatMe || (this._threatMe = { pos: null, fwd: new THREE.Vector3(), hostile: (e) => e.id !== this.meId && e.view.root.visible && !this.isAlly(e) });
    if (me.alive) { tm.pos = me.pos; tm.fwd.set(...forwardOf(fs.q)); }
    const threats = this.threats.update(dt, me.alive && this.match.phase === 'battle' ? tm : null, this.ents.values(), tm.hostile);

    // warnings
    let warn = '';
    if (me.alive) {
      const ground = fs.p[1] - this.world.floorAt(fs.p[0] + fs.vel[0] * 2, fs.p[2] + fs.vel[2] * 2);
      if (fs.vel[1] < -20 && ground < -fs.vel[1] * 2.2) warn = 'PULL UP';
      if (this.outTime > 0) warn = `RETURN TO BATTLE ${Math.ceil(OUT_OF_BOUNDS_TIME - this.outTime)}`;
      else if (Math.hypot(fs.p[0], fs.p[2]) > WORLD.radius - 300) warn = 'Edge of the battle area';
      if (fs.p[1] > WORLD.ceiling) warn = 'AIR TOO THIN';
    }
    hud.setWarn(warn, warn !== 'Edge of the battle area');
    // incoming seekers
    const seekers = [];
    for (const pr of this.projectiles) if (pr.k === 'sk' && pr.target === this.meId && !pr.evaded) seekers.push(pr.p);
    if (seekers.length) {
      hud.setLockWarn(`SEEKER INCOMING · ${this.input.isTouch ? 'TAP ROLL' : 'BARREL ROLL (Q/E)'}`, true);
      this.warnBeep -= dt;
      if (this.warnBeep <= 0) {
        this.audio.warning();
        this.warnBeep = 0.5;
      }
    } else if (this.abilWarn && (this.abilWarn.t -= dt) > 0 && me.alive) hud.setLockWarn(this.abilWarn.text, 'ability');
    else if (this.lockedBy.size) hud.setLockWarn('LOCKED ON', false);
    else if (this.threats.six) hud.setLockWarn('ON YOUR SIX', false);
    else hud.setLockWarn('', false);

    // overlay (records, vectors and the HUD state are reused frame to frame: no per-frame garbage for Safari's GC)
    const enemies = this._enemies || (this._enemies = []);
    const radarDots = this._radarDots || (this._radarDots = []);
    enemies.length = 0;
    radarDots.length = 0;
    const cam = this.w3.camera;
    for (const e of this.ents.values()) {
      if (e.id === this.meId || !e.alive || !e.view.root.visible) continue;
      const dist = e.pos.distanceTo(me.alive ? me.pos : cam.position);
      const cloud = this.w3.clouds.density(e.pos) > 0.15;
      const ally = this.isAlly(e);
      const rec = e._hud || (e._hud = { leadV: new THREE.Vector3(), dot: {} });
      rec.ent = e; rec.pos = e.pos; rec.dist = dist; rec.inCloud = cloud; rec.ally = ally;
      rec.color = this.colorOf(e); rec.maxHp = BREEDS[e.breed].hp; rec.tag = e.bounty ? '★ ' : '';
      rec.threat = threats.has(e.id);
      rec.lead = null;
      if (me.alive && dist < 900 && !ally) {
        const tt = dist / (BREEDS[me.breed].fbSpeed + fs.speed);
        rec.lead = rec.leadV.copy(e.pos).addScaledVector(e.vel, tt);
      }
      enemies.push(rec);
      if (!cloud) {
        const f = v2.set(0, 0, -1).applyQuaternion(e.quat);
        const d = rec.dot;
        d.pos = e.pos; d.heading = Math.atan2(f.x, -f.z); d.color = rec.color; d.dy = e.pos.y - me.pos.y; d.ally = ally; d.bounty = e.bounty;
        radarDots.push(d);
      }
    }
    const fwd = me.alive ? v2.set(...forwardOf(fs.q)) : v2.copy(aim);
    const nosePoint = this._noseP || (this._noseP = new THREE.Vector3());
    if (me.alive) me.view.mouthWorld(nosePoint);
    else nosePoint.copy(me.pos);
    nosePoint.addScaledVector(fwd, 420);
    // target lenses: live magnified views of far dragons (the lock-on gameplay above is unchanged)
    const lockP = Math.min(1, this.lock.t / WEAPONS.seeker.lockTime);
    const noseNdc = v1.copy(nosePoint).project(cam);
    const lc = this._lensCtx || (this._lensCtx = { nosePx: { x: 0, y: 0 }, attackers: new Set() });
    lc.nosePx.x = (noseNdc.x * 0.5 + 0.5) * innerWidth;
    lc.nosePx.y = (-noseNdc.y * 0.5 + 0.5) * innerHeight;
    lc.attackers.clear(); // dragons locked on to you and the ones lining up a shot come first
    for (const id of this.lockedBy) lc.attackers.add(id);
    for (const id of threats) lc.attackers.add(id);
    lc.camera = cam; lc.W = innerWidth; lc.H = innerHeight; lc.enemies = enemies;
    lc.lockId = this.lock.ent ? this.lock.ent.id : 0; lc.lockP = lockP; lc.locked = this.lock.locked;
    lc.nose = me.alive && noseNdc.z < 1 ? lc.nosePx : null;
    lc.maxLenses = this.w3.lens.maxLenses; lc.touch = this.input.isTouch;
    lc.enabled = lensPref.on && me.alive && this.match.phase === 'battle';
    lc.blocked = this._losTest || (this._losTest = (p) => this.lensBlocked(p));
    const lensOut = this.lensDir.update(dt, lc);
    this.w3.lens.set(lensOut.lenses);
    // incoming seekers: time to impact from the closing speed
    const seekTti = this._seekTti || (this._seekTti = []);
    seekTti.length = 0;
    for (const pr of this.projectiles) {
      if (pr.k !== 'sk' || pr.target !== this.meId || pr.evaded) continue;
      const to = v1.copy(me.pos).sub(pr.p);
      const d = to.length();
      const closing = d > 0.01 ? (pr.v.dot(to) - me.vel.dot(to)) / d : 0;
      seekTti.push(d / Math.max(30, closing));
    }
    const hs = this._hudState || (this._hudState = { aimPoint: new THREE.Vector3(), lockS: { ent: null, pos: null, progress: 0, locked: false }, shrines: [] });
    hs.camera = cam; hs.dead = !me.alive; hs.nosePoint = nosePoint; hs.enemies = enemies;
    hs.aimPoint.copy(cam.position).addScaledVector(aim, 1000);
    if (this.lock.ent) {
      const L = hs.lockS;
      L.ent = this.lock.ent; L.pos = this.lock.ent.pos; L.progress = lockP; L.locked = this.lock.locked;
      hs.lock = L;
    } else hs.lock = null;
    hs.lenses = lensOut.lenses; hs.lensCover = lensOut.cover; hs.lensHidden = lensOut.hidden; hs.lensNear = lensOut.near; hs.lensOn = lc.enabled;
    hs.aimedId = lensOut.aimedId; hs.labelId = lensOut.labelId; hs.labelLens = lensOut.labelLens; hs.focal = lensOut.focal;
    hs.seekers = seekers; hs.seekerTti = seekTti;
    hs.mePos = me.alive ? me.pos : cam.position; hs.heading = Math.atan2(aim.x, -aim.z); hs.radarDots = radarDots;
    hs.shrines.length = 0;
    const sh = this.w3.shrines;
    for (let i = 0; i < sh.items.length; i++) if (sh.ready(i)) hs.shrines.push(sh.items[i].p);
    hud.draw(dt, hs);
    // how hard the air is being worked: swing of the flight direction, climb or dive, height over the ground
    let turn = 0;
    if (me.alive) {
      q1.set(...fs.q);
      if (this._airQ) {
        const ang = 2 * Math.acos(Math.min(1, Math.abs(this._airQ.dot(q1))));
        turn = dt > 0 ? ang / dt : 0;
      } else this._airQ = new THREE.Quaternion();
      this._airQ.copy(q1);
    } else this._airQ = null;
    this.audio.update({
      speed: me.alive ? fs.speed : 0, boost: fs.boosting && me.alive, breath: this.breathing && me.alive, inCloud,
      remoteBreath: this.remoteBreath || 0, remoteBreathAt: this.remoteBreathAt,
      turn: Math.min(4, turn), climb: me.alive ? fs.vel[1] / Math.max(fs.speed, 20) : 0,
      ground: me.alive ? Math.max(0, fs.p[1] - this.world.floorAt(fs.p[0], fs.p[2])) : -1,
    });
  }

  // a lens only shows a dragon you could see: terrain, sky rocks and the Citadel block it, and so does a thick cloud
  lensBlocked(p) {
    const c = this.w3.camera.position;
    const q = LOS_Q, o = LOS_O;
    const n = 12, seg = c.distanceTo(p) / n;
    let fog = 0;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      o.x = q[0] = c.x + (p.x - c.x) * t;
      o.y = q[1] = c.y + (p.y - c.y) * t;
      o.z = q[2] = c.z + (p.z - c.z) * t;
      if (this.world.solidAt(q)) return true;
      fog += this.w3.clouds.density(o) * seg;
      if (fog > 30) return true;
    }
    return false;
  }

  // ability cooldown, status effects and the team score (small DOM hooks: #abil-tag, #status-tag, #team-score)
  updateModeHud() {
    const me = this.me;
    const A = ABILITIES[me.breed];
    const tag = document.getElementById('abil-tag');
    if (tag) {
      tag.textContent = this.abilCd > 0 ? `${A.name.toUpperCase()} ${this.abilCd.toFixed(1)}s` : `${A.name.toUpperCase()} READY [R]`;
      tag.classList.toggle('cool', this.abilCd > 0);
    }
    const st = document.getElementById('status-tag');
    if (st) {
      const bits = [];
      for (const [k, label] of [['blaze', 'BLAZING'], ['amp', 'DRAGONLORD'], ['armor', 'RIME ARMOR'], ['chill', 'CHILLED'], ['corrode', 'CORRODED'], ['burn', 'BURNING'], ['poison', 'POISONED']]) {
        if (this.has(me, k)) bits.push(`${label} ${Math.ceil(me.st[k] - this.time)}`);
      }
      if (me.bounty) bits.push(`BOUNTY ${me.bounty}`);
      const text = me.alive ? bits.join(' · ') : '';
      if (st.textContent !== text) st.textContent = text;
    }
    const ts = document.getElementById('team-score');
    if (ts) {
      ts.classList.toggle('hidden', !this.tdm);
      if (this.tdm) {
        const [g, c] = this.teamKills;
        const html = `<span style="color:${TEAMS[0].color}">${TEAMS[0].name} ${g}</span><i>:</i><span style="color:${TEAMS[1].color}">${c} ${TEAMS[1].name}</span>`;
        if (ts.dataset.v !== html) { ts.dataset.v = html; ts.innerHTML = html; }
      }
    }
  }

  sendState(dt) {
    this.sendAcc += dt;
    if (this.sendAcc < 1 / CLIENT_SEND_HZ) return;
    this.sendAcc = 0;
    let flags = 0;
    if (this.breathing) flags |= F.BREATH;
    if (this.fs.boosting) flags |= F.BOOST;
    if (this.fs.dodge > 0) flags |= F.DODGE;
    if (this.fs.braking) flags |= F.BRAKE;
    if (this.outTime > 0) flags |= F.OUT;
    this.conn.send(encodeState(this.fs, flags, this.seq++));
  }

  dispose() {
    for (const id of [...this.ents.keys()]) this.removeEnt(id);
    this.projectiles.length = 0;
    this.w3.lens.set([]);
    this.hud.show(false);
    this.hud.scoreboard(false);
    this.hud.results(false);
  }
}
