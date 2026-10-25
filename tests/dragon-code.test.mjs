// The code-built dragon (client/js/render/dragon-code*.js) must be a drop-in for the Blender one: the same bones in
// the same hierarchy, sane skinning, and a triangle budget. The geometry modules are pure JS, so this runs in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (f) => import(path.join(root, 'client/js/render', f));
const geo = await R('dragon-code-geo.js');
const limbs = await R('dragon-code-limbs.js');
const extras = await R('dragon-code-extras.js');

function glbBones() {
  const b = fs.readFileSync(path.join(root, 'client/assets/dragon.glb'));
  const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  const parent = {};
  const names = new Set(j.skins[0].joints.map((i) => j.nodes[i].name));
  j.nodes.forEach((n) => (n.children || []).forEach((c) => names.has(j.nodes[c].name) && (parent[j.nodes[c].name] = n.name)));
  return { names, parent };
}

test('same bone names and hierarchy as the GLB rig', () => {
  const glb = glbBones();
  const mine = new Set(geo.BONES.map((b) => b.name));
  assert.deepEqual([...mine].sort(), [...glb.names].sort());
  for (const b of geo.BONES) if (b.parent) assert.equal(b.parent, glb.parent[b.name], `parent of ${b.name}`);
  assert.equal(geo.BONES[0].name, 'root');
});

function check(part, name, maxTris) {
  assert.ok(part.tris > 0, `${name} is empty`);
  assert.ok(part.tris <= maxTris, `${name}: ${part.tris} triangles > ${maxTris}`);
  for (let i = 0; i < part.p.length; i++) assert.ok(Number.isFinite(part.p[i]), `${name}: NaN position at ${i}`);
  for (let i = 0; i < part.n.length; i++) assert.ok(Number.isFinite(part.n[i]), `${name}: NaN normal at ${i}`);
  for (let i = 0; i < part.idx.length; i++) assert.ok(part.idx[i] < part.count, `${name}: index out of range`);
  for (let v = 0; v < part.count; v++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const bi = part.sk[v * 8 + k * 2], w = part.sk[v * 8 + k * 2 + 1];
      assert.ok(bi >= 0 && bi < geo.BONES.length, `${name}: bad bone index`);
      assert.ok(w >= 0 && w <= 1.0001, `${name}: bad weight`);
      sum += w;
    }
    assert.ok(Math.abs(sum - 1) < 1e-3, `${name}: weights of vertex ${v} sum to ${sum}`);
  }
}

test('geometry is finite, skinned, and inside the triangle budget', () => {
  const t0 = performance.now();
  const near = [geo.buildCore(1), geo.buildJaw(1), geo.buildTeeth(1), geo.buildTongue(1), limbs.buildLimbs(1), limbs.buildWingArms(1), extras.buildHeadSpikes(1)];
  const wings = limbs.buildMembranes(1), eyes = geo.buildEyes(1);
  near.forEach((p, i) => check(p, `near part ${i}`, 20000));
  check(wings, 'wings', 8000);
  check(eyes, 'eyes', 2000);
  const nearTris = near.reduce((s, p) => s + p.tris, 0) + wings.tris + eyes.tris;
  assert.ok(nearTris > 30000 && nearTris < 62000, `near body + wings = ${nearTris} triangles`);
  const far = [geo.buildCore(0.25), geo.buildJaw(0.25), limbs.buildLimbsLod(), limbs.buildWingArmsLod(), limbs.buildMembranes(0.25)];
  far.forEach((p, i) => check(p, `far part ${i}`, 6000));
  const farTris = far.reduce((s, p) => s + p.tris, 0);
  assert.ok(farTris < 6000, `far LOD ${farTris} triangles`);
  const ex = extras.buildExtras();
  for (const b of ['ember', 'frost', 'storm', 'venom']) {
    assert.ok(ex[b], `extras for ${b}`);
    check(ex[b].body, `${b} extras`, 14000);
    check(ex[b].bodyLod, `${b} extras LOD`, 2500);
    if (ex[b].wing) check(ex[b].wing, `${b} wing extras`, 4000);
  }
  assert.ok(performance.now() - t0 < 4000, 'generation is quick');
});

test('mouth, wingtip and spine anchors sit where DragonView expects them', () => {
  // DragonView hard-codes the mouth at (0, 0.25, -8.6) and the wingtip at (12, 0.45, -0.4) in three.js axes
  const head = geo.corePos(8.6, 0);
  assert.ok(Math.abs(head[1] - 8.6) < 0.3, 'snout reaches the mouth point');
  const tip = limbs.fingerPoint(1, 0, 1);
  assert.ok(Math.hypot(tip[0] - 11.6, tip[1] - 0.4) < 0.1, 'finger 1 ends at the wing tip');
});
