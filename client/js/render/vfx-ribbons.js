// Ribbon effects: tapering camera-facing strips for fireball tails and seeker "fire serpents" (with corkscrew
// helices), and short-lived jagged lightning arcs for the storm breed. Everything is CPU-built into two
// preallocated dynamic meshes (one draw call each).
import * as THREE from 'three';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function stripMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aCol;
      attribute vec2 aUv;
      varying vec4 vCol;
      varying vec2 vUv;
      void main() {
        vCol = aCol;
        vUv = aUv;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec4 vCol;
      varying vec2 vUv;
      void main() {
        float v = abs(vUv.y);
        float core = exp(-v * v * 7.0);
        float edge = smoothstep(1.0, 0.35, v);
        float flick = 0.82 + 0.18 * sin(vUv.x * 55.0 - uTime * 38.0 + vUv.y * 3.0);
        vec3 col = vCol.rgb * (0.3 + 1.5 * core) * flick;
        float a = vCol.a * edge;
        if (a < 0.003) discard;
        gl_FragColor = vec4(col, a);
      }`,
  });
}

function stripGeometry(slots, pts) {
  const verts = slots * pts * 2;
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 4);
  const uv = new Float32Array(verts * 2);
  const idx = new Uint32Array(slots * (pts - 1) * 6);
  let k = 0;
  for (let s = 0; s < slots; s++) {
    for (let i = 0; i < pts - 1; i++) {
      const a = (s * pts + i) * 2;
      idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + 2;
      idx[k++] = a + 1; idx[k++] = a + 3; idx[k++] = a + 2;
    }
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
  const aUv = new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aCol', aCol);
  geo.setAttribute('aUv', aUv);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return { geo, pos, col, uv, aPos, aCol, aUv };
}

// evaluate a 3-colour palette (hot, mid, cool) from a Float32Array of palettes at temperature x
function ramp(pals, id, x, out) {
  const b = id * 9;
  if (x < 0.5) {
    const f = x * 2;
    for (let c = 0; c < 3; c++) out[c] = pals[b + 6 + c] + (pals[b + 3 + c] - pals[b + 6 + c]) * f;
  } else {
    const f = (x - 0.5) * 2;
    for (let c = 0; c < 3; c++) out[c] = pals[b + 3 + c] + (pals[b + c] - pals[b + 3 + c]) * f;
  }
}

const _rgb = [0, 0, 0];
const _dir = new THREE.Vector3(), _to = new THREE.Vector3(), _side = new THREE.Vector3();
const _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3(), _c = new THREE.Vector3();

// ------------------------------------------------------------------ ribbons
const MAXR = 36;
const PTS = 40;
const STEP = 1 / 60;

export class Ribbons {
  constructor(scene, palettes) {
    this.pals = palettes;
    this.g = stripGeometry(MAXR, PTS);
    this.material = stripMaterial();
    this.mesh = new THREE.Mesh(this.g.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 23;
    scene.add(this.mesh);
    this.items = new Map();
    this.slots = new Array(MAXR).fill(null);
    this.limit = MAXR;
  }

  // Add a point to ribbon `key` (any object). cfg: { width, life, pal, inten, radius, turns, phase }
  feed(key, p, dt, cfg) {
    let r = this.items.get(key);
    if (!r) {
      let slot = -1;
      for (let i = 0; i < this.limit; i++) if (!this.slots[i]) { slot = i; break; }
      if (slot < 0) return;
      r = { slot, n: 0, pos: new Float32Array(PTS * 3), age: new Float32Array(PTS), ph: new Float32Array(PTS), acc: 0, cfg, last: 0, time: 0, phase0: cfg.phase || 0 };
      this.slots[slot] = r;
      this.items.set(key, r);
    }
    r.cfg = cfg;
    r.last = 0;
    r.time += dt;
    r.acc += dt;
    if (r.n === 0 || r.acc >= STEP) {
      r.acc = 0;
      if (r.n < PTS) r.n++;
      r.pos.copyWithin(3, 0, (PTS - 1) * 3);
      r.age.copyWithin(1, 0, PTS - 1);
      r.ph.copyWithin(1, 0, PTS - 1);
      r.age[0] = 0;
      r.ph[0] = r.phase0 + r.time * (cfg.turns || 0) * 6.283;
    }
    r.pos[0] = p.x; r.pos[1] = p.y; r.pos[2] = p.z;
  }

  update(dt, camera) {
    const { pos, col, uv } = this.g;
    const cam = camera.position;
    for (const [key, r] of this.items) {
      r.last += dt;
      const cfg = r.cfg;
      const life = cfg.life;
      for (let i = 0; i < r.n; i++) r.age[i] += dt;
      while (r.n > 0 && r.age[r.n - 1] > life) r.n--;
      const base = r.slot * PTS * 2;
      if (r.n < 2) {
        if (r.last > 0.05 || r.n === 0) {
          this.items.delete(key);
          this.slots[r.slot] = null;
          for (let v = base; v < base + PTS * 2; v++) { col[v * 4 + 3] = 0; pos[v * 3] = pos[v * 3 + 1] = pos[v * 3 + 2] = 0; }
        }
        continue;
      }
      const n = r.n;
      for (let i = 0; i < n; i++) {
        const u = clamp01(r.age[i] / life);
        const ix = i * 3;
        _c.set(r.pos[ix], r.pos[ix + 1], r.pos[ix + 2]);
        const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3;
        _dir.set(r.pos[a] - r.pos[b], r.pos[a + 1] - r.pos[b + 1], r.pos[a + 2] - r.pos[b + 2]);
        if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
        _dir.normalize();
        if (cfg.radius) {
          // corkscrew: offset around the flight line, widening as the trail ages
          _n1.set(0, 1, 0).cross(_dir);
          if (_n1.lengthSq() < 1e-4) _n1.set(1, 0, 0);
          _n1.normalize();
          _n2.crossVectors(_dir, _n1);
          const rad = cfg.radius * (0.25 + 1.6 * u);
          const ph = r.ph[i];
          _c.addScaledVector(_n1, Math.cos(ph) * rad).addScaledVector(_n2, Math.sin(ph) * rad);
        }
        _to.subVectors(cam, _c);
        _side.crossVectors(_dir, _to);
        if (_side.lengthSq() < 1e-8) _side.set(0, 1, 0);
        _side.normalize();
        const w = cfg.width * Math.pow(1 - u, cfg.taper || 0.8) * (i === 0 ? 0.55 : 1);
        const v = base + i * 2;
        pos[v * 3] = _c.x + _side.x * w; pos[v * 3 + 1] = _c.y + _side.y * w; pos[v * 3 + 2] = _c.z + _side.z * w;
        pos[v * 3 + 3] = _c.x - _side.x * w; pos[v * 3 + 4] = _c.y - _side.y * w; pos[v * 3 + 5] = _c.z - _side.z * w;
        const t0 = cfg.t0 === undefined ? 1 : cfg.t0;
        ramp(this.pals, cfg.pal, t0 - u * t0 * 0.85, _rgb);
        const near = clamp01((_to.length() - 6) / 24);
        const alpha = Math.pow(1 - u, cfg.fade || 1.3) * (cfg.alpha === undefined ? 1 : cfg.alpha) * near * (r.last > 0.02 ? clamp01(1 - r.last * 6) : 1);
        const k = cfg.inten;
        for (let s = 0; s < 2; s++) {
          const vv = (v + s) * 4;
          col[vv] = _rgb[0] * k; col[vv + 1] = _rgb[1] * k; col[vv + 2] = _rgb[2] * k; col[vv + 3] = alpha;
          uv[(v + s) * 2] = u * (cfg.len || 1) + (cfg.uoff || 0);
          uv[(v + s) * 2 + 1] = s ? 1 : -1;
        }
      }
      // collapse the unused tail onto the last point
      const l = base + (n - 1) * 2;
      for (let i = n; i < PTS; i++) {
        const v = base + i * 2;
        for (let k = 0; k < 6; k++) pos[v * 3 + k] = pos[l * 3 + k];
        col[v * 4 + 3] = col[(v + 1) * 4 + 3] = 0;
      }
    }
    this.g.aPos.needsUpdate = true;
    this.g.aCol.needsUpdate = true;
    this.g.aUv.needsUpdate = true;
  }

  tick(t) {
    this.material.uniforms.uTime.value = t;
  }
}

// ------------------------------------------------------------------ lightning arcs
const MAXA = 56;
const K = 16;

export class Arcs {
  constructor(scene, palettes) {
    this.pals = palettes;
    this.g = stripGeometry(MAXA, K);
    this.material = stripMaterial();
    this.mesh = new THREE.Mesh(this.g.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 24;
    scene.add(this.mesh);
    this.arcs = [];
    for (let i = 0; i < MAXA; i++) this.arcs.push({ on: false, a: new THREE.Vector3(), b: new THREE.Vector3(), age: 0, life: 0, w: 1, pal: 0, inten: 1, jit: 0, pts: new Float32Array(K * 3), amp: 0.15, fork: 0 });
    this.head = 0;
    this.limit = MAXA;
  }

  // one crackling arc between two points (world space)
  spawn(a, b, life, width, pal, inten = 3, amp = 0.16) {
    let slot = -1;
    for (let i = 0; i < this.limit; i++) if (!this.arcs[i].on) { slot = i; break; }
    if (slot < 0) slot = this.head = (this.head + 1) % this.limit;
    const r = this.arcs[slot];
    r.on = true; r.a.copy(a); r.b.copy(b); r.age = 0; r.life = life; r.w = width; r.pal = pal; r.inten = inten; r.jit = 0; r.amp = amp;
    this.rejitter(r);
    return r;
  }

  rejitter(r) {
    _dir.subVectors(r.b, r.a);
    const L = _dir.length();
    _dir.divideScalar(Math.max(L, 1e-4));
    _n1.set(0, 1, 0).cross(_dir);
    if (_n1.lengthSq() < 1e-4) _n1.set(1, 0, 0);
    _n1.normalize();
    _n2.crossVectors(_dir, _n1);
    let o1 = 0, o2 = 0;
    for (let i = 0; i < K; i++) {
      const f = i / (K - 1);
      const env = Math.sin(f * Math.PI);
      o1 = o1 * 0.45 + (Math.random() - 0.5) * 2 * 0.7;
      o2 = o2 * 0.45 + (Math.random() - 0.5) * 2 * 0.7;
      const amp = L * r.amp * env;
      r.pts[i * 3] = r.a.x + (r.b.x - r.a.x) * f + (_n1.x * o1 + _n2.x * o2) * amp;
      r.pts[i * 3 + 1] = r.a.y + (r.b.y - r.a.y) * f + (_n1.y * o1 + _n2.y * o2) * amp;
      r.pts[i * 3 + 2] = r.a.z + (r.b.z - r.a.z) * f + (_n1.z * o1 + _n2.z * o2) * amp;
    }
  }

  update(dt, camera) {
    const { pos, col, uv } = this.g;
    const cam = camera.position;
    for (let s = 0; s < MAXA; s++) {
      const r = this.arcs[s];
      const base = s * K * 2;
      if (!r.on) continue;
      r.age += dt;
      r.jit += dt;
      if (r.age >= r.life) {
        r.on = false;
        for (let v = base; v < base + K * 2; v++) { col[v * 4 + 3] = 0; pos[v * 3] = pos[v * 3 + 1] = pos[v * 3 + 2] = 0; }
        continue;
      }
      if (r.jit > 0.04) { r.jit = 0; this.rejitter(r); }
      const t = r.age / r.life;
      const flick = (0.55 + 0.45 * Math.random()) * (1 - t * t);
      for (let i = 0; i < K; i++) {
        const ix = i * 3;
        _c.set(r.pts[ix], r.pts[ix + 1], r.pts[ix + 2]);
        const a = Math.max(0, i - 1) * 3, b = Math.min(K - 1, i + 1) * 3;
        _dir.set(r.pts[b] - r.pts[a], r.pts[b + 1] - r.pts[a + 1], r.pts[b + 2] - r.pts[a + 2]).normalize();
        _to.subVectors(cam, _c);
        _side.crossVectors(_dir, _to);
        if (_side.lengthSq() < 1e-8) _side.set(0, 1, 0);
        _side.normalize();
        const f = i / (K - 1);
        const w = r.w * (0.35 + 0.65 * Math.sin(f * Math.PI)) ;
        const v = base + i * 2;
        pos[v * 3] = _c.x + _side.x * w; pos[v * 3 + 1] = _c.y + _side.y * w; pos[v * 3 + 2] = _c.z + _side.z * w;
        pos[v * 3 + 3] = _c.x - _side.x * w; pos[v * 3 + 4] = _c.y - _side.y * w; pos[v * 3 + 5] = _c.z - _side.z * w;
        ramp(this.pals, r.pal, 0.5 + 0.5 * Math.sin(f * Math.PI), _rgb);
        const near = clamp01((_to.length() - 4) / 20);
        for (let k = 0; k < 2; k++) {
          const vv = (v + k) * 4;
          col[vv] = _rgb[0] * r.inten; col[vv + 1] = _rgb[1] * r.inten; col[vv + 2] = _rgb[2] * r.inten; col[vv + 3] = flick * near;
          uv[(v + k) * 2] = f; uv[(v + k) * 2 + 1] = k ? 1 : -1;
        }
      }
    }
    this.g.aPos.needsUpdate = true;
    this.g.aCol.needsUpdate = true;
    this.g.aUv.needsUpdate = true;
  }

  tick(t) {
    this.material.uniforms.uTime.value = t;
  }
}
