// End-to-end test against a running room server:
//   npm run build && npm run serve
//   DRAGON_URL=ws://127.0.0.1:8080/ws node --test tests/online.test.mjs
// Skipped when DRAGON_URL is not set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, encodeState, decodeSnapshot } from '../shared/protocol.js';
import { ABILITIES, BREEDS, MAX_PLAYERS } from '../shared/constants.js';

const URL = process.env.DRAGON_URL;

function client(join) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.binaryType = 'arraybuffer';
    const c = { ws, msgs: [], snaps: [], welcome: null, waiters: [] };
    c.send = (m) => ws.send(typeof m === 'string' || m instanceof ArrayBuffer ? m : JSON.stringify(m));
    c.wait = (pred, ms = 4000) =>
      new Promise((res, rej) => {
        const hit = c.msgs.find(pred);
        if (hit) return res(hit);
        const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
        c.waiters.push({ pred, res: (m) => (clearTimeout(t), res(m)) });
      });
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        c.msgs.push(m);
        if (m.t === 'welcome') {
          c.welcome = m;
          resolve(c);
        }
        if (m.t === 'error') reject(new Error(m.msg));
        c.waiters = c.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
      } else c.snaps.push(decodeSnapshot(e.data));
    };
    ws.onopen = () => c.send({ t: 'join', ...join, pv: PROTOCOL });
    ws.onerror = () => reject(new Error('socket error'));
    ws.onclose = (e) => reject(new Error(`closed ${e.code} ${e.reason}`));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('two riders meet in a private sky and fight', { skip: !URL }, async () => {
  const a = await client({ name: 'Alpha', breed: 'ember', mode: 'create', bots: false });
  const code = a.welcome.code;
  assert.match(code, /^[A-Z]{4}$/);
  const b = await client({ name: 'Bravo', breed: 'frost', mode: 'code', code });
  assert.equal(b.welcome.code, code);
  await a.wait((m) => m.t === 'join' && m.e.name === 'Bravo');
  const aId = a.welcome.you, bId = b.welcome.you;
  // the room adds bots up to 8 dragons
  assert.ok(b.welcome.ents.length >= 2);

  // both fly: A sits at its spawn, B parks 200 m in front of A
  const pa = a.welcome.spawn.p;
  const st = (p) => ({ p, q: [0, 0, 0, 1], speed: 80, throttle: 0.6 });
  for (let i = 0; i < 6; i++) {
    a.send(encodeState(st(pa), 0, i));
    b.send(encodeState(st(b.welcome.spawn.p), 0, i));
    await sleep(60);
  }
  // after spawn, moves are sanity-checked; walk B over to A in legal steps
  let pb = [...b.welcome.spawn.p];
  const target = [pa[0], pa[1], pa[2] - 200];
  for (let i = 0; i < 400; i++) {
    const d = [target[0] - pb[0], target[1] - pb[1], target[2] - pb[2]];
    const l = Math.hypot(...d);
    if (l < 1) break;
    const step = Math.min(l, 40);
    pb = pb.map((v, k) => v + (d[k] / l) * step);
    b.send(encodeState(st(pb), 0, 10 + i));
    if (i % 2 === 0) a.send(encodeState(st(pa), 0, 10 + i));
    await sleep(52);
  }
  await sleep(150);
  const snap = a.snaps[a.snaps.length - 1];
  const seenB = snap.ents.find((e) => e.id === bId);
  assert.ok(seenB, 'A sees B in snapshots');
  assert.ok(Math.hypot(seenB.p[0] - target[0], seenB.p[2] - target[2]) < 20, 'B is where it flew');

  // wait out spawn protection, then A fires at B and claims the hit
  await sleep(3200);
  a.send({ t: 'fire', k: 'fb', s: 1, o: [pa[0], pa[1], pa[2] - 9], d: [0, 0, -1] });
  const relayed = await b.wait((m) => m.t === 'fire' && m.a === aId);
  assert.equal(relayed.k, 'fb');
  await sleep(500);
  a.send({ t: 'hit', s: 1, v: bId, p: [target[0], target[1], target[2] + 2] });
  const dmg = await b.wait((m) => m.t === 'dmg' && m.v === bId && m.a === aId);
  assert.equal(dmg.hp, BREEDS.frost.hp - BREEDS.ember.fbDamage);

  // a forged claim for an unknown shot does nothing
  a.send({ t: 'hit', s: 77, v: bId, p: target });
  await sleep(300);
  assert.equal(b.msgs.filter((m) => m.t === 'dmg' && m.v === bId).length, 1);

  // B crashes right after being hit: A gets the kill
  b.send({ t: 'crash', why: 'crash' });
  const kill = await a.wait((m) => m.t === 'kill' && m.v === bId);
  assert.equal(kill.a, aId);
  assert.equal(kill.as.kills, 1);
  const spawn = await b.wait((m) => m.t === 'spawn' && m.id === bId, 8000);
  assert.equal(spawn.hp, BREEDS.frost.hp);

  // pings come back with the server clock
  b.send({ t: 'ping', c: 123 });
  const pong = await b.wait((m) => m.t === 'pong' && m.c === 123);
  assert.ok(pong.ms > 0);

  b.ws.close();
  await a.wait((m) => m.t === 'leave' && m.id === bId);
  a.ws.close();
});

test('quick battle puts riders together and fills with bots', { skip: !URL }, async () => {
  const a = await client({ name: 'Q1', breed: 'storm', mode: 'quick' });
  const b = await client({ name: 'Q2', breed: 'venom', mode: 'quick' });
  assert.equal(a.welcome.code, b.welcome.code);
  await sleep(600);
  const snap = a.snaps[a.snaps.length - 1];
  assert.ok(snap.ents.length >= 6, 'bots keep at least 6 dragons in the sky');
  const bots = snap.ents.filter((e) => e.id !== a.welcome.you && e.id !== b.welcome.you);
  await sleep(1000);
  const later = a.snaps[a.snaps.length - 1];
  const moved = bots.filter((e) => {
    const l = later.ents.find((x) => x.id === e.id);
    return l && Math.hypot(l.p[0] - e.p[0], l.p[2] - e.p[2]) > 30;
  });
  assert.ok(moved.length >= bots.length - 1, 'bots are flying');
  a.ws.close();
  b.ws.close();
});

test('a full sky of riders fits in one room', { skip: !URL }, async () => {
  const first = await client({ name: 'Host', breed: 'ember', mode: 'create' });
  const code = first.welcome.code;
  const all = [first];
  for (let i = 1; i < MAX_PLAYERS; i++) all.push(await client({ name: 'R' + i, breed: 'ember', mode: 'code', code }));
  await sleep(400);
  const snap = first.snaps[first.snaps.length - 1];
  assert.equal(snap.ents.length, MAX_PLAYERS, `${MAX_PLAYERS} dragons, no bots`);
  await assert.rejects(client({ name: 'Late', breed: 'ember', mode: 'code', code }), /full/);
  for (const c of all) c.ws.close();
});

test('team deathmatch private sky: teams and a breed ability over the wire', { skip: !URL }, async () => {
  const a = await client({ name: 'Gold1', breed: 'frost', mode: 'create', gm: 'tdm', bots: false });
  assert.equal(a.welcome.match.mode, 'tdm');
  const b = await client({ name: 'Mate', breed: 'ember', mode: 'code', code: a.welcome.code });
  const me = a.welcome.ents.find((e) => e.id === a.welcome.you);
  const other = b.welcome.ents.find((e) => e.id === b.welcome.you);
  assert.ok(me.team === 0 || me.team === 1);
  assert.notEqual(me.team, other.team, 'two humans land on opposite flights');

  // the signature ability is ready a few seconds after spawning; Frost Nova always fires
  const pa = a.welcome.spawn.p;
  const st = { p: pa, q: [0, 0, 0, 1], speed: 80, throttle: 0.6 };
  for (let i = 0; i < 4; i++) { a.send(encodeState(st, 0, i)); await sleep(60); }
  a.send({ t: 'abil' });
  await sleep(300);
  assert.ok(!a.msgs.some((m) => m.t === 'abil'), 'too early after spawning');
  await sleep(5200);
  a.send(encodeState(st, 0, 9));
  a.send({ t: 'abil' });
  const nova = await a.wait((m) => m.t === 'abil' && m.a === a.welcome.you);
  assert.equal(nova.k, 'nova');
  assert.equal(nova.cd, ABILITIES.frost.cooldown);
  assert.equal(nova.ph, 'charge');
  await a.wait((m) => m.t === 'abil' && m.a === a.welcome.you && m.ph === 'fire');
  await b.wait((m) => m.t === 'abil' && m.a === a.welcome.you);
  a.ws.close();
  b.ws.close();
});
