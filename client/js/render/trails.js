// Wingtip vapour trails: thin camera-facing ribbons that appear in hard turns and fast dives, like the
// vortices off a fighter's wingtips. All ribbons share one dynamic mesh.
import * as THREE from 'three';

const POINTS = 40;
const STEP = 0.025; // s between samples
const MAX_TRAILS = 48;

export class Trails {
  constructor(scene) {
    this.trails = new Map();
    const verts = MAX_TRAILS * POINTS * 2;
    this.pos = new Float32Array(verts * 3);
    this.alpha = new Float32Array(verts);
    const uvs = new Float32Array(verts * 2);
    for (let t = 0; t < MAX_TRAILS; t++) {
      for (let i = 0; i < POINTS; i++) {
        const v = (t * POINTS + i) * 2;
        uvs[v * 2] = i / (POINTS - 1); uvs[v * 2 + 1] = -1;
        uvs[v * 2 + 2] = i / (POINTS - 1); uvs[v * 2 + 3] = 1;
      }
    }
    const idx = [];
    for (let t = 0; t < MAX_TRAILS; t++) {
      for (let i = 0; i < POINTS - 1; i++) {
        const a = (t * POINTS + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('alpha', this.aAlpha);
    geo.setAttribute('tuv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]);
    this.uniforms = uniforms;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float alpha;
        attribute vec2 tuv;
        varying float vA;
        varying vec2 vT;
        void main() {
          vA = alpha;
          vT = tuv;
          vec3 transformed = position;
          vec4 mvPosition = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        varying float vA;
        varying vec2 vT;
        void main() {
          // soft vapour: gaussian across the ribbon, wispy along it, brighter in a tight core near the wingtip
          float across = exp(-vT.y * vT.y * 2.6);
          float wisp = 0.72 + 0.28 * sin(vT.x * 47.0 - uTime * 6.0 + vT.y * 4.0) * sin(vT.x * 19.0 + vT.y * 7.0);
          float core = exp(-vT.y * vT.y * 14.0) * (1.0 - vT.x);
          vec3 c = mix(vec3(1.05, 1.1, 1.18), vec3(1.5, 1.5, 1.55), core);
          gl_FragColor = vec4(c, vA * 0.62 * across * wisp);
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    scene.add(this.mesh);
    this._side = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._to = new THREE.Vector3();
  }

  // feed a wingtip position and how visible the vapour should be (0..1)
  feed(key, p, strength, dt) {
    let t = this.trails.get(key);
    if (!t) {
      if (this.trails.size >= MAX_TRAILS) return;
      t = { pts: [], acc: 0, slot: this.freeSlot(), last: 0 };
      this.trails.set(key, t);
    }
    t.last = performance.now();
    t.acc += dt;
    if (t.acc >= STEP || t.pts.length === 0) {
      t.acc = 0;
      t.pts.unshift({ p: p.clone(), s: strength, age: 0 });
      if (t.pts.length > POINTS) t.pts.pop();
    } else {
      t.pts[0].p.copy(p);
      t.pts[0].s = strength;
    }
  }

  freeSlot() {
    const used = new Set([...this.trails.values()].map((t) => t.slot));
    for (let i = 0; i < MAX_TRAILS; i++) if (!used.has(i)) return i;
    return 0;
  }

  update(dt, camera) {
    const now = performance.now();
    this.uniforms.uTime.value += dt;
    this.alpha.fill(0);
    for (const [key, t] of this.trails) {
      if (now - t.last > 500) {
        this.trails.delete(key);
        continue;
      }
      const base = t.slot * POINTS * 2;
      const n = t.pts.length;
      for (let i = 0; i < n; i++) {
        const pt = t.pts[i];
        pt.age += dt;
        const a = pt.p;
        const b = t.pts[Math.min(n - 1, i + 1)].p;
        this._dir.subVectors(a, b);
        if (this._dir.lengthSq() < 1e-6 && i > 0) this._dir.subVectors(t.pts[i - 1].p, a);
        this._to.subVectors(camera.position, a);
        this._side.crossVectors(this._dir, this._to).normalize();
        const w = 0.07 + Math.pow(i / POINTS, 0.7) * 0.9;
        const v = base + i * 2;
        this.pos[v * 3] = a.x + this._side.x * w;
        this.pos[v * 3 + 1] = a.y + this._side.y * w;
        this.pos[v * 3 + 2] = a.z + this._side.z * w;
        this.pos[v * 3 + 3] = a.x - this._side.x * w;
        this.pos[v * 3 + 4] = a.y - this._side.y * w;
        this.pos[v * 3 + 5] = a.z - this._side.z * w;
        // fade out where the ribbon passes close to the camera
        const near = Math.min(1, Math.max(0, (this._to.length() - 18) / 30));
        const fade = (1 - i / (POINTS - 1)) * pt.s * near;
        this.alpha[v] = this.alpha[v + 1] = i === 0 ? 0 : fade;
      }
      // collapse unused tail of the slot onto the last point
      for (let i = n; i < POINTS; i++) {
        const v = base + i * 2;
        const l = base + (n - 1) * 2;
        for (let k = 0; k < 6; k++) this.pos[v * 3 + k] = this.pos[l * 3 + (k % 3)];
      }
    }
    this.aPos.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
  }
}
