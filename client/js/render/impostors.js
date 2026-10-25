// Octahedral tree impostors for the mid and far forest.
//
// At startup (first time quality 1 or 2 is chosen) every conifer and broadleaf is rendered from a 6 x 6 grid of
// directions over the upper hemisphere (hemi-octahedral mapping) into two atlases on the GPU:
//   albedo  sRGB  rgb = foliage and bark colour as the full mesh shows it, a = coverage
//   normal  rgb = view-space normal of the crown (soft proxy normals), a = baked occlusion
// At run time each tree is one camera-facing quad. The fragment shader finds the three nearest baked views from the
// direction to the camera (rotated by the tree's own yaw, so neighbours don't look cloned), re-projects the quad
// point into each view's frame, blends them, then lights the result like a real tree: sun, image-based light,
// back-lit leaves, mountain shadow, cloud shadow (patched into the light chunk) and height fog, through a normal
// MeshStandardMaterial with patched chunks.
import * as THREE from 'three';

export const IMP = {
  N: 6, // views per side
  species: 4, // fir, pine, oak, birch
  cellW: 100, // px per view
  cellH: 168,
  worldW: 18, // metres covered by one view
  worldH: 30,
  centers: [13, 12, 8.5, 9], // metres above the trunk base at the middle of each species' view
};

const decode = (cx, cy) => {
  const e0 = (cx / (IMP.N - 1)) * 2 - 1, e1 = (cy / (IMP.N - 1)) * 2 - 1;
  const x = (e0 + e1) * 0.5, z = (e0 - e1) * 0.5;
  return new THREE.Vector3(x, Math.max(1 - Math.abs(x) - Math.abs(z), 0), z).normalize();
};

const BAKE_VERT = /* glsl */ `
attribute vec4 aCol;
varying vec4 vCol; varying vec2 vUvE; varying vec3 vOP; varying vec3 vN; varying vec3 vVP;
void main() {
  vCol = aCol; vUvE = uv; vOP = position;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vVP = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const BAKE_FRAG = /* glsl */ `
uniform sampler2D uFoliage; uniform float uLeafScale; uniform float uMode;
varying vec4 vCol; varying vec2 vUvE; varying vec3 vOP; varying vec3 vN; varying vec3 vVP;
float vh(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vh(i), vh(i + vec3(1, 0, 0)), f.x), mix(vh(i + vec3(0, 1, 0)), vh(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(vh(i + vec3(0, 0, 1)), vh(i + vec3(1, 0, 1)), f.x), mix(vh(i + vec3(0, 1, 1)), vh(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  float trunk = step(0.5, vUvE.y);
  vec3 lt = vec3(1.0);
  if (trunk < 0.5) {
    vec3 fn = normalize(cross(dFdx(vVP), dFdy(vVP)));
    float sil = 1.0 - abs(fn.z);
    vec4 t = texture2D(uFoliage, vec2(vOP.x + vOP.z * 0.7, vOP.y + vOP.z * 0.45) * uLeafScale);
    float thr = 0.3 + pow(sil, 2.0) * 0.32 + vUvE.x * 0.16;
    if (t.a < thr) discard;
    lt = t.rgb;
  }
  if (uMode < 0.5) {
    vec3 base = vCol.rgb * mix(0.84 + 0.32 * vn3(vOP * 1.6 + 3.0), 1.0, trunk);
    base *= mix(0.55 + 0.9 * lt, vec3(1.0), trunk);
    gl_FragColor = vec4(base, 1.0);
  } else {
    gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, vCol.a);
  }
}`;

// templates: geometries { fir_hi, pine_hi, oak_hi, birch_hi } with position / normal / uv / aCol
// returns { albedo, normal } textures
export function bakeImpostors(renderer, templates, foliage) {
  const { N, species, cellW, cellH } = IMP;
  const AW = species * N * cellW, AH = N * cellH;
  const mk = (srgb) => {
    const rt = new THREE.WebGLRenderTarget(AW, AH, {
      depthBuffer: true,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      anisotropy: 4,
    });
    rt.scissorTest = true;
    return rt;
  };
  const rtA = mk(true), rtN = mk(false);
  const names = ['fir_hi', 'pine_hi', 'oak_hi', 'birch_hi'];
  const conifer = [true, true, false, false];
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    uniforms: { uFoliage: { value: null }, uLeafScale: { value: 1 }, uMode: { value: 0 } },
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-IMP.worldW / 2, IMP.worldW / 2, IMP.worldH / 2, -IMP.worldH / 2, 1, 300);

  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevTM = renderer.toneMapping;
  const prevShadow = renderer.shadowMap.enabled;
  renderer.autoClear = true;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = false;
  const center = new THREE.Vector3();
  for (let pass = 0; pass < 2; pass++) {
    const rt = pass ? rtN : rtA;
    mat.uniforms.uMode.value = pass;
    if (pass === 0) renderer.setClearColor(new THREE.Color(0.2, 0.32, 0.14), 0);
    else renderer.setClearColor(new THREE.Color(0.5, 0.5, 1.0), 1);
    for (let s = 0; s < species; s++) {
      mesh.geometry = templates[names[s]];
      mat.uniforms.uFoliage.value = conifer[s] ? foliage.needle : foliage.leaf;
      mat.uniforms.uLeafScale.value = conifer[s] ? 0.85 : 0.7;
      center.set(0, IMP.centers[s], 0);
      for (let cy = 0; cy < N; cy++) {
        for (let cx = 0; cx < N; cx++) {
          const d = decode(cx, cy);
          cam.position.copy(center).addScaledVector(d, 100);
          cam.up.set(0, 1, 0);
          if (d.y > 0.999) cam.up.set(0, 0, -1);
          cam.lookAt(center);
          cam.updateMatrixWorld();
          rt.viewport.set((s * N + cx) * cellW, cy * cellH, cellW, cellH);
          rt.scissor.copy(rt.viewport);
          renderer.setRenderTarget(rt);
          renderer.render(scene, cam);
        }
      }
    }
  }
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.toneMapping = prevTM;
  renderer.shadowMap.enabled = prevShadow;
  mat.dispose();
  rtA.texture.name = 'impostor-albedo';
  rtN.texture.name = 'impostor-normal';
  return { albedo: rtA.texture, normal: rtN.texture, targets: [rtA, rtN] };
}

// ------------------------------------------------------------------------------------------------ run time
const VERT_DECL = /* glsl */ `
attribute vec4 aInst;
attribute vec4 aInst2;
uniform vec4 uLod;
uniform float uWorldHalf;
uniform vec4 uImpYc;
uniform vec4 uImp;
uniform sampler2D uTerrainData;
varying float vFade;
varying float vLit;
varying float vTint;
varying float vSp;
varying vec2 vYaw;
varying vec3 vOff;
varying vec3 vDv;
`;

export function createImpostorMaterial(tier, shared, atlas) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  mat.defines = { TIER: tier, A2C: '' };
  mat.alphaToCoverage = true;
  mat.userData.impostor = true;
  const own = {
    uAtlasA: { value: atlas.albedo },
    uAtlasN: { value: atlas.normal },
    uImp: { value: new THREE.Vector4(IMP.worldW, IMP.worldH, IMP.N, IMP.species) },
    uImpYc: { value: new THREE.Vector4(...IMP.centers) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, own);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <beginnormal_vertex>', 'float fadeV = 1.0;\nvec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed;
        {
          float dist = distance(aInst.xyz, cameraPosition);
          float rank = aInst2.y;
          float boost = 1.0;
          #if TIER == 1
            float fi = smoothstep(uLod.x - 14.0, uLod.x + 4.0, dist);
            float t1 = smoothstep(uLod.x, uLod.y, dist);
            float keep = min(uLod.w, mix(1.0, 0.9, t1));
            fadeV = fi * (1.0 - smoothstep(keep - 0.03, keep, rank)) * (1.0 - smoothstep(uLod.y - 100.0, uLod.y, dist));
            boost = mix(1.0, 1.04, t1);
          #else
            float fi = smoothstep(uLod.y - 100.0, uLod.y, dist);
            float t2 = smoothstep(uLod.y, uLod.z, dist);
            float keep = min(uLod.w, mix(0.88, 0.3, pow(t2, 0.7)));
            fadeV = fi * (1.0 - smoothstep(keep - 0.02, keep, rank)) * (1.0 - smoothstep(uLod.z * 0.86, uLod.z, dist));
            boost = mix(1.04, 1.6, pow(t2, 0.8));
          #endif
          boost *= mix(1.3, 1.0, uLod.w) * 1.1;
          vFade = fadeV;
          float sp = floor(aInst2.w + 0.001);
          float asp = clamp(aInst2.w - sp, 0.0, 1.0);
          float wm = 0.92 + 0.4 * asp;
          float sc = aInst.w * boost;
          float yc = sp < 0.5 ? uImpYc.x : sp < 1.5 ? uImpYc.y : sp < 2.5 ? uImpYc.z : uImpYc.w;
          vec3 center = aInst.xyz + vec3(0.0, yc * sc, 0.0);
          vec3 dv = normalize(cameraPosition - center);
          vec3 right = abs(dv.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), dv));
          vec3 up = cross(dv, right);
          vec3 off = right * (position.x * uImp.x) + up * (position.y * uImp.y);
          vec3 offG = right * (position.x * uImp.x * wm) + up * (position.y * uImp.y);
          transformed = center + offG * sc;
          vec2 tuv = (center.xz + uWorldHalf) / (2.0 * uWorldHalf);
          float shY = textureLod(uTerrainData, tuv, 0.0).g;
          vLit = smoothstep(-18.0, 10.0, center.y - shY);
          vTint = aInst2.z;
          vSp = sp;
          vYaw = vec2(cos(aInst2.x), sin(aInst2.x));
          vOff = off;
          vDv = dv;
        }`,
      )
      .replace('#include <project_vertex>', '#include <project_vertex>\nif (fadeV < 0.004) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform sampler2D uAtlasA;
        uniform sampler2D uAtlasN;
        uniform vec4 uImp;
        varying float vFade;
        varying float vLit;
        varying float vTint;
        varying float vSp;
        varying vec2 vYaw;
        varying vec3 vOff;
        varying vec3 vDv;
        float bayer4(vec2 p) {
          int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
          const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
          return (m[y * 4 + x] + 0.5) / 16.0;
        }
        vec3 hoDecode(vec2 c) {
          vec2 e = c / (uImp.z - 1.0) * 2.0 - 1.0;
          float x = (e.x + e.y) * 0.5, z = (e.x - e.y) * 0.5;
          return normalize(vec3(x, max(1.0 - abs(x) - abs(z), 0.0), z));
        }
        void impFrame(vec3 d, out vec3 r, out vec3 u) {
          r = abs(d.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), d));
          u = cross(d, r);
        }
        float impA = 1.0; float impAO = 1.0; vec3 impN = vec3(0.0, 1.0, 0.0);
        // one baked view: re-project the card point into its frame
        void impCell(vec2 cell, vec3 oLoc, float w, inout vec3 alb, inout vec3 nrm, inout float a, inout float ao) {
          vec3 cd = hoDecode(cell);
          vec3 r, u;
          impFrame(cd, r, u);
          vec2 q = clamp(vec2(dot(oLoc, r), dot(oLoc, u)) / uImp.xy + 0.5, vec2(0.015), vec2(0.985));
          vec2 uv = vec2((vSp * uImp.z + cell.x + q.x) / (uImp.w * uImp.z), (cell.y + q.y) / uImp.z);
          vec4 c = texture2D(uAtlasA, uv);
          vec4 n = texture2D(uAtlasN, uv);
          alb += c.rgb * w;
          a += c.a * w;
          ao += n.a * w;
          nrm += (r * (n.x * 2.0 - 1.0) + u * (n.y * 2.0 - 1.0) + cd * (n.z * 2.0 - 1.0)) * w;
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          // direction to the camera and card offset in the tree's own (yaw-free) frame
          vec3 dr = vec3(vYaw.x * vDv.x - vYaw.y * vDv.z, vDv.y, vYaw.y * vDv.x + vYaw.x * vDv.z);
          vec3 oLoc = vec3(vYaw.x * vOff.x - vYaw.y * vOff.z, vOff.y, vYaw.y * vOff.x + vYaw.x * vOff.z);
          dr.y = max(dr.y, 0.03);
          dr = normalize(dr);
          vec2 p = dr.xz / (abs(dr.x) + abs(dr.y) + abs(dr.z));
          vec2 e = vec2(p.x + p.y, p.x - p.y);
          vec2 g = (e * 0.5 + 0.5) * (uImp.z - 1.0);
          vec2 c0 = clamp(floor(g), vec2(0.0), vec2(uImp.z - 2.0));
          vec2 f = g - c0;
          vec3 alb = vec3(0.0), nrm = vec3(0.0);
          float a = 0.0, ao = 0.0;
          if (f.x + f.y < 1.0) {
            impCell(c0, oLoc, 1.0 - f.x - f.y, alb, nrm, a, ao);
            impCell(c0 + vec2(1.0, 0.0), oLoc, f.x, alb, nrm, a, ao);
            impCell(c0 + vec2(0.0, 1.0), oLoc, f.y, alb, nrm, a, ao);
          } else {
            impCell(c0 + vec2(1.0, 1.0), oLoc, f.x + f.y - 1.0, alb, nrm, a, ao);
            impCell(c0 + vec2(0.0, 1.0), oLoc, 1.0 - f.x, alb, nrm, a, ao);
            impCell(c0 + vec2(1.0, 0.0), oLoc, 1.0 - f.y, alb, nrm, a, ao);
          }
          // sharpened coverage for alpha-to-coverage
          float aa = max(fwidth(a), 0.02);
          impA = clamp((a - 0.5) / aa + 0.5, 0.0, 1.0);
          if (impA <= 0.0) discard;
          vec3 tint = mix(vec3(0.72, 0.88, 0.64), vec3(1.3, 1.08, 0.74), vTint);
          tint *= 0.9 + 0.2 * fract(vTint * 7.31);
          diffuseColor.rgb *= alb * tint;
          // normal back to world space: rotate by the tree's yaw
          vec3 nw = normalize(nrm);
          impN = vec3(vYaw.x * nw.x + vYaw.y * nw.z, nw.y, -vYaw.y * nw.x + vYaw.x * nw.z);
          impAO = ao;
        }`,
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(impN, 0.0)).xyz);')
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        #ifdef A2C
          gl_FragColor = vec4(outgoingLight, clamp(vFade, 0.0, 1.0) * impA);
        #else
          if (impA < 0.5 || vFade < bayer4(gl_FragCoord.xy)) discard;
          gl_FragColor = vec4(outgoingLight, 1.0);
        #endif`,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
        {
          float ao = impAO;
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.indirectSpecular *= ao;
          reflectedLight.directDiffuse *= mix(0.4, 1.0, ao) * vLit * 1.3;
          reflectedLight.directSpecular *= vLit;
          #if NUM_DIR_LIGHTS > 0
            vec3 Ls = directionalLights[0].direction;
            float tr = pow(clamp(dot(Ls, -normalize(vViewPosition)), 0.0, 1.0), 2.5);
            reflectedLight.directDiffuse += directionalLights[0].color * tr * RECIPROCAL_PI * diffuseColor.rgb * vec3(1.0, 1.0, 0.55) * 0.75 * ao * vLit;
          #endif
        }`,
      );
  };
  mat.customProgramCacheKey = () => `tree-imp-v1-${tier}`;
  return mat;
}

// a unit quad as the instanced template (position only matters; the other attributes keep the shared helpers happy)
export function impostorQuad() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(new Array(16).fill(1), 4));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}
