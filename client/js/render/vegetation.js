// Forests. Trees, shrubs and palms are instanced from three detail levels that cross-dissolve with distance:
//   L0  fir / pine / oak / birch / palm / shrub meshes (300-740 triangles) within ~150 m, with wind, a
//       nibbled leaf silhouette and back-lit foliage,
//   L1  60-210 triangle versions out to ~800 m, thinned with distance (the rest of the canopy is the terrain
//       shader's forest tint), and
//   L2  20-30 triangle cones and blobs out to ~2.8 km.
// Placement comes from the terrain worker one 800 m block at a time (flora-model.js). Every instance carries a
// rank, so thinning and level changes happen per instance in the vertex shader (a screen-door dissolve instead
// of pops) and the CPU only decides which 100 / 400 / 800 m cells to draw. Trees take the baked mountain
// shadows, the sun's height fog and the scene's image-based light like the terrain does.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WORLD } from '../../../shared/constants.js';
import { SPECIES, BLOCK } from './flora-model.js';
import { bakeImpostors, createImpostorMaterial, impostorQuad } from './impostors.js';

const TREE_H = { fir: 26, pine: 28, oak: 16, birch: 17, palm: 10, shrub: 2 };
const QUALITY = [
  // l0 radius, l1 radius, l2 radius, shrubs
  // q0: no full meshes (the 84-190 triangle versions are the nearest level), half the trees, no shrubs, no
  // leaf cut-outs and no MSAA, so alpha tests with a dither instead of alpha-to-coverage
  { d0: 0, d1: 170, d2: 1500, shrubs: false, density: 0.5, msaa: false },
  // q1 / q2: full meshes up close, octahedral impostors (impostors.js) from d0 out to d2
  { d0: 95, d1: 500, d2: 3000, shrubs: true, density: 1, msaa: true },
  { d0: 140, d1: 700, d2: 3800, shrubs: true, density: 1, msaa: true },
];
const STRIDE = 8;

// Procedural foliage cut-outs, drawn once at load: oak-like leaves and fir/pine needle sprigs on transparent
// canvases, tiling, multiplied into the vertex colour and alpha-tested with sharpened alpha-to-coverage.
function foliageTextures() {
  const S = 256;
  const make = (draw) => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    draw(g);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const wrap = (g, x, y, fn) => {
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      if (x + dx < -40 || x + dx > S + 40 || y + dy < -40 || y + dy > S + 40) continue;
      g.save();
      g.translate(x + dx, y + dy);
      fn();
      g.restore();
    }
  };
  const leaf = make((g) => {
    for (let layer = 0; layer < 2; layer++) {
      const n = layer ? 120 : 90;
      for (let i = 0; i < n; i++) {
        const x = rnd() * S, y = rnd() * S, a = rnd() * 6.283, L = 15 + rnd() * 10, W = L * (0.38 + rnd() * 0.12);
        const lum = layer ? 85 + rnd() * 50 : 150 + rnd() * 105;
        wrap(g, x, y, () => {
          g.rotate(a);
          const gr = g.createLinearGradient(-L / 2, 0, L / 2, 0);
          gr.addColorStop(0, `rgb(${lum * 0.8},${lum * 0.95},${lum * 0.6})`);
          gr.addColorStop(1, `rgb(${lum},${Math.min(255, lum * 1.08)},${lum * 0.72})`);
          g.fillStyle = gr;
          g.beginPath();
          g.moveTo(-L / 2, 0);
          g.quadraticCurveTo(0, -W, L / 2, 0);
          g.quadraticCurveTo(0, W, -L / 2, 0);
          g.fill();
          g.strokeStyle = `rgba(255,255,230,0.35)`;
          g.lineWidth = 0.8;
          g.beginPath();
          g.moveTo(-L / 2, 0);
          g.lineTo(L / 2 * 0.8, 0);
          g.stroke();
        });
      }
    }
  });
  const needle = make((g) => {
    for (let layer = 0; layer < 2; layer++) {
      const n = layer ? 110 : 100;
      for (let i = 0; i < n; i++) {
        const x = rnd() * S, y = rnd() * S, a = rnd() * 6.283, L = 22 + rnd() * 16;
        const lum = layer ? 80 + rnd() * 50 : 140 + rnd() * 110;
        wrap(g, x, y, () => {
          g.rotate(a);
          g.strokeStyle = `rgb(${lum * 0.75},${lum * 0.9},${lum * 0.7})`;
          g.lineWidth = 2.2;
          g.beginPath();
          g.moveTo(0, 0);
          g.lineTo(L, 0);
          g.stroke();
          g.lineWidth = 1.7;
          for (let k = 1; k < 13; k++) {
            const u = (k / 13) * L, nl = 8.5 * (1 - 0.5 * k / 13);
            for (const sg of [-1, 1]) {
              g.beginPath();
              g.moveTo(u, 0);
              g.lineTo(u + nl * 0.6, sg * nl);
              g.stroke();
            }
          }
        });
      }
    }
  });
  return { leaf, needle };
}
const HALF = WORLD.terrainHalf;
const NB = (HALF * 2) / BLOCK;

const VERT_DECL = /* glsl */ `
attribute vec4 aInst;
attribute vec4 aInst2;
attribute vec4 aCol;
uniform float uTime;
uniform vec4 uLod;
uniform float uWorldHalf;
uniform float uTreeH;
uniform float uWind;
uniform sampler2D uTerrainData;
varying vec4 vCol;
varying float vFade;
varying float vLit;
varying vec3 vOP;
varying vec2 vUvE;
varying float vTint;
`;

function patchMaterial(mat, shared, own, tier) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, own);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        float yawA = aInst2.x;
        float csY = cos(yawA), snY = sin(yawA);
        float fadeV = 1.0;
        vec3 objectNormal = vec3(csY * normal.x + snY * normal.z, normal.y, -snY * normal.x + csY * normal.z);`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed;
        {
          float dist = distance(aInst.xyz, cameraPosition);
          float rank = aInst2.y;
          float boost = 1.0;
          #if TIER == 0
            fadeV = (1.0 - smoothstep(uLod.x - 14.0, uLod.x + 4.0, dist)) * (1.0 - step(uLod.w, rank));
          #elif TIER == 1
            float fi = smoothstep(uLod.x - 14.0, uLod.x + 4.0, dist);
            float t1 = smoothstep(uLod.x, uLod.y, dist);
            float keep = min(uLod.w, mix(1.0, 0.6, t1));
            fadeV = fi * (1.0 - smoothstep(keep - 0.03, keep, rank)) * (1.0 - smoothstep(uLod.y - 100.0, uLod.y, dist));
            boost = mix(1.0, 1.12, t1);
          #else
            float fi = smoothstep(uLod.y - 100.0, uLod.y, dist);
            float t2 = smoothstep(uLod.y, uLod.z, dist);
            float keep = min(uLod.w, mix(0.6, 0.04, pow(t2, 0.45)));
            fadeV = fi * (1.0 - smoothstep(keep - 0.02, keep, rank)) * (1.0 - smoothstep(uLod.z * 0.82, uLod.z, dist));
            boost = mix(1.12, 2.4, pow(t2, 0.7));
          #endif
          vFade = fadeV;
          boost *= mix(1.3, 1.0, uLod.w);
          float sc = aInst.w * boost;
          vec3 p = position;
          p.xz *= 0.8 + 0.45 * aInst2.w;
          vec3 pr = vec3(csY * p.x + snY * p.z, p.y, -snY * p.x + csY * p.z) * sc;
          #ifdef SWAY
            float flex = pow(clamp(position.y / uTreeH, 0.0, 1.0), 1.7);
            vec2 wd = vec2(0.87, 0.49);
            float ph = dot(aInst.xz, wd) * 0.035 - uTime * 1.3;
            float gust = 0.6 + 0.4 * sin(ph) + 0.25 * sin(ph * 2.7 + 1.3);
            float amp = flex * uWind * gust * sc;
            pr.xz += wd * amp;
            pr.y -= amp * amp * 0.03;
            float fl = 0.05 * flex * (1.0 - uv.y) * uWind * sc;
            pr += vec3(sin(uTime * 3.7 + position.x * 1.7 + aInst.x), 0.5 * sin(uTime * 2.9 + position.z * 1.9 + aInst.z), cos(uTime * 3.3 + position.y * 1.3 + aInst.z)) * fl;
          #endif
          transformed = aInst.xyz + pr;
          vec2 tuv = (aInst.xz + uWorldHalf) / (2.0 * uWorldHalf);
          float shY = textureLod(uTerrainData, tuv, 0.0).g;
          vLit = smoothstep(-18.0, 10.0, transformed.y - shY);
          vCol = aCol;
          vOP = position;
          vUvE = uv;
          vTint = aInst2.z;
        }`,
      )
      .replace('#include <project_vertex>', '#include <project_vertex>\nif (fadeV < 0.004) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform sampler2D uFoliage;
        uniform float uLeafScale;
        float leafA = 1.0;
        varying vec4 vCol;
        varying float vFade;
        varying float vLit;
        varying vec3 vOP;
        varying vec2 vUvE;
        varying float vTint;
        float bayer4(vec2 p) {
          int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
          const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
          return (m[y * 4 + x] + 0.5) / 16.0;
        }
        float vh(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float vn3(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(vh(i), vh(i + vec3(1, 0, 0)), f.x), mix(vh(i + vec3(0, 1, 0)), vh(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(vh(i + vec3(0, 0, 1)), vh(i + vec3(1, 0, 1)), f.x), mix(vh(i + vec3(0, 1, 1)), vh(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          float trunk = step(0.5, vUvE.y);
          #ifdef FROND
            if (vUvE.x >= 2.0) {
              float s = vUvE.x - 2.0, t = abs(vUvE.y * 2.0 - 1.0);
              float tooth = abs(fract(s * 24.0 - t * 2.3) - 0.5) * 2.0;
              if (t > 0.09 && tooth > (1.0 - t) * 0.85 + 0.3) discard;
            }
          #endif
          #ifdef LEAF
            if (trunk < 0.5) {
              // leaf / needle cut-outs; holes open toward the silhouette and the outer edge of each skirt or clump
              vec3 fn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
              float sil = 1.0 - abs(dot(fn, normalize(vViewPosition)));
              vec2 fuv = vec2(vOP.x + vOP.z * 0.7, vOP.y + vOP.z * 0.45) * uLeafScale;
              vec4 lt = texture(uFoliage, fuv);
              float thr = LEAFTHR + pow(sil, 2.0) * 0.32 + vUvE.x * 0.16;
              float aa = max(fwidth(lt.a), 0.015);
              leafA = clamp((lt.a - thr) / aa + 0.5, 0.0, 1.0);
              diffuseColor.rgb *= 0.55 + 0.9 * lt.rgb;
            }
          #endif
          vec3 tint = mix(vec3(0.72, 0.88, 0.64), vec3(1.3, 1.08, 0.74), vTint);
          #if TIER == 2
            tint *= 0.85 + 0.3 * fract(vTint * 7.31);
          #endif
          vec3 base = vCol.rgb * mix(tint, vec3(1.0), trunk);
          #if TIER < 2
            base *= mix(0.84 + 0.32 * vn3(vOP * NFREQ + 3.0), 1.0, trunk);
          #endif
          diffuseColor.rgb *= base;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        #if TIER < 2
        {
          // lumpy crowns: object-space noise tilts the normal (rotated to view space so it stays put on the tree)
          vec3 q = vOP * NFREQ * 1.4;
          vec3 pert = vec3(vn3(q), vn3(q + 7.3), vn3(q + 13.1)) - 0.5;
          normal = normalize(normal + (viewMatrix * vec4(pert, 0.0)).xyz * 1.1 * (1.0 - step(0.5, vUvE.y)));
        }
        #endif`,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        #ifdef A2C
          gl_FragColor = vec4(outgoingLight, clamp(vFade, 0.0, 1.0) * leafA);
        #else
          if (leafA < 0.5 || vFade < bayer4(gl_FragCoord.xy)) discard;
          gl_FragColor = vec4(outgoingLight, 1.0);
        #endif`,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
        {
          float ao = vCol.a;
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.indirectSpecular *= ao;
          reflectedLight.directDiffuse *= mix(0.4, 1.0, ao) * vLit * mix(1.3, 1.0, step(0.5, vUvE.y));
          reflectedLight.directSpecular *= vLit;
          #if NUM_DIR_LIGHTS > 0
            // light shining through thin foliage toward the camera
            vec3 Ls = directionalLights[0].direction;
            float tr = pow(clamp(dot(Ls, -normalize(vViewPosition)), 0.0, 1.0), 2.5) * (1.0 - step(0.5, vUvE.y));
            reflectedLight.directDiffuse += directionalLights[0].color * tr * RECIPROCAL_PI * diffuseColor.rgb * vec3(1.0, 1.0, 0.55) * 0.75 * ao * vLit;
          #endif
        }`,
      );
  };
  mat.customProgramCacheKey = () => `tree-v1-${tier}-${mat.userData.kind}`;
}

export class Vegetation {
  constructor(scene, workerUrl, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    scene.add(this.group);
    this.workerUrl = workerUrl;
    this.blocks = new Array(NB * NB).fill(null); // null = not requested, 'pending', 'empty' or a block
    this.pending = 0;
    this.q = QUALITY[1];
    this.shared = {
      uTime: { value: 0 },
      uLod: { value: new THREE.Vector4(this.q.d0, this.q.d1, this.q.d2, this.q.density) },
      uWorldHalf: { value: HALF },
      uWind: { value: 1 },
      uTerrainData: { value: new THREE.DataTexture(new Float32Array([0, -1000, 1, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType) },
    };
    this.shared.uTerrainData.value.needsUpdate = true;
    this.units = new Map(); // key -> { mesh, in: bool }
    this.live = new Set();
    this.onBlock = null;
    this.stats = { l0: 0, l1: 0, l2: 0, instances: 0, drawCalls: 0 };
  }

  async load(base) {
    const gltf = await new GLTFLoader().loadAsync(`${base}world_trees.glb`);
    this.templates = {};
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      g.setAttribute('aCol', g.getAttribute('color'));
      g.deleteAttribute('color');
      this.templates[o.name] = g;
    });
    this.foliage = foliageTextures();
    this.materials = {};
    for (const sp of SPECIES) {
      for (let tier = 0; tier < 3; tier++) {
        if (tier === 2 && (sp === 'palm' || sp === 'shrub')) continue;
        const palm = sp === 'palm';
        const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: palm ? THREE.DoubleSide : THREE.FrontSide });
        mat.defines = { TIER: tier, NFREQ: tier === 0 ? '1.6' : '0.45', LEAFTHR: tier === 0 ? '0.3' : '0.27' };
        if (tier === 0) mat.defines.SWAY = '';
        if (palm) {
          mat.defines.FROND = '';
          mat.defines.SWAY = '';
        } else if (tier < 2) { mat.defines.LEAF = ''; mat.userData.leafy = true; }
        mat.userData.tier = tier;
        mat.userData.kind = `${palm ? 'p' : 'f'}`;
        const conifer = sp === 'fir' || sp === 'pine';
        const own = {
          uTreeH: { value: TREE_H[sp] },
          uFoliage: { value: conifer ? this.foliage.needle : this.foliage.leaf },
          uLeafScale: { value: (conifer ? 0.85 : 0.7) * (tier === 0 ? 1 : 0.28) },
        };
        patchMaterial(mat, this.shared, own, tier);
        this.materials[`${sp}${tier}`] = mat;
      }
    }
    this.applyMaterialMode();
  }

  setTerrainData(tex) {
    this.shared.uTerrainData.value = tex;
  }

  // fixed instance sets (the sky islands' groves): lists = { fir, pine, oak, birch, shrub } of
  // [x, y, z, scale, yaw, rank, tint, aspect] rows sorted by rank. They use the same three detail levels.
  addStatic(lists) {
    this.staticLists = lists;
    this.staticLow = this.staticLow || [];
    const pack = (rows) => {
      const a = new Float32Array(rows.length * STRIDE);
      rows.forEach((r, i) => a.set(r, i * STRIDE));
      return a;
    };
    for (const sp of ['fir', 'pine', 'oak', 'birch', 'shrub']) {
      const rows = lists[sp];
      if (!rows || !rows.length) continue;
      const data = pack(rows);
      const tiers = [0, 1, 2].filter((t) => this.materials[`${sp}${t}`] && !(t === 1 && sp === 'shrub'));
      for (const t of tiers) {
        const tmpl = this.templates[`${sp === 'pine' && t === 2 ? 'pine' : sp}_${['hi', 'lo', 'far'][t]}`];
        if (!tmpl) continue;
        const mesh = this.makeUnit(`static:${sp}:${t}`, tmpl, this.materials[`${sp}${t}`], data, t === 0 ? 12 : 30);
        if (mesh) {
          this.group.add(mesh);
          if (t > 0 && sp !== 'shrub') this.staticLow.push(mesh);
        }
      }
    }
    if (this.imp) this.buildStaticImpostors();
    this.applyStaticMode();
  }

  // per-tier material switches: alpha-to-coverage needs MSAA, leaf cut-outs are skipped at q0
  applyMaterialMode() {
    if (!this.materials) return;
    for (const m of [...Object.values(this.materials), ...(this.impMats || [])]) {
      if (m.userData.impostor) continue; // always alpha-to-coverage: only built when MSAA is on
      const had = [m.alphaToCoverage, 'A2C' in m.defines, 'LEAF' in m.defines].join();
      m.alphaToCoverage = this.q.msaa;
      if (this.q.msaa) m.defines.A2C = '';
      else delete m.defines.A2C;
      if (m.userData.tier === 0 || this.q.msaa) {
        if (m.userData.leafy) m.defines.LEAF = '';
      } else delete m.defines.LEAF;
      if ([m.alphaToCoverage, 'A2C' in m.defines, 'LEAF' in m.defines].join() !== had) m.needsUpdate = true;
    }
  }

  setQuality(q) {
    this.q = QUALITY[Math.max(0, Math.min(2, q))];
    this.shared.uLod.value.set(this.q.d0, this.q.d1, this.q.d2, this.q.density);
    if (this.q.msaa && !this.imp && this.templates && this.renderer) this.bakeAtlas();
    this.applyMaterialMode();
    this.applyStaticMode();
    for (const k of [...this.live]) this.hide(k);
  }

  // octahedral impostor atlas (once, the first time a quality with impostors is chosen)
  bakeAtlas() {
    const t0 = performance.now();
    this.imp = bakeImpostors(this.renderer, this.templates, this.foliage);
    this.quad = impostorQuad();
    this.impMats = [createImpostorMaterial(1, this.shared, this.imp), createImpostorMaterial(2, this.shared, this.imp)];
    this.stats.bakeMs = Math.round(performance.now() - t0);
    for (const b of this.blocks) if (b && typeof b === 'object') this.buildImpLists(b);
    if (this.staticLists) this.buildStaticImpostors();
  }

  // impostor instance lists for a block: species merged, species index in the integer part of aInst2.w
  buildImpLists(b) {
    const near = [];
    for (let q = 0; q < 4; q++) {
      let n = 0;
      for (let si = 0; si < 4; si++) {
        const sp = b.species[si];
        if (sp) n += sp.l1off[q + 1] - sp.l1off[q];
      }
      const out = new Float32Array(n * STRIDE);
      let o = 0;
      for (let si = 0; si < 4; si++) {
        const sp = b.species[si];
        if (!sp) continue;
        const a = sp.l1off[q] * STRIDE, e = sp.l1off[q + 1] * STRIDE;
        out.set(sp.l1.subarray(a, e), o);
        for (let k = o; k < o + (e - a); k += STRIDE) out[k + 7] = si + Math.min(0.98, out[k + 7]);
        o += e - a;
      }
      near.push(out);
    }
    let n = 0;
    for (let si = 0; si < 4; si++) if (b.species[si]) n += b.species[si].l2.length;
    const far = new Float32Array(n);
    let o = 0;
    for (let si = 0; si < 4; si++) {
      const sp = b.species[si];
      if (!sp) continue;
      far.set(sp.l2, o);
      for (let k = o; k < o + sp.l2.length; k += STRIDE) far[k + 7] = si + Math.min(0.98, far[k + 7]);
      o += sp.l2.length;
    }
    b.impNear = near;
    b.impFar = far;
  }

  // the sky islands' groves: full meshes up close, the old low-poly levels at q0, impostors at q1+
  buildStaticImpostors() {
    if (this.staticImp || !this.imp) return;
    const rows = [];
    for (const sp of ['fir', 'pine', 'oak', 'birch']) for (const r of this.staticLists[sp] || []) rows.push([r, SPECIES.indexOf(sp)]);
    this.staticImp = [];
    if (!rows.length) return;
    const data = new Float32Array(rows.length * STRIDE);
    rows.forEach(([r, si], i) => {
      data.set(r, i * STRIDE);
      data[i * STRIDE + 7] = si + Math.min(0.98, r[7]);
    });
    for (let t = 1; t <= 2; t++) {
      const m = this.makeUnit(`static:imp:${t}`, this.quad, this.impMats[t - 1], data, 30);
      if (m) {
        m.visible = false;
        this.group.add(m);
        this.staticImp.push(m);
      }
    }
  }

  applyStaticMode() {
    const useImp = !!(this.q.msaa && this.imp);
    for (const m of this.staticLow || []) m.visible = !useImp;
    for (const m of this.staticImp || []) m.visible = useImp;
  }

  // ----------------------------------------------------------------------------------------------- blocks
  requestBlocks(cam) {
    while (this.pending < 2 && this.requestOne(cam)) {}
  }

  requestOne(cam) {
    if (this.pending >= 2) return false;
    const reach = this.q.d2 + 500;
    let best = -1, bestD = Infinity;
    for (let j = 0; j < NB; j++) {
      for (let i = 0; i < NB; i++) {
        const k = j * NB + i;
        if (this.blocks[k]) continue;
        const x0 = -HALF + i * BLOCK, z0 = -HALF + j * BLOCK;
        if (Math.abs(x0 + BLOCK / 2) > HALF || Math.abs(z0 + BLOCK / 2) > HALF) continue;
        const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + BLOCK)), dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + BLOCK));
        const d = Math.hypot(dx, dz);
        if (d < reach && d < bestD) { bestD = d; best = k; }
      }
    }
    if (best < 0) return false;
    if (!this.worker) {
      this.worker = new Worker(this.workerUrl, { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
    }
    this.blocks[best] = 'pending';
    this.pending++;
    const i = best % NB, j = (best / NB) | 0;
    this.worker.postMessage({ type: 'flora', key: best, x0: -HALF + i * BLOCK, z0: -HALF + j * BLOCK });
    return true;
  }

  onMessage(m) {
    if (m.type !== 'flora') return;
    this.pending--;
    if (this.lastCam) this.requestBlocks(this.lastCam);
    const b = m.block;
    const any = b.species.some(Boolean) || b.rocks.length;
    if (!any) {
      this.blocks[m.key] = 'empty';
      return;
    }
    b.key = m.key;
    b.far = this.farLists(b);
    if (this.imp) this.buildImpLists(b);
    this.blocks[m.key] = b;
    for (const s of b.species) if (s) this.stats.instances += s.l0.length / STRIDE;
    if (this.onBlock) this.onBlock(b);
  }

  // L2 data per block: cones (fir + pine) and blobs (oak + birch) merged
  farLists(b) {
    const join = (a, c) => {
      const la = a ? a.l2 : new Float32Array(0), lc = c ? c.l2 : new Float32Array(0);
      const out = new Float32Array(la.length + lc.length);
      out.set(la, 0);
      out.set(lc, la.length);
      return out;
    };
    return [join(b.species[0], b.species[1]), join(b.species[2], b.species[3])];
  }

  // ----------------------------------------------------------------------------------------------- units
  makeUnit(key, template, material, data, tierRadius) {
    const count = data.length / STRIDE;
    if (!count) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.index = template.index;
    for (const n of ['position', 'normal', 'uv', 'aCol']) g.setAttribute(n, template.getAttribute(n));
    const ib = new THREE.InstancedInterleavedBuffer(data, STRIDE, 1);
    g.setAttribute('aInst', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    g.setAttribute('aInst2', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    g.instanceCount = count;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = data[i * STRIDE], y = data[i * STRIDE + 1], z = data[i * STRIDE + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const pad = tierRadius;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0 - pad, y0 - 3, z0 - pad), new THREE.Vector3(x1 + pad, y1 + pad * 3, z1 + pad));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = true;
    mesh.userData.tris = count * (template.index.count / 3);
    mesh.userData.center = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    mesh.userData.box = [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
    return mesh;
  }

  show(key, make) {
    let u = this.units.get(key);
    if (u === undefined) {
      u = make() || null;
      this.units.set(key, u);
    }
    if (u && !this.live.has(key)) {
      this.group.add(u);
      this.live.add(key);
    }
  }

  hide(key) {
    if (!this.live.has(key)) return;
    this.group.remove(this.units.get(key));
    this.live.delete(key);
  }

  update(camera, t) {
    this.shared.uTime.value = t;
    const cam = camera.position;
    this.lastCam = cam;
    this.requestBlocks(cam);
    const { d0, d1, d2 } = this.q;
    const want = this._want || (this._want = new Set());
    want.clear();
    const bi0 = Math.max(0, Math.floor((cam.x - d2 - 300 + HALF) / BLOCK)), bi1 = Math.min(NB - 1, Math.floor((cam.x + d2 + 300 + HALF) / BLOCK));
    const bj0 = Math.max(0, Math.floor((cam.z - d2 - 300 + HALF) / BLOCK)), bj1 = Math.min(NB - 1, Math.floor((cam.z + d2 + 300 + HALF) / BLOCK));
    const dist2Box = (x0, z0, x1, z1, yLo, yHi) => {
      const dx = Math.max(x0 - cam.x, 0, cam.x - x1), dz = Math.max(z0 - cam.z, 0, cam.z - z1);
      return Math.hypot(dx, dz, Math.max(yLo - 4 - cam.y, 0, cam.y - (yHi + 30)));
    };
    for (let bj = bj0; bj <= bj1; bj++) {
      for (let bi = bi0; bi <= bi1; bi++) {
        const b = this.blocks[bj * NB + bi];
        if (!b || typeof b === 'string') continue;
        const bx = b.bx0, bz = b.bz0;
        const db = dist2Box(bx, bz, bx + BLOCK, bz + BLOCK, b.ymin, b.ymax);
        if (db > d2 + 150) continue;
        const useImp = this.q.msaa && this.imp && b.impNear;
        // far level: one impostor unit per block, or at q0 cones (fir, pine) and blobs (oak, birch)
        if (useImp) {
          const key = `i2:${b.key}`;
          if (db < d2 + 50 && b.impFar.length) {
            this.show(key, () => this.makeUnit(key, this.quad, this.impMats[1], b.impFar, 30));
            want.add(key);
          }
        } else {
          for (let ty = 0; ty < 2; ty++) {
            const key = `2:${b.key}:${ty}`;
            if (db < d2 + 50 && b.far[ty].length) {
              this.show(key, () => this.makeUnit(key, this.templates[ty ? 'oak_far' : 'fir_far'], this.materials[ty ? 'oak2' : 'fir2'], b.far[ty], 40));
              want.add(key);
            }
          }
        }
        // mid level: impostors per 400 m quadrant (all four tree species in one draw), or low-poly meshes at q0
        // (palms keep their small mesh either way)
        if (db < d1 + 100) {
          for (let q = 0; q < 4; q++) {
            const qx = bx + (q & 1) * 400, qz = bz + (q >> 1) * 400;
            if (useImp && b.impNear[q].length) {
              if (dist2Box(qx, qz, qx + 400, qz + 400, b.ymin, b.ymax) <= d1 + 60) {
                const key = `i1:${b.key}:${q}`;
                this.show(key, () => this.makeUnit(key, this.quad, this.impMats[0], b.impNear[q], 30));
                want.add(key);
              }
            }
            for (let si = useImp ? 4 : 0; si < 5; si++) {
              const s = b.species[si];
              if (!s) continue;
              const a = s.l1off[q], e = s.l1off[q + 1];
              if (e <= a) continue;
              if (dist2Box(qx, qz, qx + 400, qz + 400, s.l1y[q * 2], s.l1y[q * 2 + 1]) > d1 + 60) continue;
              const key = `1:${b.key}:${si}:${q}`;
              this.show(key, () => this.makeUnit(key, this.templates[`${SPECIES[si]}_lo`], this.materials[`${SPECIES[si]}1`], s.l1.subarray(a * STRIDE, e * STRIDE), 30));
              want.add(key);
            }
          }
        }
        // L0 100 m cells
        if (d0 > 0 && db < d0 + 60) {
          for (let c = 0; c < 64; c++) {
            const cx = bx + (c & 7) * 100, cz = bz + (c >> 3) * 100;
            for (let si = 0; si < SPECIES.length; si++) {
              const s = b.species[si];
              if (!s || (si === 5 && !this.q.shrubs)) continue;
              const a = s.l0off[c], e = s.l0off[c + 1];
              if (e <= a) continue;
              if (dist2Box(cx, cz, cx + 100, cz + 100, s.l0y[c * 2], s.l0y[c * 2 + 1]) > d0 + 20) continue;
              const key = `0:${b.key}:${si}:${c}`;
              this.show(key, () => this.makeUnit(key, this.templates[`${SPECIES[si]}_hi`], this.materials[`${SPECIES[si]}0`], s.l0.subarray(a * STRIDE, e * STRIDE), 12));
              want.add(key);
            }
          }
        }
      }
    }
    let l0 = 0, l1 = 0, l2 = 0, tris = 0;
    for (const k of this.live) {
      if (!want.has(k)) (this._drop || (this._drop = [])).push(k);
      else {
        tris += this.units.get(k).userData.tris;
        if (k[0] === '0') l0++;
        else if (k[0] === '1' || k.startsWith('i1')) l1++;
        else l2++;
      }
    }
    if (this._drop && this._drop.length) {
      for (const k of this._drop) this.hide(k);
      this._drop.length = 0;
    }
    this.stats.l0 = l0; this.stats.l1 = l1; this.stats.l2 = l2; this.stats.triBound = Math.round(tris);
  }
}
