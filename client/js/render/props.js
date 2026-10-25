// Rocks and landmarks: boulders scattered on slopes, canyon floors and beaches (merged per 200 m cell while you
// are close), sea stacks along the coasts, and the ruined forts, temples and watchtowers on their levelled
// platforms (layouts and colliders live in shared/world.js). All of it uses the terrain's rock textures (or the
// cut-stone texture for ruins) projected triplanar, bakes occlusion into vertex colour and takes the mountain
// shadows and height fog like everything else.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WORLD } from '../../../shared/constants.js';

const HALF = WORLD.terrainHalf;
const STRIDE = 8;
const RANGE = [260, 480, 700]; // rock draw distance by quality

function propMaterial(kind, textures, shared, extra = {}) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.9 });
  mat.defines = { [kind]: '', ...extra };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, {
      albedoArr: { value: textures.albedo },
      normalArr: { value: textures.normal },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aCol;\nvarying vec3 vWPos;\nvarying vec3 vWN;\nvarying vec4 vCol;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * normal);\nvCol = aCol;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray albedoArr;
        uniform sampler2DArray normalArr;
        uniform sampler2D uStone;
        uniform sampler2D uStoneN;
        uniform sampler2D uTerrainData;
        uniform float uWorldHalf;
        varying vec3 vWPos;
        varying vec3 vWN;
        varying vec4 vCol;
        float ph(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float pn(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(ph(i), ph(i + vec3(1, 0, 0)), f.x), mix(ph(i + vec3(0, 1, 0)), ph(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(ph(i + vec3(0, 0, 1)), ph(i + vec3(1, 0, 1)), f.x), mix(ph(i + vec3(0, 1, 1)), ph(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }
        vec3 srgb2lin(vec3 c) { return c * c * (c * 0.305306 + 0.682171) + c * 0.012522; }
        vec3 tAlb; vec3 tWN; float tRough; float tLit;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          vec3 N = normalize(vWN);
          vec3 bw = pow(abs(N), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
          vec3 p = vWPos;
          float h = p.y;
          vec3 c; vec3 off = vec3(0.0);
          #if defined(RUIN)
            float S = 7.5;
            c = texture(uStone, p.zy / S).rgb * bw.x + texture(uStone, p.xy / S).rgb * bw.z + texture(uStone, p.xz / S).rgb * bw.y;
            vec2 nx = texture(uStoneN, p.zy / S).xy * 2.0 - 1.0, nz = texture(uStoneN, p.xy / S).xy * 2.0 - 1.0, ny = texture(uStoneN, p.xz / S).xy * 2.0 - 1.0;
            off = vec3(0.0, nx.y, nx.x) * bw.x + vec3(nz.x, nz.y, 0.0) * bw.z + vec3(ny.x, 0.0, ny.y) * bw.y;
            c = srgb2lin(c) * vCol.rgb * 1.3;
            // weathering: dark streaks below the top edges and moss in the damp low corners
            float streak = pn(vec3(p.x * 0.6 + p.z * 0.6, p.y * 0.12, 3.0));
            c *= 0.8 + 0.35 * streak;
            float moss = smoothstep(0.55, 0.9, pn(p * 0.35 + 5.0)) * smoothstep(0.2, 0.9, N.y);
            c = mix(c, vec3(0.045, 0.09, 0.03), moss * 0.55);
            tRough = 0.88;
          #elif defined(BONE)
            float S = 5.0;
            c = texture(albedoArr, vec3(p.zy / S, 1.0)).rgb * bw.x + texture(albedoArr, vec3(p.xy / S, 1.0)).rgb * bw.z + texture(albedoArr, vec3(p.xz / S, 1.0)).rgb * bw.y;
            vec2 nx = texture(normalArr, vec3(p.zy / S, 1.0)).xy * 2.0 - 1.0, nz = texture(normalArr, vec3(p.xy / S, 1.0)).xy * 2.0 - 1.0, ny = texture(normalArr, vec3(p.xz / S, 1.0)).xy * 2.0 - 1.0;
            off = vec3(0.0, nx.y, nx.x) * bw.x + vec3(nz.x, nz.y, 0.0) * bw.z + vec3(ny.x, 0.0, ny.y) * bw.y;
            float lb = dot(c, vec3(0.33));
            c = srgb2lin(vec3(lb * 1.25 + 0.2)) * vCol.rgb * 1.15;
            // lichen and dirt where it meets the ground
            c = mix(c, vec3(0.1, 0.12, 0.05), smoothstep(0.55, 0.9, pn(p * 0.4 + 7.0)) * 0.4);
            tRough = 0.82;
          #elif defined(STACK)
            float S1 = 26.0, S2 = 11.0;
            vec3 cA = texture(albedoArr, vec3(p.zy / S1, 5.0)).rgb * bw.x + texture(albedoArr, vec3(p.xy / S1, 5.0)).rgb * bw.z + texture(albedoArr, vec3(p.xz / S1, 5.0)).rgb * bw.y;
            vec3 cB = texture(albedoArr, vec3(p.zy / S2, 4.0)).rgb * bw.x + texture(albedoArr, vec3(p.xy / S2, 4.0)).rgb * bw.z + texture(albedoArr, vec3(p.xz / S2, 4.0)).rgb * bw.y;
            c = mix(cA, cB, 0.4);
            c = mix(vec3(dot(c, vec3(0.33))), c, 0.55);
            float b1 = sin((h + (pn(p * 0.12) - 0.5) * 8.0) * 0.5) * 0.5 + 0.5;
            c = srgb2lin(c) * mix(vec3(0.78, 0.74, 0.7), vec3(1.15, 1.0, 0.85), b1) * vCol.rgb;
            // wet dark band at the waterline, bird-bleached crown, lichen
            float wet = 1.0 - smoothstep(0.0, 7.0, h);
            c *= mix(1.0, 0.4, wet);
            c = mix(c, vec3(0.62, 0.6, 0.55), smoothstep(0.6, 0.95, N.y) * smoothstep(8.0, 40.0, h) * 0.55 * pn(p * 0.4));
            c = mix(c, vec3(0.04, 0.085, 0.03), smoothstep(0.6, 0.9, N.y) * smoothstep(0.62, 0.8, pn(p * 0.25 + 9.0)) * smoothstep(2.0, 12.0, h) * 0.5);
            vec2 nx = texture(normalArr, vec3(p.zy / S2, 4.0)).xy * 2.0 - 1.0, nz = texture(normalArr, vec3(p.xy / S2, 4.0)).xy * 2.0 - 1.0, ny = texture(normalArr, vec3(p.xz / S2, 4.0)).xy * 2.0 - 1.0;
            off = vec3(0.0, nx.y, nx.x) * bw.x + vec3(nz.x, nz.y, 0.0) * bw.z + vec3(ny.x, 0.0, ny.y) * bw.y;
            tRough = mix(0.88, 0.45, wet);
          #else
            float S = 3.4;
            vec3 cA = texture(albedoArr, vec3(p.zy / S, 1.0)).rgb * bw.x + texture(albedoArr, vec3(p.xy / S, 1.0)).rgb * bw.z + texture(albedoArr, vec3(p.xz / S, 1.0)).rgb * bw.y;
            vec3 cB = texture(albedoArr, vec3(p.zy / 8.0, 5.0)).rgb * bw.x + texture(albedoArr, vec3(p.xy / 8.0, 5.0)).rgb * bw.z + texture(albedoArr, vec3(p.xz / 8.0, 5.0)).rgb * bw.y;
            float mixAB = smoothstep(0.35, 0.65, pn(floor(p * 0.05) + 3.7));
            c = srgb2lin(mix(cA, cB, mixAB * 0.7)) * vCol.rgb * 0.85;
            vec2 nx = texture(normalArr, vec3(p.zy / S, 1.0)).xy * 2.0 - 1.0, nz = texture(normalArr, vec3(p.xy / S, 1.0)).xy * 2.0 - 1.0, ny = texture(normalArr, vec3(p.xz / S, 1.0)).xy * 2.0 - 1.0;
            off = vec3(0.0, nx.y, nx.x) * bw.x + vec3(nz.x, nz.y, 0.0) * bw.z + vec3(ny.x, 0.0, ny.y) * bw.y;
            // moss on the sheltered top below the snow line, snow above, wet and dark at the base
            float top = smoothstep(0.55, 0.9, N.y);
            float moss = top * (1.0 - smoothstep(520.0, 820.0, h)) * smoothstep(0.35, 0.7, pn(p * 0.5 + 2.0)) * smoothstep(8.0, 30.0, h);
            c = mix(c, vec3(0.05, 0.1, 0.03), moss * 0.7);
            #ifndef NOSNOW
            c = mix(c, vec3(0.9, 0.93, 1.0) * 0.75, top * smoothstep(860.0, 1000.0, h));
            #endif
            #ifndef NOSNOW
            c *= mix(0.55, 1.0, smoothstep(0.5, 3.0, h));
            #endif
            tRough = 0.9;
          #endif
          tAlb = c;
          tWN = normalize(N + off * 0.9);
          vec2 tuv = (p.xz + uWorldHalf) / (2.0 * uWorldHalf);
          vec4 td = texture2D(uTerrainData, tuv);
          tLit = smoothstep(-18.0, 10.0, p.y - td.g);
          diffuseColor.rgb *= tAlb;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(tWN, 0.0)).xyz);')
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
        {
          float ao = vCol.a;
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.indirectSpecular *= ao;
          reflectedLight.directDiffuse *= mix(0.5, 1.0, ao) * tLit;
          reflectedLight.directSpecular *= tLit;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `prop-v1-${kind}-${Object.keys(extra).join('')}`;
  return mat;
}

function loadTex(url) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export class Props {
  constructor(scene, textures) {
    this.scene = scene;
    this.textures = textures;
    this.group = new THREE.Group();
    this.group.name = 'props';
    scene.add(this.group);
    this.shared = {
      uTime: { value: 0 },
      uTerrainData: { value: new THREE.DataTexture(new Float32Array([0, -1000, 1, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType) },
      uWorldHalf: { value: HALF },
      uStone: { value: null },
      uStoneN: { value: null },
    };
    this.shared.uTerrainData.value.needsUpdate = true;
    this.cells = new Map(); // key -> mesh
    this.range = RANGE[1];
    this.stats = { rockCells: 0, rockTris: 0 };
  }

  async load(base) {
    const loader = new GLTFLoader();
    const [rocks, ruins] = await Promise.all([loader.loadAsync(`${base}world_rocks.glb`), loader.loadAsync(`${base}world_ruins.glb`)]);
    const grab = (gltf) => {
      const out = {};
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry;
        g.setAttribute('aCol', g.getAttribute('color'));
        g.deleteAttribute('color');
        out[o.name] = g;
      });
      return out;
    };
    this.rockGeo = grab(rocks);
    this.ruinGeo = grab(ruins);
    this.shared.uStone.value = loadTex(`${base}world_ruin_albedo.jpg`);
    this.shared.uStone.value.colorSpace = THREE.NoColorSpace;
    this.shared.uStoneN.value = loadTex(`${base}world_ruin_normal.jpg`);
    this.shared.uStoneN.value.colorSpace = THREE.NoColorSpace;
    this.rockMat = propMaterial('ROCK', this.textures, this.shared);
    this.skyRockMat = propMaterial('ROCK', this.textures, this.shared, { NOSNOW: '' });
    this.stackMat = propMaterial('STACK', this.textures, this.shared);
    this.ruinMat = propMaterial('RUIN', this.textures, this.shared);
    this.boneMat = propMaterial('BONE', this.textures, this.shared);
  }

  setTerrainData(tex) {
    this.shared.uTerrainData.value = tex;
  }

  mergeParts(parts) {
    return mergeParts(parts);
  }

  setQuality(q) {
    this.range = RANGE[Math.max(0, Math.min(2, q))];
    for (const [k, m] of this.cells) this.drop(k, m);
  }

  // ---------------------------------------------------------------------------------------------- landmarks
  buildLandmarks(world) {
    const names = Object.keys(this.rockGeo).filter((n) => n.startsWith('stack'));
    // sea stacks: all merged into one mesh
    const parts = [];
    for (const s of world.stacks) {
      const g = this.rockGeo[names[s.seed % names.length]];
      // land spires stand on slopes: sink the foot below the lowest ground under it
      const base = s.land
        ? Math.min(world.heightRaw(s.x, s.z), world.heightRaw(s.x + s.r, s.z), world.heightRaw(s.x - s.r, s.z), world.heightRaw(s.x, s.z + s.r), world.heightRaw(s.x, s.z - s.r)) - 6
        : world.heightRaw(s.x, s.z) - 3;
      const asp = 0.8 + 0.5 * ((s.seed >> 3) % 100) / 100;
      parts.push({ g, x: s.x, y: base, z: s.z, sx: s.r * 1.08 * asp, sy: Math.max(8, s.top - base), sz: s.r * 1.08 / asp, yaw: (s.seed % 628) / 100 });
    }
    if (parts.length) {
      const m = new THREE.Mesh(mergeParts(parts), this.stackMat);
      m.frustumCulled = true;
      this.group.add(m);
      this.stackMesh = m;
      this.group.add(this.stackFoam(world.stacks.filter((s) => !s.land)));
    }
    // rock rings: lumpy tori on the same rock as the stacks, one merged mesh
    if (world.arches && world.arches.length) {
      const m = new THREE.Mesh(mergeGeos(world.arches.map((a) => archGeometry(a))), this.stackMat);
      m.frustumCulled = true;
      this.group.add(m);
      this.archMesh = m;
    }
    // ruins: one mesh per site
    this.siteMeshes = [];
    for (const site of world.sites) {
      const pp = [], bp = [];
      for (const pc of site.pieces) {
        const name = pieceName(pc);
        const g = this.ruinGeo[name];
        if (!g) continue;
        (/^(rib|spine|tail|skull)/.test(name) ? bp : pp).push({ g, x: pc.wx, y: site.y, z: pc.wz, sx: pc.s, sy: pc.s, sz: pc.s, yaw: -pc.wyaw });
      }
      for (const [parts, material] of [[pp, this.ruinMat], [bp, this.boneMat]]) {
        if (!parts.length) continue;
        const m = new THREE.Mesh(mergeParts(parts), material);
        m.frustumCulled = true;
        this.group.add(m);
        this.siteMeshes.push(m);
      }
    }
  }

  // rock needles on the Citadel's massif: the sea-stack meshes at a larger scale, standing on the cliffs
  buildNeedles(world, list) {
    const names = Object.keys(this.rockGeo).filter((n) => n.startsWith('stack'));
    const parts = [];
    for (const nd of list) {
      const g = this.rockGeo[names[nd.seed % names.length]];
      const gx = nd.x, gz = nd.z;
      const base = world.height(gx, gz) - 14;
      const top = world.castle.CASTLE.y0 + nd.top;
      const asp = 0.85 + 0.35 * (((nd.seed >> 3) % 100) / 100);
      parts.push({ g, x: gx, y: base, z: gz, sx: nd.r * 1.15 * asp, sy: Math.max(30, top - base), sz: (nd.r * 1.15) / asp, yaw: (nd.seed % 628) / 100 });
    }
    if (!parts.length) return;
    const m = new THREE.Mesh(mergeParts(parts), this.stackMat);
    m.frustumCulled = true;
    this.group.add(m);
    this.needleMesh = m;
  }

  // churning foam where the sea meets each stack
  stackFoam(stacks) {
    const pos = [], att = [], idx = [];
    const SEG = 40;
    for (const s of stacks) {
      const base = pos.length / 3;
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        const rr = s.r * (0.9 + 0.1 * Math.sin(a * 5 + s.seed));
        for (const [f, t] of [[0.92, 1], [1.5, 0.6], [2.4, 0]]) {
          const w = rr * f * (1 + 0.12 * Math.sin(a * 7 + s.seed * 0.3));
          pos.push(s.x + Math.cos(a) * w, 0.12, s.z + Math.sin(a) * w);
          att.push(t, a + s.seed);
        }
      }
      for (let k = 0; k < SEG; k++) {
        const k2 = (k + 1) % SEG;
        for (let q = 0; q < 2; q++) {
          const a0 = base + k * 3 + q, b0 = base + k2 * 3 + q;
          idx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aFoam', new THREE.Float32BufferAttribute(att, 2));
    g.setIndex(idx);
    const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: this.shared.uTime }]);
    const mat = new THREE.ShaderMaterial({
      uniforms: u,
      fog: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute vec2 aFoam;
        varying vec2 vF; varying vec3 vP;
        void main() {
          vF = aFoam; vP = position;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float time;
        varying vec2 vF; varying vec3 vP;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
        void main() {
          float fn = n(vP.xz * 0.9 + vec2(time * 0.4, -time * 0.3)) * 0.6 + n(vP.xz * 2.3 - vec2(time * 0.5, time * 0.2)) * 0.4;
          float a = smoothstep(0.35, 0.8, fn + vF.x * 0.55 - 0.1) * vF.x;
          gl_FragColor = vec4(vec3(0.92, 0.96, 0.98), a * 0.85);
          #include <fog_fragment>
        }`,
    });
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = 2;
    return m;
  }

  // ---------------------------------------------------------------------------------------------- rocks
  // called with each flora block; rocks are built per 200 m cell on demand in update()
  addBlock(b) {
    (this.blocks || (this.blocks = [])).push(b);
  }

  drop(key, mesh) {
    this.group.remove(mesh);
    mesh.geometry.dispose();
    this.cells.delete(key);
  }

  update(camera, t = 0) {
    this.shared.uTime.value = t;
    if (!this.blocks) return;
    const cam = camera.position;
    const R = this.range;
    let built = 0, tris = 0;
    const want = new Set();
    for (const b of this.blocks) {
      if (cam.x < b.bx0 - R || cam.x > b.bx0 + 800 + R || cam.z < b.bz0 - R || cam.z > b.bz0 + 800 + R) continue;
      for (let c = 0; c < 16; c++) {
        const a = b.rockOff[c], e = b.rockOff[c + 1];
        if (e <= a) continue;
        const x0 = b.bx0 + (c & 3) * 200, z0 = b.bz0 + (c >> 2) * 200;
        const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + 200)), dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + 200));
        const dy = Math.max(b.ymin - 4 - cam.y, 0, cam.y - (b.ymax + 20));
        if (Math.hypot(dx, dz, dy) > R) continue;
        const key = `${b.key}:${c}`;
        want.add(key);
        if (!this.cells.has(key) && built < 1) {
          const geo = this.buildCell(b, a, e);
          const m = new THREE.Mesh(geo, this.rockMat);
          m.frustumCulled = true;
          m.matrixAutoUpdate = false;
          this.group.add(m);
          this.cells.set(key, m);
          built++;
        }
      }
    }
    for (const [k, m] of this.cells) {
      if (!want.has(k)) {
        // keep cells a little beyond the range to avoid thrashing at the edge
        this.drop(k, m);
      } else tris += m.geometry.index.count / 3;
    }
    this.stats.rockCells = this.cells.size;
    this.stats.rockTris = tris;
  }

  buildCell(b, a, e) {
    const names = ['rock0', 'rock1', 'rock2', 'rock3', 'rock4'];
    const count = e - a;
    let vtot = 0, itot = 0;
    for (let i = a; i < e; i++) {
      const g = this.rockGeo[names[b.rocks[i * STRIDE + 5] | 0]];
      vtot += g.attributes.position.count;
      itot += g.index.count;
    }
    const pos = new Float32Array(vtot * 3), nrm = new Float32Array(vtot * 3), col = new Float32Array(vtot * 4);
    const idx = new Uint32Array(itot);
    let vo = 0, io = 0;
    const R = new THREE.Matrix4(), tmp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3();
    const q = new THREE.Quaternion(), qy = new THREE.Quaternion();
    for (let i = a; i < e; i++) {
      const o = i * STRIDE;
      const x = b.rocks[o], y = b.rocks[o + 1], z = b.rocks[o + 2], s = b.rocks[o + 3], yaw = b.rocks[o + 4], v = b.rocks[o + 5] | 0;
      n.set(b.rocks[o + 6] * 0.55, 1, b.rocks[o + 7] * 0.55).normalize();
      q.setFromUnitVectors(up, n);
      qy.setFromAxisAngle(up, yaw);
      q.multiply(qy);
      const g = this.rockGeo[names[v]];
      const hash = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      const st = 0.75 + 0.5 * Math.abs(hash);
      R.compose(tmp.set(x, y + 0.18 * s, z), q, new THREE.Vector3(s * st, s * (0.8 + 0.5 * Math.abs(hash * 7 % 1)), s / st));
      const P = g.attributes.position.array, N = g.attributes.normal.array, C = g.attributes.aCol.array, nv = g.attributes.position.count;
      const e0 = R.elements;
      for (let k = 0; k < nv; k++) {
        const px = P[k * 3], py = P[k * 3 + 1], pz = P[k * 3 + 2];
        pos[(vo + k) * 3] = e0[0] * px + e0[4] * py + e0[8] * pz + e0[12];
        pos[(vo + k) * 3 + 1] = e0[1] * px + e0[5] * py + e0[9] * pz + e0[13];
        pos[(vo + k) * 3 + 2] = e0[2] * px + e0[6] * py + e0[10] * pz + e0[14];
        const nx = N[k * 3], ny = N[k * 3 + 1], nz = N[k * 3 + 2];
        let wx = e0[0] * nx + e0[4] * ny + e0[8] * nz, wy = e0[1] * nx + e0[5] * ny + e0[9] * nz, wz = e0[2] * nx + e0[6] * ny + e0[10] * nz;
        const l = Math.hypot(wx, wy, wz) || 1;
        nrm[(vo + k) * 3] = wx / l; nrm[(vo + k) * 3 + 1] = wy / l; nrm[(vo + k) * 3 + 2] = wz / l;
        col[(vo + k) * 4] = C[k * 4]; col[(vo + k) * 4 + 1] = C[k * 4 + 1]; col[(vo + k) * 4 + 2] = C[k * 4 + 2]; col[(vo + k) * 4 + 3] = C[k * 4 + 3];
      }
      const I = g.index.array;
      for (let k = 0; k < I.length; k++) idx[io + k] = I[k] + vo;
      vo += nv;
      io += I.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }
}

function pieceName(pc) {
  switch (pc.k) {
    case 'tower': return `tower${pc.v ? 1 : 0}`;
    case 'wall': return `wall${pc.v % 3}`;
    case 'arch': return 'arch0';
    case 'pillar': return `pillar${pc.v ? 1 : 0}`;
    case 'steps': return 'steps0';
    case 'altar': return 'altar0';
    case 'rib': return `rib${pc.v ? 1 : 0}`;
    case 'spine': return 'spine0';
    case 'tail': return 'tail0';
    case 'skull': return 'skull0';
    default: return null;
  }
}

// merge template geometries placed at (x, y, z) with scale and yaw (static, world space)
function mergeParts(parts) {
  let vtot = 0, itot = 0;
  for (const p of parts) { vtot += p.g.attributes.position.count; itot += p.g.index.count; }
  const pos = new Float32Array(vtot * 3), nrm = new Float32Array(vtot * 3), col = new Float32Array(vtot * 4), idx = new Uint32Array(itot);
  let vo = 0, io = 0;
  for (const p of parts) {
    const P = p.g.attributes.position.array, N = p.g.attributes.normal.array, C = p.g.attributes.aCol.array, nv = p.g.attributes.position.count;
    const cs = Math.cos(p.yaw), sn = Math.sin(p.yaw);
    for (let k = 0; k < nv; k++) {
      const px = P[k * 3] * p.sx, py = P[k * 3 + 1] * p.sy, pz = P[k * 3 + 2] * p.sz;
      pos[(vo + k) * 3] = cs * px + sn * pz + p.x;
      pos[(vo + k) * 3 + 1] = py + p.y;
      pos[(vo + k) * 3 + 2] = -sn * px + cs * pz + p.z;
      const nx = N[k * 3] / p.sx, ny = N[k * 3 + 1] / p.sy, nz = N[k * 3 + 2] / p.sz;
      const wx = cs * nx + sn * nz, wz = -sn * nx + cs * nz;
      const l = Math.hypot(wx, ny, wz) || 1;
      nrm[(vo + k) * 3] = wx / l; nrm[(vo + k) * 3 + 1] = ny / l; nrm[(vo + k) * 3 + 2] = wz / l;
      for (let c = 0; c < 4; c++) col[(vo + k) * 4 + c] = C[k * 4 + c];
    }
    const I = p.g.index.array;
    for (let k = 0; k < I.length; k++) idx[io + k] = I[k] + vo;
    vo += nv;
    io += I.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

// A rock ring: a torus about the horizontal axis (cos yaw, 0, sin yaw), lumpy and thicker at the foot, never thinner
// than 0.85 t, so the collider (shared/world.js hitArch, 0.8 t) is always inside the rock. aCol: rgb tint, a = baked AO.
function archGeometry(a) {
  const SEGS = 56, SIDES = 14;
  const { x: cx, y: cy, z: cz, R, t, yaw, seed } = a;
  const ax = Math.cos(yaw), az = Math.sin(yaw);
  const hash = (i, j, k) => { const v = Math.sin(i * 127.1 + j * 311.7 + k * 74.7 + seed * 0.0001) * 43758.5453; return v - Math.floor(v); };
  const lump = (u, v) => {
    // smooth noise on the torus surface, periodic in both angles
    const fu = u * 6, fv = v * 4;
    const iu = Math.floor(fu), iv = Math.floor(fv);
    const tu = fu - iu, tv = fv - iv;
    const su = tu * tu * (3 - 2 * tu), sv = tv * tv * (3 - 2 * tv);
    const g = (i, j) => hash(((i % 6) + 6) % 6, ((j % 4) + 4) % 4, 1);
    return (g(iu, iv) * (1 - su) + g(iu + 1, iv) * su) * (1 - sv) + (g(iu, iv + 1) * (1 - su) + g(iu + 1, iv + 1) * su) * sv;
  };
  const pos = new Float32Array((SEGS + 1) * (SIDES + 1) * 3), col = new Float32Array((SEGS + 1) * (SIDES + 1) * 4);
  const P = (i, j) => {
    const u = (i % SEGS) / SEGS, v = (j % SIDES) / SIDES;
    const th = u * Math.PI * 2, ph = v * Math.PI * 2;
    // the ring thickens toward its foot and pinches at the crown, like a worn natural arch
    const foot = 0.5 - 0.5 * Math.cos(th); // 0 at the top (th = 0), 1 at the bottom
    const tube = t * (1.0 + 0.2 * foot + 0.3 * (lump(u, v) - 0.5));
    const rr = R + Math.cos(ph) * tube;
    const inPlane = [Math.sin(th) * rr, Math.cos(th) * rr]; // across, up
    const along = Math.sin(ph) * tube * (1.0 + 0.2 * foot);
    return [cx + (-az) * inPlane[0] + ax * along, cy + inPlane[1], cz + ax * inPlane[0] + az * along, 0.62 + 0.38 * (0.5 + 0.5 * Math.cos(ph)) * (1 - 0.3 * foot)];
  };
  for (let j = 0; j <= SIDES; j++) {
    for (let i = 0; i <= SEGS; i++) {
      const k = j * (SEGS + 1) + i;
      const p = P(i, j);
      pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
      col[k * 4] = 1; col[k * 4 + 1] = 1; col[k * 4 + 2] = 1; col[k * 4 + 3] = p[3];
    }
  }
  const idx = [];
  for (let j = 0; j < SIDES; j++) {
    for (let i = 0; i < SEGS; i++) {
      const a0 = j * (SEGS + 1) + i, b0 = a0 + 1, c0 = a0 + SEGS + 1, d0 = c0 + 1;
      idx.push(a0, b0, c0, b0, d0, c0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// concatenate indexed geometries that share the position / normal / aCol layout
function mergeGeos(list) {
  let vt = 0, it = 0;
  for (const g of list) { vt += g.attributes.position.count; it += g.index.count; }
  const pos = new Float32Array(vt * 3), nrm = new Float32Array(vt * 3), col = new Float32Array(vt * 4), idx = new Uint32Array(it);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.aCol.array, vo * 4);
    const I = g.index.array;
    for (let k = 0; k < I.length; k++) idx[io + k] = I[k] + vo;
    vo += g.attributes.position.count;
    io += I.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('aCol', new THREE.BufferAttribute(col, 4));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
