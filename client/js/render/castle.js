// The Citadel in the scene: loads the photoscanned materials, asks castle-worker.js for the geometry (three detail
// levels, plus a 3D light volume of sun and occlusion), and draws it with distance-based detail.
//
//   far (beyond ~2.3 km)   one draw call: every structure's silhouette level merged
//   mid (to ~1 km)         one draw call per structure at level 1 (about 25 structures, frustum culled)
//   near (to ~400 m)       level 0: pilasters, string courses, ribs, crockets, dormers, mouldings, ramp brackets
//   everywhere             instanced parts: merlons, lancet windows, banners, chain links and braziers
// Budget at quality 1: about 30 draw calls and 150-350 k triangles in view at the closest range.
import * as THREE from 'three';
import { CASTLE } from '../../../shared/castle.js';
import { WORLD } from '../../../shared/constants.js';
import { SKY } from './atmosphere.js';
import { CastleLife } from './castle-life.js';
import {
  bannerTexture, bannerUvPatch, createBannerGeometry, createBannerMaterial, createBrazierGeometry, createCastleUniforms, createLinkGeometry, lightVolumeTexture,
  createGargoyleGeometry, createMerlonGeometry, createStoneMaterial, createWindowGeometry, createWindowMaterial, loadCastleTextures,
} from './castle-material.js';

// detail ranges (m) at quality 0 / 1 / 2: level 0 inside r0, level 1 inside r1, the merged silhouette beyond far
const RANGES = [
  { r0: 0, r1: 700, far: 1500, inst: 900, win: 1800 },
  { r0: 420, r1: 1100, far: 2300, inst: 1500, win: 3200 },
  { r0: 640, r1: 1500, far: 3000, inst: 2300, win: 4500 },
];

export class Castle {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'castle';
    this.group.position.set(CASTLE.x, CASTLE.y0, CASTLE.z);
    this.group.visible = false;
    scene.add(this.group);
    this.structs = new Map(); // id -> { lods: [mesh|null x3], bounds: Sphere, cur }
    this.far = null;
    this.floor = null;
    this.quality = 1;
    this.range = RANGES[1];
    this.ready = false;
    this.info = { lod: [0, 0, 0], tris: [0, 0, 0], buildMs: 0, structs: 0 };
    this.inst = {};
    this.braziers = [];
    this.terrainTex = null;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  async start(base) {
    let textures;
    try {
      textures = await loadCastleTextures(base);
    } catch (e) {
      console.warn('castle textures', e);
      return;
    }
    this.textures = textures;
    this.uniforms = createCastleUniforms(textures, CASTLE.y0, WORLD.terrainHalf);
    if (this.terrainTex) this.uniforms.uTerrainData.value = this.terrainTex;
    this.uniforms.uQual.value = this.quality;
    this.stone = createStoneMaterial(this.uniforms);
    this.life = new CastleLife(this.scene, textures.noise); // bats round the spires, mist in the courtyard
    this.merlonMat = createStoneMaterial(this.uniforms, { instanced: true, layer: 0 });
    this.gargoyleMat = createStoneMaterial(this.uniforms, { instanced: true, layer: 5 });
    this.worker = new Worker(new URL('castle-worker.js', document.baseURI), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => console.warn('castle worker', e.message);
    this.worker.postMessage({ type: 'build', sun: [SKY.sunDir.x, SKY.sunDir.y, SKY.sunDir.z] });
  }

  setTerrainData(tex) {
    this.terrainTex = tex;
    if (this.uniforms) this.uniforms.uTerrainData.value = tex;
  }

  setQuality(q) {
    this.quality = Math.max(0, Math.min(2, q | 0));
    this.range = RANGES[this.quality];
    if (this.uniforms) this.uniforms.uQual.value = this.quality;
  }

  // ------------------------------------------------------------------------------------------ geometry from the worker
  onMessage(m) {
    if (m.type === 'volume') {
      this.uniforms.uVol.value.dispose();
      this.uniforms.uVol.value = lightVolumeTexture(m);
    } else if (m.type === 'group') this.addGroup(m);
    else if (m.type === 'inst') this.addInstances(m);
    else if (m.type === 'done') {
      this.ready = true;
      this.group.visible = true;
      this.info.buildMs = Math.round(m.ms);
      this.info.stats = m.stats;
      this.info.structs = this.structs.size;
      console.log(`citadel built in ${this.info.buildMs} ms: ${JSON.stringify(m.stats.tris.map(Math.round))} triangles at levels 0/1/2`);
    }
  }

  makeGeometry(m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    g.setAttribute('aData', new THREE.BufferAttribute(m.dat, 4, true));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(m.bounds[0], m.bounds[1], m.bounds[2]), m.bounds[3]);
    return g;
  }

  addGroup(m) {
    const geo = this.makeGeometry(m);
    const mesh = new THREE.Mesh(geo, this.stone);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    mesh.visible = false;
    this.group.add(mesh);
    if (m.id === 'floor') {
      // the paving lies 0.3 m over the plateau: pull it toward the camera so it never z-fights at distance
      const fm = createStoneMaterial(this.uniforms);
      fm.polygonOffset = true;
      fm.polygonOffsetFactor = -6;
      fm.polygonOffsetUnits = -6;
      mesh.material = fm;
      mesh.visible = true;
      this.floor = mesh;
      return;
    }
    if (m.id === 'far') {
      this.far = mesh;
      return;
    }
    let s = this.structs.get(m.id);
    if (!s) {
      s = { id: m.id, lods: [null, null, null], bounds: new THREE.Sphere(), cur: -1, tris: [0, 0, 0] };
      this.structs.set(m.id, s);
    }
    s.lods[m.lod] = mesh;
    s.tris[m.lod] = m.tris;
    if (m.lod === 2) s.bounds.copy(geo.boundingSphere);
    else s.bounds.union(geo.boundingSphere);
    mesh.castShadow = m.lod === 0;
  }

  addInstances(m) {
    const Y0 = 0; // the group sits at the courtyard floor: instance positions are local
    const mk = (geo, mat, count, name) => {
      const im = new THREE.InstancedMesh(geo, mat, count);
      im.name = name;
      im.frustumCulled = false;
      im.receiveShadow = true;
      im.visible = false;
      this.group.add(im);
      return im;
    };
    const M = this._m, Q = this._q, E = this._e, P = this._p, S = this._s;

    // merlons
    {
      const n = m.merlons.length / 7;
      const im = mk(createMerlonGeometry(), this.merlonMat, n, 'merlons');
      for (let i = 0; i < n; i++) {
        const o = i * 7;
        E.set(0, -m.merlons[o + 3], 0);
        Q.setFromEuler(E);
        P.set(m.merlons[o], Y0 + m.merlons[o + 1], m.merlons[o + 2]);
        S.set(m.merlons[o + 4], m.merlons[o + 5], m.merlons[o + 6]);
        M.compose(P, Q, S);
        im.setMatrixAt(i, M);
      }
      im.instanceMatrix.needsUpdate = true;
      this.inst.merlons = im;
    }
    // gargoyles
    {
      const n = m.gargoyles.length / 7;
      const im = mk(createGargoyleGeometry(), this.gargoyleMat, n, 'gargoyles');
      for (let i = 0; i < n; i++) {
        const o = i * 7;
        E.set(0, Math.PI / 2 - m.gargoyles[o + 3], 0);
        Q.setFromEuler(E);
        P.set(m.gargoyles[o], m.gargoyles[o + 1], m.gargoyles[o + 2]);
        const sc = m.gargoyles[o + 4];
        S.set(sc, sc, sc);
        M.compose(P, Q, S);
        im.setMatrixAt(i, M);
      }
      im.instanceMatrix.needsUpdate = true;
      this.inst.gargoyles = im;
    }
    // windows
    {
      const n = m.windows.length / 8;
      const im = mk(createWindowGeometry(), createWindowMaterial(this.uniforms), n, 'windows');
      const aWin = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        E.set(0, Math.PI / 2 - m.windows[o + 3], 0);
        Q.setFromEuler(E);
        P.set(m.windows[o], m.windows[o + 1], m.windows[o + 2]);
        S.set(m.windows[o + 4], m.windows[o + 5], 1);
        M.compose(P, Q, S);
        im.setMatrixAt(i, M);
        aWin[i * 4] = m.windows[o + 6];
        aWin[i * 4 + 1] = m.windows[o + 7];
        aWin[i * 4 + 2] = m.windowBake[i * 4 + 1] / 255;
        aWin[i * 4 + 3] = m.windowBake[i * 4] / 255;
      }
      im.geometry.setAttribute('aWin', new THREE.InstancedBufferAttribute(aWin, 4));
      im.instanceMatrix.needsUpdate = true;
      this.inst.windows = im;
    }
    // banners: one mesh per cloth
    {
      const tex = bannerTexture();
      const base = createBannerGeometry();
      const n = m.banners.length / 8;
      const byCloth = [[], []];
      for (let i = 0; i < n; i++) byCloth[m.banners[i * 8 + 6] > 0.5 ? 1 : 0].push(i);
      this.inst.banners = [];
      byCloth.forEach((list, cloth) => {
        if (!list.length) return;
        const im = mk(bannerUvPatch(base, cloth), createBannerMaterial(this.uniforms, tex), list.length, 'banners' + cloth);
        const aBan = new Float32Array(list.length * 4);
        list.forEach((i, k) => {
          const o = i * 8;
          E.set(0, Math.PI / 2 - m.banners[o + 3], 0);
          Q.setFromEuler(E);
          P.set(m.banners[o], m.banners[o + 1], m.banners[o + 2]);
          S.set(m.banners[o + 4], m.banners[o + 5], 1);
          M.compose(P, Q, S);
          im.setMatrixAt(k, M);
          aBan[k * 4] = m.banners[o + 7];
          aBan[k * 4 + 1] = cloth;
          aBan[k * 4 + 2] = m.bannerBake[i * 4 + 1] / 255;
          aBan[k * 4 + 3] = m.bannerBake[i * 4] / 255;
        });
        im.geometry.setAttribute('aBan', new THREE.InstancedBufferAttribute(aBan, 4));
        im.instanceMatrix.needsUpdate = true;
        this.inst.banners.push(im);
      });
    }
    // chain links
    {
      const n = m.links.length / 8;
      const mat = new THREE.MeshStandardMaterial({ color: 0x1c1a19, roughness: 0.48, metalness: 0.85, envMapIntensity: 1.1 });
      const im = mk(createLinkGeometry(), mat, n, 'links');
      const ex = new THREE.Vector3(), ey = new THREE.Vector3(), ez = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), mm = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        ex.set(m.links[o + 3], m.links[o + 4], m.links[o + 5]);
        ez.crossVectors(ex, up);
        if (ez.lengthSq() < 1e-6) ez.set(0, 0, 1);
        ez.normalize();
        ey.crossVectors(ez, ex);
        mm.makeBasis(ex, ey, ez);
        Q.setFromRotationMatrix(mm);
        const roll = new THREE.Quaternion().setFromAxisAngle(ex, m.links[o + 6]);
        Q.premultiply(roll);
        const sz = m.links[o + 7] * 0.68;
        P.set(m.links[o], m.links[o + 1], m.links[o + 2]);
        S.set(sz, sz, sz);
        M.compose(P, Q, S);
        im.setMatrixAt(i, M);
      }
      im.instanceMatrix.needsUpdate = true;
      this.inst.links = im;
    }
    // braziers (the bowls; the fire is drawn by the effects)
    {
      const n = m.braziers.length / 4;
      const mat = new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.5, metalness: 0.8, side: THREE.DoubleSide });
      const im = mk(createBrazierGeometry(), mat, n, 'braziers');
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        Q.identity();
        P.set(m.braziers[o], m.braziers[o + 1], m.braziers[o + 2]);
        const bs = m.braziers[o + 3] > 1.5 ? m.braziers[o + 3] : 1.8;
        S.set(bs, bs, bs);
        M.compose(P, Q, S);
        im.setMatrixAt(i, M);
        const bp = new THREE.Vector3(m.braziers[o], CASTLE.y0 + m.braziers[o + 1] + bs * 2.0, m.braziers[o + 2]);
        bp.scale = bs / 1.8;
        this.braziers.push(bp);
      }
      im.instanceMatrix.needsUpdate = true;
      this.inst.braziers = im;
    }
  }

  // Draw calls and triangles the castle costs this frame: the main pass (visible meshes inside the camera frustum) and the
  // shadow pass (level-0 meshes that cast, inside the sun's shadow frustum). For budgets and the screenshot tool.
  measure(camera, sun) {
    const fr = new THREE.Frustum(), m = new THREE.Matrix4();
    const count = (cam, onlyCasters) => {
      m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      fr.setFromProjectionMatrix(m);
      let calls = 0, tris = 0;
      const sph = new THREE.Sphere();
      for (const o of this.group.children) {
        if (!o.visible || (onlyCasters && !o.castShadow)) continue;
        if (!o.isInstancedMesh) {
          sph.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
          if (!fr.intersectsSphere(sph)) continue;
        }
        calls++;
        tris += (o.geometry.index.count / 3) * (o.isInstancedMesh ? o.count : 1);
      }
      return { calls, tris: Math.round(tris) };
    };
    camera.updateMatrixWorld();
    this.group.updateMatrixWorld(true);
    const main = count(camera, false);
    let shadow = { calls: 0, tris: 0 };
    if (sun && sun.castShadow) {
      sun.shadow.camera.updateMatrixWorld();
      shadow = count(sun.shadow.camera, true);
    }
    return { main, shadow };
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(camera, t, dt, fx) {
    if (!this.ready) return;
    this.uniforms.uTime.value = t;
    if (this.life) this.life.update(camera, t);
    const R = this.range;
    const cp = camera.position;
    const dc = Math.hypot(cp.x - CASTLE.x, cp.z - CASTLE.z, (cp.y - CASTLE.y0 - 200) * 0.5);
    const useFar = this.far && dc > R.far;
    if (this.far) this.far.visible = useFar;
    if (this.floor) this.floor.visible = dc < R.r1 * 1.6;
    const counts = [0, 0, 0];
    const trisIn = [0, 0, 0];
    for (const s of this.structs.values()) {
      let want;
      if (useFar) want = -1;
      else {
        const dx = cp.x - s.bounds.center.x - this.group.position.x, dy = cp.y - s.bounds.center.y - this.group.position.y, dz = cp.z - s.bounds.center.z - this.group.position.z;
        const d = Math.max(0, Math.hypot(dx, dy, dz) - s.bounds.radius * 0.75);
        // hysteresis: stay at the current level a little past its edge
        const h = 1.12;
        const cur = s.cur;
        want = d < R.r0 * (cur === 0 ? h : 1) && s.lods[0] ? 0 : d < R.r1 * (cur <= 1 && cur >= 0 ? h : 1) && s.lods[1] ? 1 : 2;
        if (!s.lods[want]) want = s.lods[2] ? 2 : s.lods[1] ? 1 : 0;
      }
      if (want !== s.cur) {
        for (let i = 0; i < 3; i++) if (s.lods[i]) s.lods[i].visible = i === want;
        s.cur = want;
      }
      if (want >= 0) { counts[want]++; trisIn[want] += s.tris[want]; }
    }
    this.info.lod = counts;
    // instanced parts by distance to the castle's centre
    const dIn = Math.hypot(cp.x - CASTLE.x, cp.z - CASTLE.z);
    if (this.inst.merlons) this.inst.merlons.visible = dIn < R.inst + 300 && !useFar;
    if (this.inst.links) this.inst.links.visible = dIn < R.inst * 0.7 + 300;
    if (this.inst.braziers) this.inst.braziers.visible = dIn < R.inst * 0.7 + 300;
    if (this.inst.windows) this.inst.windows.visible = dIn < R.win;
    if (this.inst.gargoyles) this.inst.gargoyles.visible = dIn < R.inst * 0.8 + 300 && !useFar;
    if (this.inst.banners) for (const b of this.inst.banners) b.visible = dIn < R.inst + 500;
    // fire in the braziers near the camera
    if (fx && fx.brazier && this.quality > 0) {
      for (const p of this.braziers) {
        const d2 = (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2 + (p.z - cp.z) ** 2;
        if (d2 < 1.0e6) fx.brazier(p, dt, p.scale || 1);
      }
    }
  }
}
