// Landmarks (ruin sites and sea stacks) must be deterministic, levelled and solid where dragons could hit them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../shared/world.js';
import { Room } from '../shared/room.js';
import { WORLD, SPAWN } from '../shared/constants.js';
import { rng } from '../shared/math.js';
import * as castle from '../shared/castle.js';

const world = createWorld();

test('landmarks are deterministic', () => {
  const again = createWorld();
  assert.equal(JSON.stringify(again.sites.map((s) => [s.kind, s.x, s.z, s.y])), JSON.stringify(world.sites.map((s) => [s.kind, s.x, s.z, s.y])));
  assert.equal(JSON.stringify(again.stacks), JSON.stringify(world.stacks));
  assert.ok(world.sites.length >= 6, 'ruin sites placed');
  assert.ok(world.stacks.length >= 10, 'sea stacks placed');
});

test('ruin platforms are levelled', () => {
  for (const s of world.sites) {
    assert.ok(Math.abs(world.height(s.x, s.z) - s.y) < 0.01, `${s.kind} platform at ${s.x},${s.z}`);
    assert.ok(Math.abs(world.height(s.x + s.r * 0.6, s.z) - s.y) < 0.5);
  }
});

test('towers, pillars and sea stacks are solid', () => {
  for (const s of world.sites) {
    for (const c of s.colliders) {
      assert.ok(world.solidAt([c.x, (c.y0 + c.y1) / 2, c.z]), `${s.kind} collider is solid in the middle`);
      assert.ok(!world.solidAt([c.x, c.y1 + 6, c.z]), 'open air above the collider');
    }
  }
  for (const st of world.stacks) {
    assert.ok(world.solidAt([st.x, st.top - 3, st.z]), 'stack is solid below its top');
    if (!st.arch) assert.ok(!world.solidAt([st.x, st.top + 8, st.z]), 'open air above the stack'); // an arch stack carries its ring
    assert.ok(!world.solidAt([st.x + st.r * 3, st.top - 3, st.z + st.r * 3]) || world.height(st.x + st.r * 3, st.z + st.r * 3) > st.top - 3, 'not solid beside it');
  }
});

// Bots probe the path ahead for ruins and sea stacks. Real props are shorter than the 90-140 m ground clearance bots
// keep anyway, so the scenario uses an imaginary 60 m wide (about twice the widest real stack), 900 m tall pillar. The bot's own path is recorded first
// (the sim is deterministic), then the pillar goes where it would be 3.5 s later. The bot flies over an empty, flat
// stand-in for the world, so the result does not depend on the map layout (or on what else stands in the middle of it).
function botPath(seed, prop, avoid) {
  const room = new Room({ seed });
  room.join({ send() {} }, { name: 'T', breed: 'ember' });
  const bot = [...room.ents.values()].find((e) => e.isBot);
  const step = 1 / 30;
  for (let k = 0; k < 10 * 30 && !bot.alive; k++) { // bots start dead and respawn after a few seconds
    room.ms += step * 1000;
    room.tick(step);
  }
  room.world = Object.assign(Object.create(room.world), {
    floorAt: () => 0, solidAt: () => false, hitSkyRock: () => null,
    hitLandmark: (p, pad = 0) => (prop && avoid && Math.hypot(p[0] - prop.x, p[2] - prop.z) < prop.r + pad && p[1] < 900 + pad ? prop : null),
  });
  bot.fs.p = [-900, 450, 0];
  bot.fs.vel = [75, 0, 0];
  bot.fs.q = [0, Math.sin(-Math.PI / 4), 0, Math.cos(-Math.PI / 4)];
  const path = [];
  let inside = false;
  for (let k = 0; k < 9 * 30 && bot.alive; k++) {
    room.ms += step * 1000;
    room.tick(step);
    path.push([bot.fs.p[0], bot.fs.p[2]]);
    if (prop && Math.hypot(bot.fs.p[0] - prop.x, bot.fs.p[2] - prop.z) < prop.r && bot.fs.p[1] < 900) inside = true;
  }
  return { path, inside };
}

test('bots steer around props in their path', () => {
  let control = 0, avoided = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const free = botPath(seed, null, false).path;
    const at = free[Math.floor(3.5 * 30)];
    const prop = { x: at[0], z: at[1], r: 30 };
    if (botPath(seed, prop, false).inside) control++;
    if (botPath(seed, prop, true).inside) avoided++;
  }
  assert.ok(control >= 3, `the scenario flies into the pillar without avoidance (${control}/4)`);
  assert.equal(avoided, 0, `${avoided}/4 bots flew into the pillar with avoidance`);
});

test('landmark scan stays cheap', () => {
  const t = performance.now();
  createWorld();
  assert.ok(performance.now() - t < 800, 'createWorld under 0.8 s');
});

// ---- the compact map -------------------------------------------------------------------------------------------
test('the world is scaled coherently', () => {
  assert.ok(WORLD.radius >= 1500 && WORLD.radius <= 1800, 'battle radius 1.5-1.8 km');
  assert.ok(WORLD.ceiling >= 1600 && WORLD.ceiling <= 1800, 'ceiling 1.6-1.8 km');
  assert.ok(WORLD.terrainHalf > WORLD.radius * 1.5, 'terrain reaches well past the radius, so the edge never shows');
  assert.equal((WORLD.terrainHalf * 2) % 800, 0, 'the forest blocks tile the terrain');
  assert.equal((WORLD.terrainHalf * 2) % 600, 0, 'the terrain chunks tile the terrain');
  for (const s of world.sky) assert.ok(s.y + s.r * 0.3 < WORLD.ceiling - 150 && Math.hypot(s.x, s.z) + s.r < WORLD.radius, 'sky island inside the arena and under the ceiling');
  for (const s of world.sites) if (s.x * s.x + s.z * s.z < (WORLD.radius * 1.3) ** 2) assert.ok(Math.hypot(s.x, s.z) < WORLD.radius * 1.4);
});

test('the castle site is a plateau with the Citadel massif standing on it and nothing else', () => {
  const c = world.castleSite;
  assert.ok(c.x === 0 && c.z === 0 && c.radius >= 550 && c.height >= 60 && c.height <= 200, 'plateau at the centre, 60-200 m up');
  // the Citadel's rock pillar (shared/castle.js terrain) stands on the plateau: its top is level at the courtyard floor,
  // and it covers the plateau's whole disc, so no point of the disc is below the plateau and none above the pillar
  assert.ok(Math.abs(world.height(0, 0) - castle.CASTLE.y0) < 0.001, 'the courtyard is level');
  for (let a = 0; a < 64; a++) {
    for (const f of [0, 0.3, 0.6, 0.8, 1]) {
      const x = Math.cos(a) * c.radius * f, z = Math.sin(a) * c.radius * f;
      const h = world.height(x, z);
      assert.ok(h >= c.height - 0.001 && h <= castle.CASTLE.y0 + 3, `plateau or massif at ${Math.round(x)},${Math.round(z)}: ${h.toFixed(0)}`);
      assert.equal(world.plateauAt(x, z), 1);
    }
  }
  for (let a = 0; a < 32; a++) assert.ok(Math.abs(world.height(Math.cos(a) * 300, Math.sin(a) * 300) - castle.CASTLE.y0) < 0.001, 'the massif top is dead flat inside 300 m');
  assert.ok(world.height(c.radius + c.skirt * 1.6, 0) < c.height - 40 || world.height(0, c.radius + c.skirt * 1.6) < c.height - 40, 'it falls away outside the skirt');
  const clear = c.clear;
  for (const s of world.sites) assert.ok(Math.hypot(s.x, s.z) > clear + s.r, `${s.kind} clear of the castle`);
  for (const s of world.sky) assert.ok(Math.hypot(s.x, s.z) - s.r > clear, 'sky island clear of the castle');
  for (const s of world.stacks) assert.ok(Math.hypot(s.x, s.z) > clear, 'stack clear of the castle');
  for (const a of world.arches) assert.ok(Math.hypot(a.x, a.z) - a.R - a.t > clear, 'arch clear of the castle');
  assert.ok(world.shrines.slice(0, world.sky.length).every((p) => Math.hypot(p[0], p[2]) > clear), 'island shrines clear of the castle (the Citadel has two of its own)');
});

test('the ring: passes are flyable, fjords are sea, falls pour into them', () => {
  assert.equal(world.passes.length, 6);
  for (const p of world.passes) {
    for (let r = 1100; r < 1900; r += 50) {
      if (p.inlet && r > p.head - 20) continue;
      const th = world.passAngle(p, r);
      const y = world.passFloor(p, r) + 40;
      assert.ok(!world.solidAt([Math.cos(th) * r, y, Math.sin(th) * r], 8) || world.arches.some((a) => Math.hypot(a.x - Math.cos(th) * r, a.z - Math.sin(th) * r) < 80), `pass ${p.k} open at r=${r}`);
    }
  }
  const inlets = world.passes.filter((p) => p.inlet);
  assert.ok(inlets.length >= 2, 'at least two sea inlets');
  assert.equal(world.waterfalls.length, inlets.length, 'a waterfall at the head of every inlet');
  for (const f of world.waterfalls) {
    assert.ok(world.height(f.x, f.z) > 60, 'fall lip well above the sea');
    assert.ok(world.height(f.x + f.dx * 90, f.z + f.dz * 90) < -5, 'fall ends in the sea');
  }
  for (const p of inlets) {
    const r = p.head + 200, th = world.passAngle(p, r);
    assert.ok(world.height(Math.cos(th) * r, Math.sin(th) * r) < -20, 'deep water down the middle of the fjord');
  }
});

test('rock rings are solid and can be flown through', () => {
  assert.ok(world.arches.length >= 5, 'at least five rings');
  assert.ok(world.arches.some((a) => a.kind === 'sky') && world.arches.some((a) => a.kind === 'gate') && world.arches.some((a) => a.kind === 'sea'));
  for (const a of world.arches) {
    const ax = Math.cos(a.yaw), az = Math.sin(a.yaw);
    // the top of the tube is rock; the middle of the hole and the air a wing-length beyond the ring are not
    assert.ok(world.solidAt([a.x, a.y + a.R, a.z]), `ring ${a.kind} is solid at its crown`);
    assert.ok(world.hitLandmark([a.x, a.y + a.R, a.z]) === a || world.hitLandmark([a.x, a.y + a.R, a.z]), 'and reported as a landmark');
    for (const along of [-120, -40, 0, 40, 120]) {
      for (const [dx, dy] of [[0, 0], [0, 12], [12, 0], [-12, -6]]) {
        const p = [a.x + ax * along + -az * dx, a.y + dy + (a.kind === 'gate' ? 8 : 0), a.z + az * along + ax * dx];
        assert.ok(!world.hitArch(p, 3), `flying through the ${a.kind} ring at ${along} m along its axis (${dx}, ${dy}) is clear`);
      }
    }
    assert.ok(a.R >= 38 && a.R <= 70, 'a wing-friendly hole');
  }
  // the ring's own stack carries it, so that sea ring stands on solid rock
  const sea = world.arches.find((a) => a.kind === 'sea');
  assert.ok(world.stacks.some((s) => s.arch && Math.hypot(s.x - sea.x, s.z - sea.z) < 2));
});

test('spawns land players 600-1200 m from the action, never on top of an enemy or in rock', () => {
  const rand = rng(11);
  let worst = Infinity, far = 0;
  for (let trial = 0; trial < 150; trial++) {
    const others = [];
    for (let i = 0; i < 7; i++) {
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * WORLD.radius * 0.8;
      others.push([Math.cos(a) * d, 250 + rand() * 900, Math.sin(a) * d]);
    }
    const p = world.spawnPoint(rand, others);
    assert.ok(!world.solidAt(p, 40), 'not inside the ground or a prop');
    assert.ok(p[1] < WORLD.ceiling - 300 && Math.hypot(p[0], p[2]) < WORLD.radius * 0.8, 'inside the arena, well under the ceiling');
    assert.ok(p[1] > world.clearAltitude(p[0], p[2]) - 1, 'high enough to clear the land between here and the castle');
    const nn = Math.min(...others.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])));
    worst = Math.min(worst, nn);
    if (nn > 1250) far++;
  }
  assert.ok(worst >= SPAWN.clear, `never closer than ${SPAWN.clear} m to another dragon (${worst.toFixed(0)})`);
  assert.ok(far <= 8, 'almost always within about a kilometre of someone');
});
