// Combat effects: flame breath, fireballs, seekers, explosions, shockwaves, smoke, debris, splashes, burning,
// wounds, shrines. The look is breed-specific (BREED_LOOK in dragon.js): ember fire, frost mist and ice, storm
// plasma with lightning arcs, venom acid with globs and toxic smoke.
//
// Rendering lives in vfx-particles.js (instanced flipbook sprites), vfx-ribbons.js (tails, serpents, arcs) and
// vfx-distort.js (heat haze). This file decides what to spawn. A fixed pool of 4 point lights is handed to the
// brightest requests (the light count never changes, so shaders never recompile mid-fight).
import * as THREE from 'three';
import { BREED_LOOK } from './dragon.js';
import { SpritePool, buildPalettes, loadAtlas, fallbackTexture, PAL, paletteOf, smokePaletteOf } from './vfx-particles.js';
import { Ribbons, Arcs } from './vfx-ribbons.js';
import { DistortPass } from './vfx-distort.js';

// shape atlas indices (see tools/gen_vfx.py)
const SH = { round: 0, core: 1, shard: 2, flake: 3, glint: 4, drop: 5, ring: 6, scale: 7, wisp: 8, streak: 9, bubble: 10, glob: 11, splinter: 12, bolt: 13, cloud: 14, leaf: 15 };
const S_STRIDE = 28;
const ENV_FIRE = 0, ENV_SMOKE = 1, ENV_SPARK = 2, ENV_FLAT = 3, ENV_RING = 4;

const PAL_BREED = new Map();
for (const b of Object.keys(BREED_LOOK)) PAL_BREED.set(BREED_LOOK[b].fire, b);
const breedOf = (pal, breed) => breed || PAL_BREED.get(pal) || 'ember';

const rnd = (a = 1) => (Math.random() * 2 - 1) * a;
const rr = (a, b) => a + Math.random() * (b - a);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const cnt = (x) => {
  const n = Math.floor(x);
  return n + (Math.random() < x - n ? 1 : 0);
};

const _u = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// two unit vectors perpendicular to dir
function basis(dir, u, w) {
  if (Math.abs(dir.y) > 0.95) u.set(1, 0, 0);
  else u.copy(_up);
  u.cross(dir).normalize();
  w.crossVectors(dir, u);
}

const LIGHT_MAX = 40;
const QUALITY = [
  { dens: 0.45, limit: 0.5, haze: false, arcs: 12, ribbons: 10 },
  { dens: 0.8, limit: 0.8, haze: true, arcs: 32, ribbons: 24 },
  { dens: 1.2, limit: 1.0, haze: true, arcs: 56, ribbons: 36 },
];

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.cam = new THREE.Vector3(0, 1e5, 0);
    this.camera = null;
    this.floorAt = null; // (x, z) => ground height, set by the game
    this.time = 0;
    this.q = QUALITY[1];
    this.dens = this.q.dens;
    const pal = (this.palettes = buildPalettes());
    const fb = fallbackTexture();
    const base = { palettes: pal, texture: fb };
    this.pools = [];
    const mk = (max, o) => {
      const p = new SpritePool(scene, max, { ...base, ...o });
      this.pools.push(p);
      return p;
    };
    this.smoke = mk(3200, { kind: 'smoke', grid: [8, 8], frames: 64, soft: true, renderOrder: 20 });
    this.solid = mk(1500, { kind: 'solid', grid: [4, 4], frames: 16, soft: true, renderOrder: 21 });
    this.fire = mk(4800, { kind: 'fire', additive: true, grid: [8, 8], frames: 64, occ: 0.55, soft: true, renderOrder: 22 });
    this.jet = mk(320, { kind: 'fire', additive: true, grid: [4, 8], frames: 32, aspect: 2, cylindrical: true, occ: 0.5, renderOrder: 22 });
    this.glow = mk(2800, { kind: 'glow', additive: true, grid: [4, 4], frames: 16, renderOrder: 23 });
    // shock and marker rings are dust / vapour (alpha blended, fogged), never glowing lines
    this.ringB = mk(80, { kind: 'ring', additive: false, renderOrder: 23 });
    this.ringF = mk(48, { kind: 'ring', additive: false, flat: true, renderOrder: 19 });
    this.foam = mk(48, { kind: 'ring', additive: false, flat: true, renderOrder: 19 });
    this.haze = new SpritePool(scene, 96, { ...base, kind: 'distort', noScene: true });
    this.pools.push(this.haze);
    this.ribbons = new Ribbons(scene, pal);
    this.arcs = new Arcs(scene, pal);
    this.distortPass = null;

    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xff8030, 0, 140, 1.6);
      scene.add(l);
      this.lights.push(l);
    }
    this.lightReq = [];
    for (let i = 0; i < LIGHT_MAX; i++) this.lightReq.push({ p: new THREE.Vector3(), c: [1, 1, 1], i: 0, life: 0, age: 0, score: 0, on: false });
    this.lightHead = 0;

    this.columns = [];
    for (let i = 0; i < 8; i++) this.columns.push({ on: false, p: new THREE.Vector3(), t: 0, dur: 0, scale: 1, sp: 0, pal: 0, flames: 0 });
    this.burning = new Map();
    this.wounds = new Map();
    this.casts = [];
    for (let i = 0; i < 16; i++) this.casts.push({ on: false, kind: '', ent: null, tgt: null, t: 0, dur: 0, r: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), b: 'ember', P: 0 });
    this.setQuality(1);
  }

  // load the flipbook atlases; the effects work with soft fallbacks until (or unless) they arrive
  async load(base) {
    const loader = new THREE.TextureLoader();
    const [fire, smoke, jet, shapes] = await Promise.all(['vfx_fire', 'vfx_smoke', 'vfx_jet', 'vfx_shapes'].map((n) => loadAtlas(loader, `${base}${n}.png`)));
    const apply = (pool, tex, grid, frames) => {
      if (tex) {
        pool.uniforms.tex.value = tex;
      } else {
        pool.uniforms.uGrid.value.set(1, 1);
        pool.uniforms.uFrames.value = 1;
      }
    };
    apply(this.fire, fire);
    apply(this.smoke, smoke);
    apply(this.jet, jet);
    apply(this.glow, shapes);
    apply(this.solid, shapes);
    this.hasAtlases = !!(fire && smoke && jet && shapes);
    if (!this.hasAtlases) this.fallback = true;
  }

  makeDistortPass(camera) {
    this.camera = camera;
    this.distortPass = new DistortPass(this.haze, camera);
    return this.distortPass;
  }

  // terrain height map (R channel, from the terrain worker) lets particles fade out where they dip into the ground
  setTerrain(tex) {
    for (const p of this.pools) {
      p.uniforms.tTerrain.value = tex;
      p.uniforms.uHasT.value = tex ? 1 : 0;
    }
  }

  setScale(px) {
    for (const p of this.pools) p.uniforms.uNear.value = 16;
    this.pxScale = px;
  }

  setQuality(q) {
    const Q = (this.q = QUALITY[Math.max(0, Math.min(2, q | 0))]);
    this.dens = Q.dens;
    for (const p of this.pools) p.limit = Math.max(16, Math.floor(p.max * Q.limit));
    this.arcs.limit = Q.arcs;
    this.ribbons.limit = Q.ribbons;
    this.haze.limit = Q.haze ? this.haze.max : 0;
  }

  setFloor(fn) {
    this.floorAt = fn;
    for (const p of this.pools) p.floorAt = fn;
  }

  // 0..1 detail factor by distance to the camera; 0 beyond ~3.6 km
  lod(p) {
    const dx = p.x - this.cam.x, dy = p.y - this.cam.y, dz = p.z - this.cam.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return d > 3600 ? 0 : clamp01(1.15 - d / 2600);
  }

  // ----------------------------------------------------------------- emit helpers
  // flame puff from the fire flipbook (f0..f1 plays over the particle's life)
  _fire(p, vx, vy, vz, life, s0, s1, pal, inten, drag, rise, f0 = 0, f1 = 56, spin = 0, temp = 1, curve = 0.5) {
    return this.fire.emit(p.x, p.y, p.z, vx, vy, vz, life, s0, s1, pal, inten * 0.62, drag, rise, Math.random() * 6.283, spin, f0, f1, ENV_FIRE, 0, temp, curve);
  }

  _smoke(p, vx, vy, vz, life, s0, s1, pal, inten, drag, rise, glow = 0, swirl = 0, f0 = 4, f1 = 56, amul = 1) {
    const i = this.smoke.emit(p.x, p.y, p.z, vx, vy, vz, life, s0, s1, pal, inten, drag, rise, Math.random() * 6.283, rnd(0.4), f0, f1, ENV_SMOKE, 0, glow, 0.5, 0, swirl);
    if (amul !== 1) this.smoke.d[i * S_STRIDE + 20] = amul; // AMUL
    return i;
  }

  // hot spark / glint from the shape atlas, optionally velocity-stretched
  _spark(p, vx, vy, vz, life, size, pal, inten, drag, rise, shape = SH.streak, stretch = 0.05, bounce = 0, spin = 0, size1 = size * 0.4) {
    return this.glow.emit(p.x, p.y, p.z, vx, vy, vz, life, size, size1, pal, inten, drag, rise, rnd(3), spin, shape, shape, ENV_SPARK, stretch, 1, 0.6, bounce);
  }

  _solidShape(p, vx, vy, vz, life, size, shape, pal, inten, drag, rise, stretch = 0, spin = 0, glow = 0, bounce = 0, size1 = size) {
    return this.solid.emit(p.x, p.y, p.z, vx, vy, vz, life, size, size1, pal, inten, drag, rise, Math.random() * 6.283, spin, shape, shape, ENV_FLAT, stretch, glow, 1, bounce);
  }

  _ring(pool, p, life, r0, r1, pal, inten, ring = 0.8, curve = 0.45) {
    // size is the full quad diameter; the ring itself sits at `ring` of the radius
    pool.emit(p.x, p.y, p.z, 0, 0, 0, life, r0 * 2, r1 * 2, pal, inten, 0, 0, 0, 0, 0, 0, ENV_RING, 0, ring, curve);
  }

  // shockwave refraction. The distort shader reads: palette slot = mode (0 haze, 1 ring), intensity = strength,
  // extra = ring radius as a fraction of the quad radius
  _distortRing(p, life, r1, strength = 1) {
    if (!this.q.haze) return;
    this.haze.emit(p.x, p.y, p.z, 0, 0, 0, life, r1 * 0.2, r1 * 2.3, 1, strength, 0, 0, 0, 0, 0, 0, ENV_RING, 0, 0.78, 0.45, 0);
  }

  _distortHaze(p, life, size0, size1, strength = 0.5) {
    if (!this.q.haze) return;
    this.haze.emit(p.x, p.y, p.z, 0, 0, 0, life, size0, size1, 0, strength, 0, 0, 0, 0, 0, 0, ENV_FLAT, 0, 0, 0.6, 0);
  }

  // ----------------------------------------------------------------- breath
  breath(origin, dir, baseVel, pal, dt, breed) {
    const b = breedOf(pal, breed);
    const lod = this.lod(origin);
    const P = paletteOf(b), SP = smokePaletteOf(b);
    this.light(_a.copy(origin).addScaledVector(dir, 14), pal[1], b === 'storm' ? 34 : 26);
    if (lod <= 0.02) return;
    const k = this.dens * lod;
    basis(dir, _u, _w);
    const bx = baseVel.x, by = baseVel.y, bz = baseVel.z;
    const ox = origin.x, oy = origin.y, oz = origin.z;

    // flame tongues (the jet flipbook, aligned to their velocity): the body of the stream
    const jets = cnt(dt * (b === 'frost' ? 20 : b === 'storm' ? 40 : 46) * k);
    const jInt = b === 'frost' ? 1.9 : b === 'storm' ? 2.1 : b === 'venom' ? 1.7 : 1.7;
    for (let i = 0; i < jets; i++) {
      const sp = rr(92, 130), sa = rnd(0.06), sb = rnd(0.06);
      const vx = (dir.x + _u.x * sa + _w.x * sb) * sp + bx, vy = (dir.y + _u.y * sa + _w.y * sb) * sp + by, vz = (dir.z + _u.z * sa + _w.z * sb) * sp + bz;
      _b.set(ox + dir.x * 5, oy + dir.y * 5, oz + dir.z * 5);
      const f0 = (Math.random() * 20) | 0;
      this.jet.emit(_b.x, _b.y, _b.z, vx, vy, vz, rr(0.42, 0.62), 14, rr(44, 60), P, jInt, 0.9, b === 'venom' ? -3 : 5, 0, 0, f0, Math.min(31, f0 + 14), ENV_FIRE, 0.0001, 1, 0.6);
    }
    // round flame bulk
    const bulk = cnt(dt * (b === 'frost' ? 36 : 70) * k);
    const bInt = b === 'frost' ? 1.4 : b === 'storm' ? 1.7 : b === 'venom' ? 1.4 : 1.8;
    for (let i = 0; i < bulk; i++) {
      const sp = rr(52, 96);
      const sa = rnd(0.085), sb = rnd(0.085);
      _b.set(ox + dir.x * rr(0.5, 4) + rnd(0.6), oy + dir.y * rr(0.5, 4) + rnd(0.6), oz + dir.z * rr(0.5, 4) + rnd(0.6));
      this._fire(_b, (dir.x + _u.x * sa + _w.x * sb) * sp + bx, (dir.y + _u.y * sa + _w.y * sb) * sp + by, (dir.z + _u.z * sa + _w.z * sb) * sp + bz,
        rr(0.45, 0.8), rr(1.5, 3), rr(8, 14), P, bInt, 1.7, b === 'venom' ? -2 : 6, (Math.random() * 14) | 0, 56, rnd(0.8));
    }
    // hot sparks and glints
    const sparks = cnt(dt * 26 * k);
    for (let i = 0; i < sparks; i++) {
      const sp = rr(40, 100);
      const sa = rnd(0.22), sb = rnd(0.22);
      _b.set(ox + dir.x * rr(1, 14), oy + dir.y * rr(1, 14), oz + dir.z * rr(1, 14));
      const vx = (dir.x + _u.x * sa + _w.x * sb) * sp + bx, vy = (dir.y + _u.y * sa + _w.y * sb) * sp + by, vz = (dir.z + _u.z * sa + _w.z * sb) * sp + bz;
      this._spark(_b, vx, vy, vz, rr(0.35, 0.9), rr(0.5, 1.1), P, b === 'frost' ? 3 : 4, 0.6, b === 'venom' ? -26 : -9, SH.streak, 0.045);
    }

    switch (b) {
      case 'ember': {
        if (Math.random() < dt * 8 * k) {
          _b.set(ox + dir.x * rr(26, 56), oy + dir.y * rr(26, 56) + 2, oz + dir.z * rr(26, 56));
          this._smoke(_b, dir.x * 36 + bx * 0.5, dir.y * 36 + by * 0.5 + 6, dir.z * 36 + bz * 0.5, rr(1.6, 2.6), 4, rr(14, 22), PAL.smokeEmber, 1, 1.1, 4, 1.0, rnd(0.6));
        }
        break;
      }
      case 'frost': {
        // dense cold mist, snow glitter, ice crystals
        const mist = cnt(dt * 20 * k);
        for (let i = 0; i < mist; i++) {
          const sp = rr(38, 82), sa = rnd(0.16), sb = rnd(0.16);
          _b.set(ox + dir.x * rr(2, 10), oy + dir.y * rr(2, 10), oz + dir.z * rr(2, 10));
          this._smoke(_b, (dir.x + _u.x * sa + _w.x * sb) * sp + bx, (dir.y + _u.y * sa + _w.y * sb) * sp + by, (dir.z + _u.z * sa + _w.z * sb) * sp + bz,
            rr(0.7, 1.2), rr(3, 5), rr(12, 20), PAL.mist, 1.0, 1.7, 1.5, 0, rnd(1.2), 4, 56, 0.55);
        }
        const flakes = cnt(dt * 38 * k);
        for (let i = 0; i < flakes; i++) {
          const sp = rr(25, 80), sa = rnd(0.3), sb = rnd(0.3);
          _b.set(ox + dir.x * rr(2, 22) + rnd(2), oy + dir.y * rr(2, 22) + rnd(2), oz + dir.z * rr(2, 22) + rnd(2));
          this._spark(_b, (dir.x + _u.x * sa + _w.x * sb) * sp + bx, (dir.y + _u.y * sa + _w.y * sb) * sp + by, (dir.z + _u.z * sa + _w.z * sb) * sp + bz,
            rr(0.5, 1.1), rr(0.9, 1.8), PAL.white, 5, 1.2, -4, Math.random() < 0.5 ? SH.flake : SH.glint, 0, 0, rnd(4), 0.3);
        }
        const shards = cnt(dt * 15 * k);
        for (let i = 0; i < shards; i++) {
          const sp = rr(55, 105), sa = rnd(0.14), sb = rnd(0.14);
          _b.set(ox + dir.x * rr(2, 8), oy + dir.y * rr(2, 8), oz + dir.z * rr(2, 8));
          this._solidShape(_b, (dir.x + _u.x * sa + _w.x * sb) * sp + bx, (dir.y + _u.y * sa + _w.y * sb) * sp + by, (dir.z + _u.z * sa + _w.z * sb) * sp + bz,
            rr(0.45, 0.8), rr(1.8, 3.2), SH.shard, PAL.ice, 1.3, 0.8, -10, 0, rnd(8), 0.2);
        }
        break;
      }
      case 'storm': {
        const arcs = cnt(dt * 46 * k);
        for (let i = 0; i < arcs; i++) {
          _a.set(ox + dir.x * rr(4, 30) + _u.x * rnd(2), oy + dir.y * rr(4, 30) + _u.y * rnd(2), oz + dir.z * rr(4, 30) + _u.z * rnd(2));
          const len = rr(8, 24);
          _b.set(_a.x + dir.x * len + _u.x * rnd(7) + _w.x * rnd(7), _a.y + dir.y * len + _u.y * rnd(7) + _w.y * rnd(7), _a.z + dir.z * len + _u.z * rnd(7) + _w.z * rnd(7));
          this.arcs.spawn(_a, _b, rr(0.08, 0.16), rr(0.5, 0.9), PAL.storm, 3.2, 0.18);
        }
        if (Math.random() < dt * 2.5 * k) {
          _b.set(ox + dir.x * rr(15, 50), oy + dir.y * rr(15, 50), oz + dir.z * rr(15, 50));
          this._smoke(_b, dir.x * 20, dir.y * 20 + 3, dir.z * 20, rr(1.2, 1.8), 4, 14, PAL.smokeStorm, 1, 1.2, 2, 1.6, rnd(0.5));
        }
        break;
      }
      case 'venom': {
        const toxic = cnt(dt * 9 * k);
        for (let i = 0; i < toxic; i++) {
          const sp = rr(30, 70), sa = rnd(0.14), sb = rnd(0.14);
          _b.set(ox + dir.x * rr(3, 20), oy + dir.y * rr(3, 20), oz + dir.z * rr(3, 20));
          this._smoke(_b, (dir.x + _u.x * sa + _w.x * sb) * sp + bx, (dir.y + _u.y * sa + _w.y * sb) * sp + by + 2, (dir.z + _u.z * sa + _w.z * sb) * sp + bz,
            rr(1.1, 1.9), rr(3, 5), rr(12, 20), PAL.smokeVenom, 1.0, 1.3, 3, 0.9, rnd(0.8), 4, 56, 0.6);
        }
        const globs = cnt(dt * 20 * k);
        for (let i = 0; i < globs; i++) {
          const sp = rr(36, 85), sa = rnd(0.2), sb = rnd(0.2);
          _b.set(ox + dir.x * rr(1, 10), oy + dir.y * rr(1, 10), oz + dir.z * rr(1, 10));
          this._solidShape(_b, (dir.x + _u.x * sa + _w.x * sb) * sp + bx, (dir.y + _u.y * sa + _w.y * sb) * sp + by, (dir.z + _u.z * sa + _w.z * sb) * sp + bz,
            rr(0.7, 1.4), rr(1.2, 2.4), SH.glob, PAL.acid, 1.2, 0.35, -34, 0.01, rnd(3), 0.8, 0.2);
        }
        if (Math.random() < dt * 6 * k) {
          _b.set(ox + dir.x * rr(8, 40) + rnd(2), oy + dir.y * rr(8, 40) + rnd(2), oz + dir.z * rr(8, 40) + rnd(2));
          this.solid.emit(_b.x, _b.y, _b.z, rnd(2) + bx * 0.6, rr(2, 7) + by * 0.6, rnd(2) + bz * 0.6, rr(0.8, 1.5), rr(1, 2.2), rr(1.4, 2.6), PAL.acid, 1.1, 1.0, 3, 0, rnd(1), SH.bubble, SH.bubble, ENV_FLAT, 0, 0.5, 1, 0);
        }
        break;
      }
    }
    // heat shimmer along and past the stream
    if (b !== 'frost' && Math.random() < dt * 16 * k) {
      const dd = rr(10, 60);
      this._distortHaze(_a.set(ox + dir.x * dd, oy + dir.y * dd + dd * 0.05, oz + dir.z * dd), 0.55, 10, rr(20, 32), 0.55);
    }
  }

  // ----------------------------------------------------------------- fireballs and seekers
  // called every frame for each live projectile; `p` is the projectile's persistent position (also the ribbon key)
  fireballTrail(p, vel, pal, dt, big = 1, breed, kind) {
    const lod = this.lod(p);
    if (lod <= 0.02) return;
    const b = breedOf(pal, breed);
    const seeker = kind === 'sk' || big > 1.3;
    const P = paletteOf(b), SP = smokePaletteOf(b);
    const k = this.dens * lod;
    const speed = vel.length() || 1;
    _a.copy(vel).divideScalar(speed); // flight direction
    const dx = _a.x, dy = _a.y, dz = _a.z;
    const s = seeker ? 1.35 : 1;
    basis(_a, _u, _w);

    // the head: a white-hot core wrapped in a coloured halo, stretched a little along the flight line
    const hot = b === 'frost' ? 3.0 : b === 'storm' ? 2.3 : 4.0;
    const cs = (b === 'storm' ? 3.2 : 4.2) * s;
    this.glow.emit(p.x, p.y, p.z, vel.x, vel.y, vel.z, Math.max(dt * 2.2, 0.04), cs, cs, P, hot, 0, 0, 0, 0, SH.core, SH.core, ENV_FLAT, 0.012, 1, 1, 0);
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, Math.max(dt * 2.2, 0.04), 7 * s, 7 * s, P, b === 'ember' ? 0.3 : 0.18, 0, 0, Math.random() * 6, 0, SH.round, SH.round, ENV_FLAT, 0, 0.8, 1, 0);
    // flame body at the head
    _b.set(p.x - dx * 1.5, p.y - dy * 1.5, p.z - dz * 1.5);
    this._fire(_b, vel.x * 0.35, vel.y * 0.35, vel.z * 0.35, 0.16, 5 * s, 4 * s, P, b === 'ember' ? 2.6 : 1.9, 2, 0, 4, 28, 0, 1, 1);

    // flame tail laid along the path travelled this frame
    const dist = speed * dt;
    const spacing = seeker ? 2.2 : 2.8;
    const n = cnt((dist / spacing) * (0.4 + 0.6 * k));
    for (let i = 0; i < n; i++) {
      const f = Math.random();
      _b.set(p.x - vel.x * dt * f, p.y - vel.y * dt * f, p.z - vel.z * dt * f);
      const sp = rr(1, 4);
      this._fire(_b, rnd(sp) + vel.x * 0.04, rnd(sp) + vel.y * 0.04 + 1, rnd(sp) + vel.z * 0.04, rr(0.3, 0.55), rr(3.4, 4.6) * s, rr(0.5, 1.4), P, b === 'storm' ? 1.6 : 2.0, 2, b === 'venom' ? -1 : 2.5,
        6, 52, rnd(1));
    }
    // smoke trail, thin
    if (Math.random() < dt * 22 * k) {
      this._smoke(p, rnd(2), rnd(2) + 1.5, rnd(2), rr(1.0, 1.6), 1.6 * s, rr(6, 9) * s, SP, 1, 1.1, 1.5, b === 'frost' ? 0 : 0.8, rnd(0.6));
    }

    // breed flavour
    if (b === 'ember') {
      if (Math.random() < dt * 40 * k) {
        _b.copy(p).addScaledVector(_a, -rr(0, dist));
        this._spark(_b, rnd(14) - vel.x * 0.05, rnd(14) - vel.y * 0.05, rnd(14) - vel.z * 0.05, rr(0.3, 0.8), rr(0.45, 0.9), P, 6, 1, -9, SH.streak, 0.05);
      }
    } else if (b === 'frost') {
      // snow glitter and falling ice
      if (Math.random() < dt * 50 * k) {
        _b.copy(p).addScaledVector(_a, -rr(0, dist));
        this._spark(_b, rnd(6), rnd(6) - 2, rnd(6), rr(0.5, 1.0), rr(1.0, 2.0), PAL.white, 5, 1.5, -3, Math.random() < 0.5 ? SH.flake : SH.glint, 0, 0, rnd(4), 0.2);
      }
      if (Math.random() < dt * 14 * k) {
        _b.copy(p).addScaledVector(_a, -rr(0, dist));
        this._solidShape(_b, rnd(5) - vel.x * 0.02, rnd(5), rnd(5) - vel.z * 0.02, rr(0.4, 0.8), rr(1.5, 2.4), SH.shard, PAL.ice, 1.2, 1, -14, 0, rnd(8), 0.2);
      }
    } else if (b === 'storm') {
      this._boltAcc = (this._boltAcc || 0) + dt;
      if (this._boltAcc > (seeker ? 0.035 : 0.07) / Math.max(0.2, k)) {
        this._boltAcc = 0;
        const L = rr(4, 9) * s;
        _b.set(p.x + rnd(L), p.y + rnd(L), p.z + rnd(L));
        _a.copy(p);
        this.arcs.spawn(_a, _b, rr(0.05, 0.1), 0.22 * s, PAL.storm, 5, 0.2);
      }
    } else if (b === 'venom') {
      if (Math.random() < dt * 24 * k) {
        _b.copy(p).addScaledVector(_a, -rr(0, dist));
        this._solidShape(_b, rnd(4), rnd(2) - 2, rnd(4), rr(0.6, 1.1), rr(1.2, 2.0), SH.glob, PAL.acid, 1.2, 0.3, -30, 0.01, rnd(3), 0.9, 0.15);
      }
      if (Math.random() < dt * 10 * k) {
        _b.copy(p);
        this.solid.emit(_b.x, _b.y, _b.z, rnd(3), rr(1, 4), rnd(3), rr(0.8, 1.4), 1, 1.8, PAL.acid, 1, 1, 2, 0, rnd(1), SH.bubble, SH.bubble, ENV_FLAT, 0, 0.4, 1, 0);
      }
    }

    // ribbons: a hot streak for fireballs; core + two counter-rotating corkscrews for seekers ("fire serpents")
    const pr = paletteOf(b);
    if (seeker) {
      const R = this.ribbons;
      R.feed(p, p, dt, { width: 0.85, life: 0.7, pal: pr, inten: 1.8, taper: 0.75, fade: 1.2, t0: 0.8 });
      // helices are keyed by derived objects so each has its own slot
      const hk = p._hx || (p._hx = [{}, {}]);
      R.feed(hk[0], p, dt, { width: 0.5, life: 1.0, pal: pr, inten: 2.2, radius: 2.0, turns: 3.0, phase: 0, taper: 0.5, fade: 1.0, t0: 0.7 });
      R.feed(hk[1], p, dt, { width: 0.5, life: 1.0, pal: pr, inten: 2.2, radius: 2.0, turns: 3.0, phase: Math.PI, taper: 0.5, fade: 1.0, t0: 0.7 });
    } else {
      this.ribbons.feed(p, p, dt, { width: 0.45, life: 0.34, pal: pr, inten: 2.6, taper: 0.9, fade: 1.2, t0: 0.9 });
    }
  }

  // ----------------------------------------------------------------- explosions
  explosion(p, pal, scale = 1, vel = null, breed) {
    const b = breedOf(pal, breed);
    const lod = this.lod(p);
    if (lod <= 0.02 && scale < 1.2) return;
    const P = paletteOf(b), SP = smokePaletteOf(b);
    const k = this.dens * Math.max(0.35, lod);
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;

    // tiny scales are muzzle flashes: a bright pop and a few sparks
    if (scale < 0.3) {
      this.glow.emit(p.x, p.y, p.z, vx * 0.6, vy * 0.6, vz * 0.6, 0.09, 9, 14, P, 4, 0, 0, Math.random() * 6, 0, SH.core, SH.core, ENV_SPARK, 0, 1, 0.5, 0);
      this.glow.emit(p.x, p.y, p.z, vx * 0.6, vy * 0.6, vz * 0.6, 0.12, 5, 12, P, 5, 0, 0, Math.random() * 6, 0, SH.glint, SH.glint, ENV_SPARK, 0, 1, 0.5, 0);
      const n = cnt(6 * k);
      for (let i = 0; i < n; i++) this._spark(p, rnd(40) + vx * 0.7, rnd(40) + vy * 0.7, rnd(40) + vz * 0.7, rr(0.2, 0.45), rr(0.5, 0.9), P, 6, 1.5, -6, SH.streak, 0.05);
      this.light(p, pal[1], 18, 0.1);
      return;
    }

    const floor = this.floorAt ? this.floorAt(p.x, p.z) : -1e9;
    const h = p.y - Math.max(floor, 0);
    const water = floor <= 0.5 && p.y < 9 * scale + 4;
    const ground = !water && h < 10 * scale + 8;
    const S = scale;
    const big = S >= 1.0;
    // blasts close to the lens are dimmed and their glare shrunk so they never blind the player
    const dc = Math.hypot(p.x - this.cam.x, p.y - this.cam.y, p.z - this.cam.z);
    const dim = 0.3 + 0.7 * clamp01((dc - 14) / 150);
    const gl = 0.25 + 0.75 * clamp01((dc - 14) / 110);

    // 1. flash and glare
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.12, 22 * S * gl, 60 * S * gl, P, 3.2 * dim, 0, 0, Math.random() * 6, 0, SH.core, SH.core, ENV_SPARK, 0, 1, 0.5, 0);
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.2, 36 * S * gl, 80 * S * gl, P, 0.05 * dim, 0, 0, Math.random() * 6, 0, SH.round, SH.round, ENV_SPARK, 0, 0.8, 0.5, 0);
    if (S >= 0.5) this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.25, 6 * S * gl, 55 * S * gl, P, 3.5 * dim, 0, 0, rnd(0.3), 0, SH.glint, SH.glint, ENV_SPARK, 0, 1, 0.45, 0);

    // 2. the fireball: lumpy flipbook puffs thrown outward (fast, then braking), a hot core, then rising flames.
    // Plasma breeds burn dimmer than real fire, so a storm or frost blast is a burst, not a glowing white orb.
    const fk = b === 'ember' ? 1 : b === 'venom' ? 0.8 : b === 'frost' ? 0.7 : 0.6;
    const nf = cnt((11 + 14 * S) * k);
    for (let i = 0; i < nf; i++) {
      _a.set(rnd(1), rnd(1), rnd(1)).normalize();
      if (ground && _a.y < 0) _a.y = -_a.y * 0.5;
      const sp = rr(14, 80) * S;
      _b.set(p.x + _a.x * 2 * S, p.y + _a.y * 2 * S, p.z + _a.z * 2 * S);
      this._fire(_b, _a.x * sp + vx * 0.35, _a.y * sp + vy * 0.35 + 4, _a.z * sp + vz * 0.35, rr(1.0, 1.8), rr(18, 30) * S, rr(80, 140) * S * (0.5 + 0.5 * gl), P, 2.6 * dim * fk, 2.4, rr(6, 16), 0, 56, rnd(0.6), 1.3, 0.4);
    }
    for (let i = 0; i < 2; i++) this._fire(p, vx * 0.3, vy * 0.3 + 3, vz * 0.3, 1.1 + i * 0.25, 34 * S, (120 + i * 20) * S * (0.5 + 0.5 * gl), P, 3.6 * dim * fk, 2.2, 6, 0, 50, 0, 1.45, 0.45);

    // 3. sparks
    const ns = cnt((20 + 34 * S) * k);
    for (let i = 0; i < ns; i++) {
      _a.set(rnd(1), rnd(1), rnd(1)).normalize();
      if (ground && _a.y < 0) _a.y = -_a.y;
      const sp = rr(30, 95) * Math.sqrt(S);
      this._spark(p, _a.x * sp + vx * 0.4, _a.y * sp + vy * 0.4, _a.z * sp + vz * 0.4, rr(0.5, 1.5), rr(0.7, 1.4), P, 6.5, 0.9, -14, SH.streak, 0.045, 0.5);
    }

    // 4. debris: scale shards, membrane scraps, splinters (breed-flavoured); sticks around with a hot glow
    if (S >= 0.5) {
      const nd = cnt((5 + 10 * S) * k);
      for (let i = 0; i < nd; i++) {
        _a.set(rnd(1), rnd(1) + 0.3, rnd(1)).normalize();
        const sp = rr(14, 55) * Math.sqrt(S);
        const r = Math.random();
        let shape, pl, size;
        if (b === 'frost') { shape = SH.shard; pl = PAL.ice; size = rr(1.8, 3.4); } else if (b === 'venom') { shape = r < 0.5 ? SH.glob : SH.scale; pl = r < 0.5 ? PAL.acid : PAL.scale; size = rr(1.4, 2.6); } else if (b === 'storm') { shape = r < 0.5 ? SH.splinter : SH.leaf; pl = PAL.debris; size = rr(1.4, 3); } else { shape = r < 0.4 ? SH.scale : r < 0.7 ? SH.leaf : SH.splinter; pl = r < 0.4 ? PAL.scale : PAL.debris; size = rr(1.2, 3); }
        this._solidShape(p, _a.x * sp + vx * 0.4, _a.y * sp + vy * 0.4, _a.z * sp + vz * 0.4, rr(1.4, 2.6), size * Math.sqrt(S), shape, pl, 0.9, 0.25, -26, 0, rnd(9), 0.9, 0.2, size * Math.sqrt(S) * 0.7);
      }
    }

    // 5. smoke: heavy dark clouds (or mist / toxic gas / ozone haze) that start as the fire cools and linger
    const nsmk = cnt((7 + 10 * S) * k);
    for (let i = 0; i < nsmk; i++) {
      _a.set(rnd(1), rnd(0.7) + 0.2, rnd(1)).normalize();
      if (ground) _a.y = Math.abs(_a.y);
      const sp = rr(8, 44) * S;
      const j = this._smoke(p, _a.x * sp + vx * 0.3, _a.y * sp + vy * 0.3 + 2 + rr(0, 16) * S, _a.z * sp + vz * 0.3, rr(4.5, 9) * Math.min(1.4, 0.7 + S * 0.4), rr(22, 40) * S, rr(70, 200) * S * (0.5 + 0.5 * gl), SP, 0.55 + 0.45 * dim, 1.7, rr(1, 5), 0.25, rnd(0.6), 4, 56, 0.8);
      this.smoke.setDelay(j, rr(0.12, 0.5));
    }
    if (b === 'frost') {
      // frost nova: a cloud of white mist and glitter
      for (let i = 0; i < cnt(6 * S * k); i++) {
        _a.set(rnd(1), rnd(0.6), rnd(1)).normalize();
        const sp = rr(8, 26) * S;
        this._smoke(p, _a.x * sp, _a.y * sp, _a.z * sp, rr(1.4, 2.4), rr(10, 16) * S, rr(30, 50) * S, PAL.mist, 1.0, 1.4, 1.5, 0, rnd(0.4));
      }
      for (let i = 0; i < cnt(26 * S * k); i++) {
        _a.set(rnd(1), rnd(1), rnd(1)).normalize();
        const sp = rr(10, 45) * S;
        this._spark(p, _a.x * sp, _a.y * sp, _a.z * sp, rr(0.8, 1.8), rr(1.4, 2.8), PAL.white, 4.5, 1.2, -5, Math.random() < 0.5 ? SH.flake : SH.glint, 0, 0, rnd(5), 0.2);
      }
    } else if (b === 'storm') {
      for (let i = 0; i < cnt((4 + 6 * S) * Math.max(0.5, k)); i++) {
        _a.set(rnd(1), rnd(1), rnd(1)).normalize();
        const len = rr(10, 30) * S;
        _b.set(p.x + _a.x * len, p.y + _a.y * len, p.z + _a.z * len);
        this.arcs.spawn(p, _b, rr(0.12, 0.3), rr(0.5, 1.0) * Math.sqrt(S), PAL.storm, 6, 0.2);
      }
    } else if (b === 'venom') {
      for (let i = 0; i < cnt(14 * S * k); i++) {
        _a.set(rnd(1), rnd(1) + 0.4, rnd(1)).normalize();
        const sp = rr(14, 48) * S;
        this._solidShape(p, _a.x * sp, _a.y * sp, _a.z * sp, rr(0.9, 1.8), rr(1.6, 3.4), SH.glob, PAL.acid, 1.2, 0.3, -30, 0.01, rnd(3), 0.9, 0.3);
      }
    }

    // 6. shockwave rings and refraction
    if (S >= 0.4) {
      this._ring(this.ringB, p, 0.7 * Math.min(1.4, 0.7 + S * 0.3), 3 * S, 80 * S, P, 0.32 * dim, 0.84);
      this._distortRing(p, 0.55, 86 * S, 1.0);
      if (big) this._ring(this.ringB, p, 1.1, 2 * S, 36 * S, PAL.smokeGrey, 0.22, 0.8);
    }
    if (ground && S >= 0.5) {
      _b.set(p.x, Math.max(floor, 0) + 1.2, p.z);
      this._ring(this.ringF, _b, 1.1, 4 * S, 70 * S, PAL.dust, 0.6, 0.84);
      // dust billowing out along the ground
      for (let i = 0; i < cnt(10 * S * k); i++) {
        const a = Math.random() * 6.283, sp = rr(12, 36) * S;
        _b.set(p.x + Math.cos(a) * 3, Math.max(floor, 0) + 2, p.z + Math.sin(a) * 3);
        this._smoke(_b, Math.cos(a) * sp, rr(0.5, 4), Math.sin(a) * sp, rr(2.2, 3.8), rr(7, 12) * S, rr(24, 40) * S, PAL.dust, 1.0, 1.8, 1, 0.3, rnd(0.5));
      }
    }
    if (water && S >= 0.5) this.splash(_c.set(p.x, 0, p.z), S * 0.9, true);

    // 7. a smoke column that stays a while (deaths and crashes)
    if (S >= 1.2) this.column(p, S, SP);

    this.light(p, pal[1], 60 * S, 0.55);
  }

  // ----------------------------------------------------------------- hits
  hitSpark(p, pal, breed, kind) {
    const b = breedOf(pal, breed);
    const lod = this.lod(p);
    if (lod <= 0.05) return;
    const P = paletteOf(b);
    const k = this.dens * lod;
    const burn = kind === 'br';
    const ns = cnt((burn ? 4 : 16) * k);
    for (let i = 0; i < ns; i++) {
      _a.set(rnd(1), rnd(1), rnd(1)).normalize();
      const sp = rr(14, burn ? 34 : 60);
      this._spark(p, _a.x * sp, _a.y * sp, _a.z * sp, rr(0.25, 0.7), rr(0.5, 1.0), P, 6, 1.4, -14, SH.streak, 0.05, 0.3);
    }
    // a few scales and shards torn off the hide
    const nsc = cnt((burn ? 1 : 6) * k);
    for (let i = 0; i < nsc; i++) {
      _a.set(rnd(1), rnd(1) + 0.2, rnd(1)).normalize();
      const sp = rr(10, 32);
      const shape = b === 'frost' ? SH.shard : SH.scale;
      this._solidShape(p, _a.x * sp, _a.y * sp, _a.z * sp, rr(0.7, 1.4), rr(1.1, 2.2), shape, b === 'frost' ? PAL.ice : b === 'venom' ? PAL.acid : PAL.scale, 1, 0.6, -22, 0, rnd(10), 0.6, 0.15);
    }
    if (!burn) {
      this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.12, 6, 14, P, 4, 0, 0, Math.random() * 6, 0, SH.glint, SH.glint, ENV_FLAT, 0, 1, 0.5, 0);
      this._fire(p, rnd(6), rnd(6) + 2, rnd(6), 0.4, 3, 9, P, 2.2, 3, 4, 0, 40, 0, 1, 0.5);
      this.light(p, BREED_LOOK[b].fire[1], 30, 0.25);
    }
  }

  // ----------------------------------------------------------------- water
  splash(p, scale = 1, quiet = false) {
    const lod = this.lod(p);
    if (lod <= 0.03) return;
    const k = this.dens * Math.max(0.4, lod);
    const S = scale;
    const y0 = 1.2;
    // expanding foam rings on the surface
    _b.set(p.x, y0, p.z);
    this._ring(this.foam, _b, 1.7, 3 * S, 46 * S, PAL.spray, 1.0, 0.82);
    this._ring(this.foam, _b, 2.3, 2 * S, 28 * S, PAL.spray, 0.7, 0.8, 0.6);
    this._ring(this.ringF, _b, 0.8, 3 * S, 40 * S, PAL.spray, 0.4, 0.85);
    // the column: tall spray that climbs and collapses
    const nc = cnt(34 * S * k);
    for (let i = 0; i < nc; i++) {
      const a = Math.random() * 6.283, r = Math.random() * 5 * S;
      _a.set(p.x + Math.cos(a) * r, y0, p.z + Math.sin(a) * r);
      const up = rr(24, 58) * Math.sqrt(S);
      const side = rr(0, 10) * S;
      this._smoke(_a, Math.cos(a) * side, up, Math.sin(a) * side, rr(1.6, 2.8), rr(4, 8) * S, rr(14, 24) * S, PAL.spray, 1.0, 0.5, -26, 0, rnd(0.8), 18, 56, 0.6);
    }
    // wide low mist
    const nm = cnt(10 * S * k);
    for (let i = 0; i < nm; i++) {
      const a = Math.random() * 6.283, sp = rr(6, 20) * S;
      _a.set(p.x, y0 + 1, p.z);
      this._smoke(_a, Math.cos(a) * sp, rr(1, 6), Math.sin(a) * sp, rr(1.8, 3.2), rr(6, 10) * S, rr(24, 40) * S, PAL.spray, 0.9, 1.4, 1.2, 0, rnd(0.5));
    }
    // streaking jets of spray
    for (let i = 0; i < cnt(70 * S * k); i++) {
      const a = Math.random() * 6.283, sp = rr(1, 18) * S;
      _a.set(p.x + Math.cos(a) * rr(0, 3 * S), y0, p.z + Math.sin(a) * rr(0, 3 * S));
      this._spark(_a, Math.cos(a) * sp, rr(28, 80) * Math.sqrt(S), Math.sin(a) * sp, rr(1.1, 2.1), rr(1.0, 1.9), PAL.white, 1.6, 0.15, -34, SH.streak, 0.03, 0, 0, 0.5);
    }
    // droplets and sun glints
    const nd = cnt(46 * S * k);
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * 6.283, sp = rr(2, 16) * S;
      _a.set(p.x, y0, p.z);
      this._solidShape(_a, Math.cos(a) * sp, rr(18, 52) * Math.sqrt(S), Math.sin(a) * sp, rr(1.2, 2.2), rr(0.8, 1.6), SH.drop, PAL.spray, 1.0, 0.1, -30, 0.012, 0, 0, 0, rr(0.5, 1.0));
    }
    for (let i = 0; i < cnt(14 * S * k); i++) {
      const a = Math.random() * 6.283, sp = rr(2, 14) * S;
      _a.set(p.x, y0, p.z);
      this._spark(_a, Math.cos(a) * sp, rr(14, 40), Math.sin(a) * sp, rr(0.6, 1.2), rr(1, 2), PAL.white, 3, 0.5, -30, SH.glint, 0, 0, 0, 0.4);
    }
    if (!quiet) this.light(p, [0.7, 0.85, 1.0], 12, 0.2);
  }

  // ----------------------------------------------------------------- smoke, embers
  smokePuff(p, vel, dark = 0.15, size = 5) {
    const lod = this.lod(p);
    if (lod <= 0.05 || Math.random() > this.dens * 1.5) return;
    const pl = dark < 0.1 ? PAL.smokeDark : PAL.smokeGrey;
    const inten = dark < 0.1 ? 1.0 : 0.75 + dark * 1.6;
    this._smoke(p, rnd(2) + vel.x * 0.2, rnd(2) + 2 + vel.y * 0.2, rnd(2) + vel.z * 0.2, rr(1.8, 2.8), size * 0.5, size * 2.6, pl, inten, 0.8, 2.5, dark < 0.1 ? 0.7 : 0.3, rnd(0.5));
  }

  embers(p, vel, pal, dt, breed) {
    const lod = this.lod(p);
    if (lod <= 0.05) return;
    if (Math.random() > dt * 24 * this.dens) return;
    const b = breedOf(pal, breed);
    this._spark(p, rnd(5) + vel.x * 0.4, rnd(5) + vel.y * 0.4 + 2, rnd(5) + vel.z * 0.4, rr(0.6, 1.3), rr(0.8, 1.5), paletteOf(b), 5, 1.2, 3, SH.round, 0, 0, 0, 0.3);
  }

  // overheated: steam and glowing embers venting from the mouth
  steam(origin, vel, dt) {
    const lod = this.lod(origin);
    if (lod <= 0.1) return;
    const k = this.dens * lod;
    for (let i = 0; i < cnt(dt * 34 * k); i++) {
      this._smoke(origin, vel.x * 0.9 + rnd(4), vel.y * 0.9 + rr(1, 5), vel.z * 0.9 + rnd(4), rr(0.8, 1.4), rr(1.2, 2), rr(5, 8), PAL.mist, 0.9, 1.4, 3, 0, rnd(1), 4, 56, 0.55);
    }
    if (Math.random() < dt * 14 * k) this._spark(origin, vel.x * 0.8 + rnd(8), vel.y * 0.8 + rr(0, 8), vel.z * 0.8 + rnd(8), rr(0.4, 0.9), rr(0.5, 0.9), PAL.ember, 5, 1, -8, SH.streak, 0.05);
  }

  // golden sparks swirling up around a dragon that drank from a shrine
  heal(p, vel) {
    const k = this.dens;
    for (let i = 0; i < cnt(54 * k); i++) {
      _a.set(rnd(1), rnd(1), rnd(1)).normalize();
      const sp = rr(5, 18);
      _b.set(p.x + _a.x * 3, p.y + _a.y * 3, p.z + _a.z * 3);
      this._spark(_b, _a.x * sp + vel.x * 0.8, _a.y * sp + vel.y * 0.8 + 6, _a.z * sp + vel.z * 0.8, rr(0.9, 1.7), rr(1.2, 2.4), PAL.gold, 5, 1.1, 10, Math.random() < 0.5 ? SH.glint : SH.round, 0, 0, rnd(3), 0.3);
    }
    this._ring(this.ringB, p, 0.8, 2, 26, PAL.gold, 0.3, 0.82);
    this.glow.emit(p.x, p.y, p.z, vel.x * 0.5, vel.y * 0.5, vel.z * 0.5, 0.45, 16, 28, PAL.gold, 0.55, 0, 0, 0, 0, SH.round, SH.round, ENV_FLAT, 0, 0.8, 0.5, 0);
    this.light(p, [1, 0.75, 0.35], 50, 0.6);
  }

  // moisture motes hanging in the air ahead of a fast dragon: they stream past the camera
  speedMotes(camPos, fwd, speed, dt) {
    const kk = (speed - 85) / 70;
    if (kk <= 0) return;
    const n = Math.floor(dt * 80 * Math.min(1.5, kk) * this.dens + Math.random());
    for (let i = 0; i < n; i++) {
      _a.copy(camPos).addScaledVector(fwd, 60 + Math.random() * 60);
      _a.x += rnd(22); _a.y += rnd(14); _a.z += rnd(22);
      this.solid.emit(_a.x, _a.y, _a.z, 0, 0, 0, 1.1, 0.3, 0.22, PAL.mist, 1.0, 0, 0, 0, 0, SH.round, SH.round, ENV_FLAT, 0, 0, 1, 0);
    }
  }

  // ----------------------------------------------------------------- wounds, burning, wrecks
  // smoke and fire leaking from a hurt dragon. hpFrac 0..1
  wound(key, pos, vel, quat, pal, hpFrac, dt, breed) {
    if (hpFrac > 0.55) return;
    const lod = this.lod(pos);
    if (lod <= 0.08) return;
    const b = breedOf(pal, breed);
    const P = paletteOf(b);
    let w = this.wounds.get(key);
    if (!w) {
      w = { x: rnd(5.5), y: rr(0.2, 1.4), z: rr(-3, 4), x2: rnd(5.5), z2: rr(-2, 5) };
      this.wounds.set(key, w);
    }
    const k = this.dens * lod;
    const sev = 1 - hpFrac / 0.55; // 0..1
    for (let s = 0; s < (hpFrac < 0.3 ? 2 : 1); s++) {
      _a.set(s ? w.x2 : w.x, w.y, s ? w.z2 : w.z).applyQuaternion(quat).add(pos);
      const rate = (6 + 22 * sev) * k;
      const n = cnt(dt * rate);
      for (let i = 0; i < n; i++) {
        const dark = hpFrac < 0.3;
        const pl = b === 'frost' ? PAL.smokeFrost : b === 'venom' ? PAL.smokeVenom : b === 'storm' ? PAL.smokeStorm : dark ? PAL.smokeDark : PAL.smokeGrey;
        this._smoke(_a, vel.x * 0.12 + rnd(1.5), vel.y * 0.12 + rr(0.5, 2.5), vel.z * 0.12 + rnd(1.5), rr(1.4, 2.4), rr(1.5, 2.5), rr(7, 12) * (0.7 + sev * 0.6), pl, dark ? 1 : 0.8, 0.9, 2, dark ? 0.9 : 0.3, rnd(0.4));
      }
      if (hpFrac < 0.3) {
        const nf = cnt(dt * 28 * k * sev);
        for (let i = 0; i < nf; i++) {
          this._fire(_a, vel.x * 0.1 + rnd(3), vel.y * 0.1 + rr(1, 5), vel.z * 0.1 + rnd(3), rr(0.3, 0.55), rr(2.2, 3.4), rr(0.6, 1.4), P, 2.0, 2, 4, 6, 50, rnd(1));
        }
        if (Math.random() < dt * 14 * k) this._spark(_a, vel.x * 0.2 + rnd(10), vel.y * 0.2 + rnd(10), vel.z * 0.2 + rnd(10), rr(0.4, 0.9), rr(0.5, 1), P, 6, 1, -12, SH.streak, 0.05);
      }
      if (b === 'storm' && hpFrac < 0.4 && Math.random() < dt * 5 * k) {
        _b.set(_a.x + rnd(6), _a.y + rnd(6), _a.z + rnd(6));
        this.arcs.spawn(_a, _b, rr(0.05, 0.12), 0.25, PAL.storm, 5, 0.2);
      }
    }
  }

  // set a dragon alight for `secs` (refreshes while it keeps being hit). ent needs pos, vel, quat.
  ignite(key, ent, pal, secs = 1.5, breed) {
    let t = this.burning.get(key);
    if (!t) {
      if (this.burning.size >= 24) return;
      t = { ent, pal, breed: breedOf(pal, breed), t: 0, dur: secs };
      this.burning.set(key, t);
    }
    t.ent = ent;
    t.t = 0;
    t.dur = Math.max(t.dur, secs);
  }

  _updateBurning(dt) {
    for (const [key, t] of this.burning) {
      t.t += dt;
      const e = t.ent;
      if (t.t > t.dur || (e.alive === false)) {
        this.burning.delete(key);
        continue;
      }
      const lod = this.lod(e.pos);
      if (lod <= 0.08) continue;
      const k = this.dens * lod;
      const fade = clamp01(1 - (t.t / t.dur) * 0.6);
      const n = cnt(dt * 40 * k * fade);
      const P = paletteOf(t.breed);
      for (let i = 0; i < n; i++) {
        _a.set(rnd(6.5), rr(-0.5, 1.8), rnd(5)).applyQuaternion(e.quat).add(e.pos);
        const vx = e.vel.x * 0.9, vy = e.vel.y * 0.9, vz = e.vel.z * 0.9;
        this._fire(_a, vx + rnd(3), vy + rr(2, 7), vz + rnd(3), rr(0.3, 0.6), rr(2.6, 4), rr(0.8, 1.8), P, 2.0, 1.5, 5, 6, 52, rnd(1));
      }
      if (Math.random() < dt * 14 * k) {
        _a.set(rnd(6), rr(0, 2), rnd(5)).applyQuaternion(e.quat).add(e.pos);
        this._smoke(_a, e.vel.x * 0.85 + rnd(2), e.vel.y * 0.85 + 3, e.vel.z * 0.85 + rnd(2), rr(1.2, 2), 2.2, 9, smokePaletteOf(t.breed), 0.9, 0.9, 2.5, 0.8, rnd(0.4));
      }
      if (Math.random() < dt * 20 * k) {
        _a.set(rnd(6), rr(0, 2), rnd(5)).applyQuaternion(e.quat).add(e.pos);
        this._spark(_a, e.vel.x * 0.7 + rnd(10), e.vel.y * 0.7 + rnd(10), e.vel.z * 0.7 + rnd(10), rr(0.4, 0.9), rr(0.5, 1), P, 6, 1, -10, SH.streak, 0.05);
      }
    }
  }

  // the falling wreck of a killed dragon: fire, thick smoke and shedding debris
  corpse(p, vel, pal, dt, breed) {
    const lod = this.lod(p);
    if (lod <= 0.05) return;
    const b = breedOf(pal, breed);
    const P = paletteOf(b), SP = smokePaletteOf(b);
    const k = this.dens * lod;
    for (let i = 0; i < cnt(dt * 46 * k); i++) {
      _a.set(p.x + rnd(4), p.y + rnd(1.5), p.z + rnd(4));
      this._fire(_a, vel.x * 0.5 + rnd(5), vel.y * 0.5 + rnd(5), vel.z * 0.5 + rnd(5), rr(0.35, 0.7), rr(5, 8), rr(9, 15), P, 2.2, 1.5, 4, 0, 52, rnd(1));
    }
    for (let i = 0; i < cnt(dt * 24 * k); i++) {
      _a.set(p.x + rnd(3), p.y + rnd(1.5), p.z + rnd(3));
      this._smoke(_a, vel.x * 0.55 + rnd(3), vel.y * 0.55 + rnd(3), vel.z * 0.55 + rnd(3), rr(2.4, 4), rr(6, 10), rr(20, 32), SP === PAL.smokeEmber ? PAL.smokeDark : SP, 1, 0.9, 3, 1.2, rnd(0.5));
    }
    if (Math.random() < dt * 18 * k) this._spark(p, vel.x * 0.6 + rnd(12), vel.y * 0.6 + rnd(12), vel.z * 0.6 + rnd(12), rr(0.5, 1.2), rr(0.7, 1.3), P, 6, 0.8, -14, SH.streak, 0.05, 0.4);
    if (Math.random() < dt * 5 * k) {
      const sh = Math.random() < 0.5 ? SH.scale : SH.leaf;
      this._solidShape(p, vel.x * 0.4 + rnd(10), vel.y * 0.4 + rnd(10), vel.z * 0.4 + rnd(10), rr(1.5, 3), rr(2, 4), sh, PAL.debris, 1, 0.3, -20, 0, rnd(8), 0.8, 0.2);
    }
    this.light(p, pal[1], 22);
  }

  // lingering smoke column (and small fires for a while) at a wreck
  column(p, scale = 1, smokePal) {
    let c = null;
    for (const x of this.columns) if (!x.on) { c = x; break; }
    if (!c) c = this.columns.reduce((a, x) => (x.t > a.t ? x : a), this.columns[0]);
    c.on = true;
    c.p.copy(p);
    c.t = 0;
    c.dur = 7 + 3 * scale;
    c.scale = scale;
    c.sp = smokePal === PAL.smokeEmber || smokePal === undefined ? PAL.smokeDark : smokePal;
    c.flames = 0;
    c.fp = smokePal === PAL.smokeFrost ? PAL.frost : smokePal === PAL.smokeStorm ? PAL.storm : smokePal === PAL.smokeVenom ? PAL.venom : PAL.ember;
  }

  _updateColumns(dt) {
    for (const c of this.columns) {
      if (!c.on) continue;
      c.t += dt;
      if (c.t > c.dur) { c.on = false; continue; }
      const lod = this.lod(c.p);
      if (lod <= 0.05) continue;
      const k = this.dens * lod;
      const f = 1 - c.t / c.dur;
      const n = cnt(dt * (3.5 + 3 * c.scale) * k * (0.4 + 0.6 * f));
      for (let i = 0; i < n; i++) {
        _a.set(c.p.x + rnd(3), c.p.y + 1, c.p.z + rnd(3));
        this._smoke(_a, rnd(1.5), rr(7, 13), rnd(1.5), rr(5, 8), rr(7, 11) * (0.7 + c.scale * 0.4), rr(24, 40) * (0.7 + c.scale * 0.4), c.sp, 1, 0.5, 1.2, 0.5 * f, rnd(0.25));
      }
      if (c.t < c.dur * 0.45) {
        const nf = cnt(dt * 10 * k * (1 - c.t / (c.dur * 0.45)));
        for (let i = 0; i < nf; i++) {
          _a.set(c.p.x + rnd(4), c.p.y + 0.5, c.p.z + rnd(4));
          this._fire(_a, rnd(2), rr(3, 9), rnd(2), rr(0.5, 0.9), rr(4, 7), rr(8, 14), paletteOf(c.fp === PAL.ember ? 'ember' : c.fp === PAL.frost ? 'frost' : c.fp === PAL.storm ? 'storm' : 'venom'), 2.0, 1.5, 3, 4, 52, rnd(1));
        }
        this.light(_a.set(c.p.x, c.p.y + 6, c.p.z), BREED_LOOK.ember.fire[1], 10 * (1 - c.t / (c.dur * 0.45)));
      }
      if (this.q.haze && Math.random() < dt * 3 * k) this._distortHaze(_a.set(c.p.x, c.p.y + 8, c.p.z), 0.8, 8, 20, 0.45);
    }
  }

  // a burning brazier on the Citadel's galleries: a steady flame, a thread of smoke and the odd spark
  brazier(p, dt, big = 1) {
    const lod = this.lod(p);
    if (lod <= 0.05) return;
    const k = this.dens * lod;
    const P = paletteOf('ember');
    for (let i = 0; i < cnt(dt * 16 * k * big); i++) {
      _a.set(p.x + rnd(1.1 * big), p.y + 0.2, p.z + rnd(1.1 * big));
      this._fire(_a, rnd(0.8), rr(3, 6) * big, rnd(0.8), rr(0.45, 0.8), rr(1.6, 2.6) * big, rr(3.6, 6) * big, P, 1.7, 1.5, 3, 4, 52, rnd(1));
    }
    // a long, thin plume: it drifts up the spire on the wind for ten seconds or so and spreads to a veil
    for (let i = 0; i < cnt(dt * 1.2 * k * big); i++) {
      _a.set(p.x + rnd(0.8 * big), p.y + 2.5 * big, p.z + rnd(0.8 * big));
      this._smoke(_a, rnd(1.2) + 2.5, rr(4, 7), rnd(1.2), rr(7, 12), rr(1.6, 2.4) * big, rr(8, 14) * big, PAL.smokeDark, 0.42, 0.5, 1.2, 0.1, rnd(0.3));
    }
    if (Math.random() < dt * 5 * k * big) this._spark(p, rnd(4), rr(5, 11), rnd(4), rr(0.8, 1.6), rr(0.25, 0.5), P, 6, 0.7, -2, SH.streak, 0.05, 0.3);
    this.light(_a.set(p.x, p.y + 2, p.z), BREED_LOOK.ember.fire[1], 9 * big);
  }

  // ----------------------------------------------------------------- shrines
  shrine(p, charge, dt) {
    const lod = this.lod(p);
    if (lod <= 0.1 || charge < 0.2) return;
    const k = this.dens * lod * charge;
    for (let i = 0; i < cnt(dt * 16 * k); i++) {
      const a = Math.random() * 6.283, r = rr(3, 9);
      _a.set(p.x + Math.cos(a) * r, p.y + rnd(2), p.z + Math.sin(a) * r);
      const tang = 5;
      this._spark(_a, -Math.sin(a) * tang, rr(3, 9), Math.cos(a) * tang, rr(1.4, 2.4), rr(0.9, 1.7), PAL.gold, 4, 0.3, 1.5, Math.random() < 0.6 ? SH.round : SH.glint, 0, 0, rnd(2), 0.3);
    }
    if (Math.random() < dt * 4 * k) {
      this._fire(p, rnd(2), rr(3, 6), rnd(2), rr(0.6, 1.0), rr(3, 5), rr(7, 11), PAL.gold, 1.3, 1.5, 4, 6, 50, rnd(1));
    }
  }


  // ----------------------------------------------------------------- breed abilities
  _ring2(pool, p, life, r0, r1, pal, inten, thick = 0.11, env = ENV_RING, curve = 0.45) {
    // a ring whose radius runs r0 -> r1 (the ring sits at 0.8 of the quad radius) and whose thickness rides in the frame slot
    pool.emit(p.x, p.y, p.z, 0, 0, 0, life, (r0 * 2) / 0.8, (r1 * 2) / 0.8, pal, inten, 0, 0, 0, 0, thick, thick, env, 0, 0.8, curve);
  }

  _startCast(kind, ent, dur, r, b, from, to, tgt) {
    let c = null;
    for (const x of this.casts) if (!x.on) { c = x; break; }
    if (!c) c = this.casts[0];
    c.on = true; c.kind = kind; c.ent = ent; c.tgt = tgt || null; c.t = 0; c.dur = Math.max(0.1, dur); c.r = r; c.b = b; c.P = paletteOf(b);
    if (from) c.from.copy(from);
    if (to) c.to.copy(to);
  }

  // kind: inferno | nova | chain | acid. phase: 'charge' (telegraphed wind-up, drawn every frame until it lands),
  // then 'fire' (or 'miss'). `ent` is the live caster, `lookup(id)` finds other dragons.
  abilityCast(kind, phase, at, m, pal, breed, ent, lookup) {
    const b = breed || breedOf(pal);
    const P = paletteOf(b);
    switch (kind) {
      case 'inferno': return this._infernoCast(at, m, ent, P, b);
      case 'nova':
        if (phase === 'charge') this._startCast('nova', ent, m.w || 0.45, m.r || 210, b, at);
        else this._novaBurst(at, m.r || 210, P);
        return;
      case 'chain':
        if (phase === 'charge') this._startCast('chain', ent, m.w || 0.3, 0, b, at, null, lookup && m.tgt ? lookup(m.tgt) : null);
        else this._chainBolts(m.path, phase === 'miss', P);
        return;
      case 'acid':
        if (phase === 'charge') this._startCast('acid', ent, m.w || 0.6, m.r || 76, b, new THREE.Vector3(...(m.o || [at.x, at.y, at.z])), at);
        else this._acidBurst(at, m.r || 76, P);
    }
  }

  // Inferno Wake: a roaring flame sheet blasts out behind the dragon, which keeps a tail of fire while the napalm drops
  _infernoCast(at, m, ent, P, b) {
    const k = this.dens * Math.max(0.4, this.lod(at));
    const d = m.d || [0, 0, -1];
    _u.set(-d[0], -d[1], -d[2]);
    basis(_u, _a, _w);
    for (let i = 0; i < cnt(34 * k); i++) {
      const sp = rr(30, 90), sa = rnd(0.35), sb = rnd(0.35);
      _b.set(at.x + _u.x * 6, at.y + _u.y * 6, at.z + _u.z * 6);
      this._fire(_b, (_u.x + _a.x * sa + _w.x * sb) * sp, (_u.y + _a.y * sa + _w.y * sb) * sp, (_u.z + _a.z * sa + _w.z * sb) * sp, rr(0.7, 1.3), rr(10, 16), rr(34, 60), P, 2.4, 2.2, 6, 0, 56, rnd(0.6), 1.3, 0.45);
    }
    this.glow.emit(at.x, at.y, at.z, 0, 0, 0, 0.3, 18, 56, P, 2.2, 0, 0, 0, 0, SH.core, SH.core, ENV_SPARK, 0, 1, 0.5, 0);
    this._ring2(this.ringB, at, 0.9, 4, 70, PAL.smokeGrey, 0.3, 0.09);
    this._distortRing(at, 0.6, 70, 0.8);
    if (ent) this._startCast('inferno', ent, m.dur || 4.5, 0, b);
    this.light(at, BREED_LOOK.ember.fire[1], 50, 0.5);
  }

  _novaBurst(at, R, P) {
    const k = this.dens * Math.max(0.5, this.lod(at));
    this.glow.emit(at.x, at.y, at.z, 0, 0, 0, 0.3, 30, 90, P, 2.0, 0, 0, 0, 0, SH.core, SH.core, ENV_SPARK, 0, 1, 0.5, 0);
    // the shockwave: a front of frost vapour out to the radius, a slower trailing swell, a flat sheet and refraction
    this._ring2(this.ringB, at, 1.2, 8, R * 1.05, PAL.mist, 1.0, 0.09, ENV_RING, 0.38);
    this._ring2(this.ringB, at, 1.6, 6, R * 0.82, PAL.mist, 0.5, 0.14, ENV_RING, 0.5);
    this._ring2(this.ringF, at, 1.3, 8, R, PAL.mist, 0.8, 0.09, ENV_RING, 0.4);
    this._distortRing(at, 0.85, R * 1.05, 1.4);
    // ice: big readable shards flung outward, snow glitter, a cold fog
    for (let i = 0; i < cnt(54 * k); i++) {
      _a.set(rnd(1), rnd(1), rnd(1)).normalize();
      const sp = R * rr(0.55, 1.2);
      this._solidShape(at, _a.x * sp, _a.y * sp, _a.z * sp, rr(1.5, 2.6), rr(6, 13), SH.shard, PAL.ice, 1.3, 1.1, -7, 0, rnd(5), 0.5, 0, rr(4, 9));
    }
    for (let i = 0; i < cnt(170 * k); i++) {
      _a.set(rnd(1), rnd(1), rnd(1)).normalize();
      const sp = R * rr(0.3, 1.3);
      this._spark(at, _a.x * sp, _a.y * sp, _a.z * sp, rr(0.9, 2.0), rr(3, 7), PAL.white, 4.5, 1.1, -3, Math.random() < 0.5 ? SH.flake : SH.glint, 0, 0, rnd(4), 1);
    }
    for (let i = 0; i < cnt(26 * k); i++) {
      _a.set(rnd(1), rnd(0.5), rnd(1)).normalize();
      const sp = R * rr(0.2, 0.7);
      this._smoke(at, _a.x * sp, _a.y * sp, _a.z * sp, rr(2.2, 3.6), rr(30, 50), rr(90, 150), PAL.mist, 1, 1.4, 0, 0, rnd(0.4), 4, 56, 0.6);
    }
    this.light(at, BREED_LOOK.frost.fire[1], 90, 0.7);
  }

  // Chain Lightning: bright branching arcs along the path between targets, or a fizzle on a miss
  _chainBolts(path, miss, P) {
    if (!path || path.length < 2) return;
    const k = this.dens;
    for (let s = 1; s < path.length; s++) {
      const a0 = path[s - 1], a1 = path[s];
      const L = Math.hypot(a1.x - a0.x, a1.y - a0.y, a1.z - a0.z);
      const dcam = Math.hypot((a0.x + a1.x) / 2 - this.cam.x, (a0.y + a1.y) / 2 - this.cam.y, (a0.z + a1.z) / 2 - this.cam.z);
      const ws = Math.min(5, Math.max(1, dcam / 110)); // keep bolts readable at range
      this.arcs.spawn(a0, a1, miss ? 0.3 : 0.5, (miss ? 0.8 : 1.4) * ws, PAL.storm, miss ? 3.5 : 7.5, 0.1);
      this.arcs.spawn(a0, a1, miss ? 0.22 : 0.38, (miss ? 0.35 : 0.6) * ws, PAL.storm, miss ? 5 : 11, 0.18);
      const nb = miss ? 2 : 4;
      for (let i = 0; i < nb; i++) {
        const f = rr(0.1, 0.9);
        _a.set(a0.x + (a1.x - a0.x) * f, a0.y + (a1.y - a0.y) * f, a0.z + (a1.z - a0.z) * f);
        const len = L * rr(0.1, 0.28);
        _b.set(_a.x + rnd(len), _a.y + rnd(len), _a.z + rnd(len));
        this.arcs.spawn(_a, _b, rr(0.15, 0.4), rr(0.35, 0.7) * ws, PAL.storm, miss ? 3 : 6, 0.22);
      }
      if (!miss || s === path.length - 1) {
        this.glow.emit(a1.x, a1.y, a1.z, 0, 0, 0, 0.3, 18, 46, P, 2.4, 0, 0, Math.random() * 6, 0, SH.bolt, SH.bolt, ENV_SPARK, 0, 1, 0.5, 0);
        this._ring2(this.ringB, a1, 0.5, 3, miss ? 14 : 30, PAL.smokeGrey, miss ? 0.15 : 0.25, 0.1);
        for (let i = 0; i < cnt((miss ? 10 : 26) * k); i++) {
          _b.set(rnd(1), rnd(1), rnd(1)).normalize();
          const sp = rr(20, 80);
          this._spark(a1, _b.x * sp, _b.y * sp, _b.z * sp, rr(0.3, 0.8), rr(0.6, 1.2), P, 6, 1.2, -10, SH.streak, 0.05);
        }
      }
    }
    // the muzzle end flashes too
    const p0 = path[0];
    this.glow.emit(p0.x, p0.y, p0.z, 0, 0, 0, 0.2, 14, 32, P, 2.2, 0, 0, 0, 0, SH.core, SH.core, ENV_SPARK, 0, 1, 0.5, 0);
    this.light(path[path.length - 1], BREED_LOOK.storm.fire[1], miss ? 40 : 100, 0.4);
  }

  _acidBurst(at, R, P) {
    const k = this.dens * Math.max(0.5, this.lod(at));
    this.glow.emit(at.x, at.y, at.z, 0, 0, 0, 0.25, 16, 44, P, 1.1, 0, 0, 0, 0, SH.core, SH.core, ENV_SPARK, 0, 1, 0.5, 0);
    this._ring2(this.ringF, at, 1.1, 4, R, PAL.olive, 0.55, 0.08, ENV_RING, 0.4);
    this._ring2(this.ringB, at, 0.8, 3, R * 0.8, PAL.olive, 0.3, 0.1);
    for (let i = 0; i < cnt(44 * k); i++) {
      _a.set(rnd(1), rr(0.1, 1), rnd(1)).normalize();
      const sp = R * rr(0.4, 1.3);
      this._solidShape(at, _a.x * sp * 0.8, _a.y * sp * 1.3, _a.z * sp * 0.8, rr(1.2, 2.2), rr(3, 7), SH.glob, PAL.acid, 1.2, 0.4, -34, 0.01, rnd(3), 0.9, 0.2);
    }
    for (let i = 0; i < cnt(16 * k); i++) {
      _a.set(rnd(1), rnd(0.4), rnd(1)).normalize();
      const sp = R * rr(0.2, 0.8);
      this._smoke(at, _a.x * sp, _a.y * sp + 4, _a.z * sp, rr(2.5, 4), rr(26, 40), rr(R * 0.8, R * 1.3), PAL.smokeVenom, 1, 1.6, 1, 0.35, rnd(0.8), 4, 56, 0.7);
    }
    this.light(at, BREED_LOOK.venom.fire[1], 70, 0.6);
  }

  _updateCasts(dt) {
    for (const c of this.casts) {
      if (!c.on) continue;
      c.t += dt;
      const e = c.ent;
      if (c.t > c.dur || (e && e.alive === false)) { c.on = false; continue; }
      const k = clamp01(c.t / c.dur);
      const P = c.P;
      const pos = e ? e.pos : c.from;
      const lod = this.lod(pos);
      if (lod <= 0.03) continue;
      const kk = this.dens * lod;
      const life = Math.max(dt * 2.6, 0.05);
      switch (c.kind) {
        case 'nova': {
          // a wall of frost vapour closes in on the caster: two rings of mist, converging glitter and cold fog
          const rad = c.r * (1 - 0.82 * Math.pow(k, 1.5));
          this._ring2(this.ringF, pos, life, rad, rad, PAL.mist, 0.35 + 0.3 * k, 0.06, ENV_FLAT);
          this._ring2(this.ringB, pos, life, rad, rad, PAL.mist, 0.25 + 0.3 * k, 0.05, ENV_FLAT);
          for (let i = 0; i < cnt(dt * 600 * kk); i++) {
            _a.set(rnd(1), rnd(1), rnd(1)).normalize();
            const inward = (rad / Math.max(0.05, c.dur - c.t)) * 0.9;
            this._spark(_b.set(pos.x + _a.x * rad, pos.y + _a.y * rad, pos.z + _a.z * rad), -_a.x * inward, -_a.y * inward, -_a.z * inward, rr(0.12, 0.25), rr(3, 6), PAL.white, 2 + 1.5 * k, 0, 0, Math.random() < 0.5 ? SH.glint : SH.flake, 0, 0, rnd(3), 1);
          }
          for (let i = 0; i < cnt(dt * 70 * kk); i++) {
            _a.set(rnd(1), rnd(0.6), rnd(1)).normalize();
            this._smoke(_b.set(pos.x + _a.x * rad, pos.y + _a.y * rad, pos.z + _a.z * rad), -_a.x * rad * 1.1, -_a.y * rad * 1.1, -_a.z * rad * 1.1, rr(0.3, 0.5), rr(14, 24), rr(20, 34), PAL.mist, 0.9, 0.5, 0, 0, 0, 4, 56, 0.45);
          }
          this.glow.emit(pos.x, pos.y, pos.z, 0, 0, 0, life, 6 + 18 * k, 6 + 18 * k, P, 1 + 1.2 * k, 0, 0, 0, 0, SH.core, SH.core, ENV_FLAT, 0, 1, 1, 0);
          this.light(pos, BREED_LOOK.frost.fire[1], 30 + 50 * k);
          break;
        }
        case 'chain': {
          // crackle gathers on the caster; a flickering lock line and halo mark the victim
          const tp = c.tgt && c.tgt.alive !== false ? c.tgt.pos : null;
          for (let i = 0; i < cnt(dt * (24 + 70 * k) * Math.max(0.5, kk)); i++) {
            _a.set(pos.x + rnd(5), pos.y + rnd(3), pos.z + rnd(5));
            const len = rr(6, 16 + 10 * k);
            _b.set(_a.x + rnd(len), _a.y + rnd(len), _a.z + rnd(len));
            this.arcs.spawn(_a, _b, rr(0.05, 0.12), rr(0.3, 0.55), PAL.storm, 4 + 4 * k, 0.2);
          }
          this.glow.emit(pos.x, pos.y, pos.z, 0, 0, 0, life, 4 + 9 * k, 4 + 9 * k, P, 1.5 + 1.5 * k, 0, 0, 0, 0, SH.bolt, SH.bolt, ENV_FLAT, 0, 1, 1, 0);
          if (tp) {
            if (Math.random() < 0.8) this.arcs.spawn(pos, tp, 0.06, 0.18, PAL.storm, 2 + 2 * k, 0.12);
            for (let i = 0; i < cnt(dt * 40 * Math.max(0.5, kk)); i++) {
              _a.set(rnd(1), rnd(1), rnd(1)).normalize();
              _b.set(tp.x + _a.x * 16, tp.y + _a.y * 16, tp.z + _a.z * 16);
              _c.set(tp.x + _a.x * 6 + rnd(4), tp.y + _a.y * 6 + rnd(4), tp.z + _a.z * 6 + rnd(4));
              this.arcs.spawn(_b, _c, 0.07, 0.35, PAL.storm, 5, 0.22);
            }
            this.glow.emit(tp.x, tp.y, tp.z, 0, 0, 0, life, 22 + 10 * k, 22 + 10 * k, P, 0.12 + 0.25 * k, 0, 0, Math.random() * 6, 0, SH.round, SH.round, ENV_FLAT, 0, 0.8, 1, 0);
            this.light(tp, BREED_LOOK.storm.fire[1], 20 + 30 * k);
          }
          this.light(pos, BREED_LOOK.storm.fire[1], 20 + 40 * k);
          break;
        }
        case 'acid': {
          // a glob arcs out of the mouth; a pulsing marker shows where the cloud will land
          _a.copy(c.from).lerp(c.to, k);
          _a.y += Math.sin(k * Math.PI) * Math.min(40, c.from.distanceTo(c.to) * 0.16);
          this.glow.emit(_a.x, _a.y, _a.z, 0, 0, 0, life, 4, 4, P, 1.4, 0, 0, 0, 0, SH.core, SH.core, ENV_FLAT, 0, 1, 1, 0);
          this._solidShape(_a, 0, 0, 0, life, 3.4, SH.glob, PAL.acid, 1.3, 0, 0, 0, 0, 1);
          for (let i = 0; i < cnt(dt * 120 * kk); i++) {
            this._smoke(_a, rnd(6), rnd(3) - 1, rnd(6), rr(0.6, 1.1), rr(2, 4), rr(7, 12), PAL.smokeVenom, 1, 1.2, -4, 0.9, rnd(0.6), 4, 56, 0.7);
            if (Math.random() < 0.5) this._solidShape(_a, rnd(8), rr(-4, 2), rnd(8), rr(0.5, 1.0), rr(0.9, 1.7), SH.glob, PAL.acid, 1.2, 0.3, -30, 0, rnd(3), 0.8);
          }
          const pulse = 0.85 + 0.15 * Math.sin(c.t * 10);
          this._ring2(this.ringF, c.to, life, c.r, c.r, PAL.olive, (0.4 + 0.25 * k) * pulse, 0.035, ENV_FLAT);
          this._ring2(this.ringF, c.to, life, c.r * (1 - k * 0.7), c.r * (1 - k * 0.7), PAL.olive, 0.22, 0.025, ENV_FLAT);
          for (let i = 0; i < cnt(dt * 36 * kk); i++) {
            const a = Math.random() * 6.283;
            _b.set(c.to.x + Math.cos(a) * c.r, c.to.y, c.to.z + Math.sin(a) * c.r);
            this._smoke(_b, rnd(1.5), rr(5, 12), rnd(1.5), rr(0.8, 1.4), rr(2.5, 4), rr(7, 11), PAL.smokeVenom, 1, 1.0, 2, 0.15, rnd(0.6), 4, 56, 0.4);
          }
          this.light(_a, BREED_LOOK.venom.fire[1], 24);
          break;
        }
        case 'inferno': {
          // the dragon trails a ribbon of flame while the napalm drops
          if (!e) break;
          _u.set(0, 0, 1).applyQuaternion(e.quat);
          for (let i = 0; i < cnt(dt * 60 * kk); i++) {
            const sp = rr(14, 40);
            _b.set(pos.x + _u.x * 6 + rnd(2), pos.y + _u.y * 6 + rnd(1), pos.z + _u.z * 6 + rnd(2));
            this._fire(_b, e.vel.x * 0.5 + _u.x * sp + rnd(5), e.vel.y * 0.5 + _u.y * sp + rr(0, 5), e.vel.z * 0.5 + _u.z * sp + rnd(5), rr(0.5, 0.9), rr(4, 6), rr(12, 22), P, 2.2, 1.6, 5, 4, 54, rnd(1));
          }
          if (Math.random() < dt * 20 * kk) this._spark(_b.set(pos.x + _u.x * 8, pos.y, pos.z + _u.z * 8), e.vel.x * 0.4 + rnd(12), e.vel.y * 0.4 + rnd(12), e.vel.z * 0.4 + rnd(12), rr(0.5, 1), rr(0.6, 1.1), P, 6, 1, -10, SH.streak, 0.05);
          this.light(_b.set(pos.x + _u.x * 8, pos.y, pos.z + _u.z * 8), BREED_LOOK.ember.fire[1], 24);
          break;
        }
      }
    }
  }

  // Lingering ground effects, called every frame per zone. kind: 'nap' | 'acid'; lifeFrac runs 1 -> 0.
  abilityZone(kind, pos, radius, pal, dt, lifeFrac) {
    const lod = this.lod(pos);
    if (lod <= 0.05) return;
    const k = this.dens * lod;
    const fade = clamp01(lifeFrac * 4);
    const life = Math.max(dt * 2.6, 0.05);
    if (kind === 'nap') {
      const P = paletteOf('ember');
      this._ring2(this.ringF, pos, life, radius, radius, PAL.ash, 0.22 * fade, 0.06, ENV_FLAT);
      for (let i = 0; i < cnt(dt * 70 * k * fade); i++) {
        const rim = Math.random() < 0.35;
        const a = Math.random() * 6.283, r0 = rim ? radius * rr(0.85, 1) : radius * Math.sqrt(Math.random());
        _a.set(pos.x + Math.cos(a) * r0, pos.y + rnd(radius * 0.2), pos.z + Math.sin(a) * r0);
        this._fire(_a, rnd(2), rr(3, 9), rnd(2), rr(0.55, 1.0), radius * rr(0.25, 0.4), radius * rr(0.45, 0.7), P, 1.9, 1.6, 6, 6, 54, rnd(1));
      }
      for (let i = 0; i < cnt(dt * 16 * k * fade); i++) {
        const a = Math.random() * 6.283, r0 = radius * Math.sqrt(Math.random());
        _a.set(pos.x + Math.cos(a) * r0, pos.y, pos.z + Math.sin(a) * r0);
        this._spark(_a, rnd(6), rr(8, 24), rnd(6), rr(0.8, 1.7), rr(0.6, 1.2), P, 5, 0.6, 3, SH.round, 0, 0, 0, 0.3);
      }
      if (Math.random() < dt * 5 * k * fade) {
        _a.set(pos.x + rnd(radius * 0.6), pos.y + radius * 0.3, pos.z + rnd(radius * 0.6));
        this._smoke(_a, rnd(2), rr(6, 12), rnd(2), rr(2, 3.4), radius * 0.4, radius * 1.3, PAL.smokeDark, 1, 0.8, 2, 0.4, rnd(0.5), 4, 56, 0.6);
      }
      if (this.q.haze && Math.random() < dt * 2 * k * fade) this._distortHaze(_a.set(pos.x, pos.y + radius * 0.6, pos.z), 0.7, radius * 0.9, radius * 1.8, 0.5);
      this.light(_a.set(pos.x, pos.y + 4, pos.z), BREED_LOOK.ember.fire[1], 14 * fade);
    } else {
      this._ring2(this.ringF, pos, life, radius, radius, PAL.olive, 0.38 * fade, 0.035, ENV_FLAT);
      for (let i = 0; i < cnt(dt * 18 * k * fade); i++) {
        const a = Math.random() * 6.283, r0 = radius * Math.sqrt(Math.random()) * 0.85;
        _a.set(pos.x + Math.cos(a) * r0, pos.y + rnd(radius * 0.4), pos.z + Math.sin(a) * r0);
        this._smoke(_a, -Math.sin(a) * 4, rnd(2), Math.cos(a) * 4, rr(3.2, 4.8), radius * rr(0.45, 0.65), radius * rr(0.7, 1.0), PAL.smokeVenom, 1, 0.5, 0, 0.3, 0.5, 4, 56, 0.75 * (0.4 + 0.6 * fade));
      }
      for (let i = 0; i < cnt(dt * 9 * k * fade); i++) {
        const a = Math.random() * 6.283, r0 = radius * Math.sqrt(Math.random()) * 0.9;
        _a.set(pos.x + Math.cos(a) * r0, pos.y + rnd(radius * 0.3), pos.z + Math.sin(a) * r0);
        this.solid.emit(_a.x, _a.y, _a.z, rnd(1), rr(3, 9), rnd(1), rr(1.2, 2.2), rr(1.6, 3.6), rr(2, 4.4), PAL.acid, 1.1, 0.6, 1, 0, rnd(1), SH.bubble, SH.bubble, ENV_FLAT, 0, 0.5, 1, 0);
      }
      for (let i = 0; i < cnt(dt * 10 * k * fade); i++) {
        const a = Math.random() * 6.283;
        _a.set(pos.x + Math.cos(a) * radius, pos.y - radius * 0.2, pos.z + Math.sin(a) * radius);
        this._smoke(_a, rnd(2), rr(6, 14), rnd(2), rr(1.2, 2), rr(4, 6), rr(12, 18), PAL.smokeVenom, 1, 0.9, 2, 0.15, rnd(0.5), 4, 56, 0.45);
      }
      this.light(_a.set(pos.x, pos.y, pos.z), BREED_LOOK.venom.fire[1], 18 * fade);
    }
  }

  // Status telegraphs on a dragon (called every frame while the effect lasts): readable at range in a crowded fight.
  status(key, ent, kind, dt) {
    const pos = ent.pos;
    const lod = this.lod(pos);
    if (lod <= 0.08) return;
    const k = this.dens * lod;
    const life = Math.max(dt * 2.6, 0.05);
    const vel = ent.vel;
    const body = (x, y, z) => _c.set(x, y, z).applyQuaternion(ent.quat).add(pos);
    switch (kind) {
      case 'chill': {
        // frosted over: a blue halo, glitter freezing on the hide, mist streaming off the wings, ice dropping away
        this.glow.emit(pos.x, pos.y, pos.z, 0, 0, 0, life, 28, 28, PAL.frost, 0.14, 0, 0, 0, 0, SH.round, SH.round, ENV_FLAT, 0, 0.7, 1, 0);
        for (let i = 0; i < cnt(dt * 26 * k); i++) {
          body(rnd(8), rnd(1.6), rnd(5));
          this._spark(_c, vel.x * 0.97 + rnd(3), vel.y * 0.97 + rnd(3), vel.z * 0.97 + rnd(3), rr(0.5, 1.0), rr(1.2, 2.4), PAL.white, 4.5, 0.4, -3, Math.random() < 0.5 ? SH.flake : SH.glint, 0, 0, rnd(4), 0.4);
        }
        for (let i = 0; i < cnt(dt * 18 * k); i++) {
          body(i % 2 ? 8 : -8, 0, 2);
          this._smoke(_c, vel.x * 0.9 + rnd(2), vel.y * 0.9, vel.z * 0.9 + rnd(2), rr(0.8, 1.4), rr(2.5, 4), rr(9, 14), PAL.mist, 0.9, 0.8, 0, 0, rnd(0.5), 4, 56, 0.4);
        }
        if (Math.random() < dt * 5 * k) {
          body(rnd(7), -1, rnd(4));
          this._solidShape(_c, vel.x * 0.9, vel.y * 0.9, vel.z * 0.9, rr(0.7, 1.3), rr(1.6, 2.8), SH.shard, PAL.ice, 1.2, 0.6, -16, 0, rnd(8), 0.3);
        }
        break;
      }
      case 'armor': {
        // Rime Armor: three ice crystals orbit the dragon
        for (let i = 0; i < 3; i++) {
          const a = performance.now() * 0.0026 + (i * 6.283) / 3;
          body(Math.cos(a) * 12, Math.sin(a * 1.3) * 2, Math.sin(a) * 9);
          this._solidShape(_c, vel.x, vel.y, vel.z, life, 3.6, SH.shard, PAL.ice, 1.5, 0, 0, 0, a * 3, 0.6);
          this.glow.emit(_c.x, _c.y, _c.z, vel.x, vel.y, vel.z, life, 5, 5, PAL.frost, 0.9, 0, 0, 0, 0, SH.glint, SH.glint, ENV_FLAT, 0, 1, 1, 0);
        }
        this.glow.emit(pos.x, pos.y, pos.z, 0, 0, 0, life, 24, 24, PAL.frost, 0.08, 0, 0, 0, 0, SH.round, SH.round, ENV_FLAT, 0, 0.7, 1, 0);
        break;
      }
      case 'corrode':
      case 'poison': {
        // eaten by acid: sickly halo, dripping globs, rising bubbles, green wisps
        const m = kind === 'corrode' ? 1.5 : 1;
        this.glow.emit(pos.x, pos.y, pos.z, 0, 0, 0, life, 26, 26, PAL.venom, 0.1 * m, 0, 0, 0, 0, SH.round, SH.round, ENV_FLAT, 0, 0.7, 1, 0);
        for (let i = 0; i < cnt(dt * 14 * m * k); i++) {
          body(rnd(8), rr(-1, 0.5), rnd(5));
          this._solidShape(_c, vel.x * 0.92, vel.y * 0.92 - 2, vel.z * 0.92, rr(0.7, 1.3), rr(1.3, 2.4), SH.drop, PAL.acid, 1.1, 0.3, -26, 0.01, 0, 0.25);
        }
        for (let i = 0; i < cnt(dt * 8 * m * k); i++) {
          body(rnd(7), rr(0, 1.5), rnd(4));
          this.solid.emit(_c.x, _c.y, _c.z, vel.x * 0.9 + rnd(2), vel.y * 0.9 + rr(2, 6), vel.z * 0.9 + rnd(2), rr(0.8, 1.4), rr(1, 1.8), rr(1.4, 2.4), PAL.acid, 1.1, 1, 1, 0, rnd(1), SH.bubble, SH.bubble, ENV_FLAT, 0, 0.5, 1, 0);
        }
        for (let i = 0; i < cnt(dt * 10 * m * k); i++) {
          body(rnd(8), rnd(1), rnd(5));
          this._smoke(_c, vel.x * 0.9 + rnd(2), vel.y * 0.9 + rr(1, 3), vel.z * 0.9 + rnd(2), rr(1, 1.8), rr(2.5, 4), rr(9, 14), PAL.smokeVenom, 1, 0.9, 2, 0.7, rnd(0.5), 4, 56, 0.4);
        }
        break;
      }
      case 'burn': this.ignite(key, ent, BREED_LOOK.ember.fire, 0.35, 'ember'); break;
      case 'blaze': {
        this.glow.emit(pos.x, pos.y, pos.z, 0, 0, 0, life, 26, 26, PAL.ember, 0.14, 0, 0, 0, 0, SH.round, SH.round, ENV_FLAT, 0, 0.7, 1, 0);
        for (let i = 0; i < cnt(dt * 18 * k); i++) {
          body(rnd(8), rnd(1.5), rnd(5));
          this._spark(_c, vel.x * 0.95 + rnd(4), vel.y * 0.95 + rr(1, 6), vel.z * 0.95 + rnd(4), rr(0.5, 1), rr(0.9, 1.6), PAL.ember, 5, 0.6, 4, SH.round, 0, 0, 0, 0.3);
        }
        break;
      }
      case 'amp': {
        this.glow.emit(pos.x, pos.y, pos.z, 0, 0, 0, life, 26, 26, PAL.gold, 0.14, 0, 0, 0, 0, SH.round, SH.round, ENV_FLAT, 0, 0.7, 1, 0);
        for (let i = 0; i < cnt(dt * 16 * k); i++) {
          body(rnd(8), rnd(1.5), rnd(5));
          this._spark(_c, vel.x * 0.95 + rnd(3), vel.y * 0.95 + rr(1, 5), vel.z * 0.95 + rnd(3), rr(0.5, 1), rr(1.2, 2.2), PAL.gold, 5, 0.5, 3, SH.glint, 0, 0, rnd(3), 0.4);
        }
        break;
      }
    }
  }

  // ----------------------------------------------------------------- lights
  // request a light this frame (single-frame unless `life` is given)
  light(p, rgb, intensity, life = 0) {
    const r = this.lightReq[this.lightHead];
    this.lightHead = (this.lightHead + 1) % LIGHT_MAX;
    r.p.set(p.x, p.y, p.z);
    r.c = rgb;
    r.i = intensity;
    r.life = life;
    r.age = 0;
    r.on = true;
  }

  update(dt, camera) {
    this.time += dt;
    this.cam.copy(camera.position);
    this.camera = camera;
    this._updateColumns(dt);
    this._updateBurning(dt);
    this._updateCasts(dt);
    for (const p of this.pools) {
      p.uniforms.uTime.value = this.time;
      p.update(dt);
    }
    this.ribbons.tick(this.time);
    this.arcs.tick(this.time);
    this.ribbons.update(dt, camera);
    this.arcs.update(dt, camera);
    if (this.distortPass) this.distortPass.enabled = this.q.haze && this.haze.n > 0;

    // lights: keep lasting requests (explosions), single-frame ones are consumed
    const reqs = this.lightReq;
    let best = [null, null, null, null], bs = [-1, -1, -1, -1];
    for (let i = 0; i < LIGHT_MAX; i++) {
      const r = reqs[i];
      if (!r.on) continue;
      r.age += dt;
      const fade = r.life ? Math.max(0, 1 - r.age / r.life) : 1;
      r.score = (r.i * fade) / (1 + r.p.distanceToSquared(camera.position) / 40000);
      if (r.life && r.age >= r.life) r.on = false;
      // insert into the top-4 list
      for (let j = 0; j < 4; j++) {
        if (r.score > bs[j]) {
          for (let m = 3; m > j; m--) { bs[m] = bs[m - 1]; best[m] = best[m - 1]; }
          bs[j] = r.score;
          best[j] = r;
          break;
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const l = this.lights[i];
      const r = best[i];
      if (r && r.score > 0) {
        l.position.copy(r.p);
        l.color.setRGB(r.c[0], r.c[1], r.c[2]);
        l.intensity = r.i * 14 * (r.life ? Math.max(0, 1 - r.age / r.life) : 1);
      } else l.intensity = 0;
    }
    // single-frame requests are consumed after use
    for (let i = 0; i < LIGHT_MAX; i++) if (reqs[i].on && !reqs[i].life) reqs[i].on = false;
  }
}
