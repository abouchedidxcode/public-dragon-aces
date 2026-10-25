// A dragon built entirely from code: no Blender, no model files. Geometry, skinning weights and textures are
// generated at runtime (about a quarter of a second) and the surface detail (scales, belly plates, horn rings,
// veins) comes from the shader and a few small generated textures. It is a drop-in alternative to the GLB for
// DragonView (same bone names and hierarchy, same mesh names, same breed looks): load it with ?dragon=code.
//
//   dragon-code-util.js    vertex pool, lofted tubes, horns, normals, AO and skinning helpers
//   dragon-code-geo.js     skeleton, the continuous torso/neck/head/tail skin, jaw, teeth, tongue, eyes
//   dragon-code-limbs.js   legs, wing arms and fingers, membranes
//   dragon-code-extras.js  per-breed horns, crests, tail ornaments, fins
//   dragon-code.js         (this file) three.js assembly, textures and materials
import * as THREE from 'three';
import { BREED_LOOK, createEyeMaterial, HURT_TINT, HURT_RIM, withDragonFog } from './dragon.js';
import { SKY } from './atmosphere.js';
import { Part, bakeAO, mergeParts, computeTangents } from './dragon-code-util.js';
import { BONES, BI, buildCore, buildJaw, buildTeeth, buildTongue, buildEyes } from './dragon-code-geo.js';
import { buildLimbs, buildLimbsLod, buildWingArms, buildWingArmsLod, buildMembranes, wingModel, wingUV } from './dragon-code-limbs.js';
import { buildExtras, buildHeadSpikes } from './dragon-code-extras.js';

export { createEyeMaterial };
const TIME = { value: 0 };

// ------------------------------------------------------------------------------------------------------
// geometry -> three.js (Blender-style axes become three.js ones here: (x, y, z) -> (x, z, -y))
function toGeometry(part, withAO = true, withTan = true) {
  const n = part.count;
  const g = new THREE.BufferGeometry();
  const f32 = (a) => (a instanceof Float32Array ? a : Float32Array.from(a));
  const pos = f32(part.p).slice(), nor = f32(part.n).slice();
  for (let i = 0; i < n * 3; i += 3) {
    let y = pos[i + 1];
    pos[i + 1] = pos[i + 2];
    pos[i + 2] = -y;
    y = nor[i + 1];
    nor[i + 1] = nor[i + 2];
    nor[i + 2] = -y;
  }
  if (withTan) {
    // tangents from the uv layout (+u along the skin, w = handedness), in three.js axes like everything else
    const tan = computeTangents(part);
    for (let i = 0; i < n * 4; i += 4) {
      const y = tan[i + 1];
      tan[i + 1] = tan[i + 2];
      tan[i + 2] = -y;
    }
    g.setAttribute('aTan', new THREE.BufferAttribute(tan, 4));
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(f32(part.uv), 2));
  g.setAttribute('color', new THREE.BufferAttribute(f32(part.c), 4));
  if (withAO) g.setAttribute('aAO', new THREE.BufferAttribute(f32(part.ao), 1));
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), sk = part.sk;
  for (let i = 0; i < n; i++) {
    const o = i * 8, q = i * 4;
    si[q] = sk[o]; sw[q] = sk[o + 1];
    si[q + 1] = sk[o + 2]; sw[q + 1] = sk[o + 3];
    si[q + 2] = sk[o + 4]; sw[q + 2] = sk[o + 5];
    si[q + 3] = sk[o + 6]; sw[q + 3] = sk[o + 7];
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  const idx = part.idx;
  g.setIndex(new THREE.BufferAttribute(n > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), 1));
  return g;
}

function buildSkeleton() {
  const bones = BONES.map((b) => {
    const o = new THREE.Bone();
    o.name = b.name;
    return o;
  });
  const wp = (h) => [h[0], h[2], -h[1]];
  BONES.forEach((b, i) => {
    const h = wp(b.head);
    if (b.parent) {
      const ph = wp(BONES[BI[b.parent]].head);
      bones[i].position.set(h[0] - ph[0], h[1] - ph[1], h[2] - ph[2]);
      bones[BI[b.parent]].add(bones[i]);
    } else bones[i].position.set(h[0], h[1], h[2]);
  });
  return bones;
}

// AO occluders (Blender axes): big masses that shade what touches them
function aoSpheres() {
  const sp = [];
  for (const s of [1, -1]) {
    sp.push({ c: [s * 0.75, -1.3, -0.5], r: 0.62, w: 0.3 }, { c: [s * 0.95, 1.6, 0.3], r: 0.6, w: 0.6 }, { c: [s * 0.7, 2.2, -0.9], r: 0.35, w: 0.5 });
  }
  sp.push({ c: [0, 0.3, -0.1], r: 1.3, w: 0.85 }, { c: [0, 2.4, -0.1], r: 1.15, w: 0.7 }, { c: [0, 6.5, 0.7], r: 0.8, w: 0.5 }, { c: [0, -1.6, 0], r: 0.9, w: 0.6 });
  return sp;
}

let _t0 = 0;
/** builds the whole template (a Group with the root bone and every skinned mesh) */
export function buildDragonTemplate(stats = {}) {
  const t0 = performance.now();
  const parts = {};
  const lap = (k, f) => {
    const t = performance.now();
    const r = f();
    stats.laps = stats.laps || {};
    stats.laps[k] = Math.round((stats.laps[k] || 0) + performance.now() - t);
    return r;
  };
  const mk = (detail) => {
    const list = [];
    const far = detail < 0.5;
    const k = far ? 'far ' : '';
    list.push(lap(k + 'core', () => buildCore(detail)));
    list.push(lap(k + 'jaw', () => buildJaw(detail)));
    if (!far) {
      list.push(lap('teeth', () => buildTeeth(detail)));
      list.push(lap('tongue', () => buildTongue(detail)));
    }
    list.push(lap(k + 'limbs', () => (far ? buildLimbsLod() : buildLimbs(detail))));
    list.push(lap(k + 'arms', () => (far ? buildWingArmsLod() : buildWingArms(detail))));
    if (!far) list.push(lap('spikes', () => buildHeadSpikes(detail)));
    const body = lap(k + 'merge', () => mergeParts(list));
    lap(k + 'ao', () => bakeAO(body, aoSpheres()));
    return body;
  };
  parts.body = mk(1);
  parts.bodyLod = mk(0.25);
  parts.wings = lap('membranes', () => buildMembranes(1));
  parts.wingsLod = lap('far membranes', () => buildMembranes(0.25));
  parts.eyes = buildEyes(1);
  const extras = lap('extras', () => buildExtras());
  stats.partsMs = performance.now() - t0;

  const bones = buildSkeleton();
  const root = bones[0];
  const group = new THREE.Group();
  group.name = 'Dragon';
  group.add(root);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const mats = { body: new THREE.MeshBasicMaterial(), wing: new THREE.MeshBasicMaterial(), eye: new THREE.MeshBasicMaterial() };
  const mesh = (name, part, mat, ao = true) => {
    const m = new THREE.SkinnedMesh(toGeometry(part, ao, ao), mat);
    m.name = name;
    m.bind(skeleton, new THREE.Matrix4());
    m.frustumCulled = false;
    m.castShadow = name !== 'Eyes' && !name.includes('Extra');
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  mesh('Body', parts.body, mats.body);
  mesh('BodyLOD', parts.bodyLod, mats.body);
  mesh('Wings', parts.wings, mats.wing, false);
  mesh('WingsLOD', parts.wingsLod, mats.wing, false);
  mesh('Eyes', parts.eyes, mats.eye, false);
  for (const [breed, e] of Object.entries(extras)) {
    if (e.body) mesh(`Extra_${breed}`, e.body, mats.body);
    if (e.bodyLod) mesh(`ExtraLOD_${breed}`, e.bodyLod, mats.body);
    if (e.wing) mesh(`WExtra_${breed}`, e.wing, mats.wing, false);
  }
  stats.tris = {
    body: parts.body.tris, bodyLod: parts.bodyLod.tris, wings: parts.wings.tris, wingsLod: parts.wingsLod.tris, eyes: parts.eyes.tris,
    extras: Object.fromEntries(Object.entries(extras).map(([k, e]) => [k, (e.body ? e.body.tris : 0) + (e.wing ? e.wing.tris : 0)])),
  };
  stats.geoMs = performance.now() - t0;
  return group;
}

// ------------------------------------------------------------------------------------------------------
// generated textures
function periodic(size, freq, seed, octaves = 3) {
  // tileable fbm value noise
  const out = new Float32Array(size * size);
  let amp = 1, tot = 0, f = freq;
  const hash = (x, y, s) => {
    let h = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  for (let o = 0; o < octaves; o++) {
    const ff = f | 0;
    const lat = new Float32Array(ff * ff);
    for (let y = 0; y < ff; y++) for (let x = 0; x < ff; x++) lat[y * ff + x] = hash(x, y, seed + o * 17);
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * ff, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * ff, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const a = lat[(y0 % ff) * ff + (x0 % ff)], b = lat[(y0 % ff) * ff + ((x0 + 1) % ff)];
        const c = lat[((y0 + 1) % ff) * ff + (x0 % ff)], d = lat[((y0 + 1) % ff) * ff + ((x0 + 1) % ff)];
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    tot += amp;
    amp *= 0.5;
    f *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

function dataTexture(data, w, h, repeat = true) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** tileable masks for the skin colour: R, G, B are three different noises (the shader makes stripes and blotches from them) */
export function makeSkinNoise(size = 256) {
  const a = periodic(size, 4, 3, 4), b = periodic(size, 6, 9, 4), c = periodic(size, 12, 21, 3);
  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = Math.min(255, a[i] * 300 - 20);
    d[i * 4 + 1] = Math.min(255, Math.max(0, (b[i] - 0.5) * 520 + 128));
    d[i * 4 + 2] = Math.min(255, c[i] * 330 - 30);
    d[i * 4 + 3] = 255;
  }
  return dataTexture(d, size, size);
}

let canvasFactory = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** wing membrane maps: veins and ribs drawn along the membrane's own panels, then blurred into a height, a normal map, AO and masks */
export function makeWingTextures(W = 768, H = 480) {
  const M = wingModel();
  const cv = canvasFactory(W, H);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#fff';
  const px = (p) => {
    const uv = wingUV(p[0], p[1]);
    return [uv[0] * W, uv[1] * H];
  };
  const stroke = (pts, w, a) => {
    g.globalAlpha = a;
    g.lineWidth = (w * W) / 1024;
    g.beginPath();
    pts.forEach((p, i) => {
      const q = px(p);
      if (i) g.lineTo(q[0], q[1]);
      else g.moveTo(q[0], q[1]);
    });
    g.stroke();
  };
  const sample = (fn, n) => {
    const o = [];
    for (let i = 0; i <= n; i++) o.push(fn(i / n));
    return o;
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // bones
  stroke(sample((a) => M.arm(a), 24), 11, 1);
  for (let k = 0; k < 4; k++) stroke(sample((s) => M.F(k, s), 20), 9 - k, 1);
  // veins: branching, tapering lines grown outward from the bones through each panel's own (sigma, t) space
  const grow = (P, s0, t0, drift, w, depth, alpha) => {
    const n = 26;
    let t = t0, prev = P(s0, t);
    for (let i = 1; i <= n; i++) {
      const s = s0 + ((1 - s0) * i) / n;
      t = Math.min(0.97, Math.max(0.03, t + drift / n + (rnd() - 0.5) * 0.006));
      const cur = P(s, t);
      const f = i / n;
      g.globalAlpha = Math.min(1, alpha * 1.15 * (1 - 0.4 * f));
      g.lineWidth = (Math.max(0.5, w * (1 - 0.88 * f)) * W) / 1024;
      g.beginPath();
      const a0 = px(prev), a1 = px(cur);
      g.moveTo(a0[0], a0[1]);
      g.lineTo(a1[0], a1[1]);
      g.stroke();
      prev = cur;
      if (depth > 0 && i > 4 && i < n - 6 && rnd() < 0.1) grow(P, s, t, (rnd() < 0.5 ? -1 : 1) * (0.06 + rnd() * 0.12), w * (0.55 - 0.2 * f), depth - 1, alpha * 0.85);
    }
  };
  for (let k = 0; k < 3; k++) {
    const P = (s, t) => M.fingerPanel(k, s, t);
    for (const t of [0.22, 0.5, 0.78]) grow(P, 0.06, t + (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.06, 2.8 + rnd() * 1.4, 3, 0.9);
  }
  const Pin = (s, t) => M.coons(t, s);
  for (let i = 1; i < 12; i++) grow(Pin, 0.05, (i + (rnd() - 0.5) * 0.6) / 12, (rnd() - 0.5) * 0.04, 2.6 + rnd() * 1.4, 3, 0.9);
  g.globalAlpha = 1;
  // soften the lines into raised ribs: the canvas filter blurs natively; a box blur is the fallback
  let h8, soft8;
  const px8 = (cvs) => {
    const data = cvs.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const o = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) o[i] = data[i * 4];
    return o;
  };
  const probe = canvasFactory(W, H);
  const pg = probe.getContext('2d', { willReadFrequently: true });
  if (typeof pg.filter === 'string') {
    pg.filter = 'blur(1.4px)';
    pg.drawImage(cv, 0, 0);
    h8 = px8(probe);
    pg.clearRect(0, 0, W, H);
    pg.filter = 'blur(6px)';
    pg.drawImage(cv, 0, 0);
    soft8 = px8(probe);
  } else {
    const src = px8(cv);
    const box = (a, b, r, horiz) => {
      const n = horiz ? W : H, m = horiz ? H : W, st = horiz ? 1 : W, ss = horiz ? W : 1;
      for (let j = 0; j < m; j++) {
        let sum = 0;
        const o = j * ss;
        for (let i = -r; i <= r; i++) sum += a[o + Math.min(n - 1, Math.max(0, i)) * st];
        for (let i = 0; i < n; i++) {
          b[o + i * st] = sum / (2 * r + 1);
          sum += a[o + Math.min(n - 1, i + r + 1) * st] - a[o + Math.max(0, i - r) * st];
        }
      }
    };
    const t1 = new Uint8Array(W * H);
    h8 = new Uint8Array(W * H);
    soft8 = new Uint8Array(W * H);
    box(src, t1, 2, true); box(t1, h8, 2, false); box(h8, t1, 2, true); box(t1, h8, 2, false);
    box(h8, t1, 5, true); box(t1, soft8, 5, false);
  }
  const nrm = new Uint8Array(W * H * 4), ao = new Uint8Array(W * H * 4), col = new Uint8Array(W * H * 4);
  const mot = periodic(64, 5, 31, 4), mot2 = periodic(64, 11, 47, 3);
  const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < H; y++) {
    const my = (((y * 64) / H) | 0) * 64, ym = Math.max(0, y - 1) * W, yp = Math.min(H - 1, y + 1) * W, y0 = y * W;
    for (let x = 0; x < W; x++) {
      const i = y0 + x;
      const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : x;
      const hx = (h8[y0 + xp] - h8[y0 + xm]) * (8 / 255), hy = (h8[yp + x] - h8[ym + x]) * (8 / 255);
      const l = 127 / Math.sqrt(hx * hx + hy * hy + 1);
      const o = i * 4;
      nrm[o] = 128 - hx * l;
      nrm[o + 1] = 128 - hy * l;
      nrm[o + 2] = 128 + l;
      nrm[o + 3] = 255;
      ao[o] = 255 - 0.45 * soft8[i];
      ao[o + 1] = Math.min(255, h8[i] * 3.6);
      ao[o + 3] = 255;
      const mi = my + (((x * 64) / W) | 0);
      col[o] = clamp8((mot[mi] * 1.9 - 0.45) * 255);
      const f = mot2[mi];
      col[o + 1] = f > 0.62 ? clamp8((f - 0.62) * 900) : 0;
      col[o + 3] = 255;
    }
  }
  return { normal: dataTexture(nrm, W, H, false), ao: dataTexture(ao, W, H, false), col: dataTexture(col, W, H, false) };
}

// ------------------------------------------------------------------------------------------------------
// shared texture set, created on first use
let tex = null;
function textures() {
  if (!tex) {
    const t0 = performance.now();
    tex = { noise: makeSkinNoise(128), wing: makeWingTextures() };
    tex.ms = performance.now() - t0;
  }
  return tex;
}

// ------------------------------------------------------------------------------------------------------
// materials
// The skin's height fields (overlapping scales, belly plates, voronoi bony plates) are baked once on the GPU into three
// small tileable half-float textures: h, dh/du, dh/dv and a per-scale id. The body shader then reads them with one tap,
// which makes the detail mip-filtered (it fades by itself with distance and cannot shimmer) and keeps the per-pixel cost low.
const BAKE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const BAKE_FS = /* glsl */ `
  precision highp float;
  uniform float mode;
  varying vec2 vUv;
  vec2 WRAP = vec2(8.0);
  float hash12(vec2 c) { c = mod(c, WRAP); vec3 p3 = fract(vec3(c.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec2 hash22(vec2 c) { c = mod(c, WRAP); vec3 p3 = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
  // Imbricate scales: rows run toward the tail (p.y grows), alternate rows are offset by "stag"; each scale pokes
  // "ovl" cells into the next row, "wk" shapes its tip (2 = round, 8 = a straight plate edge).
  void scaleField(vec2 p, float ovl, float wk, float stag, out float h, out float id) {
    float row0 = floor(p.y);
    float rowA = row0 - 1.0;
    vec2 q = vec2(p.x + stag * 0.5 * mod(rowA, 2.0), p.y - rowA);
    float cx = floor(q.x) + 0.5;
    float w = (q.x - cx) * 2.0;
    float cover = 1.0 + ovl * (1.0 - pow(abs(w), wk)) - q.y;
    vec2 loc; float e;
    if (cover > 0.0) {
      loc = vec2(w, q.y); e = cover; id = hash12(vec2(cx, rowA));
    } else {
      vec2 q2 = vec2(p.x + stag * 0.5 * mod(row0, 2.0), p.y - row0);
      float cx2 = floor(q2.x) + 0.5;
      float w2 = (q2.x - cx2) * 2.0;
      loc = vec2(w2, q2.y);
      e = 1.0 + ovl * (1.0 - pow(abs(w2), wk)) - q2.y;
      id = hash12(vec2(cx2, row0));
    }
    float ramp = smoothstep(0.0, 1.0 + ovl, loc.y);
    float lat = 1.0 - pow(abs(loc.x), 2.4);
    h = mix(0.2, 1.0, ramp) * (0.38 + 0.62 * lat);
    h *= smoothstep(0.0, 0.16, e) * (0.88 + 0.24 * id);
  }
  // bony plates: a voronoi mosaic with flat tops and sunken seams
  void plateField(vec2 p, out float h, out float id) {
    vec2 ip = floor(p), fp = fract(p);
    float d1 = 8.0, d2 = 8.0; vec2 c1 = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(ip + g);
      vec2 r = g + 0.12 + 0.76 * o - fp;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; c1 = ip + g; } else if (d < d2) d2 = d;
    }
    float e = sqrt(d2) - sqrt(d1);
    id = hash12(c1);
    h = smoothstep(0.0, 0.3, e) * (0.62 + 0.38 * id) * (1.0 - 0.35 * sqrt(d1));
  }
  float field(vec2 p, out float id) {
    float h;
    if (mode < 0.5) scaleField(p, 0.55, 2.1, 1.0, h, id);
    else if (mode < 1.5) scaleField(p, 0.3, 7.0, 0.0, h, id);
    else plateField(p, h, id);
    return h;
  }
  void main() {
    vec2 p, gs = vec2(1.0);
    if (mode < 0.5) { p = vUv * 8.0; WRAP = vec2(8.0); }
    else if (mode < 1.5) { p = vec2(vUv.x, vUv.y * 4.0); WRAP = vec2(1.0, 4.0); gs = vec2(1.0 / 9.0, 1.0 / 0.95); }
    else { p = vUv * 4.0; WRAP = vec2(4.0); gs = vec2(0.25); }
    float e = 0.035, id, i2;
    float h = field(p, id);
    float hx = field(p + vec2(e, 0.0), i2), hy = field(p + vec2(0.0, e), i2);
    gl_FragColor = vec4(h, (hx - h) / e * gs.x, (hy - h) / e * gs.y, id);
  }
`;

let tiles = null;
function makeTiles() {
  if (tiles) return tiles;
  const mk = (n) => {
    const rt = new THREE.WebGLRenderTarget(n, n, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true, depthBuffer: false,
    });
    rt.texture.anisotropy = 8;
    return rt;
  };
  tiles = { scale: mk(512), plate: mk(128), voro: mk(256), baked: false };
  return tiles;
}
/** draws the three tiles; called from the first body material's onBeforeRender, which hands us the renderer */
function bakeTiles(renderer) {
  const T = makeTiles();
  if (T.baked) return;
  T.baked = true;
  try {
    const t0 = performance.now();
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({ uniforms: { mode: { value: 0 } }, vertexShader: BAKE_VS, fragmentShader: BAKE_FS, depthTest: false, depthWrite: false });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    const prev = renderer.getRenderTarget(), ac = renderer.autoClear, xr = renderer.xr.enabled, sa = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    [T.scale, T.plate, T.voro].forEach((rt, i) => {
      mat.uniforms.mode.value = i;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
    });
    renderer.setRenderTarget(prev);
    renderer.autoClear = ac;
    renderer.xr.enabled = xr;
    renderer.shadowMap.autoUpdate = sa;
    mat.dispose();
    T.ms = performance.now() - t0;
    if (typeof window !== 'undefined' && window.__codeDragonStats) window.__codeDragonStats.bakeMs = T.ms;
  } catch (e) {
    console.warn('dragon-code: tile bake failed', e);
  }
}

export function createBodyMaterial(breed) {
  const L = BREED_LOOK[breed];
  const T = textures();
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0.0, clearcoat: 0.35, clearcoatRoughness: 0.45,
    iridescence: L.iri, iridescenceIOR: 1.6, vertexColors: true, envMapIntensity: 1.0,
  });
  const u = {
    cBack: { value: new THREE.Color(L.back) },
    cBelly: { value: new THREE.Color(L.belly) },
    cAccent: { value: new THREE.Color(L.accent) },
    cHorn: { value: new THREE.Color(L.horn) },
    cHornTip: { value: new THREE.Color(L.hornTip) },
    cStripe: { value: new THREE.Color(L.stripe) },
    cGlow: { value: new THREE.Color(L.glow) },
    uPat: { value: new THREE.Vector4(...L.pat) },
    uBreed: { value: new THREE.Vector4(L.magma, L.wet, L.frost, L.storm) },
    tNoise: { value: T.noise },
    tScale: { value: makeTiles().scale.texture },
    tPlate: { value: makeTiles().plate.texture },
    tVoro: { value: makeTiles().voro.texture },
    uTime: TIME,
    glow: { value: 0 },
    hurt: { value: 0 },
    sunlit: { value: 1 },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAO;\nattribute vec4 aTan;\nvarying float vAO;\nvarying vec2 vCell;\nvarying vec3 vBind;\nvarying vec3 vBindN;\nvarying vec3 vTan;\nvarying float vTanW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;\nvBindN = normal;\nvAO = aAO;\nvCell = uv;')
      // the tangent follows the bones like the normal does (skinMatrix is declared by skinnormal_vertex)
      .replace('#include <skinnormal_vertex>', '#include <skinnormal_vertex>\n  vec3 objTan = aTan.xyz;\n  #ifdef USE_SKINNING\n  objTan = (skinMatrix * vec4(objTan, 0.0)).xyz;\n  #endif\n  vTan = normalMatrix * objTan;\n  vTanW = aTan.w;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 cBack, cBelly, cAccent, cHorn, cHornTip, cStripe, cGlow;
        uniform vec4 uPat, uBreed;
        uniform sampler2D tNoise, tScale, tPlate, tVoro;
        uniform float uTime, glow, hurt, sunlit;
        varying float vAO; varying vec2 vCell; varying vec3 vBind; varying vec3 vBindN; varying vec3 vTan; varying float vTanW;
        float dMouth, dTongue, dCrys, dHorn, dBelly, dScale, hornT, dStripe, dRid, dGroove, dRim, dOcc, bumpK;
        vec4 sk;
        `,
      )
      .replace('#include <color_fragment>', `
        vec4 m = vColor;
        dBelly = m.r; dHorn = smoothstep(0.4, 0.5, m.g);
        dMouth = smoothstep(0.88, 0.95, m.a);
        dTongue = smoothstep(0.6, 0.66, m.a) * (1.0 - dMouth);
        dCrys = step(0.15, m.a) * step(m.a, 0.35);
        hornT = clamp((m.g - 0.5) * 2.0, 0.0, 1.0);
        vec3 bn = normalize(vBindN);
        float belly = smoothstep(0.1, 0.9, dBelly);
        vec3 nz1 = texture2D(tNoise, vCell * 0.043).rgb;
        vec3 nz2 = texture2D(tNoise, vCell * 0.0113 + 0.37).rgb;
        // the height fields come from the baked tiles; a low-frequency warp keeps the lattice from reading as a grid
        vec2 pw = vec2(vCell.x, -vCell.y) + (nz1.rg - 0.5) * 0.8;
        float plateK = m.b * (1.0 - dHorn);
        sk = texture2D(tScale, pw * 0.125);
        if (plateK > 0.001) sk = mix(sk, texture2D(tVoro, pw * 0.0625), plateK);
        if (belly > 0.001) sk = mix(sk, texture2D(tPlate, vec2(pw.x * (1.0 / 9.0) + 0.5, pw.y * (1.0 / 3.8))), belly);
        float hs = sk.x, hid = sk.w;
        float hocc = 0.5 * (1.0 - smoothstep(0.1, 0.5, hs));
        float hrim = smoothstep(0.7, 2.2, length(sk.yz));
        // the head's skin is smooth bone and fine scale; the mouth is soft
        float headK = smoothstep(-5.6, -6.5, vBind.z);
        bumpK = (1.0 - dHorn) * (1.0 - 0.45 * headK) * (1.0 - 0.7 * max(dMouth, dTongue));
        // horn and tooth: growth rings along the length and fine fibres around it
        vec3 nzH = vec3(0.5);
        if (dHorn > 0.01) nzH = texture2D(tNoise, vCell * vec2(0.5, 0.06)).rgb;
        float rings = 0.5 + 0.5 * sin(vCell.y * 5.5 + nzH.r * 3.0);
        dScale = mix(hs, 0.45 + 0.45 * rings * (0.7 + 0.5 * nzH.g), dHorn);
        dRid = mix(hid, nzH.b, dHorn);
        dOcc = hocc; dRim = hrim;
        dGroove = clamp(1.0 - smoothstep(0.08, 0.3, hs) + hocc * 0.3, 0.0, 1.0) * (1.0 - dHorn);
        vec3 pc;
        float bands = 0.5 + 0.5 * sin(vCell.y * 1.5 + (nz2.r - 0.5) * 5.5 + abs(vCell.x) * 0.22);
        pc.r = smoothstep(0.52, 0.74, bands * (0.55 + 0.9 * nz1.g));
        pc.g = smoothstep(0.52, 0.84, nz2.g);
        pc.b = nz1.b;
        // countershading: dark back, paler flanks, light belly
        float dors = smoothstep(-0.25, 0.85, bn.y);
        vec3 flank = mix(cBack, cBelly, 0.2);
        vec3 base = mix(flank, cBack, dors);
        base = mix(base, cBelly, belly);
        // blotches (lighter on the scale crowns), then dark stripe bands that wrap the flanks and fade on the belly
        float blot = pc.g * uPat.y * (1.0 - belly) * (0.3 + 0.6 * dScale) * (1.0 - 0.35 * smoothstep(-5.6, -6.5, vBind.z));
        base = mix(base, cAccent, clamp(blot, 0.0, 1.0));
        dStripe = pc.r * uPat.x * (1.0 - smoothstep(0.15, 0.8, dBelly)) * (1.0 - 0.85 * headK);
        base = mix(base, cStripe, clamp(dStripe * 0.85, 0.0, 1.0));
        // soft mottling and a per-scale tint (warmer / cooler scales)
        base *= 1.0 + (pc.b - 0.5) * uPat.z * 1.5;
        float jit = (dRid - 0.5) * uPat.w;
        base *= vec3(1.0 + jit * 0.7, 1.0 + jit * 0.25, 1.0 - jit * 0.5);
        // grooves between scales: darker and deeper in hue; the lit rim of each scale is a touch lighter
        base *= 0.55 + 0.6 * dScale;
        base = mix(base * vec3(1.15, 0.85, 0.8), base, smoothstep(0.15, 0.5, dScale));
        base *= 1.0 + 0.22 * dRim * (1.0 - dHorn);
        // thin crest skin between the spikes
        base = mix(base, cStripe * 1.6 + cAccent * 0.15, smoothstep(0.2, 0.3, m.g) * (1.0 - dHorn) * 0.75);
        // horns, claws and teeth: dark keratin roots with growth rings, pale worn tips
        vec3 ivory = mix(vec3(0.92, 0.85, 0.68), cHornTip, 0.6);
        vec3 hornC = mix(cHorn * 0.8, ivory, smoothstep(0.25, 0.95, hornT) * 0.9);
        hornC *= 0.62 + 0.55 * dScale;
        hornC = mix(hornC, hornC * vec3(1.15, 1.0, 0.85) + 0.03, smoothstep(0.7, 1.0, hornT));
        base = mix(base, hornC, dHorn);
        // mouth: red-black flesh, pink tongue
        base = mix(base, vec3(0.07, 0.01, 0.014) + vec3(0.04, 0.0, 0.0) * dScale, dMouth);
        base = mix(base, vec3(0.2, 0.035, 0.05) * (0.7 + 0.5 * dScale), dTongue);
        // ice crystals: blue-white glass with deeper cores
        base = mix(base, mix(cAccent * 0.55, vec3(0.8, 0.93, 1.0), 0.55), dCrys);
        diffuseColor.rgb = base;
        ${HURT_TINT}
      `)
      .replace('#include <normal_fragment_maps>', `
        {
          // bump from the baked height gradient, in the frame of the generated tangents (v runs opposite to the tile's y)
          vec3 Tv = normalize(vTan - normal * dot(normal, vTan));
          vec3 Bv = cross(normal, Tv) * vTanW;
          normal = normalize(normal - 0.62 * bumpK * (sk.y * Tv - sk.z * Bv));
        }
      `)
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
         roughnessFactor = mix(0.66 - dScale * 0.28 + (dRid - 0.5) * 0.14 + dOcc * 0.1, 0.52 + hornT * 0.1 - dScale * 0.1, dHorn);
         roughnessFactor *= 1.0 - uBreed.y * 0.3 * (1.0 - dHorn);
         roughnessFactor = mix(roughnessFactor, 0.18, dMouth);
         roughnessFactor = mix(roughnessFactor, 0.3, dTongue);
         roughnessFactor = mix(roughnessFactor, 0.07, dCrys);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
         material.clearcoat = clamp(0.3 + uBreed.y * 0.25 + dCrys + dMouth * 0.6 + dTongue * 0.5 + dHorn * 0.05, 0.0, 1.0);
         material.clearcoatRoughness = mix(0.45 - uBreed.y * 0.15, 0.05, max(dMouth, dCrys));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         vec3 vd = normalize(vViewPosition);
         float fres = pow(1.0 - clamp(abs(dot(normal, vd)), 0.0, 1.0), 3.0);
         float pulse = 0.62 + 0.38 * sin(uTime * 1.6 + vBind.z * 0.9 + pc.b * 7.0);
         totalEmissiveRadiance += cGlow * glow * (dMouth * 14.0 + dTongue * 6.0 + smoothstep(-5.0, -7.5, vBind.z) * smoothstep(0.3, -0.4, vBind.y) * 2.0);
         float seam = dGroove * (1.0 - dHorn) * (1.0 - dMouth) * (1.0 - dTongue) * smoothstep(-5.9, -5.0, vBind.z);
         totalEmissiveRadiance += vec3(1.0, 0.3, 0.04) * uBreed.x * seam * pulse * (0.02 + 1.0 * belly + 0.12 * dStripe) * (1.0 + 3.5 * glow);
         float zap = pow(0.5 + 0.5 * sin(uTime * 7.0 + vBind.z * 2.7 + pc.b * 9.0 + dRid * 5.0), 5.0);
         totalEmissiveRadiance += cGlow * uBreed.w * dStripe * (0.03 + 0.8 * zap) * (1.0 - dHorn) * (1.0 + 2.0 * glow);
         float glit = pow(max(0.0, sin(dot(vd, normal) * 38.0 + dRid * 90.0 + vBind.x * 6.0)), 220.0);
         totalEmissiveRadiance += vec3(0.7, 0.9, 1.0) * uBreed.z * glit * dScale * 0.3 * sunlit;
         totalEmissiveRadiance += cGlow * dCrys * (0.5 + 1.2 * fres) * (0.6 + 0.4 * pulse);
         totalEmissiveRadiance += cGlow * glow * dHorn * smoothstep(0.55, 1.0, hornT) * 2.2;
         totalEmissiveRadiance += cGlow * (uBreed.y > 0.5 ? 1.0 : 0.0) * (belly * dGroove * 0.35 * smoothstep(-5.9, -5.0, vBind.z) + blot * 0.3) * pulse;
         totalEmissiveRadiance += ${HURT_RIM} * fres;`,
      )
      .replace(
        '#include <aomap_fragment>',
        `float ambientOcclusion = vAO * (0.7 + 0.3 * smoothstep(0.05, 0.45, dScale)) * (1.0 - 0.3 * dOcc);
         reflectedLight.indirectDiffuse *= ambientOcclusion;
         reflectedLight.indirectSpecular *= ambientOcclusion;
         reflectedLight.directDiffuse *= sunlit * (0.78 + 0.22 * smoothstep(0.05, 0.4, dScale)) * mix(1.0, vAO, 0.6);
         reflectedLight.directSpecular *= sunlit;`,
      );
  };
  mat.onBeforeRender = (renderer) => {
    TIME.value = performance.now() / 1000;
    if (!tiles.baked) bakeTiles(renderer);
  };
  withDragonFog(mat);
  mat.customProgramCacheKey = () => 'dragon-code-body-v2';
  return mat;
}

export function createWingMaterial(breed) {
  const L = BREED_LOOK[breed];
  const T = textures().wing;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, vertexColors: true, envMapIntensity: 0.8,
    normalMap: T.normal, normalScale: new THREE.Vector2(1.0, 1.0), aoMap: T.ao,
  });
  const u = {
    cMem: { value: new THREE.Color(L.membrane) },
    cMemLight: { value: new THREE.Color(L.memLight) },
    cTrans: { value: new THREE.Color(L.membrane).lerp(new THREE.Color(L.glow), 0.3) },
    cVein: { value: new THREE.Color(L.back).multiplyScalar(0.55) },
    cAccent: { value: new THREE.Color(L.accent) },
    cGlow: { value: new THREE.Color(L.glow) },
    uBreed: { value: new THREE.Vector4(L.magma, L.wet, L.frost, L.storm) },
    tCol: { value: T.col },
    uTime: TIME,
    sunCol: { value: SKY.sunColor },
    sunlit: { value: 1 },
    hurt: { value: 0 },
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 cMem, cMemLight, cTrans, cVein, cAccent, cGlow, sunCol; uniform vec4 uBreed;
        uniform sampler2D tCol; uniform float sunlit, hurt, uTime;
        varying vec3 vBind; float wThin; float wVein; float wFin; float wRib;
        float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        float vn3(vec3 p) {
          vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `
        wThin = vColor.r; wFin = step(0.5, vColor.g);
        vec3 aoT = texture2D(aoMap, vAoMapUv).rgb;
        vec3 pc = texture2D(tCol, vAoMapUv).rgb; // R mottle, G freckles
        wVein = smoothstep(0.35, 0.75, aoT.g) * smoothstep(0.02, 0.2, wThin);
        float cap = max((1.0 - smoothstep(0.0, 0.045, abs(vn3(vBind * 4.5) - 0.5))) * 0.7, (1.0 - smoothstep(0.0, 0.06, abs(vn3(vBind * 10.0 + 7.0) - 0.5))) * 0.45);
        cap *= smoothstep(0.1, 0.5, wThin) * (1.0 - wFin * 0.5);
        float edgeT = smoothstep(0.0, 0.85, wThin);
        vec3 mem = mix(cMem * 0.7, cMem, smoothstep(0.0, 0.5, wThin));
        mem = mix(mem, cMemLight, smoothstep(0.35, 1.0, edgeT) * 0.6);
        mem *= (0.85 + 0.45 * pc.r) * 1.16;
        mem = mix(mem, cVein, pc.g * 0.45 * (1.0 - wFin));
        float rr = length(vec2(abs(vBind.x) - 6.0, vBind.z + 1.75));
        mem *= 1.0 - 0.25 * smoothstep(5.0, 7.5, rr) * (1.0 - wFin);
        mem = mix(mem, vec3(0.82, 0.93, 1.0), uBreed.z * smoothstep(0.5, 0.95, pc.r + wThin * 0.35) * 0.5 * (1.0 - wFin));
        mem = mix(mem, mix(cAccent, cMemLight, 0.5) * (0.6 + 0.6 * pc.r), wFin * 0.3);
        mem = mix(mem, mem * 0.6 + cVein * 0.4, cap * 0.7);
        diffuseColor.rgb = mix(mem, cVein, clamp(wVein, 0.0, 1.0) * 0.8);
        wRib = clamp(wVein + cap * 0.35, 0.0, 1.0);
        ${HURT_TINT}`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness * (1.0 - uBreed.y * 0.35) * (0.85 + 0.3 * (1.0 - aoT.g));`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.directDiffuse *= sunlit;
        reflectedLight.directSpecular *= sunlit;`)
      .replace('#include <opaque_fragment>', `
        #if NUM_DIR_LIGHTS > 0
        {
          vec3 Ld = directionalLights[0].direction;
          float back = max(0.0, -dot(normal, Ld));
          float viewBack = pow(max(0.0, dot(normalize(vViewPosition), -Ld) * -1.0 + 1.0) * 0.5, 0.5);
          float th = 0.35 + 0.65 * wThin;
          float flaw = 0.8 + 0.4 * pc.r;
          outgoingLight += cTrans * cTrans * sunCol * (back * 1.7 + 0.16) * th * flaw * (1.0 - wRib * 0.85) * sunlit * (0.6 + 0.4 * viewBack);
          float grazing = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);
          outgoingLight += cMemLight * sunCol * grazing * wThin * 0.12 * sunlit;
        }
        #endif
        float zap = pow(0.5 + 0.5 * sin(uTime * 6.0 + vBind.z * 2.3 + vBind.x * 1.7), 6.0);
        outgoingLight += cGlow * uBreed.w * wRib * (0.12 + 1.1 * zap);
        outgoingLight += vec3(1.0, 0.3, 0.05) * uBreed.x * wRib * 0.25 * (0.7 + 0.3 * sin(uTime * 1.6 + vBind.z));
        outgoingLight += ${HURT_RIM} * pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 3.0);
        #include <opaque_fragment>`);
  };
  mat.onBeforeRender = () => {
    TIME.value = performance.now() / 1000;
  };
  withDragonFog(mat);
  mat.customProgramCacheKey = () => 'dragon-code-wing-v1';
  return mat;
}

// ------------------------------------------------------------------------------------------------------
/** What DragonView needs: a template to clone and the three material factories. */
export function loadCodeDragon() {
  const stats = {};
  const t0 = performance.now();
  const template = buildDragonTemplate(stats);
  textures();
  stats.texMs = tex.ms;
  stats.totalMs = performance.now() - t0;
  if (typeof window !== 'undefined') window.__codeDragonStats = stats;
  return { template, createBodyMaterial, createWingMaterial, createEyeMaterial, stats };
}
