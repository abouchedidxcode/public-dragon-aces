// Headless checks of the shared simulation: bots fly and fight, claims are validated, protocol round-trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../shared/room.js';
import { Hub } from '../shared/hub.js';
import { PROTOCOL, encodeState, decodeState, decodeSnapshot } from '../shared/protocol.js';
import { createFlightState, stepFlight, steerToward, forwardOf } from '../shared/flight.js';
import { ABILITIES, BREEDS, MATCH, MAX_PLAYERS, STATUS, STREAK, WEAPONS } from '../shared/constants.js';
import { chilled } from '../shared/abilities.js';
import { createWorld } from '../shared/world.js';

function fakeConn() {
  const c = { json: [], bin: 0, send(d) { if (typeof d === 'string') c.json.push(JSON.parse(d)); else c.bin++; } };
  return c;
}
function run(room, seconds) {
  const step = 1 / 30;
  for (let t = 0; t < seconds; t += step) {
    room.ms += step * 1000;
    room.tick(step);
  }
}

test('bots fly and fight without all crashing', () => {
  const room = new Room({ seed: 42 });
  const conn = fakeConn();
  const me = room.join(conn, { name: 'Tester', breed: 'ember' });
  assert.ok(me);
  assert.equal(room.ents.size, 6, 'bots fill the sky to 6');
  me.alive = false; me.deadUntil = 1e12; // spectate
  run(room, 180);
  const kills = conn.json.filter((m) => m.t === 'kill');
  const crashes = kills.filter((m) => m.k === 'crash' || m.k === 'bounds');
  const combat = kills.filter((m) => m.k === 'fb' || m.k === 'br');
  console.log('3 min: kills', kills.length, 'combat', combat.length, 'crashes', crashes.length,
    'fires', conn.json.filter((m) => m.t === 'fire').length, 'dmg', conn.json.filter((m) => m.t === 'dmg').length);
  assert.ok(combat.length >= 3, 'bots shoot each other down');
  assert.ok(crashes.length <= combat.length, 'bots mostly avoid terrain');
});

test('hit claims are validated', () => {
  const room = new Room({ seed: 1, bots: false });
  const ca = fakeConn(), cb = fakeConn();
  const a = room.join(ca, { name: 'A', breed: 'ember' });
  const b = room.join(cb, { name: 'B', breed: 'ember' });
  a.awaitSpawn = b.awaitSpawn = null;
  room.ms = 10000; a.shieldUntil = b.shieldUntil = 0;
  a.fs.p = [0, 1000, 0]; b.fs.p = [0, 1000, -200];
  room.message(a, JSON.stringify({ t: 'fire', k: 'fb', s: 1, o: [0, 1000, -9], d: [0, 0, -1] }));
  assert.ok(cb.json.some((m) => m.t === 'fire' && m.a === a.id), 'fire relayed');
  room.ms += 500;
  // bogus claim: far from the victim
  room.message(a, JSON.stringify({ t: 'hit', s: 1, v: b.id, p: [500, 1000, 0] }));
  assert.equal(b.hp, BREEDS.ember.hp);
  room.message(a, JSON.stringify({ t: 'hit', s: 1, v: b.id, p: [0, 1000, -198] }));
  assert.equal(b.hp, BREEDS.ember.hp - BREEDS.ember.fbDamage);
  // the same shot cannot hit twice
  room.message(a, JSON.stringify({ t: 'hit', s: 1, v: b.id, p: [0, 1000, -198] }));
  assert.equal(b.hp, BREEDS.ember.hp - BREEDS.ember.fbDamage);
  // unknown shot
  room.message(a, JSON.stringify({ t: 'hit', s: 99, v: b.id, p: [0, 1000, -198] }));
  assert.equal(b.hp, BREEDS.ember.hp - BREEDS.ember.fbDamage);
});

test('teleporting states are rejected', () => {
  const room = new Room({ seed: 2, bots: false });
  const a = room.join(fakeConn(), { name: 'A' });
  const st = { p: [...a.fs.p], q: a.fs.q, speed: 80, throttle: 0.5 };
  room.message(a, new Uint8Array(encodeState(st, 0, 1)));
  room.ms += 50;
  room.message(a, new Uint8Array(encodeState({ ...st, p: [st.p[0] + 3000, st.p[1], st.p[2]] }, 0, 2)));
  assert.ok(Math.abs(a.fs.p[0] - st.p[0]) < 1);
});

test('protocol round trip', () => {
  const s = { p: [1.5, 2.5, -3.5], q: [0, 0.7071, 0, 0.7071], speed: 88.2, throttle: 0.5 };
  const d = decodeState(new Uint8Array(encodeState(s, 5, 77)));
  assert.equal(d.flags, 5); assert.equal(d.seq, 77);
  assert.deepEqual(d.p, s.p);
  assert.ok(Math.abs(d.q[1] - 0.7071) < 1e-3);
  assert.ok(Math.abs(d.speed - 88.2) < 0.05);
  const room = new Room({ seed: 3 });
  const c = fakeConn();
  room.join(c, { name: 'x' });
  let snap = null;
  for (const e of room.ents.values()) if (e.conn) e.conn = { send: (b) => { if (typeof b !== 'string') snap = decodeSnapshot(b); } };
  room.snapshot();
  assert.equal(snap.ents.length, room.ents.size);
});

test('hub fills rooms and private codes work', () => {
  const hub = new Hub({ tickMs: 1e9 });
  const conns = [];
  for (let i = 0; i < MAX_PLAYERS + 1; i++) {
    const c = fakeConn();
    const h = hub.connect(c);
    h.message(JSON.stringify({ t: 'join', pv: PROTOCOL, name: 'p' + i, mode: 'quick' }));
    conns.push(c);
  }
  assert.equal(hub.rooms.size, 2, `player ${MAX_PLAYERS + 1} opens a second room`);
  const first = [...hub.rooms.values()][0];
  assert.equal(first.humans, MAX_PLAYERS);
  assert.equal(first.ents.size, MAX_PLAYERS, 'bots made room');
  const c = fakeConn();
  hub.connect(c).message(JSON.stringify({ t: 'join', pv: PROTOCOL, name: 'host', mode: 'create' }));
  const code = c.json.find((m) => m.t === 'welcome').code;
  const c2 = fakeConn();
  hub.connect(c2).message(JSON.stringify({ t: 'join', pv: PROTOCOL, name: 'friend', mode: 'code', code: code.toLowerCase() }));
  assert.equal(c2.json.find((m) => m.t === 'welcome').code, code);
  // a page cached from before the last protocol bump is told to reload instead of joining a sky it disagrees with
  const stale = fakeConn();
  hub.connect(stale).message(JSON.stringify({ t: 'join', name: 'old', mode: 'quick' }));
  assert.ok(stale.json.some((m) => m.t === 'error' && /Reload/.test(m.msg)) && !stale.json.some((m) => m.t === 'welcome'), 'stale client turned away');
  hub.stop();
});

test('autopilot turns toward a direction', () => {
  const s = createFlightState([0, 1000, 0], [0, 0, 0, 1]);
  const input = { throttle: 0.6 };
  const target = [1, 0, 0];
  for (let i = 0; i < 30 * 6; i++) {
    steerToward(s, target, input);
    stepFlight(s, input, 1 / 30, BREEDS.ember);
  }
  const f = forwardOf(s.q);
  assert.ok(f[0] > 0.95, 'facing +X after 6 s, got ' + f.map((x) => x.toFixed(2)));
  assert.ok(Math.abs(s.p[1] - 1000) < 200, 'kept altitude roughly');
});

test('world is deterministic', () => {
  const a = createWorld(), b = createWorld();
  for (const [x, z] of [[0, 0], [1234, -555], [-3000, 2000]]) assert.equal(a.height(x, z), b.height(x, z));
  assert.ok(a.sky.length >= 8);
});

test('shrines heal only dragons that are really there, then recharge', () => {
  const room = new Room({ seed: 9, bots: false });
  const c = fakeConn();
  const a = room.join(c, { name: 'A', breed: 'ember' });
  a.hp = 30;
  const p = room.world.shrines[0];
  a.fs.p = [p[0] + 500, p[1], p[2]];
  room.message(a, JSON.stringify({ t: 'shrine', i: 0 }));
  assert.equal(a.hp, 30, 'too far away');
  a.fs.p = [p[0] + 5, p[1], p[2]];
  room.message(a, JSON.stringify({ t: 'shrine', i: 0 }));
  assert.equal(a.hp, 70);
  room.message(a, JSON.stringify({ t: 'shrine', i: 0 }));
  assert.equal(a.hp, 70, 'drained until it recharges');
  assert.ok(c.json.some((m) => m.t === 'shrine' && m.by === a.id));
});

// ---------------------------------------------------------------------------------------------------------
// breed abilities, teams, streaks

// a room with no bots and n riders flying level at (0, 1400, -200 * i), facing -Z, all past spawn protection
function arena(n, { mode = 'ffa', breeds = [], seed = 5 } = {}) {
  const room = new Room({ seed, bots: false, mode });
  const conns = [], ents = [];
  for (let i = 0; i < n; i++) {
    const c = fakeConn();
    const e = room.join(c, { name: 'P' + i, breed: breeds[i] || 'ember' });
    e.awaitSpawn = null;
    e.fs.p = [0, 1400, -200 * i];
    e.fs.q = [0, 0, 0, 1];
    e.shieldUntil = 0;
    conns.push(c);
    ents.push(e);
  }
  room.ms = 20000;
  for (const e of ents) e.abilReady = 0;
  return { room, conns, ents };
}
const say = (room, e, msg) => room.message(e, JSON.stringify(msg));
// kill `victim` outright with one damage call from `killer`
function slay(room, victim, killer) {
  victim.alive = true; victim.hp = 10; victim.shieldUntil = 0;
  room.damage(victim, killer, 50, 'fb', 0, null);
}

test('every breed has a signature ability on a cooldown that the room enforces', () => {
  for (const breed of ['ember', 'frost', 'storm', 'venom']) {
    const { room, conns, ents } = arena(2, { breeds: [breed, 'ember'] });
    const [a, b] = ents;
    b.fs.p = [0, 1400, -150]; // something for the bolt to hit
    a.abilReady = room.ms + 3000;
    say(room, a, { t: 'abil' });
    assert.ok(!conns[1].json.some((m) => m.t === 'abil'), breed + ' cannot fire early');
    room.ms += 3100;
    say(room, a, { t: 'abil' });
    const fired = conns[1].json.find((m) => m.t === 'abil');
    assert.ok(fired && fired.a === a.id, breed + ' fires when ready');
    assert.equal(fired.cd, ABILITIES[breed].cooldown);
    assert.ok(a.abilReady - room.ms > ABILITIES[breed].cooldown * 990, 'cooldown restarts');
    const n = conns[1].json.filter((m) => m.t === 'abil').length;
    say(room, a, { t: 'abil' });
    assert.equal(conns[1].json.filter((m) => m.t === 'abil').length, n, breed + ' cannot spam');
  }
});

test('abilities need a living dragon in a battle', () => {
  const { room, conns, ents } = arena(2, { breeds: ['frost', 'ember'] });
  const [a] = ents;
  a.alive = false;
  say(room, a, { t: 'abil' });
  a.alive = true;
  room.phase = 'results';
  say(room, a, { t: 'abil' });
  assert.ok(!conns[1].json.some((m) => m.t === 'abil'));
});

test('Frost Nova hurts and chills nearby foes only, and armours the caster', () => {
  const { room, conns, ents } = arena(3, { breeds: ['frost', 'ember', 'ember'] });
  const [a, near, far] = ents;
  near.fs.p = [0, 1400, -120];
  far.fs.p = [0, 1400, -900];
  say(room, a, { t: 'abil' });
  assert.ok(conns[1].json.some((m) => m.t === 'abil' && m.k === 'nova' && m.ph === 'charge' && m.w === ABILITIES.frost.windup), 'telegraphed charge');
  assert.equal(near.hp, BREEDS.ember.hp, 'nothing happens until the charge is released');
  assert.ok(a.st.armor > room.ms, 'Rime Armor from the start of the charge');
  run(room, 0.2);
  assert.equal(near.hp, BREEDS.ember.hp);
  run(room, 0.4);
  assert.equal(near.hp, BREEDS.ember.hp - ABILITIES.frost.damage);
  assert.equal(far.hp, BREEDS.ember.hp, 'out of range');
  assert.ok(near.st.chill > room.ms, 'chilled');
  assert.ok(!(far.st.chill > room.ms));
  assert.ok(a.st.armor > room.ms, 'Rime Armor');
  assert.ok(conns[1].json.some((m) => m.t === 'st' && m.id === near.id && m.k === 'chill'));
  // armour trims damage taken
  const hp = a.hp;
  room.damage(a, near, 20, 'fb', 0, null);
  assert.ok(Math.abs(hp - a.hp - 20 * STATUS.armor) < 0.01);
  // a chilled dragon flies slower and turns wide
  const base = createFlightState([0, 1400, 0], [0, 0, 0, 1]);
  const slow = createFlightState([0, 1400, 0], [0, 0, 0, 1]);
  const slowBreed = chilled('ember', BREEDS.ember);
  const input = { pitch: 0, roll: 0, yaw: 0, throttle: 1 };
  for (let i = 0; i < 90; i++) { stepFlight(base, input, 1 / 30, BREEDS.ember); stepFlight(slow, input, 1 / 30, slowBreed); }
  assert.ok(slow.speed < base.speed * 0.95, 'slower');
  assert.ok(slowBreed.turn < BREEDS.ember.turn * 0.6, 'wider turns');
});

test('Chain Lightning arcs from the nose target to nearby foes and is refused with nothing in front', () => {
  const { room, conns, ents } = arena(4, { breeds: ['storm', 'ember', 'frost', 'venom'] });
  const [a, b, c, d] = ents;
  b.fs.p = [0, 1400, -300];
  c.fs.p = [100, 1400, -450]; // 180 m from b: a jump
  d.fs.p = [900, 1400, -300]; // out of jump range of b
  say(room, a, { t: 'abil' });
  const charge = conns[0].json.find((x) => x.t === 'abil');
  assert.equal(charge.ph, 'charge');
  assert.equal(charge.tgt, b.id, 'the locked target is announced');
  assert.ok(conns[1].json.some((x) => x.t === 'abilwarn' && x.a === a.id), 'the target is warned');
  assert.equal(b.hp, BREEDS.ember.hp, 'bolt not released yet');
  run(room, 0.45);
  const m = conns[0].json.find((x) => x.t === 'abil' && x.ph === 'fire');
  assert.deepEqual(m.hits, [b.id, c.id]);
  assert.equal(b.hp, BREEDS.ember.hp - ABILITIES.storm.damage[0]);
  assert.equal(c.hp, BREEDS.frost.hp - ABILITIES.storm.damage[1]);
  assert.equal(d.hp, BREEDS.venom.hp);
  const { room: r2, conns: c2, ents: e2 } = arena(2, { breeds: ['storm', 'ember'] });
  e2[1].fs.p = [0, 1400, 800]; // behind
  say(r2, e2[0], { t: 'abil' });
  assert.ok(c2[0].json.some((x) => x.t === 'abilno'));
  assert.ok(e2[0].abilReady <= r2.ms, 'no cooldown spent');
});

test('Acid Cloud lingers, poisons and corrodes', () => {
  const { room, conns, ents } = arena(2, { breeds: ['venom', 'ember'] });
  const [a, b] = ents;
  b.fs.p = [0, 1400, -ABILITIES.venom.ahead];
  say(room, a, { t: 'abil' });
  assert.ok(conns[1].json.some((m) => m.t === 'abil' && m.k === 'acid' && m.ph === 'charge'), 'spit in flight');
  assert.equal(room.zones.length, 0, 'the cloud lands after the spit has flown');
  run(room, 0.7);
  assert.ok(conns[1].json.some((m) => m.t === 'zone' && m.k === 'acid'));
  assert.equal(room.zones.length, 1);
  run(room, 3);
  assert.ok(b.hp < BREEDS.ember.hp - 20, 'inside the cloud for 3 s: ' + b.hp);
  assert.ok(b.st.corrode > room.ms - 100, 'corroded');
  assert.equal(a.hp, BREEDS.venom.hp, 'own cloud is harmless');
  b.fs.p = [0, 1400, -900]; // leave the cloud: poison keeps ticking for a while
  const hp = b.hp;
  run(room, 2);
  assert.ok(b.hp < hp, 'poison keeps ticking');
  run(room, 8);
  assert.equal(room.zones.length, 0, 'cloud expires');
});

test('Inferno Wake drops napalm behind a moving dragon that burns pursuers', () => {
  const { room, conns, ents } = arena(2, { breeds: ['ember', 'venom'] });
  const [a, b] = ents;
  b.fs.p = [0, 1400, 500];
  say(room, a, { t: 'abil' });
  const step = 1 / 30;
  for (let t = 0; t < 4; t += step) {
    a.fs.p = [0, 1400, a.fs.p[2] - 90 * step]; // the owner flies on
    room.ms += step * 1000;
    room.tick(step);
  }
  assert.ok(room.zones.length >= 8, 'a trail of puffs: ' + room.zones.length);
  assert.equal(a.hp, BREEDS.ember.hp, 'owner is immune');
  b.fs.p = [0, 1400, room.zones[Math.floor(room.zones.length / 2)].p[2]]; // a pursuer flying down the trail burns
  const hp = b.hp;
  run(room, 1.5);
  assert.ok(b.hp < hp - 15, 'pursuer scorched: ' + (hp - b.hp));
  assert.ok(conns[0].json.some((m) => m.t === 'dmg' && m.k === 'nap'));
});

test('Team Deathmatch: balanced flights and team spawn sides', () => {
  const room = new Room({ seed: 11, mode: 'tdm' });
  const hs = [];
  for (let i = 0; i < 3; i++) hs.push(room.join(fakeConn(), { name: 'H' + i, breed: 'ember' }));
  const size = (t) => [...room.ents.values()].filter((e) => e.team === t).length;
  assert.equal(room.ents.size, 6, 'bots fill to 6: three a side');
  assert.equal(size(0), 3);
  assert.equal(size(1), 3);
  const humans = (t) => hs.filter((e) => e.team === t).length;
  assert.ok(Math.abs(humans(0) - humans(1)) <= 1, 'humans split evenly');
  for (let i = 0; i < 6; i++) room.join(fakeConn(), { name: 'J' + i });
  assert.equal(size(0), 5, 'bots made room evenly');
  assert.equal(size(1), 5);
  for (const e of room.ents.values()) room.spawn(e, false);
  for (const e of room.ents.values()) assert.ok(room.onTeamSide(e.fs.p, e.team), 'spawned on its own side');
});

test('Team Deathmatch: allies cannot hurt each other by any route', () => {
  const { room, ents } = arena(3, { mode: 'tdm', breeds: ['ember', 'ember', 'frost'] });
  const [a, b, c] = ents;
  a.team = 0; b.team = 0; c.team = 1;
  b.fs.p = [0, 1400, -200]; c.fs.p = [0, 1400, -210];
  say(room, a, { t: 'fire', k: 'fb', s: 1, o: [0, 1400, -9], d: [0, 0, -1] });
  room.ms += 500;
  say(room, a, { t: 'hit', s: 1, v: b.id, p: [0, 1400, -198] });
  assert.equal(b.hp, BREEDS.ember.hp, 'fireball claim on an ally ignored');
  a.flags |= 1; // breathing
  b.fs.p = [0, 1400, -30];
  say(room, a, { t: 'burn', v: b.id });
  assert.equal(b.hp, BREEDS.ember.hp, 'breath claim on an ally ignored');
  room.damage(b, a, 50, 'fb', 0, null);
  assert.equal(b.hp, BREEDS.ember.hp, 'room.damage refuses friendly fire');
  c.fs.p = [0, 1400, -60]; // enemies still burn
  say(room, a, { t: 'burn', v: c.id });
  assert.ok(c.hp < BREEDS.frost.hp);
  const nova = arena(3, { mode: 'tdm', breeds: ['frost', 'ember', 'ember'] });
  const [f, ally, foe] = nova.ents;
  f.team = 0; ally.team = 0; foe.team = 1;
  ally.fs.p = [0, 1400, -60]; foe.fs.p = [0, 1400, 60];
  say(nova.room, f, { t: 'abil' });
  run(nova.room, 0.6);
  assert.equal(ally.hp, BREEDS.ember.hp, 'nova spares allies');
  assert.equal(foe.hp, BREEDS.ember.hp - ABILITIES.frost.damage);
});

test('Team Deathmatch: kills score for the flight and the first to the limit wins', () => {
  const { room, conns, ents } = arena(2, { mode: 'tdm' });
  const [a, b] = ents;
  a.team = 0; b.team = 1;
  for (let i = 0; i < MATCH.tdmKillLimit - 1; i++) slay(room, b, a);
  assert.equal(room.teamKills[0], MATCH.tdmKillLimit - 1);
  assert.equal(room.phase, 'battle');
  slay(room, b, a);
  assert.equal(room.phase, 'results');
  const end = conns[0].json.filter((m) => m.t === 'match').pop();
  assert.equal(end.mode, 'tdm');
  assert.equal(end.result.winner, 0);
  assert.deepEqual(end.teams, [MATCH.tdmKillLimit, 0]);
  assert.ok(end.board.every((r) => 'team' in r && 'medals' in r && 'awards' in r));
});

test('public skies alternate FFA and TDM; private skies keep the mode they were made with', () => {
  const hub = new Hub({ tickMs: 1e9 });
  const c = fakeConn();
  hub.connect(c).message(JSON.stringify({ t: 'join', pv: PROTOCOL, name: 'q', mode: 'quick' }));
  const room = [...hub.rooms.values()][0];
  assert.equal(room.mode, 'ffa');
  room.startMatch();
  assert.equal(room.mode, 'tdm');
  assert.ok([...room.ents.values()].every((e) => e.team === 0 || e.team === 1));
  room.startMatch();
  assert.equal(room.mode, 'ffa');
  assert.ok([...room.ents.values()].every((e) => e.team === -1));
  const p = fakeConn();
  hub.connect(p).message(JSON.stringify({ t: 'join', pv: PROTOCOL, name: 'p', mode: 'create', gm: 'tdm' }));
  const priv = p.json.find((m) => m.t === 'welcome');
  assert.equal(priv.match.mode, 'tdm');
  const pr = [...hub.rooms.values()].find((r) => r.code === priv.code);
  pr.startMatch();
  assert.equal(pr.mode, 'tdm');
  hub.stop();
});

test('kill streaks: Blazing at 3, Surge at 5, Dragonlord at 7, with bounties', () => {
  const { room, conns, ents } = arena(3);
  const [a, v, w] = ents;
  const lastKill = () => conns[0].json.filter((m) => m.t === 'kill').pop();
  slay(room, v, a);
  assert.deepEqual(lastKill().med, ['firstblood']);
  slay(room, w, a);
  assert.ok(!(a.st.blaze > room.ms));
  slay(room, v, a);
  assert.ok(a.st.blaze > room.ms, 'Blazing after 3');
  assert.equal(lastKill().rw, 'blaze');
  // Blazing fires faster (enforced by the room)
  a.fs.p = [0, 1400, 0];
  say(room, a, { t: 'fire', k: 'fb', s: 1, o: [0, 1400, -9], d: [0, 0, -1] });
  room.ms += WEAPONS.fireball.cooldown * 800 * STREAK.blaze.fireCooldown + 5;
  say(room, a, { t: 'fire', k: 'fb', s: 2, o: [0, 1400, -9], d: [0, 0, -1] });
  assert.ok(a.shots.has(2), 'fast second shot allowed while Blazing');
  assert.equal(a.bounty, 0);
  slay(room, w, a); // 4: bounty
  assert.equal(a.bounty, 75);
  assert.ok(conns[1].json.some((m) => m.t === 'bounty' && m.id === a.id && m.amt === 75));
  a.hp = 20;
  slay(room, v, a); // 5: surge
  assert.equal(lastKill().rw, 'surge');
  assert.equal(a.hp, 20 + BREEDS.ember.hp * STREAK.surge.heal);
  assert.equal(a.abilReady, room.ms, 'ability ready');
  slay(room, w, a);
  slay(room, v, a); // 7
  assert.equal(lastKill().rw, 'lord');
  assert.ok(a.st.amp > room.ms);
  const bounty = a.bounty;
  assert.equal(bounty, 150);
  // damage amp
  w.hp = 100; w.shieldUntil = 0; w.alive = true;
  room.damage(w, a, 10, 'fb', 0, null);
  assert.ok(Math.abs(100 - w.hp - 10 * STREAK.lord.damage) < 0.01);
  // ending the run pays the bounty
  const before = w.score;
  slay(room, a, w);
  assert.equal(w.score - before, 100 + bounty + 25, 'kill + bounty + revenge for the earlier death');
  assert.ok(['bounty', 'shutdown', 'revenge'].every((m) => lastKill().med.includes(m)));
  assert.equal(a.bounty, 0);
});

test('comeback: three deaths in a row earn a Second Wind spawn', () => {
  const { room, conns, ents } = arena(2);
  const [a, b] = ents;
  for (let i = 0; i < STREAK.droughtDeaths; i++) slay(room, a, b);
  room.ms += 5000;
  room.spawn(a, true);
  assert.ok(a.st.blaze > room.ms, 'hot fireballs');
  assert.ok(a.shieldUntil - room.ms > 4500, 'longer protection');
  assert.ok(a.abilReady <= room.ms, 'ability ready');
  assert.equal(conns[1].json.filter((m) => m.t === 'spawn').pop().bonus, 'wind');
  assert.equal(a.drought, 0);
});

test('revenge and assists score, and medals reach the results board', () => {
  const { room, conns, ents } = arena(3);
  const [a, v, w] = ents;
  slay(room, a, v); // v kills a
  const s0 = a.score;
  slay(room, v, a); // a gets revenge
  assert.ok(conns[0].json.filter((m) => m.t === 'kill').pop().med.includes('revenge'));
  assert.equal(a.score - s0, 100 + 25);
  v.alive = true; v.hp = 100; v.shieldUntil = 0; v.dmgLog.clear();
  room.damage(v, w, 40, 'fb', 0, null); // 40 damage is over 30% of the hide: an assist
  room.damage(v, a, 80, 'fb', 0, null);
  assert.equal(w.assists, 1);
  assert.ok(conns[2].json.some((m) => m.t === 'abilcd'), 'assist trims the ability cooldown');
  a.kills = Math.max(a.kills, 3);
  room.endMatch();
  const mine = room.lastBoard.find((r) => r.id === a.id);
  assert.equal(mine.medals.revenge, 1);
  assert.ok(room.lastBoard.some((r) => r.awards.includes('Top Ace')));
  assert.ok(room.lastBoard.every((r) => typeof r.dmg === 'number' && r.medals));
});

test('ability messages cannot be used to deal damage from a distance or by a corpse', () => {
  const { room, ents } = arena(2, { breeds: ['storm', 'ember'] });
  const [a, b] = ents;
  b.fs.p = [0, 1400, -2000];
  say(room, a, { t: 'abil', hits: [b.id], dmg: 999, p: b.fs.p });
  assert.equal(b.hp, BREEDS.ember.hp, 'out of range and client-supplied fields ignored');
  assert.ok(a.abilReady <= room.ms, 'refused casts are free');
});

test('bot-only matches use abilities and stay sane in both modes', () => {
  for (const mode of ['ffa', 'tdm']) {
    const room = new Room({ seed: 99, mode });
    const conn = fakeConn();
    const me = room.join(conn, { name: 'Spectator' });
    me.alive = false; me.deadUntil = 1e12;
    run(room, 150);
    const abil = conn.json.filter((m) => m.t === 'abil');
    const kills = conn.json.filter((m) => m.t === 'kill');
    console.log(mode, '150 s: abilities', abil.length, 'kills', kills.length, 'kinds', [...new Set(abil.map((m) => m.k))].join(','));
    assert.ok(abil.length >= 6, 'bots use their abilities');
    assert.ok(kills.length >= 5);
    if (mode === 'tdm') {
      const friendly = conn.json.filter((m) => {
        const a = room.ents.get(m.a), v = room.ents.get(m.v);
        return m.t === 'dmg' && a && v && a !== v && a.team === v.team;
      });
      assert.equal(friendly.length, 0, 'no friendly damage in a full bot match');
    }
  }
});

test('counterplay: a last-moment barrel roll dodges Chain Lightning, a fast foe outruns the Nova, a dead caster cancels', () => {
  // dodge
  const { room, conns, ents } = arena(2, { breeds: ['storm', 'ember'] });
  const [a, b] = ents;
  b.fs.p = [0, 1400, -300];
  say(room, a, { t: 'abil' });
  run(room, 0.2);
  b.lastDodge = room.ms; // rolled just before the bolt lands
  run(room, 0.2);
  assert.equal(b.hp, BREEDS.ember.hp, 'dodged');
  const miss = conns[0].json.find((m) => m.t === 'abil' && m.ph === 'miss');
  assert.ok(miss && miss.dodged, 'everyone sees the miss');
  assert.ok(a.abilReady - room.ms < ABILITIES.storm.cooldown * 700, 'a miss refunds part of the cooldown');
  // out-flying the nova
  const n = arena(2, { breeds: ['frost', 'ember'] });
  n.ents[1].fs.p = [0, 1400, -150];
  say(n.room, n.ents[0], { t: 'abil' });
  n.ents[1].fs.p = [0, 1400, -ABILITIES.frost.radius - 60];
  run(n.room, 0.6);
  assert.equal(n.ents[1].hp, BREEDS.ember.hp, 'escaped the blast radius during the charge');
  // caster downed during the charge
  const c = arena(2, { breeds: ['frost', 'ember'] });
  c.ents[1].fs.p = [0, 1400, -100];
  say(c.room, c.ents[0], { t: 'abil' });
  slay(c.room, c.ents[0], c.ents[1]);
  run(c.room, 0.7);
  assert.equal(c.ents[1].hp, BREEDS.ember.hp, 'cancelled');
});

test('seekers keep their speed and catch a dragon in a hard turn', async () => {
  const { homeSeeker } = await import('../shared/combat.js');
  const { WEAPONS } = await import('../shared/constants.js');
  // target circles at 80 m/s on a 250 m radius; the seeker starts 500 m behind it
  const R = 250, w = 80 / R, dt = 1 / 60;
  const tgt = (t) => [R * Math.cos(w * t), 600, R * Math.sin(w * t)];
  const p = [R, 600, -500], v = [0, 0, WEAPONS.seeker.speed + 40];
  const speed0 = Math.hypot(...v);
  let best = Infinity;
  for (let t = 0; t < WEAPONS.seeker.life; t += dt) {
    const tp = tgt(t), tv = [-80 * Math.sin(w * t), 0, 80 * Math.cos(w * t)];
    best = Math.min(best, homeSeeker(p, v, tp, tv, dt, WEAPONS.seeker.turn));
    if (best < 3) break;
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
  }
  assert.ok(Math.abs(Math.hypot(...v) - speed0) < 1e-6, 'guidance must not change the speed');
  assert.ok(best < 3, `closest approach ${best.toFixed(1)} m`);
});
