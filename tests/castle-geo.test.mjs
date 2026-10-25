// The Citadel's generated geometry: finite, inside the castle's bounds, within the triangle budget, and in step with
// the colliders (what you see is what you crash into).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCastle, buildFloor } from '../client/js/render/castle-geo-struct.js';
import { MeshBuilder } from '../client/js/render/castle-geo.js';
import { CASTLE, castleSpec, hit } from '../shared/castle.js';

const levels = [0, 1, 2].map((lod) => ({ lod, ...buildCastle(lod) }));
const tris = (b) => [...b.groups.values()].reduce((a, mb) => a + mb.ni / 3, 0);

test('every detail level builds finite, well-formed geometry', () => {
  for (const { lod, groups } of levels) {
    assert.ok(groups.size >= 20, `level ${lod} has the structures`);
    for (const [id, mb] of groups) {
      assert.ok(mb.n > 0 && mb.ni > 0, `${id} is not empty`);
      for (let i = 0; i < mb.n * 3; i++) assert.ok(Number.isFinite(mb.pos[i]) && Number.isFinite(mb.nrm[i]), `${id} vertex ${i} is finite`);
      for (let i = 0; i < mb.n; i++) assert.ok(Math.abs(Math.hypot(mb.nrm[i * 3], mb.nrm[i * 3 + 1], mb.nrm[i * 3 + 2]) - 1) < 1e-3, `${id} normal ${i} is a unit vector`);
      for (let i = 0; i < mb.ni; i++) assert.ok(mb.idx[i] < mb.n, `${id} index ${i} is in range`);
      for (let i = 0; i < mb.n; i++) assert.ok(mb.dat[i * 4 + 3] <= 5, `${id} material layer is valid`);
    }
  }
});

test('detail levels thin out and stay within the triangle budget', () => {
  const t = levels.map((l) => tris(l));
  assert.ok(t[0] > t[1] && t[1] > t[2], `levels get coarser: ${t.join(' > ')}`);
  assert.ok(t[0] < 400000, `level 0 is ${t[0]} triangles`);
  assert.ok(t[2] < 40000, `the far silhouette is ${t[2]} triangles`);
  const l0 = levels[0].ctx;
  assert.ok(l0.merlons.length > 800 && l0.windows.length > 400 && l0.banners.length >= 10 && l0.braziers.length >= 10 && l0.chains.length >= 5 && l0.gargoyles.length > 100, 'instances for the repeated parts');
});

test('geometry stays inside the castle volume and the spires reach their heights', () => {
  let top = -1e9;
  for (const mb of levels[0].groups.values()) {
    for (let i = 0; i < mb.n; i++) {
      const x = mb.pos[i * 3] - CASTLE.x, y = mb.pos[i * 3 + 1], z = mb.pos[i * 3 + 2] - CASTLE.z;
      assert.ok(Math.hypot(x, z) < CASTLE.radius, `vertex inside the bounding cylinder (${x.toFixed(0)}, ${z.toFixed(0)})`);
      assert.ok(y < CASTLE.top + 2 && y > -90, `vertex height ${y.toFixed(1)} is in range`);
      top = Math.max(top, y);
    }
  }
  assert.ok(top > 585 && top <= CASTLE.top, `the keep's finial reaches ${top.toFixed(0)} m`);
  const S = castleSpec();
  const tall = S.towers.filter((t) => t.top - t.y0 >= 250);
  assert.ok(tall.length >= 6, 'several towers and spires of 250 m or more');
});

test('the colliders follow the mesh: tower walls are solid just inside and open just outside', () => {
  const S = castleSpec();
  for (const t of S.towers) {
    for (const s of t.segs) {
      if (s.k !== 'shaft' || s.r0 < 8 || s.y1 - s.y0 < 30) continue;
      const y = CASTLE.y0 + (s.y0 + s.y1) / 2;
      if (y < CASTLE.y0 + 2) continue;
      const r = (s.r0 + s.r1) / 2 * Math.cos(Math.PI / s.sides);
      // sample a few directions: 3 m inside the face is solid; 6 m outside the circumscribed radius is air unless something else is there
      let solidIn = 0, airOut = 0, n = 0;
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI * 2) / 6 + 0.3;
        n++;
        if (hit([CASTLE.x + t.x + Math.cos(a) * (r - 3), y, CASTLE.z + t.z + Math.sin(a) * (r - 3)], 0)) solidIn++;
        if (!hit([CASTLE.x + t.x + Math.cos(a) * ((s.r0 + s.r1) / 2 + 9), y, CASTLE.z + t.z + Math.sin(a) * ((s.r0 + s.r1) / 2 + 9)], 0)) airOut++;
      }
      assert.equal(solidIn, n, `${t.id} shaft is solid inside its walls`);
      assert.ok(airOut >= 3, `${t.id} shaft: open air outside it (${airOut}/${n})`);
    }
  }
});

test('the courtyard floor builds', () => {
  const mb = new MeshBuilder();
  buildFloor(mb);
  assert.ok(mb.n > 500 && mb.ni > 1000);
});
