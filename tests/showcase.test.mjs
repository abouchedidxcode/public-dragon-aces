// The title-screen film (client/js/showcase-flight.js): the dragon's route and every camera must stay out of the
// terrain, the Citadel, sea stacks, rock rings and sky islands, and keep the dragon in view, at every moment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../shared/world.js';
import * as castle from '../shared/castle.js';
import { buildFlight, scheduleShots, cameraAt, pickHero, clearView, newCamera, HERO, HERO_SPOTS, heroSpot } from '../client/js/showcase-flight.js';
import { CF } from '../client/js/render/cloudfield.js';

const world = createWorld();
const flight = buildFlight();
const sched = scheduleShots(flight);
const D = flight.duration;

test('the flight is a sensible loop', () => {
  assert.ok(D > 90 && D < 150, `about two minutes (${D.toFixed(1)} s)`);
  const a = flight.sample(0, flight.newState()), b = flight.sample(D - 1e-6, flight.newState());
  assert.ok(Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < 1, 'closed at the seam');
  const st = flight.newState();
  let prev = null, maxRoll = 0;
  for (let T = 0; T < D; T += 0.05) {
    flight.sample(T, st);
    assert.ok(st.speed > 50 && st.speed < 170, `speed ${st.speed.toFixed(0)} m/s at ${T.toFixed(1)} s`);
    assert.ok(Math.abs(st.bank) < 1.25, `bank at ${T.toFixed(1)} s`);
    if (prev !== null) maxRoll = Math.max(maxRoll, Math.abs(st.bank - prev) / 0.05);
    prev = st.bank;
  }
  assert.ok(maxRoll < 2.2, `roll rate stays animal, not a snap (${maxRoll.toFixed(2)} rad/s)`);
  const marks = Object.values(flight.marks);
  assert.ok(marks.every((t, i) => i === 0 || t > marks[i - 1]), 'route marks in order');
});

test('the dragon never touches rock, castle or sea', () => {
  const st = flight.newState();
  for (let T = 0; T < D; T += 0.1) {
    const p = flight.sample(T, st).p;
    const at = `${T.toFixed(1)} s at ${p.map(Math.round)}`;
    assert.ok(p[1] - world.floorAt(p[0], p[2]) > 15, `above the ground and the waves: ${at}`);
    assert.equal(world.hitSkyRock(p, 16), null, `clear of sky islands: ${at}`);
    assert.equal(world.hitLandmark(p, 16), null, `clear of stacks, ruins and rock rings: ${at}`);
    assert.equal(castle.hit(p, 16), null, `clear of the Citadel: ${at}`);
  }
});

test('the shot list covers the loop with real shots', () => {
  for (const s of sched) assert.ok(s.t1 - s.t0 > 3, `${s.type} at ${s.t0.toFixed(1)} s lasts over 3 s`);
  assert.ok(Math.abs(sched[sched.length - 1].t1 - D - sched[0].t0) < 1e-6, 'no gap at the seam');
});

test('every camera is in open air and sees the dragon', () => {
  const clear = clearView(world, 3);
  const cam = newCamera(), st = flight.newState();
  for (let T = 0; T < D; T += 0.1) {
    cameraAt(flight, sched, T, cam);
    const q = flight.sample(T, st).p;
    assert.ok(clear(cam.pos, q), `${cam.shot} camera at ${T.toFixed(1)} s (${cam.pos.map(Math.round)})`);
    assert.ok(cam.fov > 7 && cam.fov < 70, `${cam.shot} lens at ${T.toFixed(1)} s: ${cam.fov.toFixed(1)} deg`);
  }
});

test('a breed change at any moment cuts to a clear close-up', () => {
  const clear = clearView(world, 3);
  const cam = newCamera(), st = flight.newState();
  for (let T = 0; T < D; T += 0.5) {
    const pick = pickHero(flight, T, clearView(world));
    for (let h = 0; h <= HERO.dur; h += 0.1) {
      cameraAt(flight, sched, T + h, cam, h, pick);
      assert.ok(clear(cam.pos, flight.sample(T + h, st).p), `close-up from ${T.toFixed(1)} s, ${h.toFixed(1)} s in`);
    }
  }
});

test('every breed close-up spot is clear, sunlit, under the clouds, open behind and faces away from the menu', () => {
  const clear = clearView(world, 3);
  const cam = newCamera(), st = flight.newState();
  const sun = [0.5543, 0.3775]; // the sun's horizontal direction (render/atmosphere.js SKY.sunDir)
  const sl = Math.hypot(sun[0], sun[1]);
  const cloudFloor = Math.min(...CF.layers.map((l) => l.base - l.wobble)); // the lowest any cloud base gets
  assert.ok(HERO_SPOTS.length >= 3, 'a few spots, so successive picks vary');
  for (let i = 0; i < HERO_SPOTS.length; i++) {
    const s = heroSpot(flight, i);
    for (let h = 0; h <= HERO.dur + 1e-6; h += 0.1) {
      cameraAt(flight, sched, s.t + h, cam, h, s);
      const p = flight.sample(s.t + h, st).p, f = st.f;
      const at = `spot ${i} (${s.t.toFixed(1)} s), ${h.toFixed(1)} s in`;
      assert.ok(clear(cam.pos, p), `clear view: ${at}`);
      assert.ok(Math.max(p[1], cam.pos[1]) < cloudFloor - 8, `under the low clouds (${Math.round(p[1])} m): ${at}`);
      assert.ok(cam.pos[1] - world.floorAt(cam.pos[0], cam.pos[2]) > 25, `camera well above trees and waves: ${at}`);
      const o = [cam.pos[0] - p[0], cam.pos[2] - p[2]];
      assert.ok((o[0] * sun[0] + o[1] * sun[1]) / (Math.hypot(o[0], o[1]) * sl) > 0.3, `sun behind the camera: ${at}`);
      // the dragon faces screen right (its breath crosses the open frame, away from the menu column)
      const v = [cam.look[0] - cam.pos[0], cam.look[2] - cam.pos[2]];
      const right = [-v[1], v[0]]; // horizontal camera right = view x up
      assert.ok((f[0] * right[0] + f[2] * right[1]) / Math.hypot(...right) > 0.3, `faces screen right: ${at}`);
      // nothing solid close behind the dragon: sky, sea or land at least 300 m back (lit, and lifted by the haze)
      const d = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
      const dl = Math.hypot(...d);
      for (let k = 20; k < 300; k += 20) {
        const q = [p[0] + (d[0] / dl) * k, p[1] + (d[1] / dl) * k, p[2] + (d[2] / dl) * k];
        assert.ok(q[1] > world.height(q[0], q[2]) && !world.solidAt(q, 0), `open behind the dragon (rock ${k} m behind): ${at}`);
      }
    }
  }
});
