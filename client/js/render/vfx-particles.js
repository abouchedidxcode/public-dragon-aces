// GPU-instanced particle sprites for the combat effects. One SpritePool is one draw call: CPU-simulated
// particles (packed struct-of-floats, swap-remove so only live ones are uploaded) drawn as camera-facing,
// optionally velocity-stretched quads with flipbook animation, per-particle palette ramps and HDR output.
//
// kinds
//   fire    additive, flipbook (R heat, G opacity): flames, fireballs, plasma. Heat drives a 3-stop palette ramp
//   smoke   alpha, flipbook (R density, G baked shade): billowing smoke, mist, dust, spray. Lit + optional ember glow
//   glow    additive, shape atlas: sparks, glints, snow glitter, projectile cores
//   solid   alpha, shape atlas: shards, scales, droplets, globs, bubbles
//   ring    alpha, procedural: dust / vapour rings (camera facing, or flat on the world XZ plane); intensity = opacity
//   distort procedural, rendered into the heat-haze buffer (see vfx-distort.js)
import * as THREE from 'three';
import { BREED_LOOK } from './dragon.js';
import { WORLD } from '../../../shared/constants.js';

// ---------------------------------------------------------------- palettes
// Each palette is three colours. Fire/glow: [hot, mid, cool]. Smoke/solid: [shadow, lit, ember glow]. Ring: mid only.
export const PAL = {
  ember: 0, frost: 1, storm: 2, venom: 3, gold: 4, white: 5, steel: 6, blood: 7,
  smokeDark: 8, smokeGrey: 9, mist: 10, dust: 11, spray: 12,
  smokeEmber: 13, smokeFrost: 14, smokeStorm: 15, smokeVenom: 16, ice: 17, acid: 18, debris: 19, scale: 20,
  olive: 21, ash: 22,
};
export const NPAL = 24;
const BREEDS = ['ember', 'frost', 'storm', 'venom'];

export function buildPalettes() {
  const a = new Float32Array(NPAL * 9);
  const set = (id, c) => a.set([...c[0], ...c[1], ...c[2]], id * 9);
  // the elemental breeds' plasma is pulled a quarter of the way toward grey: still frost blue, storm violet and
  // venom green, but closer to a real flame or arc than to a neon tube
  const tame = (c, k) => c.map((v) => {
    const l = v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
    return v.map((x) => l + (x - l) * (1 - k));
  });
  BREEDS.forEach((b, i) => set(i, b === 'ember' ? BREED_LOOK[b].fire : tame(BREED_LOOK[b].fire, b === 'venom' ? 0.35 : 0.22)));
  set(PAL.gold, [[1.0, 0.95, 0.7], [1.0, 0.72, 0.28], [0.65, 0.3, 0.04]]);
  set(PAL.white, [[1, 1, 1], [0.85, 0.9, 1.0], [0.5, 0.6, 0.8]]);
  set(PAL.steel, [[1.0, 0.95, 0.85], [1.0, 0.7, 0.3], [0.6, 0.25, 0.08]]);
  set(PAL.blood, [[1.0, 0.5, 0.35], [0.8, 0.1, 0.05], [0.3, 0.02, 0.01]]);
  set(PAL.smokeDark, [[0.014, 0.013, 0.012], [0.15, 0.14, 0.13], [1.0, 0.45, 0.12]]);
  set(PAL.smokeGrey, [[0.20, 0.20, 0.21], [0.82, 0.82, 0.8], [1.0, 0.6, 0.25]]);
  set(PAL.mist, [[0.55, 0.64, 0.76], [1.12, 1.16, 1.2], [0.7, 0.9, 1.0]]);
  set(PAL.dust, [[0.2, 0.16, 0.12], [0.78, 0.66, 0.5], [1.0, 0.5, 0.2]]);
  set(PAL.spray, [[0.45, 0.62, 0.74], [1.0, 1.06, 1.1], [0.7, 0.9, 1.0]]);
  const sm = (glow, lit = 0.15) => [[0.015, 0.015, 0.016], [lit, lit * 0.95, lit * 0.9], glow];
  set(PAL.smokeEmber, sm(BREED_LOOK.ember.fire[1]));
  set(PAL.smokeFrost, [[0.16, 0.26, 0.4], [0.7, 0.88, 1.1], BREED_LOOK.frost.fire[1]]);
  set(PAL.smokeStorm, [[0.03, 0.025, 0.06], [0.2, 0.16, 0.32], BREED_LOOK.storm.fire[1]]);
  set(PAL.smokeVenom, [[0.02, 0.04, 0.01], [0.17, 0.26, 0.08], [0.34, 0.46, 0.12]]);
  set(PAL.ice, [[0.4, 0.7, 0.95], [0.85, 1.1, 1.35], [0.4, 0.8, 1.0]]);
  set(PAL.acid, [[0.05, 0.11, 0.02], [0.36, 0.6, 0.1], [0.55, 0.78, 0.16]]);
  set(PAL.debris, [[0.02, 0.016, 0.014], [0.28, 0.2, 0.15], [1.0, 0.4, 0.1]]);
  set(PAL.scale, [[0.06, 0.02, 0.01], [0.4, 0.14, 0.07], [1.0, 0.45, 0.1]]);
  // vapour rings (kind 'ring' uses the mid colour as is for these): bilious olive acid mist, dark ash
  set(PAL.olive, [[0.1, 0.12, 0.05], [0.44, 0.47, 0.25], [0.6, 0.62, 0.34]]);
  set(PAL.ash, [[0.03, 0.028, 0.026], [0.2, 0.18, 0.165], [0.4, 0.36, 0.3]]);
  return a;
}

export function paletteOf(breed) {
  const i = BREEDS.indexOf(breed);
  return i < 0 ? 0 : i;
}

export function smokePaletteOf(breed) {
  return [PAL.smokeEmber, PAL.smokeFrost, PAL.smokeStorm, PAL.smokeVenom][paletteOf(breed)];
}

// ---------------------------------------------------------------- textures
export function fallbackTexture() {
  const S = 64;
  const d = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = Math.hypot(x / S - 0.5, y / S - 0.5) * 2;
      const v = Math.max(0, 1 - r * r) * 255;
      d.set([v, v, v, 255], (y * S + x) * 4);
    }
  }
  const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export async function loadAtlas(loader, url) {
  try {
    const t = await loader.loadAsync(url);
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 1;
    return t;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the pool
// CPU struct layout (floats per particle)
export const S = 28;
const POS = 0, VEL = 3, AGE = 6, LIFE = 7, S0 = 8, S1 = 9, ROT = 10, SPIN = 11, DRAG = 12, RISE = 13, F0 = 14, F1 = 15,
  ENV = 16, STRETCH = 17, PALI = 18, INT = 19, AMUL = 20, EXTRA = 21, CURVE = 22, BOUNCE = 23, SWIRL = 24, WIND = 25;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function envelope(env, t) {
  switch (env) {
    case 0: return Math.min(1, t / 0.05) * (1 - sstep(0.7, 1, t)); // fire (the flipbook burns out by itself)
    case 1: return sstep(0, 0.1, t) * Math.pow(1 - t, 1.25); // smoke
    case 2: return Math.min(1, t * 24) * (1 - sstep(0.55, 1, t)); // sparks
    case 3: return sstep(0, 0.08, t) * (1 - sstep(0.8, 1, t)); // flat
    default: return Math.min(1, t * 6) * (1 - t); // ring
  }
}

const VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute vec4 iPos;
  attribute vec3 iVel;
  attribute vec4 iA;
  attribute vec4 iB;
  uniform vec2 uGrid;
  uniform float uFrames;
  uniform float uAspect;
  uniform float uNear;
  uniform float uCyl;
  uniform float uZoom; // > 1 while a target lens renders (it zooms the projection; render/lens.js)
  varying vec2 vUv0;
  varying vec2 vUv1;
  varying float vMix;
  varying vec2 vLocal;
  varying vec4 vB;
  varying float vAlpha;
  varying vec3 vWorldP;
  varying float vSoft;
  varying float vFrame;
  vec2 frameUv(vec2 q, float f) {
    float col = mod(f, uGrid.x);
    float row = floor(f / uGrid.x);
    return (vec2(col, uGrid.y - 1.0 - row) + q * 0.96 + 0.02) / uGrid;
  }
  void main() {
    vec2 c = position.xy;
    vLocal = c * 2.0;
    vB = iB;
    vAlpha = iPos.w;
    vSoft = 3.0 + iA.x * 0.14;
    float f = iA.w;
    vFrame = f;
    float f0 = floor(f);
    vMix = fract(f);
    vUv0 = frameUv(c + 0.5, f0);
    vUv1 = frameUv(c + 0.5, min(f0 + 1.0, uFrames - 1.0));
    vec4 mvPosition = viewMatrix * vec4(iPos.xyz, 1.0);
    #ifdef FLAT
      vec3 wp = iPos.xyz + vec3(c.x, 0.0, c.y) * iA.x;
      vec4 mvp = viewMatrix * vec4(wp, 1.0);
      gl_Position = projectionMatrix * mvp;
      vWorldP = wp;
      vAlpha *= smoothstep(uNear * 0.3, uNear, -mvPosition.z);
    #else
      vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
      float sp = length(vv.xy);
      vec2 ax = vec2(cos(iA.z), sin(iA.z));
      float len = iA.x;
      float wid = iA.x / uAspect;
      if (iA.y > 0.0) {
        if (sp > 0.001) ax = vv.xy / sp;
        len += iA.y * sp;
      }
      vec2 perp = vec2(-ax.y, ax.x);
      vec4 mvp = mvPosition;
      mvp.xy += ax * c.x * len + perp * c.y * wid;
      if (uCyl > 0.5) {
        // cylindrical billboard for flame tongues: the true 3D length foreshortens when the flame points at the lens
        vec3 dv = normalize(vv + vec3(0.0001));
        vec3 ray = normalize(mvPosition.xyz);
        vec3 side = cross(dv, ray);
        float sl = length(side);
        side /= max(sl, 0.001);
        mvp = vec4(mvPosition.xyz + dv * c.x * iA.x + side * c.y * wid, 1.0);
        vAlpha *= smoothstep(0.06, 0.4, sl);
      }
      gl_Position = projectionMatrix * mvp;
      vWorldP = cameraPosition + transpose(mat3(viewMatrix)) * mvp.xyz;
      // fade particles right in front of the lens so your own breath doesn't blind you
      vAlpha *= smoothstep(uNear * 0.35, uNear, -mvPosition.z);
      // big sprites dissolve as the camera flies into them instead of filling the screen
      vAlpha *= smoothstep(iA.x * 0.12, iA.x * 0.6, -mvPosition.z);
      // never let one sprite fill the view: fade by the share of screen height it would cover
      // (a lens zooms the projection: measure against the main view, or particles vanish inside the lens)
      float cover = iA.x * projectionMatrix[1][1] / (max(-mvPosition.z, 0.5) * uZoom);
      vAlpha *= 1.0 - 0.9 * smoothstep(1.1, 2.6, cover);
    #endif
    #include <fog_vertex>
  }`;

const PAL_GLSL = /* glsl */ `
  uniform vec3 uPal[${NPAL * 3}];
  vec3 palC(float id, int k) { return uPal[int(id + 0.5) * 3 + k]; }
  vec3 ramp3(float id, float x) {
    vec3 c = palC(id, 2), m = palC(id, 1), h = palC(id, 0);
    return x < 0.5 ? mix(c, m, x * 2.0) : mix(m, h, (x - 0.5) * 2.0);
  }
  // soft particles without a depth buffer: fade where the quad dips into the sea or the (coarse) terrain height map
  float softGround() {
    if (uSoftG < 0.5) return 1.0;
    float g = 0.0;
    if (uHasT > 0.5) {
      vec2 duv = (vWorldP.xz + uHalf) / (2.0 * uHalf);
      if (all(greaterThan(duv, vec2(0.0))) && all(lessThan(duv, vec2(1.0)))) g = max(0.0, texture2D(tTerrain, duv).r);
    }
    return smoothstep(g - 1.5, g + vSoft, vWorldP.y);
  }
  vec4 flip() { return mix(texture2D(tex, vUv0), texture2D(tex, vUv1), vMix); }
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
`;

const FRAGS = {
  fire: /* glsl */ `
    void main() {
      vec4 t = flip();
      float age = vB.x;
      float temp = clamp(t.r * vB.w, 0.0, 1.0);
      vec3 col = ramp3(vB.y, temp) * vB.z * mix(0.5, 1.0, temp);
      // flame flicker: fine noise carried in B eats into the edges
      float a = t.g * vAlpha * softGround() * (0.8 + 0.4 * (t.b / max(t.g, 0.05) - 0.5));
      if (a < 0.003) discard;
      // emissive but partly occluding: layers converge to the flame colour instead of whiting out
      gl_FragColor = vec4(col * a, a * uOcc);
    }`,
  smoke: /* glsl */ `
    void main() {
      vec4 t = flip();
      float d = t.r;
      float shade = d > 0.01 ? clamp(t.g / d, 0.0, 1.0) : 0.5;
      vec3 col = mix(palC(vB.y, 0), palC(vB.y, 1), shade) * vB.z;
      float glow = vB.w * pow(1.0 - vB.x, 3.0);
      col += palC(vB.y, 2) * glow * (0.45 + 0.55 * d);
      float a = d * vAlpha * softGround();
      if (a < 0.003) discard;
      gl_FragColor = vec4(col, a);
      #include <fog_fragment>
    }`,
  glow: /* glsl */ `
    void main() {
      vec4 t = texture2D(tex, vUv0);
      float temp = clamp(t.r * (1.0 - vB.x * 0.6) * vB.w, 0.0, 1.0);
      vec3 col = ramp3(vB.y, temp) * vB.z;
      float a = t.r * vAlpha;
      if (a < 0.003) discard;
      gl_FragColor = vec4(col, a);
    }`,
  solid: /* glsl */ `
    void main() {
      vec4 t = texture2D(tex, vUv0);
      float a = smoothstep(0.05, 0.22, t.r) * vAlpha * softGround();
      if (a < 0.01) discard;
      vec3 col = mix(palC(vB.y, 0), palC(vB.y, 1), clamp(t.r * 1.15, 0.0, 1.0)) * vB.z;
      col += palC(vB.y, 2) * vB.w * pow(1.0 - vB.x, 1.5);
      gl_FragColor = vec4(col, a);
      #include <fog_fragment>
    }`,
  ring: /* glsl */ `
    uniform float uTime;
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    void main() {
      // a ring of dust or vapour, alpha blended and fogged: a soft band at r0 whose density is broken up by drifting
      // noise, with a faint haze sheet inside. Intensity is opacity. Breed palettes (and gold) only tint the vapour;
      // the physical palettes (mist, dust, spray, olive, ash ...) give its colour directly.
      float d = length(vLocal);
      float r0 = vB.w; // ring centre as a fraction of the quad radius
      float w = vFrame > 0.001 ? vFrame : 0.11; // ring thickness rides in the frame slot
      // noise in world space, so markers re-emitted every frame hold still; a slow drift makes them billow
      vec2 q = (vWorldP.xz + vWorldP.y * 0.7) * 0.045 + vec2(uTime * 0.21, -uTime * 0.17);
      float n = vnoise(q) * 0.62 + vnoise(q * 2.7 + 3.1) * 0.38;
      float dd = d + (n - 0.5) * w * 0.9;
      float x = (dd - r0) / w;
      float band = exp(-x * x * (x > 0.0 ? 2.2 : 0.8)); // the front is crisper than the wake behind it
      float sheet = smoothstep(r0 + w * 0.3, r0 * 0.25, dd) * 0.16;
      float a = (band * mix(0.35, 1.0, n) + sheet * n) * clamp(vB.z, 0.0, 1.0) * vAlpha;
      if (a < 0.003) discard;
      vec3 m = palC(vB.y, 1);
      vec3 col = vB.y < 4.5 ? mix(vec3(0.82, 0.81, 0.79), m, 0.16) : m;
      col *= 0.72 + 0.42 * n; // lumpy self-shadowing, so vapour still reads in front of white cloud
      gl_FragColor = vec4(col, a);
      #include <fog_fragment>
    }`,
  distort: /* glsl */ `
    uniform float uTime;
    void main() {
      float d = length(vLocal);
      if (d > 1.0) discard;
      vec2 v;
      float prof;
      if (vB.y < 0.5) {
        // heat haze: a swirling wobble inside a soft blob
        prof = smoothstep(1.0, 0.1, d);
        vec2 p = vLocal * 3.0 + vB.x * 4.0 + vec2(uTime * 2.0, -uTime * 3.0);
        v = vec2(sin(p.y * 2.3 + p.x) + sin(p.y * 4.1 - uTime * 5.0), cos(p.x * 2.7 + p.y) + cos(p.x * 3.7 + uTime * 6.0)) * 0.5;
      } else {
        // shockwave: radial push/pull concentrated on the front
        float r0 = vB.w;
        float w = 0.2;
        prof = smoothstep(r0 - w, r0, d) * smoothstep(r0 + w * 0.25, r0, d);
        v = normalize(vLocal + 1e-5) * prof * 1.6;
        prof = 1.0;
      }
      gl_FragColor = vec4(v * prof * vB.z * vAlpha, 0.0, 1.0);
    }`,
};

export class SpritePool {
  constructor(scene, max, opts) {
    const { kind, texture, grid = [1, 1], frames = 1, additive, flat = false, aspect = 1, renderOrder = 20, palettes, noScene = false } = opts;
    this.kind = kind;
    this.max = max;
    this.limit = max;
    this.n = 0;
    this.d = new Float32Array(max * S);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iA', this.aA);
    geo.setAttribute('iB', this.aB);
    geo.instanceCount = 0;
    this.geo = geo;
    const distort = kind === 'distort';
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      tex: { value: texture }, uGrid: { value: new THREE.Vector2(grid[0], grid[1]) }, uFrames: { value: frames },
      uOcc: { value: opts.occ === undefined ? 0 : opts.occ }, tTerrain: { value: null }, uHalf: { value: WORLD.terrainHalf }, uHasT: { value: 0 }, uSoftG: { value: opts.soft && !flat ? 1 : 0 }, uAspect: { value: aspect }, uCyl: { value: opts.cylindrical ? 1 : 0 }, uNear: { value: 16 }, uPal: { value: null }, uTime: { value: 0 },
    }]);
    this.uniforms.uZoom = { value: 1 }; // set by the lens pass (render/lens.js)
    this.uniforms.uPal.value = [];
    for (let i = 0; i < NPAL * 3; i++) this.uniforms.uPal.value.push(new THREE.Vector3(palettes[i * 3], palettes[i * 3 + 1], palettes[i * 3 + 2]));
    const defines = {};
    if (flat) defines.FLAT = 1;
    const fogOn = kind === 'smoke' || kind === 'solid' || (kind === 'ring' && !additive);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines,
      fog: fogOn,
      transparent: true,
      depthWrite: false,
      depthTest: !distort,
      side: THREE.DoubleSide,
      blending: distort ? THREE.CustomBlending : additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform sampler2D tex;
        uniform float uOcc;
        uniform sampler2D tTerrain;
        uniform float uHalf;
        uniform float uHasT;
        uniform float uSoftG;
        varying vec3 vWorldP;
        varying float vSoft;
        varying float vFrame;
        varying vec2 vUv0; varying vec2 vUv1; varying float vMix; varying vec2 vLocal; varying vec4 vB; varying float vAlpha;
        ${PAL_GLSL}
        ${FRAGS[kind]}`,
    });
    if (kind === 'fire') {
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    if (distort) {
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
    }
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    if (!noScene) scene.add(this.mesh);
    this.floorAt = null;
  }

  // Spawn a particle. Returns its slot (valid until the next emit/update). When the pool is full the newest
  // particle replaces a pseudo-random live one, so a burst never silently disappears.
  emit(px, py, pz, vx, vy, vz, life, s0, s1, pal, inten = 1, drag = 1.5, rise = 0, rot = Math.random() * 6.283, spin = 0,
    f0 = 0, f1 = 0, env = 1, stretch = 0, extra = 1, curve = 0.5, bounce = 0, swirl = 0, wind = 0) {
    let i;
    if (this.n < this.limit) i = this.n++;
    else i = (Math.random() * this.limit) | 0;
    const d = this.d, b = i * S;
    d[b] = px; d[b + 1] = py; d[b + 2] = pz;
    d[b + VEL] = vx; d[b + VEL + 1] = vy; d[b + VEL + 2] = vz;
    d[b + AGE] = 0; d[b + LIFE] = life; d[b + S0] = s0; d[b + S1] = s1; d[b + ROT] = rot; d[b + SPIN] = spin;
    d[b + DRAG] = drag; d[b + RISE] = rise; d[b + F0] = f0; d[b + F1] = f1; d[b + ENV] = env; d[b + STRETCH] = stretch;
    d[b + PALI] = pal; d[b + INT] = inten; d[b + AMUL] = 1; d[b + EXTRA] = extra; d[b + CURVE] = curve;
    d[b + BOUNCE] = bounce; d[b + SWIRL] = swirl; d[b + WIND] = wind;
    return i;
  }

  // hold slot i invisible for `seconds` before it starts (call right after emit)
  setDelay(i, seconds) {
    this.d[i * S + AGE] = -seconds;
  }

  update(dt) {
    const d = this.d;
    const aPos = this.aPos.array, aVel = this.aVel.array, aA = this.aA.array, aB = this.aB.array;
    const floorAt = this.floorAt;
    let i = 0;
    while (i < this.n) {
      const b = i * S;
      const age = (d[b + AGE] += dt);
      const L = d[b + LIFE];
      if (age < 0) {
        // delayed spawn: keep it invisible until its time comes
        aPos[i * 4 + 3] = 0;
        aA[i * 4] = 0;
        i++;
        continue;
      }
      if (age >= L) {
        const last = --this.n;
        if (i !== last) d.copyWithin(b, last * S, last * S + S);
        continue;
      }
      const t = age / L;
      const k = Math.exp(-d[b + DRAG] * dt);
      let vx = d[b + 3] * k, vy = d[b + 4] * k + d[b + RISE] * dt, vz = d[b + 5] * k;
      const sw = d[b + SWIRL];
      if (sw !== 0) {
        // lazy curl: rotate the horizontal velocity a little so smoke billows sideways
        const a = sw * dt, c = Math.cos(a), s = Math.sin(a);
        const nx = vx * c - vz * s;
        vz = vx * s + vz * c;
        vx = nx;
      }
      let x = d[b] + vx * dt, y = d[b + 1] + vy * dt, z = d[b + 2] + vz * dt;
      const bn = d[b + BOUNCE];
      if (bn > 0 && floorAt) {
        const fl = floorAt(x, z);
        if (y < fl + 0.4 && vy < 0) {
          y = fl + 0.4;
          vy = -vy * bn;
          vx *= 0.7; vz *= 0.7;
          if (bn < 0.05) { d[b + AGE] = L; }
        }
      }
      d[b] = x; d[b + 1] = y; d[b + 2] = z; d[b + 3] = vx; d[b + 4] = vy; d[b + 5] = vz;
      d[b + ROT] += d[b + SPIN] * dt;
      const size = d[b + S0] + (d[b + S1] - d[b + S0]) * Math.pow(t, d[b + CURVE]);
      const f = d[b + F0] + (d[b + F1] - d[b + F0]) * t;
      const i4 = i * 4, i3 = i * 3;
      aPos[i4] = x; aPos[i4 + 1] = y; aPos[i4 + 2] = z;
      aPos[i4 + 3] = envelope(d[b + ENV], t) * d[b + AMUL];
      aVel[i3] = vx; aVel[i3 + 1] = vy; aVel[i3 + 2] = vz;
      aA[i4] = size; aA[i4 + 1] = d[b + STRETCH]; aA[i4 + 2] = d[b + ROT]; aA[i4 + 3] = f;
      aB[i4] = t; aB[i4 + 1] = d[b + PALI]; aB[i4 + 2] = d[b + INT]; aB[i4 + 3] = d[b + EXTRA];
      i++;
    }
    const n = this.n;
    this.geo.instanceCount = n;
    for (const a of [this.aPos, this.aVel, this.aA, this.aB]) {
      a.clearUpdateRanges();
      if (n) a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    this.mesh.visible = n > 0;
  }

  // distance-based emission cull helper
  clear() {
    this.n = 0;
  }
}
