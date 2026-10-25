// Chunked LOD terrain. Chunks are meshed by the terrain worker at four resolutions and swapped by distance;
// skirts hide the cracks between neighbours. The material is MeshStandardMaterial with a splat shader
// injected: sand / grass / rock / snow by height, slope and noise, a triplanar cliff layer on steep faces, two
// texture scales against visible tiling, and baked mountain shadows + AO from the worker's global data.
import * as THREE from 'three';
import { WORLD } from '../../../shared/constants.js';
import { SKY } from './atmosphere.js';
import { CASTLE } from '../../../shared/castle.js';

// 7.2 km of terrain in 12 x 12 chunks of 600 m (the old 12.8 km needed 16 x 16 of 800 m). Cells are 4.7 m at the
// finest level, so the jagged ridges and gorges keep their edges; the coarse levels reach the whole (smaller) map.
const CHUNK = 600;
const LODS = [
  { res: 128, dist: 900 },
  { res: 64, dist: 1800 },
  { res: 32, dist: 3400 },
  { res: 16, dist: Infinity },
];
const GLOBAL_N = 1024;

const indexCache = new Map();
function indices(res) {
  if (indexCache.has(res)) return indexCache.get(res);
  const vn = res + 1;
  const idx = [];
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * vn + i, b = a + 1, c = a + vn, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // skirt strips: edges are stored after the grid as rows z0, z1, columns x0, x1
  const base = vn * vn;
  const strip = (edgeStart, gridIndex, flip) => {
    for (let i = 0; i < res; i++) {
      const g0 = gridIndex(i), g1 = gridIndex(i + 1);
      const s0 = edgeStart + i, s1 = edgeStart + i + 1;
      if (flip) idx.push(g0, g1, s0, s0, g1, s1);
      else idx.push(g0, s0, g1, g1, s0, s1);
    }
  };
  strip(base, (i) => i, false);
  strip(base + vn, (i) => res * vn + i, true);
  strip(base + vn * 2, (j) => j * vn, true);
  strip(base + vn * 3, (j) => j * vn + res, false);
  const attr = new THREE.BufferAttribute(vn * vn + vn * 4 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
  indexCache.set(res, attr);
  return attr;
}

export class Terrain {
  constructor(scene, textures, onGlobal) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.worker = new Worker(new URL('terrain-worker.js', document.baseURI), { type: 'module' });
    this.pending = new Map();
    this.chunks = [];
    this.globalReady = false;
    this.onGlobal = onGlobal;
    this.inflight = 0;
    this.material = this.createMaterial(textures);
    this.dataTex = null;
    const n = (WORLD.terrainHalf * 2) / CHUNK;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        this.chunks.push({ i, j, x0: -WORLD.terrainHalf + i * CHUNK, z0: -WORLD.terrainHalf + j * CHUNK, lods: [], mesh: null, shown: -1, want: 3 });
      }
    }
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.postMessage({ type: 'global', n: GLOBAL_N, sun: SKY.sunDir.toArray() });
    // coarse meshes for everything first
    for (const c of this.chunks) this.request(c, 3);
  }

  request(c, lod) {
    const key = `${c.i},${c.j},${lod}`;
    if (c.lods[lod] || this.pending.has(key)) return;
    this.pending.set(key, { c, lod });
    this.inflight++;
    this.worker.postMessage({ type: 'chunk', key, x0: c.x0, z0: c.z0, size: CHUNK, res: LODS[lod].res });
  }

  onMessage(m) {
    if (m.type === 'global') {
      this.setGlobal(m.data, m.mask);
      return;
    }
    const job = this.pending.get(m.key);
    if (!job) return;
    this.pending.delete(m.key);
    this.inflight--;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
    geo.setIndex(indices(LODS[job.lod].res));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(job.c.x0, m.minY, job.c.z0), new THREE.Vector3(job.c.x0 + CHUNK, m.maxY, job.c.z0 + CHUNK));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    job.c.lods[job.lod] = geo;
    this.refresh(job.c);
  }

  setQuality(q) {
    const u = this.material.userData.uniforms;
    u.qual.value = q;
    // anisotropic filtering is a third of the ground's cost at 8x (dozens of array taps per pixel): 2x / 4x / 8x
    const aniso = [2, 4, 8][Math.max(0, Math.min(2, q))];
    for (const t of [u.albedoArr.value, u.normalArr.value]) {
      if (t && t.anisotropy !== aniso) {
        t.anisotropy = aniso;
        t.needsUpdate = true;
      }
    }
  }

  setGlobal(data, mask) {
    if (mask) {
      const mt = new THREE.DataTexture(mask, GLOBAL_N, GLOBAL_N, THREE.RGBAFormat, THREE.UnsignedByteType);
      mt.magFilter = mt.minFilter = THREE.LinearFilter;
      mt.wrapS = mt.wrapT = THREE.ClampToEdgeWrapping;
      mt.needsUpdate = true;
      this.maskTex = mt;
      this.material.userData.uniforms.forestMask.value = mt;
    }
    // pack to half floats for a filterable texture
    const half = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
    const tex = new THREE.DataTexture(half, GLOBAL_N, GLOBAL_N, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.dataTex = tex;
    this.globalData = data;
    this.material.userData.uniforms.terrainData.value = tex;
    this.globalReady = true;
    if (this.onGlobal) this.onGlobal(tex, data, GLOBAL_N);
  }

  // shadow height lookup on the CPU (for lighting dragons / clouds in mountain shadows)
  sunlit(x, y, z) {
    if (!this.globalData) return 1;
    const half = WORLD.terrainHalf;
    const fx = ((x + half) / (half * 2)) * (GLOBAL_N - 1), fz = ((z + half) / (half * 2)) * (GLOBAL_N - 1);
    const i = Math.max(0, Math.min(GLOBAL_N - 1, Math.round(fx))), j = Math.max(0, Math.min(GLOBAL_N - 1, Math.round(fz)));
    const sh = this.globalData[(j * GLOBAL_N + i) * 4 + 1];
    return THREE.MathUtils.smoothstep(y - sh, -25, 25);
  }

  refresh(c) {
    // best available LOD at or coarser than wanted, else the finest we have
    let lod = -1;
    for (let l = c.want; l < LODS.length; l++) if (c.lods[l]) { lod = l; break; }
    if (lod < 0) for (let l = c.want; l >= 0; l--) if (c.lods[l]) { lod = l; break; }
    if (lod < 0 || lod === c.shown) return;
    if (!c.mesh) {
      c.mesh = new THREE.Mesh(c.lods[lod], this.material);
      c.mesh.receiveShadow = true;
      c.mesh.matrixAutoUpdate = false;
      this.group.add(c.mesh);
    } else c.mesh.geometry = c.lods[lod];
    c.shown = lod;
  }

  update(camera, t = 0) {
    this.material.userData.uniforms.time.value = t;
    const cx = camera.position.x, cz = camera.position.z;
    const cy = Math.max(0, camera.position.y - 300);
    const order = [];
    for (const c of this.chunks) {
      const dx = Math.max(c.x0 - cx, 0, cx - (c.x0 + CHUNK));
      const dz = Math.max(c.z0 - cz, 0, cz - (c.z0 + CHUNK));
      const d = Math.hypot(dx, dz, cy * 0.6);
      let want = 0;
      while (d > LODS[want].dist) want++;
      c.want = want;
      c.d = d;
      if (!c.lods[want]) order.push(c);
      this.refresh(c);
      // free fine meshes we've flown far away from
      for (let l = 0; l < want - 1; l++) {
        if (c.lods[l] && c.shown !== l) {
          c.lods[l].dispose();
          c.lods[l] = null;
        }
      }
    }
    order.sort((a, b) => a.d - b.d);
    for (const c of order) {
      if (this.inflight >= 4) break;
      this.request(c, c.want);
    }
  }

  createMaterial(t) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, envMapIntensity: 0.9 });
    const uniforms = {
      albedoArr: { value: t.albedo },
      normalArr: { value: t.normal },
      terrainData: { value: null },
      forestMask: { value: new THREE.DataTexture(new Uint8Array([0, 255, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType) },
      worldHalf: { value: WORLD.terrainHalf },
      castle: { value: new THREE.Vector3(0, 0, 600) }, // x, z, radius of the flat castle massif: bare rock
      time: { value: 0 },
      qual: { value: 1 },
    };
    uniforms.forestMask.value.needsUpdate = true;
    mat.userData.uniforms = uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normal;');
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          precision highp sampler2DArray;
          uniform sampler2DArray albedoArr;
          uniform sampler2DArray normalArr;
          uniform sampler2D terrainData;
          uniform sampler2D forestMask;
          uniform float worldHalf;
          uniform vec3 castle;
          uniform float time;
          uniform float qual;
          varying vec3 vWPos;
          varying vec3 vWNrm;
          float th(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float tnoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(th(i), th(i + vec2(1, 0)), u.x), mix(th(i + vec2(0, 1)), th(i + vec2(1, 1)), u.x), u.y);
          }
          float tfbm(vec2 p) { return tnoise(p) * 0.5 + tnoise(p * 2.03 + 7.1) * 0.3 + tnoise(p * 4.1 - 3.3) * 0.2; }
          vec3 srgb2lin(vec3 c) { return c * c * (c * 0.305306 + 0.682171) + c * 0.012522; }
          // layers: 0 grass 1 rock 2 sand 3 snow 4 cliff 5 cliff B 6 forest litter
          vec3 TA(vec2 uv, float l, vec2 gx, vec2 gy) { return textureGrad(albedoArr, vec3(uv, l), gx, gy).rgb; }
          vec3 TN(vec2 uv, float l, vec2 gx, vec2 gy) { return textureGrad(normalArr, vec3(uv, l), gx, gy).xyz * 2.0 - 1.0; }
          // a layer at two scales blended by a noise mask, against visible tiling
          // the mask is fully 0 or 1 over most of the map: one tap there
          vec3 layerA(vec2 xz, float scale, float l, float m, vec2 gx, vec2 gy) {
            vec2 uv = xz / scale; vec2 ux = gx / scale, uy = gy / scale;
            if (m < 0.002) return TA(uv, l, ux, uy);
            if (m > 0.998) return TA(uv * 0.27 + 0.37, l, ux * 0.27, uy * 0.27);
            return mix(TA(uv, l, ux, uy), TA(uv * 0.27 + 0.37, l, ux * 0.27, uy * 0.27), m);
          }
          // ground normal detail is mipped flat beyond a kilometre or so: skip the taps there (tNK, cliffs keep theirs)
          float tNK;
          vec3 layerN(vec2 xz, float scale, float l, float m, vec2 gx, vec2 gy) {
            if (tNK < 0.001) return vec3(0.0, 0.0, 1.0);
            vec2 uv = xz / scale; vec2 ux = gx / scale, uy = gy / scale;
            if (m < 0.002) return normalize(TN(uv, l, ux, uy));
            if (m > 0.998) return normalize(TN(uv * 0.27 + 0.37, l, ux * 0.27, uy * 0.27));
            return normalize(mix(TN(uv, l, ux, uy), TN(uv * 0.27 + 0.37, l, ux * 0.27, uy * 0.27), m));
          }
          // triplanar weights: projections under 3% are dropped (fewer taps), the rest rescaled so the blend stays continuous
          vec3 triW(vec3 n, float k) { vec3 w = pow(abs(n), vec3(k)); w /= w.x + w.y + w.z; w = max(w - 0.03, 0.0); return w / (w.x + w.y + w.z); }
          vec3 tAlbedo; vec3 tNormal; float tRough; vec4 tData; vec3 tEmis; float tCanopyAO;
          `,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          {
            vec3 N = normalize(vWNrm);
            vec2 xz = vWPos.xz;
            float h = vWPos.y;
            float slope = 1.0 - N.y;
            float camD = length(vWPos - cameraPosition);
            vec2 gx = dFdx(xz), gy = dFdy(xz);
            tNK = 1.0 - smoothstep(900.0, 1300.0, camD);
            vec2 duv = (xz + worldHalf) / (2.0 * worldHalf);
            vec4 mk = texture2D(forestMask, duv);
            float n1 = tnoise(xz * 0.004) * 0.65 + tnoise(xz * 0.021) * 0.35;
            float n2 = tnoise(xz * 0.0013 + 17.0);
            float n3 = tnoise(xz * 0.011 + 41.0);
            float tm = smoothstep(0.3, 0.7, tnoise(xz * 0.0021 + 3.0));
            // layer weights
            float wSand = (1.0 - smoothstep(6.0, 16.0, h + n1 * 8.0)) * (1.0 - smoothstep(0.3, 0.5, slope));
            // the ring of mountains tops out near 1 km, so snow and bare rock start lower than they did
            float wSnow = smoothstep(640.0, 860.0, h + (n1 - 0.5) * 200.0 + slope * -240.0);
            float massif = 1.0 - smoothstep(castle.z * 0.92, castle.z * 1.55 + 120.0, length(xz - castle.xy) + (n1 - 0.5) * 120.0);
            float wRock = clamp(smoothstep(0.2, 0.42, slope + (n1 - 0.5) * 0.18) + smoothstep(380.0, 760.0, h + (n2 - 0.5) * 260.0) * 0.8 + massif * 0.85, 0.0, 1.0);
            // the citadel's massif is bare rock, plateau and cliffs alike
            wRock = max(wRock, 1.0 - smoothstep(${(CASTLE.plateau + 30).toFixed(1)}, ${(CASTLE.plateau + 230).toFixed(1)}, length(xz - vec2(${CASTLE.x.toFixed(1)}, ${CASTLE.z.toFixed(1)}))));
            float wCliff = smoothstep(0.46, 0.7, slope + (n1 - 0.5) * 0.12);
            float forest = mk.r * (1.0 - wCliff) * (1.0 - wSnow);

            // ---- ground: grass graded from lush to sun-dried, with a close-up detail layer
            vec3 grass = layerA(xz, 46.0, 0.0, tm, gx, gy);
            vec3 nG = layerN(xz, 46.0, 0.0, tm, gx, gy);
            float dry = smoothstep(0.35, 0.8, tnoise(xz * 0.0031 + 90.0) + (n1 - 0.5) * 0.4 - smoothstep(0.0, 300.0, h) * 0.12);
            grass = mix(grass, grass * vec3(1.28, 1.06, 0.62) + vec3(0.04, 0.02, 0.0), dry * 0.75);
            grass = mix(grass, grass * vec3(0.78, 0.86, 0.7), (1.0 - dry) * smoothstep(0.55, 0.8, tnoise(xz * 0.0071 + 5.0)) * 0.6);
            float closeK = 1.0 - smoothstep(25.0, 220.0, camD);
            if (closeK > 0.01 && qual > 0.5) {
              float d1 = dot(TA(xz / 3.3, 0.0, gx / 3.3, gy / 3.3), vec3(0.34));
              float d2 = dot(TA(xz / 0.9 + 0.2, 0.0, gx / 0.9, gy / 0.9), vec3(0.34));
              grass *= mix(1.0, (0.55 + d1 * 0.9) * (0.7 + d2 * 0.6), 0.55 * closeK);
              nG = normalize(nG + (TN(xz / 1.7, 0.0, gx / 1.7, gy / 1.7)) * 0.7 * closeK * vec3(1.0, 1.0, 0.0));
            }
            vec3 col = grass;
            vec3 tn = nG;
            vec3 slopeOff = vec3(0.0); // triplanar normal detail for rock on slopes
            float slopeW = 0.0;
            if (wRock > 0.005) {
              vec3 rock = layerA(xz, 64.0, 1.0, tm, gx, gy);
              vec3 rn = layerN(xz, 64.0, 1.0, tm, gx, gy);
              // on slopes the planar projection smears the rock down the hill: blend in a triplanar lookup
              float tri = smoothstep(0.1, 0.28, slope);
              if (tri > 0.01) {
                vec3 tw = triW(N, 3.0);
                vec3 sp = vWPos;
                vec2 zy = sp.zy, xy = sp.xy;
                float TS = 52.0;
                vec2 gzy = dFdx(zy) / TS, hzy = dFdy(zy) / TS, gxy = dFdx(xy) / TS, hxy = dFdy(xy) / TS;
                vec3 tr = vec3(0.0);
                bool nrm = tNK > 0.001;
                if (tw.x > 0.0) {
                  tr += TA(zy / TS, 1.0, gzy, hzy) * tw.x;
                  if (nrm) { vec2 n = TN(zy / TS, 1.0, gzy, hzy).xy; slopeOff += vec3(0.0, n.y, n.x) * tw.x; }
                }
                if (tw.z > 0.0) {
                  tr += TA(xy / TS + 0.17, 1.0, gxy, hxy) * tw.z;
                  if (nrm) { vec2 n = TN(xy / TS + 0.17, 1.0, gxy, hxy).xy; slopeOff += vec3(n.x, n.y, 0.0) * tw.z; }
                }
                if (tw.y > 0.0) {
                  tr += TA(xz / TS, 1.0, gx / TS, gy / TS) * tw.y;
                  if (nrm) { vec2 n = TN(xz / TS, 1.0, gx / TS, gy / TS).xy; slopeOff += vec3(n.x, 0.0, n.y) * tw.y; }
                }
                rock = mix(rock, tr, tri);
                slopeW = tri * wRock * tNK;
              }
              // fine world-space grain that does not follow any projection, so slopes never look combed
              float grain = tnoise(vec2(vWPos.x + vWPos.z * 0.7, vWPos.y * 1.3) * 0.55) * 0.6 + tnoise(vec2(vWPos.z - vWPos.x * 0.6, vWPos.y * 0.9 + 5.0) * 1.7) * 0.4;
              rock *= 0.82 + 0.36 * grain;
              col = mix(col, rock, wRock);
              tn = mix(tn, rn, wRock);
            }
            if (wSand > 0.005) {
              vec3 sand = layerA(xz, 38.0, 2.0, tm, gx, gy);
              col = mix(col, sand, wSand);
              tn = mix(tn, layerN(xz, 38.0, 2.0, tm, gx, gy), wSand);
            }
            // forest litter under the canopy
            if (forest > 0.02) {
              vec3 lit = layerA(xz, 14.0, 6.0, tm, gx, gy);
              lit = mix(vec3(dot(lit, vec3(0.33))), lit, 0.6) * vec3(0.36, 0.36, 0.29) * (0.7 + 0.5 * n3);
              col = mix(col, lit, smoothstep(0.08, 0.5, forest) * 0.92);
              tn = mix(tn, layerN(xz, 14.0, 6.0, tm, gx, gy), smoothstep(0.08, 0.5, forest) * 0.8);
            }
            // gravel and stream beds along canyon floors (mk.g is the distance to the canyon centre line)
            float wb = 0.095 * (0.75 + 0.5 * tnoise(xz * 0.021 + 3.0));
            float bed = 1.0 - smoothstep(wb * 1.4, wb * 3.2, mk.g);
            float water = 1.0 - smoothstep(wb * 0.85, wb * 1.15, mk.g);
            if (bed > 0.01) {
              vec3 grav = layerA(xz, 9.0, 1.0, tm, gx, gy) * vec3(1.15, 1.08, 0.95);
              col = mix(col, grav * mix(0.45, 1.0, smoothstep(wb * 1.1, wb * 3.0, mk.g)), bed * (1.0 - wCliff) * 0.9);
            }
            // snow
            if (wSnow > 0.005) {
              vec3 snow = layerA(xz, 70.0, 3.0, tm, gx, gy);
              col = mix(col, snow, wSnow);
              tn = mix(tn, layerN(xz, 70.0, 3.0, tm, gx, gy), wSnow);
            }
            // ---- cliffs: full triplanar with a warped lookup, two rock types and sedimentary banding
            vec3 wn = normalize(vec3(N.x + tn.x * 0.9 * tNK, N.y, N.z - tn.y * 0.9 * tNK));
            if (slopeW > 0.01) wn = normalize(mix(wn, normalize(N + slopeOff * 0.9), slopeW));
            float cw = wCliff * (1.0 - wSnow * 0.55);
            if (cw > 0.01) {
              vec3 wp = vWPos + 16.0 * vec3(tnoise(vWPos.xz * 0.02), tnoise(vWPos.yx * 0.03 + 4.0), tnoise(vWPos.zy * 0.025 + 9.0));
              vec3 bw = triW(N, 4.0);
              vec2 sx = vWPos.zy, sz = vWPos.xy, sy = vWPos.xz;
              vec2 gxX = dFdx(sx), gyX = dFdy(sx), gxZ = dFdx(sz), gyZ = dFdy(sz), gxY = dFdx(sy), gyY = dFdy(sy);
              float S1 = 118.0, S2 = 71.0;
              bool two = qual > 0.5;
              vec3 cA = vec3(0.0), cB = vec3(0.0), off = vec3(0.0);
              if (bw.x > 0.0) {
                cA += TA(wp.zy / S1, 4.0, gxX / S1, gyX / S1) * bw.x;
                if (two) cB += TA(wp.zy / S2 + 0.3, 5.0, gxX / S2, gyX / S2) * bw.x;
                vec2 n = TN(wp.zy / S1, 4.0, gxX / S1, gyX / S1).xy; off += vec3(0.0, n.y, n.x) * bw.x;
              }
              if (bw.z > 0.0) {
                cA += TA(wp.xy / S1, 4.0, gxZ / S1, gyZ / S1) * bw.z;
                if (two) cB += TA(wp.xy / S2 + 0.3, 5.0, gxZ / S2, gyZ / S2) * bw.z;
                vec2 n = TN(wp.xy / S1, 4.0, gxZ / S1, gyZ / S1).xy; off += vec3(n.x, n.y, 0.0) * bw.z;
              }
              if (bw.y > 0.0) {
                cA += TA(wp.xz / S1, 4.0, gxY / S1, gyY / S1) * bw.y;
                if (two) cB += TA(wp.xz / S2 + 0.3, 5.0, gxY / S2, gyY / S2) * bw.y;
                vec2 n = TN(wp.xz / S1, 4.0, gxY / S1, gyY / S1).xy; off += vec3(n.x, 0.0, n.y) * bw.y;
              }
              if (!two) cB = cA;
              float mixAB = smoothstep(0.3, 0.7, tnoise(xz * 0.0019 + 7.0) + (tnoise(vWPos.yy * 0.02 + xz * 0.004) - 0.5) * 0.3);
              vec3 cliff = mix(cA, cB, mixAB);
              // desaturate cold grey rock, keep the warm limestone
              float lumC = dot(cliff, vec3(0.33));
              cliff = mix(vec3(lumC), cliff, mix(0.4, 0.72, mixAB));
              // sedimentary bands: warped sine steps in altitude, ochre / rust / grey
              float warp = (tfbm(xz * 0.0045) - 0.5) * 70.0 + (tnoise(xz * 0.03) - 0.5) * 8.0;
              float b1 = sin((h + warp) * 0.085) * 0.5 + 0.5;
              float b2 = sin((h + warp * 0.6) * 0.31 + 1.7) * 0.5 + 0.5;
              vec3 strata = mix(vec3(0.74, 0.7, 0.68), vec3(1.12, 0.98, 0.84), b1);
              strata = mix(strata, vec3(1.18, 0.82, 0.62), smoothstep(0.78, 1.0, b2) * 0.45);
              cliff *= mix(vec3(1.0), strata, 0.85);
              // vertical weathering streaks and lichen toward the foot of the walls
              float streak = tnoise(vec2((xz.x + xz.y) * 0.11, h * 0.045)) * 0.6 + tnoise(vec2((xz.x - xz.y) * 0.31, h * 0.11)) * 0.4;
              cliff *= 0.88 + 0.26 * streak;
              float cgrain = tnoise(vec2(vWPos.x + vWPos.z * 0.7, vWPos.y * 1.1) * 0.45) * 0.6 + tnoise(vec2(vWPos.z - vWPos.x * 0.6, vWPos.y * 0.8 + 5.0) * 1.5) * 0.4;
              cliff *= 0.84 + 0.32 * cgrain;
              cliff = mix(cliff, cliff * vec3(0.55, 0.7, 0.42), smoothstep(0.2, 0.9, tnoise(wp.xz * 0.05 + wp.y * 0.02)) * (1.0 - smoothstep(60.0, 380.0, h)) * 0.5);
              col = mix(col, cliff, cw);
              vec3 wnC = normalize(N + off * mix(0.5, 1.0, step(0.5, qual)));
              wn = normalize(mix(wn, wnC, cw));
            }
            col = srgb2lin(col);
            // ---- canopy: from a distance the crowns shade the ground (individual trees take over up close)
            float canopy = forest * smoothstep(40.0, 420.0, camD);
            // crowns of about 10 m clump into groves of 40 m; gaps between them are dark
            float crown = tnoise(xz * 0.17) * 0.5 + tnoise(xz * 0.41 + 9.0) * 0.3 + tnoise(xz * 0.035 + 2.0) * 0.2;
            float gap = smoothstep(0.3, 0.6, crown);
            vec3 leafA = mix(vec3(0.062, 0.118, 0.03), vec3(0.036, 0.075, 0.04), mk.b); // broadleaf .. conifer
            vec3 canCol = mix(vec3(0.012, 0.026, 0.014), leafA * (0.65 + 0.8 * crown), gap);
            canCol *= 0.85 + 0.3 * tnoise(xz * 0.0045 + 31.0);
            col = mix(col, canCol, canopy * 0.92);
            tCanopyAO = 1.0 - forest * 0.5 * (1.0 - smoothstep(30.0, 600.0, camD) * 0.5);
            // wind gusts rolling over the grass: moving light and dark bands
            float grassW = (1.0 - wRock) * (1.0 - wSand) * (1.0 - wSnow) * (1.0 - cw) * (1.0 - forest * 0.6);
            float g1 = tnoise(xz * 0.021 + vec2(time * 7.0, time * 3.5)), g2 = tnoise(xz * 0.07 + vec2(time * 11.0, time * 5.0));
            float gust = (g1 - 0.5) * 0.7 + (g2 - 0.5) * 0.3;
            col *= 1.0 + gust * 0.38 * grassW * (1.0 - smoothstep(300.0, 2400.0, camD) * 0.6);
            // macro colour variation and wet sand near the waterline
            col *= 0.86 + 0.28 * n2;
            col *= mix(0.62, 1.0, smoothstep(0.5, 4.0, h));
            float rough = mix(0.95, 0.82, wRock) - wSnow * 0.3 - (1.0 - smoothstep(0.5, 3.0, h)) * 0.4;
            // ---- streams
            tEmis = vec3(0.0);
            if (water > 0.01) {
              vec2 e = vec2(12.0, 0.0);
              float gxm = textureLod(forestMask, duv + e.xy / (2.0 * worldHalf), 0.0).g - textureLod(forestMask, duv - e.xy / (2.0 * worldHalf), 0.0).g;
              float gzm = textureLod(forestMask, duv + e.yx / (2.0 * worldHalf), 0.0).g - textureLod(forestMask, duv - e.yx / (2.0 * worldHalf), 0.0).g;
              vec2 across = normalize(vec2(gxm, gzm) + 1e-5);
              vec2 along = vec2(-across.y, across.x);
              along *= sign(dot(along, N.xz) + 1e-4);
              vec2 q = vec2(dot(xz, along), dot(xz, across));
              float t1 = time * 2.2;
              float r0 = tnoise(vec2(q.x * 0.22 - t1 * 0.6, q.y * 0.6)), r1 = tnoise(vec2(q.x * 0.5 - t1 + 4.0, q.y * 1.2 + 8.0));
              float rx = tnoise(vec2(q.x * 0.22 - t1 * 0.6 + 0.3, q.y * 0.6)) - r0, ry = tnoise(vec2(q.x * 0.22 - t1 * 0.6, q.y * 0.6 + 0.3)) - r0;
              float rfade = 1.0 - smoothstep(30.0, 260.0, camD);
              vec3 wnW = normalize(vec3(N.x + ((along.x * rx + across.x * ry) * 0.9 + (r1 - 0.5) * 0.03) * rfade, N.y, N.z + (along.y * rx + across.y * ry) * 0.9 * rfade));
              float depth = 1.0 - smoothstep(0.0, wb, mk.g);
              vec3 wcol = mix(vec3(0.03, 0.09, 0.075), vec3(0.005, 0.03, 0.04), depth);
              float foam = smoothstep(0.55, 0.9, r0 * r1 * 1.8) * (1.0 - depth * 0.7);
              wcol = mix(wcol, vec3(0.5, 0.55, 0.55), foam * 0.35);
              col = mix(col, wcol, water);
              wn = normalize(mix(wn, wnW, water));
              rough = mix(rough, mix(0.34, 0.11, rfade) + foam * 0.4 * rfade, water);
            }
            // glittering snow
            if (wSnow > 0.3 && camD < 260.0) {
              vec2 cell = floor(xz * 7.0);
              float sp = step(0.985, th(cell)) * (1.0 - smoothstep(60.0, 260.0, camD));
              vec3 vd = normalize(cameraPosition - vWPos);
              float flick = pow(max(0.0, dot(normalize(vec3(th(cell + 3.0) - 0.5, 1.0, th(cell + 9.0) - 0.5)), normalize(vd + vec3(0.5543, 0.7418, 0.3775)))), 60.0);
              tEmis = vec3(1.0, 0.97, 0.9) * sp * flick * 2.5 * wSnow;
            }
            tAlbedo = col;
            tNormal = wn;
            tRough = rough;
            tData = texture2D(terrainData, duv);
            diffuseColor.rgb *= tAlbedo;
          }`,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
        .replace(
          '#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(tNormal, 0.0)).xyz);',
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += tEmis;')
        .replace(
          '#include <aomap_fragment>',
          /* glsl */ `#include <aomap_fragment>
          {
            float lit = smoothstep(-18.0, 10.0, vWPos.y - tData.g);
            reflectedLight.directDiffuse *= lit;
            reflectedLight.directSpecular *= lit;
            float ao = mix(1.0, tData.b, 0.85) * tCanopyAO;
            reflectedLight.indirectDiffuse *= ao;
            reflectedLight.indirectSpecular *= ao;
            reflectedLight.directDiffuse *= mix(1.0, tCanopyAO, 0.6);
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'terrain-v3';
    return mat;
  }
}

// Load the terrain layers into two texture arrays (albedo and normal).
export async function loadTerrainTextures(base) {
  const names = ['grass', 'rock', 'sand', 'snow', 'cliff', 'world_cliffb', 'world_forest'];
  const size = 1024;
  const load = (url) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const build = async (kind) => {
    const data = new Uint8Array(size * size * 4 * names.length);
    const imgs = await Promise.all(names.map((n) => load(`${base}${n}_${kind}.jpg`)));
    imgs.forEach((img, i) => {
      ctx.drawImage(img, 0, 0, size, size);
      data.set(ctx.getImageData(0, 0, size, size).data, i * size * size * 4);
    });
    const tex = new THREE.DataArrayTexture(data, size, size, names.length);
    tex.format = THREE.RGBAFormat;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  };
  const [albedo, normal] = await Promise.all([build('albedo'), build('normal')]);
  return { albedo, normal };
}
