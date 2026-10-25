// Ocean. A camera-centred clip-map of grids (fine under you, doubling out to the horizon) displaced by Gerstner
// waves whose short components fade with distance, so the sea is a real wave field at low altitude and a calm,
// glittering sheet from a mile up. The fragment shader re-evaluates the wave normals per pixel (ten components,
// each faded by distance), adds scrolling normal-map ripples, and shades with Fresnel reflection of the HDRI
// sky and of the cloud layers, a roughness-widened sun glitter, sub-surface turquoise in the crests, foam where
// the surface folds, shore foam and turquoise shallows from the terrain data, mountain shadows and cloud shadows.
import * as THREE from 'three';
import { WORLD } from '../../../shared/constants.js';
import { SKY, fogFunctions } from './atmosphere.js';
import { CLOUD_TEX } from './cloudfield.js';

// [wavelength m, direction rad, steepness k*A]
const WAVES = [
  [260, 0.2, 0.08], [170, 1.15, 0.07], [120, -0.75, 0.07], [85, 2.0, 0.052], [60, 0.55, 0.045], [41, -1.5, 0.05],
  [29, 2.6, 0.04], [19, -0.2, 0.035], [13, 1.6, 0.03], [8.5, -2.3, 0.025],
];

function clipmapGeometry(levels = 6, N = 64, s0 = 8) {
  const pos = [], lvl = [], idx = [];
  let base = 0;
  for (let L = 0; L < levels; L++) {
    const s = s0 * 2 ** L, half = (N * s) / 2;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        pos.push(i * s - half, 0, j * s - half);
        lvl.push(L, s);
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        // the middle half is covered by the finer level (one cell less, so snapping never opens a gap)
        if (L > 0 && i >= N / 4 + 1 && i < (3 * N) / 4 - 1 && j >= N / 4 + 1 && j < (3 * N) / 4 - 1) continue;
        const a = base + j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    base += (N + 1) * (N + 1);
  }
  // far ring out to the horizon: four quads around the last level
  const s = s0 * 2 ** (levels - 1), half = (N * s) / 2, far = 60000;
  const quad = (x0, z0, x1, z1) => {
    const o = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1);
    for (let k = 0; k < 4; k++) lvl.push(levels, s); // snaps with the outermost grid, so no gap opens as the camera moves
    idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
  };
  quad(-far, -far, far, -half);
  quad(-far, half, far, far);
  quad(-far, -half, -half, half);
  quad(half, -half, far, half);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aLevel', new THREE.Float32BufferAttribute(lvl, 2));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 90000);
  return geo;
}

const waveGLSL = (n) => /* glsl */ `
const int NW = ${n};
const vec4 WAVE[10] = vec4[10](${WAVES.map(([l, a, e]) => {
  const k = (2 * Math.PI) / l;
  return `vec4(${k.toFixed(5)}, ${Math.cos(a).toFixed(4)}, ${Math.sin(a).toFixed(4)}, ${e})`;
}).join(', ')});
`;

export function createOcean(normals, skyTex) {
  normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
  normals.colorSpace = THREE.NoColorSpace;
  const vMin = (SKY.minElevation + 90) / 180;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 },
    normals: { value: null },
    sky: { value: null },
    terrainData: { value: null },
    hasData: { value: 0 },
    worldHalf: { value: WORLD.terrainHalf },
    sunDir: { value: SKY.sunDir.clone() },
    sunColor: { value: SKY.sunColor.clone() },
    skyScale: { value: 1 / SKY.skyScale },
  }]);
  uniforms.normals.value = normals;
  uniforms.sky.value = skyTex;
  uniforms.cloudWeather = CLOUD_TEX; // shared with the cloud renderer; filled in when clouds are created

  const common = /* glsl */ `
    uniform float time;
    uniform sampler2D normals;
    ${waveGLSL(10)}
    // Gerstner sum over the first n components. p: world xz. fadeLen scales how far each wave carries.
    // returns displacement in xyz; h is a crest measure; slope accumulates (dh/dx, dh/dz); jac the fold factor.
    void gerstner(vec2 p, float dist, int n, float fadeLo, float fadeHi, out vec3 disp, out vec2 slope, out float jac, out float crest) {
      disp = vec3(0.0); slope = vec2(0.0); crest = 0.0;
      // domain warp: the crests meander instead of running ruler-straight
      p += (texture2D(normals, p / 520.0 + 0.17).rg - 0.5) * 55.0 + (texture2D(normals, p / 190.0 + 0.61).gb - 0.5) * 16.0;
      // slowly varying gusts so the swell is never a uniform corduroy
      float gust = 0.5 + 1.0 * texture2D(normals, p / 1300.0 + vec2(0.31, 0.77) + vec2(time * 0.0008, 0.0)).r;
      float jxx = 0.0, jzz = 0.0, jxz = 0.0;
      for (int i = 0; i < 10; i++) {
        if (i >= n) break;
        vec4 w = WAVE[i];
        float lam = 6.2831853 / w.x;
        float foot = dist * dist * 0.004 / max(abs(cameraPosition.y - 1.0), 6.0);
        float f = smoothstep(foot * fadeLo, foot * fadeHi, lam);
        if (f <= 0.0) continue;
        float ph = w.x * (w.y * p.x + w.z * p.y) - sqrt(9.81 * w.x) * time * 1.0 + float(i) * 1.7;
        float c = cos(ph), s = sin(ph);
        float e = w.w * f * (i < 3 ? mix(0.8, gust, 0.5) : gust);   // k*A
        disp.x += -w.y * e / w.x * s;         // horizontal pull toward the crest
        disp.z += -w.z * e / w.x * s;
        disp.y += e / w.x * c;
        slope += vec2(w.y, w.z) * (-e * s);   // d(height)/d(x,z)
        jxx += e * w.y * w.y * c; jzz += e * w.z * w.z * c; jxz += e * w.y * w.z * c;
        crest += e * c;
      }
      jac = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
    }`;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    defines: { FRAG_WAVES: 10, CLOUD_REFL: 1 },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec2 aLevel; // level, cell size
      varying vec3 vW;
      varying vec2 vP;
      varying float vDist;
      ${common}
      void main() {
        vec2 snapped = floor(cameraPosition.xz / aLevel.y + 0.5) * aLevel.y;
        vec3 wp = vec3(position.x + snapped.x, 0.0, position.z + snapped.y);
        vP = wp.xz;
        float dist = length(wp - cameraPosition);
        vec3 disp; vec2 slope; float jac, crest;
        gerstner(wp.xz, dist, 6, 5.0, 14.0, disp, slope, jac, crest);
        wp += disp;
        vW = wp;
        vDist = dist;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float worldHalf, hasData, skyScale;
      uniform sampler2D sky, terrainData;
      uniform vec3 sunDir, sunColor;
      varying vec3 vW;
      varying vec2 vP;
      varying float vDist;
      ${common}
      vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      vec3 skyColor(vec3 d) {
        d.y = max(d.y, 0.02);
        d = normalize(d);
        float u = atan(d.z, d.x) * 0.15915494 + 0.5;
        float v = asin(d.y) * 0.31830989 + 0.5;
        float t = clamp((v - ${vMin.toFixed(5)}) / ${(1 - vMin).toFixed(5)}, 0.002, 0.998);
        return toLinear(texture2D(sky, vec2(u, t)).rgb) * skyScale;
      }
      // the cloud layers seen in the mirror: underside colour and coverage from the weather map
      vec3 withClouds(vec3 sk, vec3 P, vec3 R) {
        float grazing = smoothstep(0.03, 0.16, R.y); // no hard edge where the mirrored layers reach the horizon
        if (grazing <= 0.0) return sk;
        vec2 drift = vec2(fogNear, fogFar);
        for (int l = 0; l < 2; l++) {
          float yb = l == 0 ? 1390.0 : 700.0;
          float t = (yb - P.y) / R.y;
          vec3 q = P + R * t;
          vec4 w = textureLod(cloudWeather, (q.xz - drift) / ${'24576.0'}, clamp(log2(t * 0.0014 + 1.0) * 1.6 + 1.5, 1.5, 6.0));
          float thick = l == 0 ? w.x : w.y;
          float cov = smoothstep(10.0, 260.0, thick);
          // undersides: one soft grey that only darkens a little where the cloud is thick (no bright rim: that read as rings)
          vec3 under = vec3(0.6, 0.65, 0.75) * (1.0 - 0.3 * smoothstep(80.0, 600.0, thick));
          under += sunColor * 0.3 * pow(max(dot(R, sunDir), 0.0), 8.0) * (1.0 - smoothstep(60.0, 300.0, thick));
          float hz = 1.0 - exp(-t * 0.00006);
          under = mix(under, sk, hz);
          // seen from above the cloud decks the mirror shows their hidden undersides: keep that subtle
          cov *= 1.0 - 0.8 * smoothstep(900.0, 2300.0, cameraPosition.y);
          cov *= grazing * (1.0 - smoothstep(25000.0, 60000.0, t));
          sk = mix(sk, under, cov * (1.0 - hz * 0.6));
        }
        return sk;
      }
      void main() {
        vec3 view = vW - cameraPosition;
        float dist = length(view);
        vec3 V = view / dist;
        vec2 p = vP;
        vec3 disp; vec2 slope; float jac, crest;
        gerstner(p, dist, FRAG_WAVES, 2.5, 8.0, disp, slope, jac, crest);
        // scrolling normal-map ripples, carried farther at low altitude
        float rip = 1.0 - smoothstep(60.0, 1000.0, dist);
        vec2 t = vec2(time);
        vec3 n1 = texture2D(normals, p / 37.0 + t * vec2(0.012, 0.008)).xzy * 2.0 - 1.0;
        vec3 n2 = texture2D(normals, p / 23.0 - t * vec2(0.010, -0.014)).xzy * 2.0 - 1.0;
        vec3 n3 = texture2D(normals, p / 9.0 + t * vec2(0.02, -0.013)).xzy * 2.0 - 1.0;
        vec2 detail = (n1.xz / max(n1.y, 0.2) + n2.xz / max(n2.y, 0.2)) * 0.5 + (n3.xz / max(n3.y, 0.2)) * 0.5 * (1.0 - smoothstep(60.0, 500.0, dist));
        detail += (texture2D(normals, p / 171.0 + t * vec2(-0.003, 0.004)).xzy * 2.0 - 1.0).xz * 0.9;
        vec2 sl = slope + detail * 0.11 * rip + detail * 0.012 * (1.0 - rip);
        vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
        // the horizon should not mirror a pixel-sized facet: lean the normal toward up a little as the view grazes
        N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(2000.0, 16000.0, dist) * 0.6));

        vec4 td = vec4(-300.0, -1000.0, 1.0, 0.0);
        vec2 duv = (p + worldHalf) / (2.0 * worldHalf);
        if (hasData > 0.5 && all(greaterThan(duv, vec2(0.0))) && all(lessThan(duv, vec2(1.0)))) td = texture2D(terrainData, duv);
        float depth = max(0.0, -td.r);
        float lit = smoothstep(-25.0, 15.0, 0.0 - td.g);
        float csh = cloudShadowFactor();
        float sunLit = lit * csh;

        vec3 R = reflect(V, N);
        R.y = abs(R.y) + 0.12 * smoothstep(1500.0, 14000.0, dist); // distant facets mirror higher, bluer sky
        float cosT = clamp(dot(-V, N), 0.0, 1.0);
        float fres = (0.02 + 0.98 * pow(1.0 - cosT, 5.0)) * mix(1.0, 0.8, smoothstep(1500.0, 14000.0, dist));
        vec3 refl = skyColor(R);
        #if CLOUD_REFL
        refl = withClouds(refl, vW, R);
        #endif

        // body colour: deep blue-green, turquoise over shallow sand
        vec3 deep = vec3(0.006, 0.042, 0.085);
        vec3 shallow = vec3(0.03, 0.2, 0.2);
        float sh = exp(-depth / 9.0);
        vec3 body = mix(deep, shallow, sh);
        vec3 amb = hazeTable(vec3(0.0, 0.6, 0.8)) * 0.9;
        float sunN = max(dot(N, sunDir), 0.0);
        vec3 scatter = body * (amb + sunColor * sunN * 2.2 * sunLit);
        // sub-surface: sunlight through thin crests toward the viewer
        float hN = clamp(crest * 1.2 + 0.5, 0.0, 1.0);
        vec3 Hs = normalize(sunDir + N * 0.6);
        float sss = pow(clamp(dot(V, -Hs), 0.0, 1.0), 3.0) * hN * hN * (1.0 - fres);
        scatter += vec3(0.03, 0.34, 0.3) * sss * sunLit * 1.6 * (1.0 - sh * 0.6);
        vec3 col = mix(scatter, refl, fres);

        // sun glitter: GGX whose roughness widens with distance (unresolved waves)
        float alpha = mix(0.035, 0.22, smoothstep(150.0, 9000.0, dist)) + 0.02;
        vec3 H = normalize(sunDir - V);
        float nh = max(dot(N, H), 0.0);
        float a2 = alpha * alpha;
        float dd = nh * nh * (a2 - 1.0) + 1.0;
        float D = a2 / (3.14159 * dd * dd);
        float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(H, -V), 0.0), 5.0);
        float spec = min(D * Fh * 0.25 / max(cosT, 0.06) * step(0.0, dot(N, sunDir)), 400.0);
        col += sunColor * spec * 1.4 * sunLit;

        // foam: where the surface folds over itself, plus a noisy crest line
        float fn = texture2D(normals, p / 7.0 + vec2(time * 0.03, -time * 0.02)).r * texture2D(normals, p / 12.0 - vec2(time * 0.02, time * 0.015)).g;
        float fold = smoothstep(0.62, 0.32, jac);
        float foamW = fold * smoothstep(0.12, 0.45, fn + fold * 0.35) * (1.0 - smoothstep(1500.0, 7000.0, dist) * 0.7);
        // shore foam: breaking fronts rolling in
        float foamBand = (1.0 - smoothstep(0.0, 4.5, depth)) * step(0.01, depth + 0.6);
        float front = 0.5 + 0.5 * sin(depth * 1.6 - time * 1.4 + fn * 5.0);
        float foamS = foamBand * smoothstep(0.15, 0.4, fn * (0.5 + front) + foamBand * 0.3);
        float foam = max(foamW * 0.9, foamS * 0.8);
        vec3 foamCol = vec3(0.92, 0.95, 0.97) * (0.35 + 0.65 * sunLit) + amb * 0.2;
        col = mix(col, foamCol, foam);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(clipmapGeometry(), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.update = (t) => {
    uniforms.time.value = t;
  };
  mesh.setTerrainData = (tex) => {
    uniforms.terrainData.value = tex;
    uniforms.hasData.value = 1;
  };
  mesh.setQuality = (q) => {
    mat.defines.FRAG_WAVES = q >= 1 ? 10 : 7;
    mat.defines.CLOUD_REFL = q >= 1 ? 1 : 0;
    mat.needsUpdate = true;
  };
  return mesh;
}
