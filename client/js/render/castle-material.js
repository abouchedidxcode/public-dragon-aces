// Materials for the Citadel: one PBR "stone" shader for every built surface (towers, walls, bridges, roofs, decks,
// ironwork) driven by per-vertex material layers, plus windows, banners and the small instanced parts.
//
// The stone shader (injected into MeshStandardMaterial, so sun, image-based light, cloud shadows and the height fog
// all behave like the rest of the world):
//   * photoscanned Poly Haven albedo / normal / roughness from two texture arrays, sampled at two scales and blended,
//     with metric UVs from the geometry so courses stay level and texel density is constant at any scale
//   * relief: a height map per layer drives parallax (the blocks stand out from the mortar as you move), mortar
//     cavity darkening and chipped, lightened block edges; colour varies from block to block
//   * a macro variation layer (octaves of value noise in world space, warm and cool patches) against tiling
//   * lighting from a 3D volume (sun transmittance, rain exposure, ambient openness; see castle-bake.js) sampled per
//     pixel just off the surface, plus the mountain shadow texture of the terrain
//   * weathering: dirt in occluded creases, vertical rain streaks below ledges (strength from the rain exposure),
//     moss on damp upward faces low on the building, a wet base, rust on iron, patina on slate
// All noise comes from one small tiling texture (four independent value-noise octaves in its channels), which is
// much cheaper than computing it, and the fine detail fades out with distance.
import * as THREE from 'three';
import { SKY } from './atmosphere.js';
import { VOL } from './castle-bake.js';
import { CASTLE } from '../../../shared/castle.js';

// metres per texture tile, normal strength, roughness multiplier, metalness
const LAYERS = [
  [4.4, 1.0, 1.0, 0.0], // ashlar (Poly Haven medieval_blocks_03): big cut blocks
  [5.2, 1.1, 1.0, 0.0], // rubble (castle_wall_varriation): coursed rubble
  [3.6, 1.2, 1.0, 0.0], // slate (grey_roof_01): spire shingles
  [3.2, 1.0, 1.0, 0.0], // wood (medieval_wood): deck boards
  [3.0, 0.9, 0.9, 0.55], // iron (metal_plate_02)
  [5.0, 1.0, 1.0, 0.0], // dark (stone_brick_wall_001): plinths, soffits, paving
];

export async function loadCastleTextures(base) {
  const load = (url) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
  const mk = async (names, kind, size, channels = 4) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = new Uint8Array(size * size * channels * names.length);
    const imgs = await Promise.all(names.map((n) => load(`${base}castle_${n}_${kind}.jpg`)));
    imgs.forEach((img, i) => {
      ctx.drawImage(img, 0, 0, size, size);
      const px = ctx.getImageData(0, 0, size, size).data;
      if (channels === 4) data.set(px, i * size * size * 4);
      else for (let k = 0; k < size * size; k++) data[i * size * size + k] = px[k * 4]; // greyscale: keep one channel
    });
    const tex = new THREE.DataArrayTexture(data, size, size, names.length);
    tex.format = channels === 4 ? THREE.RGBAFormat : THREE.RedFormat;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = channels === 4 ? 8 : 4;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  };
  const hi = ['ashlar', 'rubble'], lo = ['slate', 'wood', 'iron', 'dark'];
  const [hiA, hiN, loA, loN, hiH, loH] = await Promise.all([
    mk(hi, 'albedo', 768), mk(hi, 'nr', 768), mk(lo, 'albedo', 512), mk(lo, 'nr', 512), mk(hi, 'h', 768, 1), mk(lo, 'h', 512, 1),
  ]);
  return { hiA, hiN, loA, loN, hiH, loH, noise: noiseTexture() };
}

// A 256 x 256 tiling texture holding four independent value-noise octaves, one per channel. The lattice of R and A has
// 16 cells across the tile, G has 48 and B has 128, so one fetch gives a base frequency and its 3x and 8x harmonics.
function noiseTexture() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const hash = (x, y, s) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const chan = [[16, 1], [48, 2], [128, 3], [16, 4]];
  for (let c = 0; c < 4; c++) {
    const [L, seed] = chan[c];
    const cell = N / L;
    for (let y = 0; y < N; y++) {
      const fy = y / cell, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < N; x++) {
        const fx = x / cell, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const a = hash(x0 % L, y0 % L, seed), b = hash((x0 + 1) % L, y0 % L, seed), cc = hash(x0 % L, (y0 + 1) % L, seed), d = hash((x0 + 1) % L, (y0 + 1) % L, seed);
        data[(y * N + x) * 4 + c] = Math.round((a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy) * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// the light volume (castle-bake.js buildLightVolume) as a 3D texture; until the worker delivers it, a 1-texel stand-in
// that says 'fully lit, dry and open'
export function lightVolumeTexture(v) {
  const data = v ? v.data : new Uint8Array([255, 255, 255, 255]);
  const t = new THREE.Data3DTexture(data, v ? v.nx : 1, v ? v.ny : 1, v ? v.nz : 1);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// shared uniforms for every castle material (one object, so the terrain data and time are set in one place)
export function createCastleUniforms(textures, y0, worldHalf) {
  const nx = Math.ceil((VOL.HALF * 2) / VOL.CELL), ny = Math.ceil((VOL.YMAX - VOL.YMIN) / VOL.CELL);
  return {
    tHiA: { value: textures.hiA }, tHiN: { value: textures.hiN }, tLoA: { value: textures.loA }, tLoN: { value: textures.loN },
    tHiH: { value: textures.hiH }, tLoH: { value: textures.loH }, uNoise: { value: textures.noise },
    uVol: { value: lightVolumeTexture(null) },
    uVolO: { value: new THREE.Vector3(CASTLE.x - VOL.HALF, y0 + VOL.YMIN, CASTLE.z - VOL.HALF) },
    uVolS: { value: new THREE.Vector3(1 / (nx * VOL.CELL), 1 / (ny * VOL.CELL), 1 / (nx * VOL.CELL)) },
    uTile: { value: LAYERS.map((l) => new THREE.Vector4(...l)) },
    uTerrainData: { value: new THREE.DataTexture(new Float32Array([0, -1000, 1, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType) },
    uWorldHalf: { value: worldHalf },
    uY0: { value: y0 },
    uTime: { value: 0 },
    uQual: { value: 1 },
    uSun: { value: SKY.sunDir.clone() },
  };
}

// instanced: the part has a fixed material layer (merlons, gargoyles)
export function createStoneMaterial(uniforms, { instanced = false, layer = 0 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, envMapIntensity: 0.95 });
  if (instanced) mat.defines = { CASTLE_INSTANCED: '', CASTLE_LAYER: String(layer) };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute vec4 aData;
        varying vec3 vWPos; varying vec3 vWNrm; varying vec2 vUvM; varying float vGeoAo; flat varying float vMat;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef CASTLE_INSTANCED
          vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vWNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vGeoAo = 1.0;
          vMat = float(CASTLE_LAYER);
        #else
          vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWNrm = normalize(mat3(modelMatrix) * normal);
          vGeoAo = aData.x;
          vMat = floor(aData.w * 255.0 + 0.5);
        #endif
        vUvM = uv;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        precision highp sampler2DArray;
        precision highp sampler3D;
        uniform sampler2DArray tHiA; uniform sampler2DArray tHiN; uniform sampler2DArray tLoA; uniform sampler2DArray tLoN;
        uniform sampler2DArray tHiH; uniform sampler2DArray tLoH;
        uniform sampler2D uNoise; uniform sampler3D uVol; uniform vec3 uVolO; uniform vec3 uVolS;
        uniform vec4 uTile[6];
        uniform sampler2D uTerrainData; uniform float uWorldHalf; uniform float uY0; uniform float uQual;
        varying vec3 vWPos; varying vec3 vWNrm; varying vec2 vUvM; varying float vGeoAo; flat varying float vMat;
        // relief depth in metres per layer (ashlar, rubble, slate, wood, iron, dark)
        const float PDEPTH[6] = float[6](0.11, 0.11, 0.07, 0.035, 0.01, 0.08);
        // one fetch = four value-noise octaves (R base, G x3, B x8, A another base); x.y shears the plane so 3D positions
        // do not line up with the tile
        vec4 nz(vec3 x) { return texture2D(uNoise, (x.xz + x.y * vec2(0.73, 0.41)) * 0.0625); }
        vec3 cLin(vec3 c) { return c * c * (c * 0.305306 + 0.682171) + c * 0.012522; }
        vec3 cN; float cRough; float cMetal; float cSun; float cAo;
        float cHeight(int m, vec2 uv, vec2 gx, vec2 gy) {
          return m < 2 ? textureGrad(tHiH, vec3(uv, float(m)), gx, gy).r : textureGrad(tLoH, vec3(uv, float(m - 2)), gx, gy).r;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          vec3 N = normalize(vWNrm);
          vec3 p = vWPos;
          vec3 toCam = cameraPosition - p;
          float dist = length(toCam);
          vec3 V = toCam / max(dist, 1e-3);
          float h = p.y - uY0;
          int m = int(vMat + 0.5);
          vec4 T = uTile[m];
          float up = clamp(N.y, 0.0, 1.0);
          bool near = uQual > 0.5 && dist < 520.0; // relief, block colour and the second texture scale live here
          // light from the volume, just off the surface along its normal
          vec3 vol = texture(uVol, (p + N * 5.5 - uVolO) * uVolS).rgb;

          // tangent frame from derivatives of position and the metric uv (u along the surface, v up it)
          vec3 dp1 = dFdx(p), dp2 = dFdy(p);
          vec2 duv1 = dFdx(vUvM), duv2 = dFdy(vUvM);
          vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
          vec3 Tg = dp2perp * duv1.x + dp1perp * duv2.x;
          vec3 Bg = dp2perp * duv1.y + dp1perp * duv2.y;
          float tinv = inversesqrt(max(max(dot(Tg, Tg), dot(Bg, Bg)), 1e-12));
          Tg *= tinv; Bg *= tinv;

          vec2 uvm0 = vec2(vUvM.x, -vUvM.y);
          vec2 uvm = uvm0;
          // texture gradients from the surface footprint (uv jumps at face seams would otherwise smear a mip line)
          float fp = max(length(dp1), length(dp2)) / T.x;
          vec2 gx1 = dFdx(uvm0) / T.x, gy1 = dFdy(uvm0) / T.x;
          if (length(gx1) > fp * 3.0 || length(gy1) > fp * 3.0) { gx1 = vec2(fp, 0.0); gy1 = vec2(0.0, fp); }
          // the coarse second scale only carries broad tone and slope: sampled blurred, or its rotated mortar lines would read as a diagonal lattice
          vec2 gx2 = gx1 * 1.3, gy2 = gy1 * 1.3;

          // relief: shift the lookup along the view direction by how deep the surface is below the top of the blocks
          float hc = 1.0;
          if (near) {
            float pf = (1.0 - smoothstep(30.0, 95.0, dist)) * smoothstep(0.12, 0.3, dot(V, N));
            vec3 Vt = vec3(dot(V, Tg), dot(V, Bg), dot(V, N));
            float vz = max(Vt.z, 0.28);
            hc = cHeight(m, uvm / T.x, gx1, gy1);
            if (pf > 0.01) {
              float pd = PDEPTH[m] * pf;
              vec2 off = -Vt.xy / vz * (1.0 - hc) * pd;
              uvm = uvm0 + vec2(off.x, -off.y);
              hc = cHeight(m, uvm / T.x, gx1, gy1);
              if (uQual > 1.5) { // a second pass settles it on steep joints
                off = -Vt.xy / vz * (1.0 - hc) * pd;
                uvm = uvm0 + vec2(off.x, -off.y);
                hc = cHeight(m, uvm / T.x, gx1, gy1);
              }
            }
          }
          vec2 uv1 = uvm / T.x;
          vec2 uv2 = mat2(0.87, -0.5, 0.5, 0.87) * uvm / (T.x * 4.7) + 0.31;
          vec3 a1, a2, mean, nr1, nr2;
          bool second = near && dist < 650.0; // the coarse second scale is skipped at quality 0 and far away
          if (m < 2) {
            float l = float(m);
            a1 = textureGrad(tHiA, vec3(uv1, l), gx1, gy1).rgb;
            nr1 = textureGrad(tHiN, vec3(uv1, l), gx1, gy1).rgb;
            a2 = a1; nr2 = nr1; mean = a1;
            if (second) {
              a2 = textureGrad(tHiA, vec3(uv2, l), gx2, gy2).rgb;
              mean = textureLod(tHiA, vec3(0.5, 0.5, l), 9.0).rgb;
              nr2 = textureGrad(tHiN, vec3(uv2, l), gx2, gy2).rgb;
            }
          } else {
            float l = float(m - 2);
            a1 = textureGrad(tLoA, vec3(uv1, l), gx1, gy1).rgb;
            nr1 = textureGrad(tLoN, vec3(uv1, l), gx1, gy1).rgb;
            a2 = a1; nr2 = nr1; mean = a1;
            if (second) {
              a2 = textureGrad(tLoA, vec3(uv2, l), gx2, gy2).rgb;
              mean = textureLod(tLoA, vec3(0.5, 0.5, l), 8.0).rgb;
              nr2 = textureGrad(tLoN, vec3(uv2, l), gx2, gy2).rgb;
            }
          }
          vec3 c = cLin(a1);
          float rel = clamp(dot(cLin(a2), vec3(0.3333)) / max(dot(cLin(mean), vec3(0.3333)), 0.02), 0.45, 1.8);
          c *= mix(1.0, rel, 0.55);
          // macro variation in world space: broad light and dark patches, warm and cool tints
          vec4 mn4 = nz(p * 0.0065);
          float mac = mn4.r * 0.5 + mn4.g * 0.32 + mn4.b * 0.18;
          c *= 0.66 + 0.68 * mac;
          c *= mix(vec3(0.95, 0.98, 1.04), vec3(1.07, 1.0, 0.91), mn4.a);
          float chipv = 0.0;
          if (near) {
            // every block its own stone: brightness and warmth change on a block-sized lattice of the metric uv
            vec4 bn = nz(vec3(uvm0.x, 0.0, uvm0.y) * (1.0 / 2.6) + 7.0);
            float bs = m < 2 ? 1.0 : 0.45;
            c *= 1.0 + (bn.r - 0.5) * 0.46 * bs;
            c *= mix(vec3(0.96, 0.99, 1.04), vec3(1.06, 1.0, 0.9), bn.g * bs);
            // the mortar sits back: darker in the joints, with the blocks' arrises catching light where they are chipped
            c *= mix(0.55, 1.0, smoothstep(0.04, 0.5, hc));
            float edge = smoothstep(0.28, 0.5, hc) * (1.0 - smoothstep(0.5, 0.78, hc));
            chipv = edge * smoothstep(0.35, 0.75, bn.b) * bs;
            c *= 1.0 + edge * 0.22 * bs + chipv * 0.45;
          }
          // weathering
          float ao = vGeoAo * vol.b, expo = vol.g;
          c *= mix(0.55, 1.0, pow(ao, 0.75));
          float dampH = 1.0 - smoothstep(0.0, 420.0, h);
          // the fine weathering fades out with distance (it averages away anyway) and is skipped at quality 0
          float fd = (1.0 - smoothstep(350.0, 1100.0, dist)) * step(0.5, uQual);
          if (m != 2 && m != 4 && fd > 0.01) {
            // rain streaks under ledges: long vertical noise, strongest where the surface is exposed to rain
            vec4 sn4 = nz(vec3(vUvM.x * 0.9, p.y * 0.01, 5.0));
            float streak = smoothstep(0.16, 0.42, sn4.r * sn4.g * 1.9) * expo * (1.0 - up) * (0.35 + 0.65 * (1.0 - ao)) * fd;
            c *= 1.0 - streak * 0.5;
            c = mix(c, c * vec3(0.78, 0.82, 0.7), streak * 0.4);
            // moss on damp, upward-facing surfaces low on the building and in shaded creases
            vec4 mo = nz(p * 0.21 + 2.0);
            float mn = mo.r * 0.6 + mo.g * 0.4;
            float moss = smoothstep(0.52, 0.78, mn) * (0.25 + 0.75 * up) * dampH * (0.35 + 0.65 * (1.0 - ao)) * (1.0 - 0.5 * vol.r) * fd;
            c = mix(c, vec3(0.05, 0.1, 0.03) * (0.6 + 0.8 * dot(c, vec3(0.33)) * 3.0), moss * 0.62);
            // pale lime bloom weeping down from the lee of ledges
            float lime = smoothstep(0.62, 0.85, mo.b) * (1.0 - up) * expo * 0.5 * fd;
            c = mix(c, c * vec3(1.35, 1.3, 1.2) + 0.02, lime * 0.5);
          }
          if (m == 2) {
            // slate: cool, a little glossy where wet, lichen speckle low down
            vec4 sl = nz(p * 0.7);
            c *= vec3(0.9, 0.96, 1.06);
            c = mix(c, c * vec3(1.25, 1.2, 0.7), smoothstep(0.62, 0.8, sl.r) * 0.35 * dampH);
            // some roofs have weathered to verdigris, some to a warm violet slate: patches large enough to read from afar
            float pat = mn4.g * 0.7 + mn4.b * 0.3;
            c = mix(c, c * vec3(0.55, 1.35, 1.1) + vec3(0.0, 0.012, 0.01), smoothstep(0.55, 0.78, pat) * 0.8);
            c = mix(c, c * vec3(1.18, 0.92, 1.18), smoothstep(0.18, 0.05, pat) * 0.7);
          }
          float rn = 0.0;
          if (m == 4) {
            // iron: rust blooms and streaks
            vec4 rr = nz(p * 0.55 + 1.0);
            rn = smoothstep(0.5, 0.78, rr.r * 0.6 + rr.b * 0.4);
            c = mix(c, vec3(0.28, 0.12, 0.05), rn * 0.65);
          }
          // wet, dark stone at the foot of the walls
          float wet = 1.0 - smoothstep(2.0, 26.0, h);
          c *= mix(1.0, 0.58, wet * (m == 2 ? 0.0 : 1.0));
          // normal and roughness
          vec2 n1 = nr1.xy * 2.0 - 1.0, n2 = nr2.xy * 2.0 - 1.0;
          vec2 nxy = (n1 + n2 * 0.45) * T.y;
          float nzc = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
          cN = normalize(Tg * nxy.x + Bg * nxy.y + N * nzc);
          cRough = clamp(nr1.z * T.z * (1.0 + 0.1 * (rel - 1.0)) + chipv * 0.12, 0.18, 1.0);
          cRough = mix(cRough, 0.28, wet * 0.6);
          cMetal = T.w * (m == 4 ? (1.0 - rn * 0.9) : 1.0);
          // baked light, with the mountain shadow of the terrain on top
          vec2 tuv = (p.xz + uWorldHalf) / (2.0 * uWorldHalf);
          float tLit = smoothstep(-18.0, 10.0, p.y - texture2D(uTerrainData, tuv).g);
          cSun = vol.r * tLit;
          cAo = ao;
          diffuseColor.rgb *= c;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = cMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(cN, 0.0)).xyz);')
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
        {
          float aoI = mix(0.5, 1.0, cAo);
          reflectedLight.indirectDiffuse *= aoI;
          reflectedLight.indirectSpecular *= aoI;
          reflectedLight.directDiffuse *= cSun;
          reflectedLight.directSpecular *= cSun;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `castle-v2${instanced ? 'i' + layer : ''}`;
  return mat;
}

// --------------------------------------------------------------------------------------------- windows
// Pointed-arch lancet: a recessed pane (glowing), a reveal and a stone frame, all unit-sized (width 1, height 1,
// depth 0.8) and placed by the instance matrix. part: 0 pane, 1 stone.
export function createWindowGeometry() {
  const pos = [], nrm = [], uv = [], part = [], idx = [];
  const arch = [[-0.5, 0], [0.5, 0], [0.5, 0.58], [0.44, 0.74], [0.3, 0.87], [0, 1], [-0.3, 0.87], [-0.44, 0.74], [-0.5, 0.58]];
  const depth = 0.8;
  const cy = 0.5;
  const push = (x, y, z, nx, ny, nz, u, v, pt) => {
    pos.push(x, y, z); nrm.push(nx, ny, nz); uv.push(u, v); part.push(pt);
    return pos.length / 3 - 1;
  };
  // pane at the back, facing +z
  const c = push(0, cy, -depth, 0, 0, 1, 0.5, cy, 0);
  const ring = arch.map(([x, y]) => push(x, y, -depth, 0, 0, 1, x + 0.5, y, 0));
  for (let i = 0; i < arch.length; i++) idx.push(c, ring[i], ring[(i + 1) % arch.length]);
  // reveal: from the pane edge to the face, facing the window's centre
  for (let i = 0; i < arch.length; i++) {
    const a = arch[i], b = arch[(i + 1) % arch.length];
    const ex = (a[0] + b[0]) / 2, ey = (a[1] + b[1]) / 2;
    let nx = -(ey - cy) * 0, ny = 0;
    nx = -ex; ny = -(ey - cy);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const v0 = push(a[0], a[1], -depth, nx, ny, 0, 0, 0, 1), v1 = push(b[0], b[1], -depth, nx, ny, 0, 1, 0, 1), v2 = push(b[0], b[1], 0, nx, ny, 0, 1, 1, 1), v3 = push(a[0], a[1], 0, nx, ny, 0, 0, 1, 1);
    idx.push(v0, v2, v1, v0, v3, v2);
  }
  // frame: the outline expanded around the centre, flat, proud of the wall
  const k = 0.22;
  const outer = arch.map(([x, y]) => [x * (1 + k), cy + (y - cy) * (1 + k * 0.5) + (y > 0.9 ? 0.08 : 0)]);
  for (let i = 0; i < arch.length; i++) {
    const j = (i + 1) % arch.length;
    const a = arch[i], b = arch[j], A = outer[i], B = outer[j];
    const q0 = push(a[0], a[1], 0, 0, 0, 1, 0, 0, 1), q1 = push(b[0], b[1], 0, 0, 0, 1, 1, 0, 1), q2 = push(B[0], B[1], 0.1, 0, 0, 1, 1, 1, 1), q3 = push(A[0], A[1], 0.1, 0, 0, 1, 0, 1, 1);
    idx.push(q0, q1, q2, q0, q2, q3);
  }
  // sill
  const s0 = push(-0.62, -0.1, 0.1, 0, 1, 0, 0, 0, 1), s1 = push(0.62, -0.1, 0.1, 0, 1, 0, 1, 0, 1), s2 = push(0.62, 0.0, -0.3, 0, 1, 0, 1, 1, 1), s3 = push(-0.62, 0.0, -0.3, 0, 1, 0, 0, 1, 1);
  idx.push(s0, s2, s1, s0, s3, s2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('part', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

// instance attribute aWin: x seed, y kind (0 lancet, 1 slit), z sun, w ao
export function createWindowMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x6a655e, roughness: 0.85, metalness: 0, envMapIntensity: 0.9 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: uniforms.uTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float part; attribute vec4 aWin;\nvarying float vPart; varying vec2 vWUv; varying vec4 vWin;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = part; vWUv = uv; vWin = aWin;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; varying float vPart; varying vec2 vWUv; varying vec4 vWin;\nfloat wh(float x) { return fract(sin(x * 91.17) * 43758.5453); }`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float blind = step(1.5, vWin.y); // 2: an unglazed panel in the wall
        float paneMask = (1.0 - step(0.5, vPart)) * (1.0 - blind);
        diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.55, 0.52, 0.5) * mix(1.0, 0.55, (1.0 - step(0.5, vPart)) * blind), vec3(0.012, 0.014, 0.02), paneMask);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          float seed = vWin.x;
          // tracery: a central mullion, two transoms and a quatrefoil-ish ring near the head
          vec2 q = vWUv;
          float bars = max(step(abs(q.x - 0.5), 0.026), max(step(abs(q.y - 0.36), 0.018), step(abs(q.y - 0.68), 0.018)));
          float side = step(0.46, abs(q.x - 0.5)) * 0.0;
          float ring = smoothstep(0.012, 0.0, abs(length((q - vec2(0.5, 0.82)) * vec2(1.0, 1.6)) - 0.2));
          float lit = (1.0 - max(bars, ring)) * paneMask;
          float kind = wh(seed * 13.0);
          vec3 warm = vec3(1.0, 0.56, 0.2), cool = vec3(0.45, 0.72, 1.0), ember = vec3(1.0, 0.3, 0.1);
          vec3 col = kind < 0.64 ? warm : kind < 0.8 ? cool : ember;
          float on = step(0.05, wh(seed * 7.0 + 3.0));
          float flick = 0.85 + 0.15 * sin(uTime * (1.5 + kind * 3.0) + seed * 40.0) + 0.06 * sin(uTime * 11.0 + seed * 90.0);
          // dazzling in shadow, faint in sunlight
          float vis = mix(1.0, 0.4, vWin.z);
          totalEmissiveRadiance += col * lit * on * flick * vis * 5.6 * (0.55 + 0.45 * vWin.w);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'castle-win-v1';
  return mat;
}

// --------------------------------------------------------------------------------------------- banners
export function bannerTexture() {
  const W = 512, H = 1024; // drawn at this size, stored at half of it (two cloths side by side)
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H / 2;
  const g = c.getContext('2d');
  g.scale(0.5, 0.5);
  const cloth = (x0, base, trim, emb) => {
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, base[0]);
    grd.addColorStop(1, base[1]);
    g.fillStyle = grd;
    g.fillRect(x0, 0, W, H);
    // weave
    g.globalAlpha = 0.07;
    for (let y = 0; y < H; y += 4) { g.fillStyle = y % 8 ? '#000' : '#fff'; g.fillRect(x0, y, W, 2); }
    for (let x = 0; x < W; x += 5) { g.fillStyle = x % 10 ? '#000' : '#fff'; g.fillRect(x0 + x, 0, 2, H); }
    g.globalAlpha = 1;
    // border
    g.strokeStyle = trim;
    g.lineWidth = 12;
    g.strokeRect(x0 + 22, 22, W - 44, H - 44);
    g.lineWidth = 4;
    g.strokeRect(x0 + 40, 40, W - 80, H - 80);
    // swallow-tail
    g.fillStyle = '#000';
    g.beginPath();
    g.moveTo(x0, H); g.lineTo(x0 + W / 2, H - 150); g.lineTo(x0 + W, H);
    g.closePath();
    g.globalCompositeOperation = 'destination-out';
    g.fill();
    g.globalCompositeOperation = 'source-over';
    // emblem: a dragon-wing crest around a flame
    const cx = x0 + W / 2, cy = 400;
    g.save();
    g.translate(cx, cy);
    g.strokeStyle = emb;
    g.fillStyle = emb;
    g.lineWidth = 10;
    g.beginPath();
    g.arc(0, 0, 150, 0, Math.PI * 2);
    g.stroke();
    for (const sgn of [-1, 1]) {
      g.beginPath();
      g.moveTo(sgn * 40, 40);
      g.bezierCurveTo(sgn * 120, -20, sgn * 210, -90, sgn * 230, -190);
      g.bezierCurveTo(sgn * 170, -130, sgn * 140, -140, sgn * 112, -110);
      g.bezierCurveTo(sgn * 110, -70, sgn * 70, -30, sgn * 20, -10);
      g.closePath();
      g.fill();
      for (let k = 0; k < 3; k++) {
        g.beginPath();
        g.moveTo(sgn * (56 + k * 20), 22 - k * 8);
        g.lineTo(sgn * (150 + k * 20), -90 + k * 30);
        g.stroke();
      }
    }
    g.beginPath();
    g.moveTo(0, -120);
    g.bezierCurveTo(60, -50, 70, 40, 0, 110);
    g.bezierCurveTo(-70, 40, -60, -50, 0, -120);
    g.fill();
    g.fillStyle = base[0];
    g.beginPath();
    g.moveTo(0, -60);
    g.bezierCurveTo(26, -20, 26, 30, 0, 60);
    g.bezierCurveTo(-26, 30, -26, -20, 0, -60);
    g.fill();
    g.restore();
    // chevrons below
    g.strokeStyle = trim;
    g.lineWidth = 14;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(x0 + 110, 700 + k * 56);
      g.lineTo(x0 + W / 2, 760 + k * 56);
      g.lineTo(x0 + W - 110, 700 + k * 56);
      g.stroke();
    }
  };
  cloth(0, ['#7a0f18', '#3d070c'], '#e3b04a', '#e8b84e');
  cloth(W, ['#12263f', '#091422'], '#b9c7d8', '#cfd9e6');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// a flat strip with a few divisions, a rod along the top (uv.y = 1 is the top edge and does not sway)
export function createBannerGeometry() {
  const nx = 4, ny = 16;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      pos.push(i / nx - 0.5, -j / ny, 0);
      uv.push(i / nx, 1 - j / ny);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// instance attribute aBan: x seed, y cloth (0 crimson, 1 blue), z sun, w ao
export function createBannerMaterial(uniforms, map) {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, envMapIntensity: 0.8 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: uniforms.uTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aBan; uniform float uTime; varying vec4 vBan;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vBan = aBan;
        // hangs from the rod at the top; sways more toward the bottom
        float hang = clamp(1.0 - uv.y, 0.0, 1.0);
        float ph = uTime * 1.5 + aBan.x * 40.0 + hang * 5.0;
        transformed.z += (sin(ph) * 0.12 + sin(ph * 2.3 + 1.3) * 0.05) * hang * hang * 3.0 + hang * 0.35;
        transformed.x += sin(ph * 0.7 + 2.0) * 0.035 * hang * hang;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vBan;')
      .replace('#include <map_fragment>', '#include <map_fragment>');
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
      reflectedLight.directDiffuse *= vBan.z;
      reflectedLight.directSpecular *= vBan.z;
      reflectedLight.indirectDiffuse *= mix(0.4, 1.0, vBan.w);`,
    );
  };
  mat.customProgramCacheKey = () => 'castle-banner-v1';
  return mat;
}

// map atlas selection: the banner texture holds two cloths side by side; the instance picks one via the uv offset
export function bannerUvPatch(geo, cloth) {
  const uv = geo.getAttribute('uv');
  const out = new Float32Array(uv.count * 2);
  for (let i = 0; i < uv.count; i++) {
    out[i * 2] = (uv.getX(i) + cloth) * 0.5;
    out[i * 2 + 1] = uv.getY(i);
  }
  const g = geo.clone();
  g.setAttribute('uv', new THREE.BufferAttribute(out, 2));
  return g;
}

// a link of chain: a stretched torus along x
export function createLinkGeometry() {
  const segs = 8, tube = 4;
  const pos = [], idx = [];
  const a = 1.0, b = 0.62, r = 0.17; // half length, half width, tube radius (in units of the link size / 2.4)
  const path = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    // stadium-ish oval
    path.push([Math.cos(t) * a, Math.sin(t) * b, 0]);
  }
  for (let i = 0; i < segs; i++) {
    const p = path[i], q = path[(i + 1) % segs], o = path[(i + segs - 1) % segs];
    const tx = q[0] - o[0], ty = q[1] - o[1];
    const tl = Math.hypot(tx, ty);
    const nx = ty / tl, ny = -tx / tl; // outward in plane
    for (let k = 0; k < tube; k++) {
      const ang = (k / tube) * Math.PI * 2;
      const dx = nx * Math.cos(ang) * r, dy = ny * Math.cos(ang) * r, dz = Math.sin(ang) * r;
      pos.push(p[0] + dx, p[1] + dy, p[2] + dz);
    }
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    for (let k = 0; k < tube; k++) {
      const k2 = (k + 1) % tube;
      const A = i * tube + k, B = i * tube + k2, C = j * tube + k2, D = j * tube + k;
      idx.push(A, B, C, A, C, D);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// the merlon: a tapered block with a chamfered top
export function createMerlonGeometry() {
  const hw = 1.8, hd = 1.15, h = 3.3;
  const pos = [], nrm = [], uv = [], idx = [];
  const q = (p0, p1, p2, p3, u0, v0, u1, v1) => {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const b = pos.length / 3;
    for (const [p, u, v] of [[p0, u0, v0], [p1, u1, v0], [p2, u1, v1], [p3, u0, v1]]) { pos.push(...p); nrm.push(nx, ny, nz); uv.push(u, v); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const bot = 0, top = h;
  const tw = hw * 0.9, td = hd * 0.85;
  // front (+z), back (-z), left, right, sloped top, flat top
  q([-hw, bot, hd], [hw, bot, hd], [tw, top - 0.5, td], [-tw, top - 0.5, td], 0, 0, hw * 2, h);
  q([hw, bot, -hd], [-hw, bot, -hd], [-tw, top - 0.5, -td], [tw, top - 0.5, -td], 0, 0, hw * 2, h);
  q([-hw, bot, -hd], [-hw, bot, hd], [-tw, top - 0.5, td], [-tw, top - 0.5, -td], 0, 0, hd * 2, h);
  q([hw, bot, hd], [hw, bot, -hd], [tw, top - 0.5, -td], [tw, top - 0.5, td], 0, 0, hd * 2, h);
  q([-tw, top - 0.5, td], [tw, top - 0.5, td], [tw * 0.8, top, td * 0.6], [-tw * 0.8, top, td * 0.6], 0, 0, tw * 2, 0.5);
  q([tw, top - 0.5, -td], [-tw, top - 0.5, -td], [-tw * 0.8, top, -td * 0.6], [tw * 0.8, top, -td * 0.6], 0, 0, tw * 2, 0.5);
  q([-tw * 0.8, top, td * 0.6], [tw * 0.8, top, td * 0.6], [tw * 0.8, top, -td * 0.6], [-tw * 0.8, top, -td * 0.6], 0, 0, tw * 1.6, td * 1.2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// a brazier: a bowl on three legs
export function createBrazierGeometry() {
  const pos = [], idx = [];
  const add = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  // bowl: frustum rings
  const rings = [[0.0, 0.5], [0.35, 1.0], [0.85, 1.35], [1.05, 1.5], [1.05, 1.34]];
  const n = 10;
  const base = [];
  for (const [y, r] of rings) {
    const row = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; row.push(add(Math.cos(a) * r, 1.4 + y * 1.1, Math.sin(a) * r)); }
    base.push(row);
  }
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(base[k][i], base[k][j], base[k + 1][j], base[k][i], base[k + 1][j], base[k + 1][i]);
    }
  }
  const bc = add(0, 1.4, 0);
  for (let i = 0; i < n; i++) idx.push(bc, base[0][(i + 1) % n], base[0][i]);
  // legs
  for (let l = 0; l < 3; l++) {
    const a = (l / 3) * Math.PI * 2 + 0.5;
    const top = [Math.cos(a) * 0.6, 1.5, Math.sin(a) * 0.6], bot = [Math.cos(a) * 1.35, 0, Math.sin(a) * 1.35];
    const t = [-Math.sin(a) * 0.12, 0, Math.cos(a) * 0.12];
    const v0 = add(top[0] - t[0], top[1], top[2] - t[2]), v1 = add(top[0] + t[0], top[1], top[2] + t[2]), v2 = add(bot[0] + t[0], bot[1], bot[2] + t[2]), v3 = add(bot[0] - t[0], bot[1], bot[2] - t[2]);
    idx.push(v0, v2, v1, v0, v3, v2, v0, v1, v2, v0, v2, v3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// a gargoyle: a dragon-head spout (+z is out of the wall, +y up), about 6 m long at scale 1
export function createGargoyleGeometry() {
  const pos = [], nrm = [], uv = [], idx = [];
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const k = pos.length / 3;
    for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); nrm.push(nx, ny, nz); uv.push(p[0] * 0.8 + p[2] * 0.3, p[1] * 0.8 + p[2] * 0.2); }
    idx.push(k, k + 1, k + 2);
  };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  // sections along z: [z, halfWidth, yTop, yBottom]
  const S = [[-0.6, 0.95, 1.0, -1.1], [1.6, 0.8, 0.95, -0.85], [3.0, 0.62, 0.78, -0.5], [4.0, 0.46, 0.5, -0.1], [5.2, 0.3, 0.12, -0.3]];
  for (let i = 0; i < S.length - 1; i++) {
    const [z0, w0, t0, b0] = S[i], [z1, w1, t1, b1] = S[i + 1];
    quad([-w0, t0, z0], [-w1, t1, z1], [w1, t1, z1], [w0, t0, z0]); // top
    quad([-w0, b0, z0], [w0, b0, z0], [w1, b1, z1], [-w1, b1, z1]); // bottom
    quad([w0, b0, z0], [w0, t0, z0], [w1, t1, z1], [w1, b1, z1]); // right
    quad([-w0, b0, z0], [-w1, b1, z1], [-w1, t1, z1], [-w0, t0, z0]); // left
  }
  const e = S[S.length - 1];
  quad([-e[1], e[3], e[0]], [e[1], e[3], e[0]], [e[1], e[2], e[0]], [-e[1], e[2], e[0]]); // snout end
  // brow ridges and horns sweeping back
  for (const sx of [-1, 1]) {
    tri([sx * 0.5, 0.75, 2.8], [sx * 0.2, 0.62, 3.4], [sx * 0.55, 1.5, 1.5]);
    tri([sx * 0.5, 0.75, 2.8], [sx * 0.7, 0.62, 2.4], [sx * 0.55, 1.5, 1.5]);
    tri([sx * 0.7, 0.62, 2.4], [sx * 0.2, 0.62, 3.4], [sx * 0.55, 1.5, 1.5]);
    // small wings folded along the neck
    tri([sx * 0.9, 0.4, 0.0], [sx * 2.4, 1.5, -0.4], [sx * 0.9, -0.3, 1.8]);
    tri([sx * 0.9, 0.4, 0.0], [sx * 0.9, -0.3, 1.8], [sx * 2.4, 1.5, -0.4]);
    // fangs
    tri([sx * 0.18, -0.2, 4.6], [sx * 0.3, -0.25, 4.9], [sx * 0.22, -1.0, 4.8]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
