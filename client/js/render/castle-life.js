// Life around the Citadel: bats wheeling round the spire tops and a faint mist pooling in the courtyard, both cheap.
//
//   bats   one InstancedMesh (about 150 bats, 6 triangles each, one draw call). Everything is in the vertex shader: the
//          orbit round a spire, the bank into the turn, the wing beat. They are drawn as dark silhouettes with the
//          world's height fog, and only within a couple of kilometres.
//   mist   two big translucent discs low in the courtyard, noise-modulated and drifting, fading to nothing toward the
//          keep, the walls and the camera (so flying through the layer never shows a sheet), with a warm glow near
//          the braziers of the avenue.
import * as THREE from 'three';
import { CASTLE, castleSpec, towerRadiusAt } from '../../../shared/castle.js';

const BATS = 150;

function batGeometry() {
  // a bat seen from above, nose to +z, wings along x: body (2 triangles) and two wings (2 triangles each); the wing
  // vertices carry their distance from the body in `wing` (0 body, 1 tip) so the shader can beat them
  const pos = [], wing = [], idx = [];
  const v = (x, y, z, w) => { pos.push(x, y, z); wing.push(w); return pos.length / 3 - 1; };
  const n = v(0, 0, 0.9, 0), l = v(-0.18, 0, -0.1, 0), r = v(0.18, 0, -0.1, 0), t = v(0, 0, -0.75, 0);
  idx.push(n, r, l, l, r, t);
  for (const s of [-1, 1]) {
    const a = v(s * 0.16, 0, 0.35, 0.15), b = v(s * 2.0, 0.1, 0.1, 1), c = v(s * 1.2, 0, -0.55, 0.7), d = v(s * 0.16, 0, -0.45, 0.1);
    if (s > 0) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('wing', new THREE.Float32BufferAttribute(wing, 1));
  g.setIndex(idx);
  return g;
}

export class CastleLife {
  constructor(scene, noiseTex) {
    this.group = new THREE.Group();
    this.group.position.set(CASTLE.x, CASTLE.y0, CASTLE.z);
    this.group.visible = false;
    scene.add(this.group);
    this.uTime = { value: 0 };
    this.buildBats();
    this.buildMist(noiseTex);
  }

  buildBats() {
    const S = castleSpec();
    // the tall spires: keep, satellites and the great towers. Bats favour the tallest.
    const spires = S.towers.filter((t) => t.top - t.y0 >= 240 && !/^(wt-o|bg)/.test(t.id));
    let wsum = 0;
    const ws = spires.map((t) => { const w = t.id === 'keep' ? 3.2 : t.top > 420 ? 1.6 : 1; wsum += w; return w; });
    const orb = new Float32Array(BATS * 4), mot = new Float32Array(BATS * 4);
    let seed = 91;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < BATS; i++) {
      let q = rnd() * wsum, k = 0;
      while (k < spires.length - 1 && q > ws[k]) q -= ws[k++];
      const t = spires[k];
      const yTop = t.top;
      const y = yTop - 20 - rnd() * Math.min(160, (yTop - t.y0) * 0.45);
      const rad = towerRadiusAt(t, y) + 14 + rnd() * 42;
      orb[i * 4] = t.x; orb[i * 4 + 1] = y; orb[i * 4 + 2] = t.z; orb[i * 4 + 3] = rad;
      const speed = 9 + rnd() * 5; // m/s along the circle
      const dir = rnd() < 0.5 ? -1 : 1;
      mot[i * 4] = rnd() * 6.283; // phase
      mot[i * 4 + 1] = (dir * speed) / rad; // angular speed
      mot[i * 4 + 2] = 3 + rnd() * 8; // vertical bob
      mot[i * 4 + 3] = rnd() * 6.283; // wing phase
    }
    const geo = batGeometry();
    geo.setAttribute('aOrb', new THREE.InstancedBufferAttribute(orb, 4));
    geo.setAttribute('aMot', new THREE.InstancedBufferAttribute(mot, 4));
    geo.instanceCount = BATS;
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: this.uTime }]);
    const mat = new THREE.ShaderMaterial({
      uniforms,
      fog: true,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float wing; attribute vec4 aOrb; attribute vec4 aMot;
        uniform float uTime;
        varying float vShade;
        void main() {
          float a = aMot.x + aMot.y * uTime;
          float dirn = sign(aMot.y);
          vec3 c = aOrb.xyz + vec3(cos(a) * aOrb.w, sin(uTime * 0.6 + aMot.x * 3.0) * aMot.z, sin(a) * aOrb.w);
          // heading: the tangent of the circle; bank into the turn
          vec3 fwd = vec3(-sin(a) * dirn, 0.0, cos(a) * dirn);
          vec3 side = vec3(fwd.z, 0.0, -fwd.x);
          float flap = sin(uTime * (11.0 + aMot.z) + aMot.w) * 0.6 + sin(uTime * 1.7 + aMot.w) * 0.25;
          vec3 p = position * 1.7;
          float bank = -0.28 * dirn;
          float lift = p.x * (flap + bank * 0.6) * wing;
          p.y += lift * 0.9 + (p.x * bank) * 0.5;
          p.z -= abs(p.x) * 0.12 * flap * wing;
          vec3 world = c + fwd * p.z + side * p.x + vec3(0.0, 1.0, 0.0) * p.y;
          vShade = 0.5 + 0.5 * wing;
          vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        varying float vShade;
        void main() {
          gl_FragColor = vec4(vec3(0.028, 0.03, 0.04) * (0.7 + 0.5 * vShade), 1.0);
          #include <fog_fragment>
        }`,
    });
    this.bats = new THREE.Mesh(geo, mat);
    this.bats.frustumCulled = false;
    this.group.add(this.bats);
  }

  buildMist(noiseTex) {
    const braz = [];
    const S = castleSpec();
    for (const b of S.avenue || []) braz.push(new THREE.Vector2(b[0], b[1]));
    while (braz.length < 8) braz.push(new THREE.Vector2(1e5, 1e5));
    const make = (y, seed, amt) => {
      const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uBraz: { value: braz.slice(0, 8) }, uY: { value: y }, uSeed: { value: seed }, uAmt: { value: amt } }]);
      u.uTime = this.uTime;
      u.uNoise = { value: noiseTex };
      const mat = new THREE.ShaderMaterial({
        uniforms: u,
        fog: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          #include <common>
          #include <fog_pars_vertex>
          varying vec2 vXZ;
          void main() {
            vXZ = position.xz;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: /* glsl */ `
          #include <common>
          #include <fog_pars_fragment>
          uniform float uTime; uniform sampler2D uNoise; uniform float uY; uniform float uSeed; uniform float uAmt;
          uniform vec2 uBraz[8];
          varying vec2 vXZ;
          void main() {
            vec2 q = vXZ;
            vec2 drift = vec2(uTime * 0.9, uTime * 0.45) * (1.0 + uSeed * 0.3);
            float n1 = texture2D(uNoise, (q + drift) * 0.002 + uSeed).r;
            float n2 = texture2D(uNoise, (q * 1.3 - drift * 1.3) * 0.0026 + 0.37 * uSeed).g;
            float n = n1 * 0.62 + n2 * 0.38;
            float body = smoothstep(0.34, 0.74, n);
            // pooled between the keep and the walls
            float rc = length(q - vec2(0.0, -20.0)), rw = length(q);
            float mask = smoothstep(100.0, 140.0, rc) * (1.0 - smoothstep(160.0, 214.0, rw));
            // thin out toward the camera, vertically (a layer you fly through should not show as a sheet) and horizontally
            float dy = abs(cameraPosition.y - (uY + ${CASTLE.y0.toFixed(1)}));
            float near = smoothstep(2.0, 30.0, dy);
            float a = body * mask * near * uAmt * 0.68;
            // the avenue's braziers light it from below
            float glow = 0.0;
            for (int i = 0; i < 8; i++) glow += exp(-dot(q - uBraz[i], q - uBraz[i]) / 1600.0);
            vec3 col = vec3(0.62, 0.66, 0.74) + vec3(1.0, 0.5, 0.18) * min(glow, 1.2) * 0.75;
            a *= 1.0 + min(glow, 1.0) * 0.6;
            gl_FragColor = vec4(col, clamp(a, 0.0, 0.75));
            #include <fog_fragment>
          }`,
      });
      const g = new THREE.CircleGeometry(230, 48);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.position.y = y;
      m.renderOrder = 9;
      m.frustumCulled = false;
      return m;
    };
    this.mist = [make(6, 0, 1.0), make(22, 1, 0.7)];
    for (const m of this.mist) this.group.add(m);
  }

  update(camera, t) {
    const cp = camera.position;
    const d = Math.hypot(cp.x - CASTLE.x, cp.z - CASTLE.z);
    this.uTime.value = t;
    this.group.visible = d < 2600;
    this.bats.visible = d < 2400;
    for (const m of this.mist) m.visible = d < 900;
  }
}
