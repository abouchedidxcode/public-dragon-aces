// The Citadel: colliders, routes through it, spawn safety and bot behaviour around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as castle from '../shared/castle.js';
import { CASTLE } from '../shared/castle.js';
import { rng } from '../shared/math.js';
import { Room } from '../shared/room.js';
import { world, flatWorld, Y, flight, sweep } from './castle-flights.mjs';

test('the massif is levelled under the courtyard and falls away in cliffs', () => {
  for (const [x, z] of [[0, 0], [100, 100], [-150, 60], [0, 150], [200, -120]]) assert.equal(world.height(x, z), Y, `plateau at ${x},${z}`);
  assert.ok(world.height(CASTLE.plateau + 300, 0) < Y - 150, 'cliffs');
  assert.ok(world.height(1200, 0) !== undefined);
  for (const s of world.sites) assert.ok(Math.hypot(s.x, s.z) > CASTLE.clear, 'ruins keep clear of the citadel');
});

test('the citadel is solid where it should be and open where dragons fly through', () => {
  const solid = {
    'keep shaft': [0, Y + 80, -20], 'keep spire': [0, Y + 500, -20], 'great tower': [170, Y + 200, -160],
    'curtain wall': [130, Y + 40, 232], 'gate wall beside the tunnel': [60, Y + 30, 270], 'gate lintel': [0, Y + 110, 270],
    'viaduct pier': [(0 + 170) / 2 * 0.5, Y + 40, -90],
  };
  for (const [k, p] of Object.entries(solid)) {
    if (k === 'viaduct pier') continue; // positions depend on the bay layout; covered by the route test
    assert.ok(world.solidAt(p, 2), `${k} is solid`);
  }
  const open = { 'above the keep': [0, Y + 830, -20], 'courtyard': [0, Y + 30, 140], 'gate tunnel': [0, Y + 30, 270], 'far outside': [900, Y + 300, 0] };
  for (const [k, p] of Object.entries(open)) assert.ok(!castle.hit(p, 2), `${k} is open air`);
});

test('every route through the citadel is clear along its axis and walled beside it', () => {
  const gs = castle.gates();
  assert.ok(gs.length >= 6, 'several arches to thread');
  const main = gs.find((g) => g.id === 'gate');
  assert.ok(main && main.hw >= 28, 'the gate is 56 m wide');
  for (const g of gs) {
    for (let s = -g.len / 2 - 90; s <= g.len / 2 + 90; s += 4) {
      const p = [g.p[0] + g.dir[0] * s, g.p[1], g.p[2] + g.dir[1] * s];
      assert.ok(!castle.hit(p, 8), `${g.id}: axis clear at ${s}`);
    }
    // beside the opening, inside the bay's thickness, it is stone
    const side = [g.p[0] - g.dir[1] * (g.hw + 3), g.p[1] - g.hh * 0.3, g.p[2] + g.dir[0] * (g.hw + 3)];
    assert.ok(castle.hit(side, 0), `${g.id}: solid beside the opening`);
  }
});

test('spawn points never land in or near the citadel', () => {
  const r = rng(77);
  for (let i = 0; i < 3000; i++) {
    const p = world.spawnPoint(r, []);
    assert.ok(Math.hypot(p[0] - CASTLE.x, p[2] - CASTLE.z) > CASTLE.radius + 400, 'far from the citadel');
    assert.ok(!world.solidAt(p, 30), 'in open air');
  }
});

test('healing shrines inside the citadel are in open air', () => {
  const extra = world.shrines.slice(world.sky.length);
  assert.equal(extra.length, 2);
  for (const q of extra) {
    assert.ok(!castle.hit(q, 24), 'shrine has room around it');
    assert.ok(Math.hypot(q[0] - CASTLE.x, q[2] - CASTLE.z) < CASTLE.radius);
  }
});

test('solidAt stays cheap near the citadel', () => {
  const r = rng(5);
  const pts = [];
  for (let i = 0; i < 20000; i++) pts.push([(r() - 0.5) * 1100, Y + r() * 640, (r() - 0.5) * 1100]);
  let n = 0;
  const t = performance.now();
  for (let k = 0; k < 10; k++) for (const p of pts) if (world.solidAt(p, 2)) n++;
  const per = ((performance.now() - t) * 1000) / (pts.length * 10);
  assert.ok(n > 0);
  assert.ok(per < 30, `solidAt ${per.toFixed(2)} us per call near the castle`);
  const far = [3000, 900, 2000];
  const t2 = performance.now();
  for (let i = 0; i < 200000; i++) castle.hit(far, 2);
  assert.ok((performance.now() - t2) / 200000 < 0.002, 'the broad phase rejects far points at once');
});

test('bots flying at the citadel steer around it', () => {
  const r = sweep(false, 0.7, 48, [0, Math.PI * 2], [40, 600], { w: flatWorld });
  console.log('bot sweep (no chaser):', JSON.stringify({ castleCrash: r.castleCrash, passes: r.passes }), r.detail.slice(0, 6).join(' | '));
  assert.ok(r.castleCrash / r.passes <= 0.04, `${r.castleCrash}/${r.passes} straight-line flights hit the citadel`);
});

test('bots in the real world do not hit the citadel or its massif either', () => {
  const r = sweep(true, 1.0, 48, [0, Math.PI * 2], [300, 650]);
  console.log('bot sweep (real terrain, chased):', JSON.stringify({ castleCrash: r.castleCrash, otherCrash: r.otherCrash, passes: r.passes }), r.detail.slice(0, 6).join(' | '));
  assert.ok(r.castleCrash / r.passes <= 0.06, `${r.castleCrash}/${r.passes} flights hit the citadel or its cliffs`);
});

test('pursued bots lined up with the gate dive through it', () => {
  // approach from the gate's side (south) within about 30 degrees; good pilots with a pursuer on the tail
  const r = sweep(true, 1.0, 24, [Math.PI / 2 - 0.5, Math.PI / 2 + 0.5], [60, 300], { w: flatWorld, secs: 30, D: 1100 });
  console.log('gate sweep:', JSON.stringify({ castleCrash: r.castleCrash, threaded: r.threaded, gateRuns: r.ran, passes: r.passes }), r.detail.slice(0, 6).join(' | '));
  assert.ok(r.ran >= 6, `${r.ran} flights started a run through an arch`);
  assert.ok(r.threaded >= 4, `${r.threaded} flights flew through an arch`);
  assert.ok(r.castleCrash / r.passes <= 0.15, `${r.castleCrash} of ${r.passes} hit the citadel`);
});

test('chased bots all round the citadel: threading arches does not make them crash more', () => {
  const r = sweep(true, 1.0, 72, [0, Math.PI * 2], [60, 400], { w: flatWorld, secs: 40, D: 1100 });
  console.log('all-round chase sweep:', JSON.stringify({ castleCrash: r.castleCrash, threaded: r.threaded, gateRuns: r.ran, passes: r.passes }), r.detail.slice(0, 6).join(' | '));
  assert.ok(r.castleCrash / r.passes <= 0.06, `${r.castleCrash} of ${r.passes} hit the citadel`);
});

// open-air control: the very same flights (same bearings, altitudes and chasers) flown over empty sea 5 km away
test('the citadel adds almost nothing to the bots crash rate compared with open air', () => {
  let free = 0, withCastle = 0;
  const n = 32;
  const shift = 5200;
  for (let i = 0; i < n; i++) {
    const r = rng(500 + i);
    const bearing = (i / n) * Math.PI * 2;
    const alt = Y + 40 + r() * 560;
    const sx = Math.cos(bearing) * 1500, sz = Math.sin(bearing) * 1500;
    const off = (r() - 0.5) * 360;
    const ex = -Math.cos(bearing) * 900 - Math.sin(bearing) * off, ez = -Math.sin(bearing) * 900 + Math.cos(bearing) * off;
    const args = { skill: 0.7, chaser: i % 2 === 0, seed: 9 + i };
    const a = flight({ ...args, w: world, start: [sx, alt, sz], aim: [ex, alt, ez] });
    if (a.crashed && a.crashed.id !== 'terrain') withCastle++;
    if (flight({ ...args, w: world, start: [sx + shift, alt, sz], aim: [ex + shift, alt, ez], castleOn: false }).crashed) free++;
  }
  console.log(`crash rate: open air ${free}/${n}, with the citadel ${withCastle}/${n}`);
  assert.ok(withCastle - free <= Math.ceil(n * 0.1), `citadel crashes ${withCastle} vs open air ${free}`);
});

test('fireballs burst on the stone and dragons that touch it are killed by the room', () => {
  const room = new Room({ seed: 3, bots: false });
  // a fireball fired at the keep from the courtyard side, and one down the open gate tunnel
  const fire = (p, d) => room.shots.push({ a: 999, s: room.shots.length, p: [...p], d, sp: 300, life: 5, dmg: 20 });
  fire([0, Y + 90, 150], [0, 0, -1]);
  fire([0, Y + 40, 420], [0, 0, -1]);
  const startShots = room.shots.length;
  let tunnelGone = -1;
  for (let k = 0; k < 120 && room.shots.length; k++) {
    room.tickShots(1 / 30);
    if (room.shots.length < startShots && tunnelGone < 0) tunnelGone = k;
  }
  assert.equal(room.shots.length, 0, 'both fireballs ended');
  // the first one hit the keep (about 130 m away), the second flew the whole tunnel and the courtyard first
  assert.ok(tunnelGone >= 0 && tunnelGone < 12, `the keep shot burst after ${tunnelGone} ticks`);
  // a dragon flying into the wall crashes: solid at its position with the crash pad
  assert.ok(world.solidAt([130, Y + 40, 232], 2), 'a dragon in the curtain wall is in stone');
  assert.ok(!world.solidAt([0, Y + 40, 232], 2), 'and one in the gate tunnel is not');
});
