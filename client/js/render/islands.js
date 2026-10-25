// Floating sky islands: lush tops with groves, boulders and glowing crystals over layered rock roots, with
// hanging roots and vines, drifting debris and a waterfall that dissolves into mist off each rim.
// The silhouette follows world.skyRockRadius() so what you see is what you crash into.
import * as THREE from 'three';
import { createNoise } from '../../../shared/noise.js';
import { rng } from '../../../shared/math.js';

const HUES = [
  new THREE.Color(0.25, 0.85, 1.0), // cyan
  new THREE.Color(0.65, 0.45, 1.0), // violet
  new THREE.Color(0.3, 1.0, 0.7), // jade
];

export function createSkyIslands(world, textures, ctx = {}) {
  const { vegetation, props, crystals } = ctx;
  const timeU = vegetation ? vegetation.shared.uTime : { value: 0 };
  const group = new THREE.Group();
  group.name = 'sky-islands';

  // ------------------------------------------------------------------------------------------------ rock material
  // stream: the body has an `aStream` attribute (distance to the brook across the meadow); debris does not
  const makeRockMat = (stream) => {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: false });
  if (stream) mat.defines = { STREAM: '' };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.albedoArr = { value: textures.albedo };
    sh.uniforms.normalArr = { value: textures.normal };
    sh.uniforms.uTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;\n#ifdef STREAM\nattribute float aStream; varying float vStream;\n#endif')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef STREAM
          vStream = aStream;
        #endif
        #ifdef USE_INSTANCING
          vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vWNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        #else
          vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWNrm = normalize(mat3(modelMatrix) * normal);
        #endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray albedoArr; uniform sampler2DArray normalArr; uniform float uTime;
        varying vec3 vWPos; varying vec3 vWNrm;
        #ifdef STREAM
        varying float vStream;
        #endif
        float ih(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float inz(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f); return mix(mix(ih(i), ih(i + vec2(1, 0)), u.x), mix(ih(i + vec2(0, 1)), ih(i + vec2(1, 1)), u.x), u.y); }
        vec3 srgb2lin(vec3 c) { return c * c * (c * 0.305306 + 0.682171) + c * 0.012522; }
        vec3 iN; float iRough;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `{
          vec3 N = normalize(vWNrm);
          vec3 bw = pow(abs(N), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
          vec3 p = vWPos;
          // two rock types, warped so the layers never line up with the projection axes
          vec3 wp = p + 3.5 * vec3(inz(p.xz * 0.03), inz(p.yx * 0.035 + 4.0), inz(p.zy * 0.032 + 9.0));
          vec3 cA = texture(albedoArr, vec3(wp.zy / 62.0, 4.0)).rgb * bw.x + texture(albedoArr, vec3(wp.xz / 45.0, 1.0)).rgb * bw.y + texture(albedoArr, vec3(wp.xy / 62.0, 4.0)).rgb * bw.z;
          vec3 cB = texture(albedoArr, vec3(wp.zy / 34.0, 5.0)).rgb * bw.x + texture(albedoArr, vec3(wp.xz / 34.0, 5.0)).rgb * bw.y + texture(albedoArr, vec3(wp.xy / 34.0, 5.0)).rgb * bw.z;
          vec3 rk = mix(cA, cB, smoothstep(0.35, 0.65, inz(p.xz * 0.012 + p.y * 0.006)));
          float lum = dot(rk, vec3(0.33));
          rk = mix(vec3(lum), rk, 0.6);
          // sedimentary banding and weathering streaks
          float band = sin((p.y + (inz(p.xz * 0.02) - 0.5) * 30.0) * 0.12) * 0.5 + 0.5;
          rk *= mix(vec3(0.72, 0.7, 0.68), vec3(1.08, 0.98, 0.88), band);
          rk *= 0.9 + 0.2 * inz(vec2((p.x + p.z) * 0.12, p.y * 0.05));
          vec3 gr = mix(texture(albedoArr, vec3(p.xz / 41.0, 0.0)).rgb, texture(albedoArr, vec3(p.xz / 157.0 + 0.37, 0.0)).rgb, 0.55);
          float camD = length(p - cameraPosition);
          float dry = smoothstep(0.35, 0.8, inz(p.xz * 0.011 + 17.0));
          gr = mix(gr * vec3(0.78, 0.95, 0.62), gr * vec3(1.15, 1.02, 0.6), dry * 0.55);
          gr *= 0.78 + 0.44 * inz(p.xz * 0.017 + 3.0);
          float closeK = 1.0 - smoothstep(25.0, 220.0, camD);
          if (closeK > 0.01) {
            float d1 = dot(texture(albedoArr, vec3(p.xz / 3.3, 0.0)).rgb, vec3(0.34));
            float d2 = dot(texture(albedoArr, vec3(p.xz / 0.9 + 0.2, 0.0)).rgb, vec3(0.34));
            gr *= mix(1.0, (0.55 + d1 * 0.9) * (0.7 + d2 * 0.6), 0.55 * closeK);
          }
          // wind gusts rolling over the meadow
          float gust = (inz(p.xz * 0.05 + vec2(uTime * 6.0, uTime * 3.0)) - 0.5) * 0.7 + (inz(p.xz * 0.16 + vec2(uTime * 10.0, uTime * 4.0)) - 0.5) * 0.3;
          float top = smoothstep(0.5, 0.75, N.y);
          gr *= 1.0 + gust * 0.35;
          float under = smoothstep(0.0, -0.7, N.y);
          rk *= 1.0 - under * 0.5;
          // wildflowers sprinkled over the grass
          vec2 fc = floor(p.xz * 1.5);
          float fh = ih(fc);
          float fl = step(0.985, fh) * top * (1.0 - smoothstep(30.0, 140.0, camD));
          vec3 fcol = mix(mix(vec3(1.0, 0.92, 0.35), vec3(1.0), step(0.4, ih(fc + 3.0))), mix(vec3(0.8, 0.5, 1.0), vec3(1.0, 0.45, 0.4), step(0.5, ih(fc + 7.0))), step(0.7, ih(fc + 11.0)));
          gr = mix(gr, fcol * 0.9, fl * 0.85);
          vec3 col = mix(rk, gr, top);
          // soil lip under the grass, moss creeping down the upper sides
          col = mix(col, vec3(0.2, 0.14, 0.09), smoothstep(0.32, 0.5, N.y) * (1.0 - top) * 0.7);
          float moss = smoothstep(0.1, 0.5, N.y) * (1.0 - top) * smoothstep(0.4, 0.75, inz(p.xz * 0.09 + p.y * 0.05));
          col = mix(col, vec3(0.2, 0.34, 0.12) * lum * 2.2, moss * 0.45);
          vec3 lin = srgb2lin(col);
          float sw = 0.0;
          vec3 ripple = vec3(0.0);
          #ifdef STREAM
            sw = (1.0 - smoothstep(0.2, 0.34, vStream)) * top;
            float bank = (1.0 - smoothstep(0.34, 0.62, vStream)) * top;
            lin = mix(lin, lin * vec3(0.5, 0.46, 0.4), bank * 0.75);
            vec3 wcol = mix(vec3(0.03, 0.09, 0.08), vec3(0.006, 0.03, 0.04), 1.0 - smoothstep(0.0, 0.25, vStream));
            lin = mix(lin, wcol, sw);
            float r0 = inz(p.xz * 0.35 + vec2(uTime * 1.2, uTime * 0.7));
            ripple = vec3((inz(p.xz * 0.35 + vec2(uTime * 1.2 + 0.3, uTime * 0.7)) - r0) * 1.4, 0.0, (inz(p.xz * 0.35 + vec2(uTime * 1.2, uTime * 0.7 + 0.3)) - r0) * 1.4);
          #endif
          diffuseColor.rgb *= lin;
          vec2 nx = texture(normalArr, vec3(wp.zy / 62.0, 4.0)).xy * 2.0 - 1.0, nz = texture(normalArr, vec3(wp.xy / 62.0, 4.0)).xy * 2.0 - 1.0, ny = texture(normalArr, vec3(wp.xz / 45.0, 1.0)).xy * 2.0 - 1.0;
          vec3 off = vec3(0.0, nx.y, nx.x) * bw.x + vec3(nz.x, nz.y, 0.0) * bw.z + vec3(ny.x, 0.0, ny.y) * bw.y;
          iN = normalize(N + off * (1.0 - top * 0.6));
          iN = normalize(mix(iN, normalize(N + ripple), sw));
          iRough = mix(mix(0.92, 0.85, 1.0 - top), 0.1, sw);
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = iRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(iN, 0.0)).xyz);');
  };
  mat.customProgramCacheKey = () => 'skyrock-v4' + (stream ? 's' : '');
  return mat;
  };
  const mat = makeRockMat(true);
  const debrisMat = makeRockMat(false);

  // ------------------------------------------------------------------------------------------------ waterfalls
  const fallUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: timeU }]);
  const waterMat = new THREE.ShaderMaterial({
    uniforms: fallUniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float time;
      varying vec2 vUv;
      float h1(float x) { return fract(sin(x * 91.7) * 43758.5); }
      float n1(float x) { float i = floor(x), f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
      void main() {
        float fall = 1.0 - vUv.y; // 0 at the lip, 1 at the bottom
        float x = vUv.x;
        float streak = n1(x * 38.0 + 3.0) * 0.6 + n1(x * 90.0) * 0.4;
        float sp = 2.6 + 1.4 * n1(x * 13.0);
        float flow = n1(x * 23.0 + floor(vUv.y * 9.0 + time * sp));
        float flow2 = n1(x * 61.0 + 7.0 + floor(vUv.y * 24.0 + time * sp * 1.7));
        float sheet = smoothstep(0.25, 0.75, streak + (flow - 0.5) * 0.6 + (flow2 - 0.5) * 0.25);
        float edge = smoothstep(0.0, 0.16, x) * smoothstep(1.0, 0.84, x);
        float a = (sheet * 0.7 + 0.3) * edge * (1.0 - smoothstep(0.45, 1.0, fall));
        // foam at the lip, thinning ribbons and spray toward the end
        float lip = 1.0 - smoothstep(0.0, 0.07, fall);
        float spray = smoothstep(0.35, 0.9, fall) * (0.6 + 0.4 * flow2);
        a = clamp(a + lip * 0.5, 0.0, 1.0) * 0.9;
        vec3 water = mix(vec3(0.62, 0.8, 0.9), vec3(1.0), sheet * 0.7 + lip + spray * 0.5);
        gl_FragColor = vec4(water * (0.85 + 0.5 * sheet) * 1.15, a);
        #include <fog_fragment>
      }`,
  });
  // mist: soft sprites billowing where the water dissolves
  const mistTex = (() => {
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.35, 'rgba(235,245,255,0.45)');
    gr.addColorStop(1, 'rgba(225,238,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const mistUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: timeU, map: { value: mistTex }, scale: { value: 1000 } }]);
  const mistMat = new THREE.ShaderMaterial({
    uniforms: mistUniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec4 aMist; // x phase, y size, z rise speed, w alpha
      uniform float time;
      uniform float scale;
      varying float vA;
      varying float vPh;
      void main() {
        float ph = fract(aMist.x + time * aMist.z * 0.05);
        vec3 p = position + vec3(sin(aMist.x * 40.0 + time * 0.3), ph * 16.0, cos(aMist.x * 55.0 + time * 0.27)) * (1.0 + ph);
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = aMist.y * (0.7 + ph * 1.1) * scale / max(1.0, -mvPosition.z);
        vA = aMist.w * smoothstep(0.0, 0.2, ph) * (1.0 - smoothstep(0.55, 1.0, ph));
        vPh = ph;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform sampler2D map;
      varying float vA;
      varying float vPh;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        gl_FragColor = vec4(vec3(0.93, 0.96, 1.0), t.a * vA);
        #include <fog_fragment>
      }`,
  });

  // ------------------------------------------------------------------------------------------------ roots and crystals
  const rootMat = new THREE.MeshStandardMaterial({ roughness: 0.95, vertexColors: true });
  rootMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        {
          // roots hang from the rock and sway: the free end swings more
          vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;
          float k = clamp(color.a, 0.0, 1.0);
          transformed.x += sin(uTime * 0.9 + wp0.x * 0.07 + wp0.z * 0.05) * k * k * 1.6;
          transformed.z += cos(uTime * 0.8 + wp0.z * 0.06) * k * k * 1.1;
        }`,
      );
  };
  rootMat.customProgramCacheKey = () => 'skyroot-v1';
  rootMat.vertexColors = true;

  const crystalMat = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.18, metalness: 0.0, vertexColors: false });
  crystalMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aCol;\nvarying vec4 vAC;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAC = aCol;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vAC;\nuniform float uTime;')
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          vec3 hue = vColor.rgb;
          float pulse = 0.85 + 0.15 * sin(uTime * 1.7 + vWorldHash);
          totalEmissiveRadiance += hue * (vAC.r * vAC.r * 1.9 + 0.1) * pulse;
          diffuseColor.rgb = mix(diffuseColor.rgb, hue * 0.25, 0.7);
        }`,
      );
    sh.fragmentShader = sh.fragmentShader.replace('varying vec4 vAC;\nuniform float uTime;', 'varying vec4 vAC;\nuniform float uTime;\nfloat vWorldHash = 0.0;');
  };
  crystalMat.customProgramCacheKey = () => 'skycrystal-v1';

  // soft additive halos so the crystals read from far away
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: mistTex }, scale: mistUniforms.scale, time: timeU },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aGlow;
      uniform float scale; uniform float time;
      varying vec3 vC; varying float vK;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aGlow.w * scale / max(1.0, -mv.z), 2.0, 240.0);
        vK = exp(length(mv.xyz) * -0.00022) * (0.85 + 0.15 * sin(time * 1.7 + position.x));
        vC = aGlow.rgb;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec3 vC; varying float vK;
      void main() { float a = texture2D(map, gl_PointCoord).a; gl_FragColor = vec4(vC * a * vK * 0.55, a * vK); }`,
  });
  const glow = [];
  const falls = [];
  const rootParts = [];
  const crystalInst = [[], [], []]; // matrices + hue per crystal variant
  const debris = []; // animated chunks
  const treeLists = { fir: [], pine: [], oak: [], birch: [], shrub: [] };
  const rockParts = [];
  const mistPos = [];
  const mistAttr = [];

  const dummy = new THREE.Object3D();
  const UP = new THREE.Vector3(0, 1, 0);

  for (let si = 0; si < world.sky.length; si++) {
    const s = world.sky[si];
    const nz = createNoise(s.seed);
    const r = rng(s.seed ^ 0x5bd1e995);
    const SEG = 96;
    const pos = [];
    const idx = [];
    const streamAttr = [];
    const fallA = s.spin;
    // gentle hills on the meadow: the same function places the trees
    const relief = (x, z, rho) => s.r * 0.05 * nz.fbm(x * 0.022 + 5.0, z * 0.022 - 3.0, 3) * Math.min(1, (1 - rho) * 3);
    // a brook from a spring on the far side of the meadow to the waterfall lip; vertices store their distance to it
    const streamPts = [];
    {
      const a0 = fallA + (s.seed % 2 ? 2.1 : -2.1);
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        const a = a0 * (1 - t) + fallA * t + Math.sin(t * 7.0 + s.seed) * 0.16 * Math.sin(t * Math.PI);
        const rr = (0.34 + 0.65 * t * t) * Math.sqrt(s.r * s.r - s.r * 0.3 * s.r * 0.3) + Math.cos(t * 5.0 + s.seed) * 6 * Math.sin(t * Math.PI);
        streamPts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
    }
    const streamDist = (x, z) => {
      let d = 1e9;
      for (let i = 0; i < streamPts.length - 1; i++) {
        const [ax, az] = streamPts[i], [bx, bz] = streamPts[i + 1];
        const vx = bx - ax, vz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
        d = Math.min(d, Math.hypot(x - ax - vx * t, z - az - vz * t));
      }
      return Math.min(1, d / 14);
    };
    const ring = (y, rad, jag, hills = false, cap = false) => {
      const start = pos.length / 3;
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        // broad lumps, sharp vertical fissures, and horizontal ledges that step the silhouette
        const n = nz.fbm(Math.cos(a) * 2.2 + y * 0.012, Math.sin(a) * 2.2 + y * 0.009, 4);
        const crag = 1 - Math.abs(nz.simplex(a * 9.0, y * 0.018));
        const ledge = 0.035 * Math.sin(y * 0.21 + nz.simplex(a * 2.0, y * 0.01) * 3.0);
        const rr = rad * (1 + n * jag + (crag * crag - 0.5) * jag * 0.55 + ledge);
        pos.push(Math.cos(a) * rr, hills ? y + relief(Math.cos(a) * rr, Math.sin(a) * rr, rr / rimR) : y, Math.sin(a) * rr);
        streamAttr.push(cap ? streamDist(Math.cos(a) * rr, Math.sin(a) * rr) : 1);
      }
      return start;
    };
    const rings = [];
    const topY = s.r * 0.3;
    const rimR = Math.sqrt(s.r * s.r - topY * topY);
    for (let k = 0; k <= 15; k++) {
      const f = 1 - k / 16;
      const y = topY + (1 - f * f) * s.r * 0.06 + nz.simplex(k, 3) * 0.8 * f;
      rings.push(ring(y, rimR * f, 0.06, k > 0, true));
    }
    rings.reverse();
    const N = 34;
    for (let k = 1; k <= N; k++) {
      const t = k / N;
      const dy = topY - t * (topY + s.r * 1.75);
      let rad = world.skyRockRadius(s, dy);
      if (rad < 0) rad = 0;
      if (dy < -s.r * 1.2) rad = Math.max(rad, s.r * 0.25 * (1 - -(dy + s.r * 1.2) / (s.r * 0.6)));
      rings.push(ring(dy, Math.max(0.5, rad * 1.02), 0.12 + t * 0.25));
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      for (let k = 0; k < SEG; k++) {
        const k2 = (k + 1) % SEG;
        idx.push(a + k, a + k2, b + k, a + k2, b + k2, b + k);
      }
    }
    const top = pos.length / 3;
    pos.push(0, topY + s.r * 0.07 + relief(0, 0, 0), 0);
    streamAttr.push(streamDist(0, 0));
    for (let k = 0; k < SEG; k++) idx.push(top, rings[0] + (k + 1) % SEG, rings[0] + k);
    const tip = pos.length / 3;
    pos.push(0, topY - (topY + s.r * 1.85), 0);
    streamAttr.push(1);
    const last = rings[rings.length - 1];
    for (let k = 0; k < SEG; k++) idx.push(last + k, last + (k + 1) % SEG, tip);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aStream', new THREE.Float32BufferAttribute(streamAttr, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.x, s.y, s.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // ---- top: groves, boulders, a clear glade round the shrine and a clear sector at the waterfall
    const topAt = (rho, a = 0) => s.y + topY + (1 - rho * rho) * s.r * 0.06 + relief(Math.cos(a) * rho * rimR, Math.sin(a) * rho * rimR, rho) - 0.5;
    const adiff = (a) => Math.abs(Math.atan2(Math.sin(a - fallA), Math.cos(a - fallA)));
    // an islands that carries a rock ring (world.arches, kind 'sky') keeps the ring's footprint clear
    const skyRing = s.ring;
    const nearRing = (x, z) => !!skyRing && Math.hypot(x - Math.cos(skyRing.a) * skyRing.rho, z - Math.sin(skyRing.a) * skyRing.rho) < skyRing.R + skyRing.t + 12;
    const area = Math.PI * (rimR * 0.85) ** 2;
    const nTrees = Math.floor(area / 140);
    for (let i = 0; i < nTrees; i++) {
      const a = r() * Math.PI * 2, rho = Math.sqrt(r()) * 0.86;
      const x = Math.cos(a) * rho * rimR, z = Math.sin(a) * rho * rimR;
      const dist = rho * rimR;
      if (dist < 20) continue; // shrine glade
      if (streamDist(x, z) < 0.5) continue; // the brook
      if (rho > 0.55 && adiff(a) < 0.3) continue; // waterfall
      if (nearRing(x, z)) continue;
      const grove = nz.fbm(x * 0.03 + 4.0, z * 0.03 - 2.0, 2);
      if (grove < -0.12 && r() < 0.8) continue;
      const q = r();
      const sp = q < 0.28 ? 'fir' : q < 0.5 ? 'oak' : q < 0.68 ? 'birch' : q < 0.8 ? 'pine' : 'shrub';
      const sc = (sp === 'shrub' ? 1.0 + r() * 1.0 : 0.85 + r() * 0.6) * (1 - rho * 0.2);
      treeLists[sp].push([s.x + x, topAt(rho, a), s.z + z, sc, r() * 6.283, r(), r(), r()]);
    }
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2, rho = 0.25 + r() * 0.62;
      if (adiff(a) < 0.25 || nearRing(Math.cos(a) * rho * rimR, Math.sin(a) * rho * rimR)) continue;
      const g = props && props.rockGeo['rock' + ((r() * 5) | 0)];
      if (!g) continue;
      const sc = 1.2 + r() * 3.2;
      rockParts.push({ g, x: s.x + Math.cos(a) * rho * rimR, y: topAt(rho, a) + 0.1 * sc, z: s.z + Math.sin(a) * rho * rimR, sx: sc, sy: sc * 0.8, sz: sc, yaw: r() * 6.283 });
    }

    // ---- crystals: a few on top, many hanging from the underside, some jutting from the flanks
    const hue = si % HUES.length;
    const addCrystal = (px, py, pz, dir, size) => {
      dummy.position.set(px, py, pz);
      dummy.quaternion.setFromUnitVectors(UP, dir.normalize());
      dummy.rotateY(r() * 6.283);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      crystalInst[(r() * 3) | 0].push({ m: dummy.matrix.clone(), hue });
      const h = HUES[hue];
      glow.push(px + dir.x * size * 0.5, py + dir.y * size * 0.5, pz + dir.z * size * 0.5, h.r, h.g, h.b, size * 3.2);
    };
    for (let i = 0; i < 3; i++) {
      const a = r() * 6.283, rho = 0.45 + r() * 0.4;
      if (adiff(a) < 0.35 || nearRing(Math.cos(a) * rho * rimR, Math.sin(a) * rho * rimR)) continue;
      addCrystal(s.x + Math.cos(a) * rho * rimR, topAt(rho, a) - 0.3, s.z + Math.sin(a) * rho * rimR, new THREE.Vector3((r() - 0.5) * 0.5, 1, (r() - 0.5) * 0.5), 7 + r() * 6.0);
    }
    for (let i = 0; i < 7; i++) {
      const a = r() * 6.283, dy = -s.r * (0.25 + r() * 0.8);
      const R = world.skyRockRadius(s, dy);
      if (R <= 0) continue;
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      if (i < 4) {
        addCrystal(s.x + out.x * R * 0.98, s.y + dy, s.z + out.z * R * 0.98, new THREE.Vector3(out.x * 0.5, -1, out.z * 0.5), 18 + r() * 22 * (s.r / 120));
      } else {
        addCrystal(s.x + out.x * R * 0.98, s.y + dy, s.z + out.z * R * 0.98, new THREE.Vector3(out.x, 0.25, out.z), 12 + r() * 14);
      }
    }

    // ---- hanging roots and vines on the flanks and underside
    const nRoots = Math.floor(14 + s.r * 0.22);
    for (let i = 0; i < nRoots; i++) {
      const a = r() * 6.283, dy = -s.r * (0.02 + r() * 0.85);
      let R = world.skyRockRadius(s, dy);
      if (R <= 2) continue;
      if (adiff(a) < 0.2 && dy > -s.r * 0.3) continue;
      const len = (8 + r() * 26) * (0.7 + s.r / 220);
      const segs = 7;
      const px = [], rad = [];
      let x = s.x + Math.cos(a) * R * 0.97, y = s.y + dy, z = s.z + Math.sin(a) * R * 0.97;
      let dx = Math.cos(a) * 0.35, dz = Math.sin(a) * 0.35;
      for (let k = 0; k <= segs; k++) {
        px.push(new THREE.Vector3(x, y, z));
        const t = k / segs;
        rad.push(Math.max(0.03, (0.5 + r() * 0.25) * (1 - t) ** 1.2 * (0.5 + s.r / 260)));
        y -= len / segs;
        dx *= 0.55; dz *= 0.55;
        x += dx * len / segs + (r() - 0.5) * 1.2;
        z += dz * len / segs + (r() - 0.5) * 1.2;
      }
      rootParts.push({ pts: px, rad: rad.map((v) => v * 3.2), leafy: false, len });
    }

    // ---- waterfall off the rim, fading into mist as it falls
    const fallH = 200 + s.r * 1.0;
    const fgeo = new THREE.PlaneGeometry(s.r * 0.16, fallH, 1, 24);
    const fp = fgeo.getAttribute('position');
    for (let i = 0; i < fp.count; i++) {
      const t = (fallH / 2 - fp.getY(i)) / fallH;
      fp.setX(i, fp.getX(i) * (1 + t * 1.6));
      fp.setZ(i, Math.sqrt(Math.max(0, t)) * s.r * 0.3 + t * t * 30);
    }
    fgeo.translate(0, -fallH / 2, 0);
    const fall = new THREE.Mesh(fgeo, waterMat);
    fall.position.set(s.x + Math.cos(fallA) * rimR * 0.97, s.y + topY, s.z + Math.sin(fallA) * rimR * 0.97);
    fall.rotation.y = -fallA + Math.PI / 2;
    group.add(fall);
    falls.push(fall);
    // mist puffs along the lower half of the fall, widening downward
    for (let i = 0; i < 26; i++) {
      const t = 0.45 + 0.55 * r();
      const lx = (r() - 0.5) * s.r * 0.22 * (1 + t * 2), lz = Math.sqrt(t) * s.r * 0.3 + t * t * 30 + (r() - 0.3) * 10;
      const wx = Math.cos(fallA) * rimR * 0.97, wz = Math.sin(fallA) * rimR * 0.97;
      // local x runs along the tangent, z outward (matches the plane's rotation)
      const tx = -Math.sin(fallA), tz = Math.cos(fallA);
      const ox = Math.cos(fallA), oz = Math.sin(fallA);
      mistPos.push(s.x + wx + tx * lx + ox * lz, s.y + topY - fallH * t, s.z + wz + tz * lx + oz * lz);
      mistAttr.push(r(), 28 + r() * 40 * (0.5 + t), 0.6 + r() * 0.9, 0.18 + 0.2 * r());
    }

    // ---- drifting debris
    for (let i = 0; i < 4; i++) {
      const a = r() * 6.283, d = s.r * (1.15 + r() * 0.5), y = s.y - s.r * (0.1 + r() * 0.9);
      debris.push({ cx: s.x, cz: s.z, a, d, y, w: 0.02 + r() * 0.03, sc: 1.5 + r() * 3.5, ph: r() * 6.283, v: (r() * 3) | 0, spin: [r() - 0.5, r() - 0.5, r() - 0.5] });
    }
  }

  // ------------------------------------------------------------------------------------------------ build shared meshes
  if (vegetation && vegetation.addStatic) {
    const rowsFor = (rows) => rows.sort((a, b) => a[5] - b[5]);
    const lists = {};
    for (const k of Object.keys(treeLists)) lists[k] = rowsFor(treeLists[k]);
    vegetation.addStatic(lists);
  }
  if (rockParts.length && props) {
    const m = new THREE.Mesh(props.mergeParts(rockParts), props.skyRockMat);
    group.add(m);
  }
  if (rootParts.length) group.add(new THREE.Mesh(buildRoots(rootParts), rootMat));
  if (crystals) {
    const names = ['crystal0', 'crystal1', 'crystal2'];
    names.forEach((n, v) => {
      const list = crystalInst[v];
      if (!list.length || !crystals[n]) return;
      const im = new THREE.InstancedMesh(crystals[n], crystalMat, list.length);
      list.forEach((c, i) => {
        im.setMatrixAt(i, c.m);
        im.setColorAt(i, HUES[c.hue]);
      });
      im.frustumCulled = false;
      group.add(im);
    });
  }
  if (mistPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(mistPos, 3));
    g.setAttribute('aMist', new THREE.Float32BufferAttribute(mistAttr, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 750, 0), 3000);
    const pts = new THREE.Points(g, mistMat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    group.add(pts);
  }
  if (glow.length) {
    const g = new THREE.BufferGeometry();
    const n = glow.length / 7;
    const pa = new Float32Array(n * 3), ca = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      pa.set(glow.slice(i * 7, i * 7 + 3), i * 3);
      ca.set(glow.slice(i * 7 + 3, i * 7 + 7), i * 4);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pa, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(ca, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 750, 0), 3000);
    const pts = new THREE.Points(g, glowMat);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    group.add(pts);
  }
  let debrisMesh = null;
  if (debris.length && props && props.rockGeo.rock1) {
    debrisMesh = new THREE.InstancedMesh(props.rockGeo.rock1, debrisMat, debris.length);
    debrisMesh.frustumCulled = false;
    group.add(debrisMesh);
  }

  const d = new THREE.Object3D();
  group.userData.update = (t, renderer) => {
    if (renderer) mistUniforms.scale.value = renderer.domElement.height * 0.5 * (renderer.getPixelRatio ? 1 : 1);
    if (debrisMesh) {
      for (let i = 0; i < debris.length; i++) {
        const o = debris[i];
        const a = o.a + t * o.w;
        d.position.set(o.cx + Math.cos(a) * o.d, o.y + Math.sin(t * 0.4 + o.ph) * 3, o.cz + Math.sin(a) * o.d);
        d.rotation.set(t * o.spin[0] * 0.3 + o.ph, t * o.spin[1] * 0.3, t * o.spin[2] * 0.3);
        d.scale.set(o.sc, o.sc * 0.8, o.sc);
        d.updateMatrix();
        debrisMesh.setMatrixAt(i, d.matrix);
      }
      debrisMesh.instanceMatrix.needsUpdate = true;
    }
  };
  return group;
}

// tapered tubes (5 sides) along each root path; vertex alpha is the sway weight (0 at the rock, 1 at the tip);
// leafy roots get a few leaf clumps
function buildRoots(parts) {
  const pos = [], col = [], idx = [];
  const sides = 5;
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tang = new THREE.Vector3();
  const bark = [0.075, 0.052, 0.035], bark2 = [0.04, 0.028, 0.02], leaf = [0.05, 0.12, 0.03], leaf2 = [0.1, 0.18, 0.04];
  for (const p of parts) {
    const base = pos.length / 3;
    const n = p.pts.length;
    for (let k = 0; k < n; k++) {
      tang.subVectors(p.pts[Math.min(k + 1, n - 1)], p.pts[Math.max(k - 1, 0)]).normalize();
      tmpA.set(1, 0, 0);
      if (Math.abs(tang.x) > 0.9) tmpA.set(0, 0, 1);
      tmpA.crossVectors(tang, tmpA).normalize();
      tmpB.crossVectors(tang, tmpA).normalize();
      const t = k / (n - 1);
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        pos.push(
          p.pts[k].x + (tmpA.x * Math.cos(a) + tmpB.x * Math.sin(a)) * p.rad[k],
          p.pts[k].y + (tmpA.y * Math.cos(a) + tmpB.y * Math.sin(a)) * p.rad[k],
          p.pts[k].z + (tmpA.z * Math.cos(a) + tmpB.z * Math.sin(a)) * p.rad[k],
        );
        const c = t < 0.6 ? bark : bark2;
        col.push(c[0], c[1], c[2], t);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      for (let s = 0; s < sides; s++) {
        const a = base + k * sides + s, b = base + k * sides + ((s + 1) % sides), c = a + sides, d = b + sides;
        idx.push(a, c, b, b, c, d);
      }
    }
    if (p.leafy) {
      // a few leaf clumps (flattened octahedra) along the lower half
      for (let q = 0; q < 3; q++) {
        const k = Math.min(n - 1, 3 + q * 2 % (n - 3));
        const c = p.pts[k], rr = 1.8 + q * 0.7, t = k / (n - 1);
        const b0 = pos.length / 3;
        const vs = [[1, 0, 0], [-1, 0, 0], [0, 0.6, 0], [0, -0.9, 0], [0, 0, 1], [0, 0, -1]];
        for (const v of vs) {
          pos.push(c.x + v[0] * rr * 1.5, c.y + v[1] * rr, c.z + v[2] * rr * 1.5);
          const lc = v[1] > 0 ? leaf2 : leaf;
          col.push(lc[0], lc[1], lc[2], t);
        }
        for (const f of [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]]) idx.push(b0 + f[0], b0 + f[1], b0 + f[2]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
