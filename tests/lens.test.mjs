// Target lenses (client/js/render/lens.js): which dragons get a magnifier, how strongly it magnifies, when it hands
// over to the plain view, merging, the cap on how many show at once, line of sight, the one name label, and the off
// switch. Plus the threat cue (client/js/threats.js) that gives dragons lining up a shot at you lens priority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LENS, LensDirector, focalPx, lensFill, lensRadius, maxLensesFor } from '../client/js/render/lens.js';
import { THREAT, ThreatDetector } from '../client/js/threats.js';

const W = 1280, H = 720;
const camera = new THREE.PerspectiveCamera(68, W / H, 1, 26000);
camera.updateMatrixWorld();
camera.updateProjectionMatrix();

let nextId = 1;
// a dragon at distance d, offset by (x, y) radians from straight ahead
function dragon(d, x = 0, y = 0, extra = {}) {
  const pos = new THREE.Vector3(Math.sin(x) * d, Math.sin(y) * d, -Math.cos(x) * Math.cos(y) * d);
  return { ent: { id: nextId++, name: 'Bot', hp: 100 }, pos, dist: d, inCloud: false, ally: false, color: '#f80', maxHp: 100, ...extra };
}
const place = (e, d) => { e.dist = d; e.pos.setLength(d); };

function ctxFor(enemies, extra = {}) {
  return { camera, W, H, enemies, lockId: 0, lockP: 0, locked: false, nose: { x: W / 2, y: H / 2 }, attackers: new Set(), maxLenses: 3, enabled: true, ...extra };
}
function run(dir, enemies, frames = 30, extra = {}) {
  let out;
  for (let i = 0; i < frames; i++) out = dir.update(1 / 30, ctxFor(enemies, extra));
  return out;
}

test('a far dragon gets a lens; its size inside the glass shrinks with range so it still reads as distance', () => {
  const R = lensRadius(W, H);
  let prevSpan = Infinity;
  for (const d of [500, 900, 1200, 1800]) {
    const e = dragon(d, 0.02, 0.02);
    const out = run(new LensDirector(), [e], 30, { nose: null });
    assert.equal(out.lenses.length, 1, `one lens at ${d} m`);
    const L = out.lenses[0];
    assert.ok(L.alpha > 0.95, 'fully faded in');
    const natural = (LENS.span * focalPx(camera, H)) / d;
    const span = natural * L.m; // wingspan inside the lens, px
    const k = span / (lensFill(d) * R);
    assert.ok(Math.abs(k - 1) < 0.05 || L.m >= LENS.mMax - 0.01, `size follows lensFill at ${d} m (${k.toFixed(2)})`);
    assert.ok(span < prevSpan, `smaller further away (${d} m: ${span.toFixed(1)} px)`);
    prevSpan = span;
    assert.equal(L.views.length, 1);
  }
  assert.equal(lensFill(100), LENS.fill);
  assert.equal(lensFill(LENS.fillNear), LENS.fill);
  assert.ok(Math.abs(lensFill(LENS.fillFarFrom) - LENS.fill * LENS.fillFar) < 1e-9);
  assert.ok(Math.abs(lensFill(2500) - LENS.fill * LENS.fillFar) < 1e-9);
  assert.equal(run(new LensDirector(), [dragon(2000, 0.02, 0.02)]).lenses.length, 0, 'nothing past maxDist (the arena is 1650 m)');
});

test('close dragons need no lens; the lens fades out smoothly as one closes in', () => {
  const near = dragon(90, 0.02, 0);
  const o = run(new LensDirector(), [near]);
  assert.equal(o.lenses.length, 0);
  assert.ok(o.near.has(near.ent.id), 'big on screen: plain close-range marks');
  const e = dragon(1200, 0.02, 0.02);
  const dir = new LensDirector();
  const first = run(dir, [e], 30, { nose: null });
  assert.ok(!first.near.has(e.ent.id), 'far away: no close-range marks');
  let prev = 1;
  for (let d = 1200; d >= 100; d -= 10) {
    place(e, d);
    const out = dir.update(1 / 30, ctxFor([e], { nose: null }));
    const a = out.lenses.length ? out.lenses[0].alpha : 0;
    assert.ok(Math.abs(a - prev) < 0.2, `no pop at ${d} m (${prev.toFixed(2)} -> ${a.toFixed(2)})`);
    // the close-range marks (drawn at 1 - cover) are there by the time the lens has gone
    if (a < 0.01 && d < 400) assert.ok(out.near.has(e.ent.id), `close marks once the lens is gone at ${d} m`);
    if (d > 700) assert.ok(!out.near.has(e.ent.id), `no close marks far away (${d} m)`);
    prev = a;
  }
  assert.equal(prev, 0, 'gone up close');
});

test('the dragon you are on hands its lens over early, so the real dragon and the lead pip show', () => {
  const d = 450;
  const aimed = dragon(d, 0.01, 0.01);
  const outA = run(new LensDirector(), [aimed], 60);
  assert.equal(outA.aimedId, aimed.ent.id);
  const other = dragon(d, 0.01, 0.01);
  const outB = run(new LensDirector(), [other], 60, { nose: null });
  const aA = outA.lenses.length ? outA.lenses[0].alpha : 0;
  const aB = outB.lenses[0].alpha;
  assert.ok(aB > 0.95, `a dragon you are not on keeps its lens at ${d} m (${aB.toFixed(2)})`);
  assert.ok(aA < 0.8, `the aimed one is handing over (${aA.toFixed(2)})`);
  assert.ok(outA.near.has(aimed.ent.id), 'and gets its close-range marks');
  // beyond focusDist nothing changes
  const farA = run(new LensDirector(), [dragon(800, 0.01, 0.01)], 60);
  assert.ok(farA.lenses[0].alpha > 0.95);
  // switching target never pops the lens
  const e = dragon(d, 0.01, 0.01), dir = new LensDirector();
  run(dir, [e], 60, { nose: null });
  let prev = dir.out.lenses[0].alpha;
  for (let i = 0; i < 60; i++) {
    const a = dir.update(1 / 30, ctxFor([e])).lenses[0]?.alpha ?? 0;
    assert.ok(Math.abs(a - prev) < 0.12, `eased (${prev.toFixed(2)} -> ${a.toFixed(2)})`);
    prev = a;
  }
});

test('at most 3 lenses (2 on touch and small screens), and the lock target always has one', () => {
  const es = [dragon(700, -0.4, 0.1), dragon(900, -0.2, -0.1), dragon(800, 0.2, 0.15), dragon(1000, 0.4, -0.15), dragon(1500, 0.5, 0.25)];
  const lockId = es[4].ent.id;
  const out = run(new LensDirector(), es, 30, { lockId, lockP: 0.5 });
  assert.equal(out.lenses.length, 3);
  const L = out.lenses.find((l) => l.id === lockId);
  assert.ok(L, 'lock target lensed');
  assert.equal(L.lockP, 0.5);
  assert.equal(run(new LensDirector(), es, 30, { maxLenses: 2 }).lenses.length, 2, 'the renderer caps it (quality 0)');
  assert.equal(run(new LensDirector(), es, 30, { touch: true }).lenses.length, 2, 'touch screen');
  const small = run(new LensDirector(), es, 30, { W: 844, H: 390 });
  assert.equal(small.lenses.length, 2, 'phone-sized viewport');
  assert.equal(maxLensesFor(1280, 720, false), 3);
  assert.equal(maxLensesFor(1280, 720, true), 2);
  assert.equal(maxLensesFor(900, 480, false), 2);
  assert.equal(maxLensesFor(1280, 720, false, 2), 2);
});

test('dragons bunched up on screen share one lens; lenses never overlap', () => {
  const a = dragon(800, 0.05, 0.03), b = dragon(820, 0.056, 0.034);
  const out = run(new LensDirector(), [a, b]);
  assert.equal(out.lenses.length, 1);
  assert.equal(out.lenses[0].members.length, 2);
  assert.equal(out.lenses[0].views.length, 2);
  assert.ok(out.cover.get(a.ent.id) > 0.9 && out.cover.get(b.ent.id) > 0.9);
  // one dragon slides across the screen past two others: at no frame do two lenses overlap
  const fixed = [dragon(1000, -0.1, 0), dragon(1100, 0.1, 0.02)];
  const mover = dragon(900, -0.35, 0.01);
  const dir = new LensDirector();
  for (let i = 0; i <= 140; i++) {
    const x = -0.35 + i * 0.005;
    mover.pos.set(Math.sin(x) * 900, Math.sin(0.01) * 900, -Math.cos(x) * Math.cos(0.01) * 900);
    const o = dir.update(1 / 30, ctxFor([...fixed, mover], { nose: null }));
    const ls = o.lenses.filter((l) => l.alpha > 0.05);
    for (let p = 0; p < ls.length; p++) {
      for (let q = p + 1; q < ls.length; q++) {
        const dd = Math.hypot(ls[p].cx - ls[q].cx, ls[p].cy - ls[q].cy);
        assert.ok(dd >= (ls[p].r + ls[q].r) * 0.98, `frame ${i}: lenses ${ls[p].id} and ${ls[q].id} overlap (${dd.toFixed(1)} px)`);
      }
    }
  }
});

test('out of sight: hidden dragons get no lens, no close marks, no name and cannot be your target', () => {
  const e = dragon(500, 0.01, 0.0);
  const out = run(new LensDirector(), [e], 30, { blocked: () => true });
  assert.equal(out.lenses.length, 0);
  assert.ok(out.hidden.has(e.ent.id), 'reported hidden');
  assert.ok(!out.near.has(e.ent.id));
  assert.equal(out.aimedId, 0);
  assert.equal(out.labelId, 0);
  // close up behind a rock too (this is what drew a full rim, name and LOCKED around rock)
  const c = dragon(120, 0.01, 0);
  const oc = run(new LensDirector(), [c], 30, { blocked: () => true, lockId: c.ent.id, locked: true });
  assert.ok(oc.hidden.has(c.ent.id) && !oc.near.has(c.ent.id) && oc.labelId === 0);
  // only the blocked one of two
  const a = dragon(800, -0.1, 0), b = dragon(800, 0.1, 0);
  const o2 = run(new LensDirector(), [a, b], 30, { blocked: (p) => p === a.pos });
  assert.ok(o2.hidden.has(a.ent.id) && !o2.hidden.has(b.ent.id));
  assert.deepEqual(o2.lenses.map((l) => l.id), [b.ent.id]);
  // allies are never "hidden" (they keep their small caret)
  const al = dragon(800, 0, 0, { ally: true });
  assert.ok(!run(new LensDirector(), [al], 5, { blocked: () => true }).hidden.has(al.ent.id));
  // the line-of-sight test is throttled per dragon
  let calls = 0;
  run(new LensDirector(), [dragon(800, 0, 0)], 30, { blocked: () => { calls++; return false; } });
  assert.ok(calls <= 8, `throttled (${calls} tests in 1 s)`);
});

test('one name on screen: the lock target, else the dragon on your nose within 900 m, on exactly one representation', () => {
  const far = dragon(1200, 0.0, 0.0);
  assert.equal(run(new LensDirector(), [far]).aimedId, 0, 'nothing is "your target" beyond 900 m');
  // a lock wins over the nose
  const onNose = dragon(700, 0.0, 0.0), locked = dragon(800, 0.25, 0.1);
  const o = run(new LensDirector(), [onNose, locked], 30, { lockId: locked.ent.id, lockP: 1, locked: true });
  assert.equal(o.aimedId, onNose.ent.id);
  assert.equal(o.labelId, locked.ent.id);
  assert.equal(o.lenses.filter((l) => l.label).length, 1);
  assert.equal(o.lenses.find((l) => l.label).id, locked.ent.id);
  // fly at one from 1000 m to 150 m: every frame its name is on its lens or on the dragon itself, never both
  const e = dragon(1000, 0.005, 0.005), dir = new LensDirector();
  let lensFrames = 0, worldFrames = 0;
  for (let d = 1000; d >= 150; d -= 4) {
    place(e, d);
    const out = dir.update(1 / 30, ctxFor([e]));
    const onLens = out.lenses.filter((l) => l.label).length;
    assert.ok(onLens <= 1);
    if (out.labelId !== e.ent.id) { assert.equal(onLens, 0); continue; }
    const onWorld = out.labelLens ? 0 : 1;
    assert.equal(onLens + onWorld, 1, `exactly one name at ${d} m`);
    if (onLens) {
      assert.equal(out.labelLens, e.ent.id);
      const L = out.lenses.find((l) => l.label);
      assert.ok(L.alpha >= 1 - (out.cover.get(e.ent.id) || 0), 'on the more visible one');
      lensFrames++;
    } else worldFrames++;
  }
  assert.ok(lensFrames > 10 && worldFrames > 10, `both ends seen (${lensFrames} on the lens, ${worldFrames} on the dragon)`);
});

test('no lens for allies, dragons in cloud, or when switched off', () => {
  assert.equal(run(new LensDirector(), [dragon(900, 0.02, 0, { ally: true })]).lenses.length, 0);
  assert.equal(run(new LensDirector(), [dragon(900, 0.02, 0, { inCloud: true })]).lenses.length, 0);
  assert.equal(run(new LensDirector(), [dragon(900, 0.02, 0)], 30, { enabled: false }).lenses.length, 0);
  assert.equal(run(new LensDirector(), [dragon(900, 2.5, 0)]).lenses.length, 0, 'behind the camera');
});

test('attackers (locked on to you, or lining up a shot) win the lens over others', () => {
  const es = [dragon(700, -0.3, 0), dragon(700, 0, 0.2), dragon(700, 0.3, 0)];
  const out = run(new LensDirector(), es, 30, { touch: true, nose: { x: W / 2, y: H * 0.3 }, attackers: new Set([es[2].ent.id]) });
  assert.ok(out.lenses.some((l) => l.id === es[2].ent.id));
});

// ---- threats.js
function bot(id, pos, lookAt, extra = {}) {
  const m = new THREE.Matrix4().lookAt(pos, lookAt, new THREE.Vector3(0, 1, 0)); // -Z towards lookAt
  return { id, pos: pos.clone(), quat: new THREE.Quaternion().setFromRotationMatrix(m), alive: true, ...extra };
}

test('threats: a hostile close by with its nose on you, with hysteresis and "on your six" only when behind', () => {
  const me = { pos: new THREE.Vector3(0, 500, 0), fwd: new THREE.Vector3(0, 0, -1) };
  const hostile = (e) => !e.ally;
  const behind = bot(1, new THREE.Vector3(0, 500, 300), me.pos);
  const ahead = bot(2, new THREE.Vector3(0, 500, -300), me.pos);
  const away = bot(3, new THREE.Vector3(200, 500, 200), new THREE.Vector3(2000, 500, 2000));
  const far = bot(4, new THREE.Vector3(0, 500, 900), me.pos);
  const ally = bot(5, new THREE.Vector3(0, 520, 250), me.pos, { ally: true });
  const td = new ThreatDetector();
  // (the game passes ents.values(), a one-shot iterator)
  const ids = td.update(1 / 30, me, new Map([[1, behind], [3, away], [4, far], [5, ally]]).values(), hostile);
  assert.deepEqual([...ids], [1]);
  assert.equal(td.six, true);
  const t2 = new ThreatDetector();
  t2.update(1 / 30, me, [ahead], hostile);
  assert.ok(t2.ids.has(2) && !t2.six, 'a threat ahead is lens priority but not "on your six"');
  // nose 10 degrees off: not a threat to start with, but an existing threat stays one
  const off = (deg) => bot(1, behind.pos, new THREE.Vector3(Math.tan(THREE.MathUtils.degToRad(deg)) * 300, 500, 0));
  assert.equal(new ThreatDetector().update(1 / 30, me, [off(10)], hostile).size, 0);
  const t3 = new ThreatDetector();
  t3.update(1 / 30, me, [off(4)], hostile);
  for (let i = 0; i < 30; i++) t3.update(1 / 30, me, [off(10)], hostile);
  assert.ok(t3.ids.has(1), 'kept inside the wider cone');
  // turning well away: it lapses after the short hold
  for (let i = 0; i < 6; i++) t3.update(1 / 30, me, [off(40)], hostile);
  assert.ok(t3.ids.has(1), 'held briefly');
  for (let i = 0; i < 20; i++) t3.update(1 / 30, me, [off(40)], hostile);
  assert.ok(!t3.ids.has(1) && !t3.six, 'then gone');
  // dead you, dead them
  assert.equal(new ThreatDetector().update(1 / 30, null, [behind], hostile).size, 0);
  assert.equal(new ThreatDetector().update(1 / 30, me, [{ ...behind, alive: false }], hostile).size, 0);
  assert.ok(THREAT.range <= 600);
});
