// "The map is too big. It takes too long to find people." A scripted room of 8 bots (no humans) is simulated for
// four minutes on six seeds (tools/encounter-bench.mjs) and the numbers are compared with the same script run on the
// old 4.2 km map, recorded before the map was shrunk. The bench only uses Room, so the numbers are the map's doing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureEncounters } from '../tools/encounter-bench.mjs';
import { WORLD } from '../shared/constants.js';

// Old map (radius 4200 m, ceiling 2600 m, terrainHalf 6400 m); node tools/encounter-bench.mjs 240 6 at the old commit.
const OLD = { firstDmg: 5.478, firstKill: 15.439, contact: 25.215, nearest: 995.519, engaged: 0.451, killsPerMin: 6.708, crashesPerMin: 0.333 };

test('8 bots find each other much faster than on the old map', () => {
  const { avg } = measureEncounters({ seconds: 240, seeds: 6, bots: 8 });
  console.log('encounters (old -> new):', Object.keys(OLD).map((k) => `${k} ${OLD[k].toFixed(2)} -> ${avg[k].toFixed(2)}`).join(', '));
  assert.ok(WORLD.radius <= 1800 && WORLD.radius >= 1500, 'battle radius between 1.5 and 1.8 km');
  assert.ok(avg.nearest < OLD.nearest * 0.5, `dragons are at least twice as close (${avg.nearest.toFixed(0)} m vs ${OLD.nearest} m to the nearest foe)`);
  assert.ok(avg.contact < OLD.contact * 0.5, `a fresh spawn meets a foe in under half the time (${avg.contact.toFixed(1)} s vs ${OLD.contact} s)`);
  assert.ok(avg.engaged > OLD.engaged * 1.3, `dragons spend far more of their time with a foe inside 500 m (${(avg.engaged * 100).toFixed(0)}% vs ${(OLD.engaged * 100).toFixed(0)}%)`);
  assert.ok(avg.firstKill < OLD.firstKill * 0.9, `first kill comes sooner (${avg.firstKill.toFixed(1)} s vs ${OLD.firstKill} s)`);
  assert.ok(avg.firstDmg < OLD.firstDmg, `first hit comes sooner (${avg.firstDmg.toFixed(1)} s vs ${OLD.firstDmg} s)`);
  assert.ok(avg.killsPerMin > OLD.killsPerMin * 1.15, `the room produces more kills (${avg.killsPerMin.toFixed(1)}/min vs ${OLD.killsPerMin}/min)`);
  // a denser map must not turn the bots into lemmings
  assert.ok(avg.crashesPerMin < 0.35, `bots mostly survive the terrain (${avg.crashesPerMin.toFixed(2)} crashes/min vs ${OLD.crashesPerMin}/min)`);
});

// "It's hard to ever really see the other dragons: a tiny dot, then they are there, then they are dead." The same bench
// with a scripted stand-in for a player (full throttle at the nearest foe, boost to close, fire when lined up) in a
// typical room. PREV is that run on the version before dragons were drawn 1.4x, rooms filled to 6 instead of 8, the
// map came in from 2.2 to 1.65 km and bots stopped jousting head-on: node tools/encounter-bench.mjs 240 6 8 with PILOT=1.
const PREV = { pApproach: 5.484, pVisual: 6.585, pFleeting: 0.225, lastLook: 4.452, crashesPerMin: 0.167 };

test('a player sees foes coming and fights them in view for longer', () => {
  const { avg } = measureEncounters({ seconds: 240, seeds: 6, bots: 6, pilot: true });
  console.log('in view (prev -> now):', Object.keys(PREV).map((k) => `${k} ${PREV[k].toFixed(2)} -> ${avg[k].toFixed(2)}`).join(', '));
  assert.ok(avg.pFleeting < PREV.pFleeting * 0.9, `fewer foes are only a blur (${(avg.pFleeting * 100).toFixed(0)}% of looks under 2 s vs ${(PREV.pFleeting * 100).toFixed(0)}%)`);
  assert.ok(avg.pVisual > PREV.pVisual * 1.08, `a foe stays within 300 m for longer (${avg.pVisual.toFixed(1)} s vs ${PREV.pVisual} s)`);
  assert.ok(avg.lastLook > PREV.lastLook, `kills come after a longer fight in view (${avg.lastLook.toFixed(1)} s vs ${PREV.lastLook} s)`);
  // pApproach (800 m -> 300 m) is printed but not pinned: it barely moved (5.5 s before, 5.4-5.6 s now); the gain is
  // in what happens once a foe is close, plus the dragons being drawn bigger, which the bench cannot see.
  assert.ok(avg.crashesPerMin < 0.3, `bots still mostly survive the terrain (${avg.crashesPerMin.toFixed(2)} crashes/min)`);
});
