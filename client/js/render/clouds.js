// Volumetric cumulus you can fly through.
//
// The cloud field (cloudfield.js) is a tiling 2D weather map of cloud thickness for two layers. Each frame a
// reduced-resolution pass raymarches it from the camera: macro density from the map, eroded by 3D Perlin-Worley
// noise (baked on the GPU at start-up), lit with Beer-Lambert extinction, a powder term, a dual-lobe Henyey-Greenstein
// phase function and a three-octave multiple-scattering approximation, then hazed with the same height fog as the
// rest of the world. A full-screen quad inside the scene composites the result: it writes the cloud's entry depth as
// gl_FragDepth, so the depth test against terrain, islands and dragons occludes it at full resolution, while
// transparent effects (renderOrder > 10: fire, smoke, trails) still draw on top of it.
// Clouds.density(p) (0..1) is the CPU twin of the macro shape and drives radar hiding and the whiteout.
import * as THREE from 'three';
import { SKY, fogFunctions } from './atmosphere.js';
import { WORLD } from '../../../shared/constants.js';
import { CF, MACRO_GLSL, CLOUD_TEX, buildWeather, WeatherField } from './cloudfield.js';

// Cloud shadows for every lit material and the ocean. Clouds are analytic here: the sun ray from a point is
// followed up to each layer, the weather map's thickness there gives the optical depth. The map reaches the
// shaders through three.js's built-in uniform tables (ShaderLib) and the drift through fogNear/fogFar (SkyFog).
function installCloudShadows(tex) {
  CLOUD_TEX.value = tex;
  const v = SKY.sunDir;
  const fn = /* glsl */ `
  uniform sampler2D cloudWeather;
  float cloudShadowFactor() {
    vec3 p = vFogWorld;
    vec3 L = vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)});
    vec2 drift = vec2(fogNear, fogFar);
    float tr = 1.0;
    for (int l = 0; l < 2; l++) {
      float ym = l == 0 ? ${(CF.layers[0].base + 220).toFixed(1)} : ${(CF.layers[1].base + 90).toFixed(1)};
      float t = (ym - p.y) / L.y;
      if (t <= 0.0) continue;
      vec3 q = p + L * t;
      vec4 w = textureLod(cloudWeather, (q.xz - drift) / ${CF.tile.toFixed(1)}, 1.5);
      tr *= exp(-0.0105 * (l == 0 ? w.x : w.y));
    }
    return 0.12 + 0.88 * tr;
  }`;
  const chunk = THREE.ShaderChunk.fog_pars_fragment;
  if (!chunk.includes('cloudShadowFactor')) THREE.ShaderChunk.fog_pars_fragment = chunk.replace(/#endif\s*$/, fn + '\n#endif');
  const lp = THREE.ShaderChunk.lights_pars_begin;
  if (!lp.includes('cloudShadowFactor')) {
    THREE.ShaderChunk.lights_pars_begin = lp.replace(
      'light.color = directionalLight.color;',
      `light.color = directionalLight.color;
#ifdef USE_FOG
		light.color *= cloudShadowFactor();
#endif`,
    );
  }
  for (const k of ['lambert', 'phong', 'standard', 'physical', 'toon']) {
    if (THREE.ShaderLib[k]) THREE.ShaderLib[k].uniforms.cloudWeather = { value: tex };
  }
}

const WIND = new THREE.Vector2(5.5, 2.4); // m/s: the whole field drifts
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const DRIFT_PERIOD = 8601600; // lcm of the weather tile (16384), shape (1200) and detail (420) periods

const QUALITY = [
  // scale: fraction of the render size, steps per slab, step growth, light samples
  { scale: 0.25, steps: 56, grow: 0.06, coarse: 0.14, light: 3 },
  { scale: 0.36, steps: 96, grow: 0.04, coarse: 0.1, light: 4 },
  { scale: 0.5, steps: 150, grow: 0.03, coarse: 0.08, light: 5 },
];

// ---------------------------------------------------------------- noise baking
const NOISE_GLSL = /* glsl */ `
vec3 h33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
// inverted, tiling worley: 1 at feature points
float worleyInv(vec3 p, float f) {
  vec3 q = p * f, i = floor(q), fr = fract(q);
  float d = 8.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = h33(mod(i + g, f));
    vec3 r = g + o - fr;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
float perlin(vec3 p, float f) {
  vec3 q = p * f, i = floor(q), fr = fract(q);
  vec3 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  float v[8];
  for (int k = 0; k < 8; k++) {
    vec3 g = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 gr = h33(mod(i + g, f)) * 2.0 - 1.0;
    v[k] = dot(gr, fr - g);
  }
  float x0 = mix(v[0], v[1], u.x), x1 = mix(v[2], v[3], u.x), x2 = mix(v[4], v[5], u.x), x3 = mix(v[6], v[7], u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z) * 0.5 + 0.5;
}`;

const bakeShader = (detail) => /* glsl */ `
precision highp float;
uniform float layer;
varying vec2 vUv;
${NOISE_GLSL}
layout(location = 0) out highp vec4 outColor;
void main() {
  vec3 p = vec3(vUv, layer);
  ${detail
    ? `outColor = vec4(worleyInv(p, 4.0), worleyInv(p, 8.0), worleyInv(p, 16.0), 1.0);`
    : `float pf = perlin(p, 3.0) * 0.55 + perlin(p, 6.0) * 0.3 + perlin(p, 12.0) * 0.15;
  float w4 = worleyInv(p, 4.0);
  float pw = w4 + pf * (1.0 - w4);
  pw = clamp((pw - 0.18) / 0.82, 0.0, 1.0);
  outColor = vec4(pw, w4, worleyInv(p, 8.0), worleyInv(p, 16.0));`}
}`;

const FULLSCREEN_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function bake3D(renderer, size, detail) {
  const rt = new THREE.WebGL3DRenderTarget(size, size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
  rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.RepeatWrapping;
  rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { layer: { value: 0 } },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: bakeShader(detail),
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  for (let z = 0; z < size; z++) {
    mat.uniforms.layer.value = (z + 0.5) / size;
    renderer.setRenderTarget(rt, z);
    renderer.render(scene, cam);
  }
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.geometry.dispose();
  return rt;
}

// ---------------------------------------------------------------- the march
const marchFragment = (hdr) => /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D weather, terrainData;
uniform sampler3D shapeTex, detailTex;
uniform float hasTerrain, worldHalf, time, sigma;
uniform vec2 jitter;
uniform vec4 tune; // shape lo, shape hi, detail erosion, cover
uniform vec4 lightK; // sun scale, ambient scale, multiscatter a decay, b decay
uniform vec2 pxJitter; // sub-pixel offset in ndc, different every frame: the accumulation turns it into anti-aliasing
uniform vec2 wind;
uniform mat4 invProj, camWorld;
uniform vec3 sunDir, sunRad, ambTop, ambBot, fogColor;
uniform float fogDensity;
varying vec2 vUv;
layout(location = 0) out highp vec4 outColor;
layout(location = 1) out highp vec4 outInfo;

${MACRO_GLSL}
${fogFunctions()}

const float TMAX = 23000.0;
const float SHAPE_SCALE = 1.0 / 1200.0;
const float DETAIL_SCALE = 1.0 / 420.0;
// slab extents of the two layers
const vec2 SLAB_A = vec2(${(CF.layers[0].base - CF.layers[0].wobble).toFixed(1)}, ${(CF.layers[0].base + CF.layers[0].wobble + CF.layers[0].maxThick).toFixed(1)});
const vec2 SLAB_B = vec2(${(CF.layers[1].base - CF.layers[1].wobble).toFixed(1)}, ${(CF.layers[1].base + CF.layers[1].wobble + CF.layers[1].maxThick).toFixed(1)});

vec3 gCol; float gT; float gEntry; float gWD; bool gDone;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); } // 4*pi*HG: isotropic = 1

vec4 wthr(vec2 xz) { return textureLod(weather, (xz - wind) / CF_TILE, 0.0); }
float macroOf(vec4 w, vec3 p, int layer) {
  float thick = layer == 0 ? w.x : w.y;
  float base = layer == 0 ? CF_BASE.x + w.z : CF_BASE.y + w.w;
  return cfLayerMacro(p.y, base, thick);
}
float shapeBase(vec3 p) {
  vec4 s = textureLod(shapeTex, (p - vec3(wind.x, 0.0, wind.y)) * SHAPE_SCALE, 0.0);
  float n = s.g * 0.36 + s.b * 0.4 + s.a * 0.24 + (s.r - 0.71) * 0.45;
  return smoothstep(tune.x, tune.y, n);
}
float coverShape(float macro, float b) {
  float thr = 1.0 - macro * tune.w;
  return smoothstep(thr, thr + 0.22, b);
}
// cheap density for the light march (both layers, no detail)
float lightDens(vec3 p) {
  vec4 w = wthr(p.xz);
  float m = max(macroOf(w, p, 0), macroOf(w, p, 1));
  if (m < 0.01) return 0.0;
  return coverShape(m, shapeBase(p));
}
float detailErode(float d, vec3 p, float t) {
  if (d <= 0.0) return d;
  vec3 dt = textureLod(detailTex, (p - vec3(wind.x, -time, wind.y)) * DETAIL_SCALE, 0.0).rgb;
  float df = dt.r * 0.55 + dt.g * 0.3 + dt.b * 0.15;
  float k = (1.0 - df) * tune.z * (1.0 - smoothstep(1200.0, 6000.0, t) * 0.8);
  return clamp((d - k) / (1.0 - k), 0.0, 1.0);
}

vec2 slab(vec3 ro, vec3 rd, vec2 y) {
  if (abs(rd.y) < 1e-4) return (ro.y >= y.x && ro.y <= y.y) ? vec2(0.0, TMAX) : vec2(1.0, 0.0);
  float ta = (y.x - ro.y) / rd.y, tb = (y.y - ro.y) / rd.y;
  return vec2(max(min(ta, tb), 0.0), min(max(ta, tb), TMAX));
}

void march(vec3 ro, vec3 rd, int layer, vec2 seg, float jit) {
  float cs = dot(rd, sunDir);
  float t = seg.x;
  bool fine = false;
  int calm = 0;
  for (int i = 0; i < STEPS; i++) {
    if (t >= seg.y || gDone) break;
    if (!fine) {
      // empty-space skipping: a mip of the weather map covers the whole coarse step, so thin clouds are never missed
      float dc = clamp(30.0 + t * COARSE_K, 30.0, 900.0);
      vec3 pm = ro + rd * (t + dc * 0.5);
      vec4 wl = textureLod(weather, (pm.xz - wind) / CF_TILE, log2(dc / ${(CF.tile / CF.res).toFixed(1)}) + 0.5);
      float th = layer == 0 ? wl.x : wl.y;
      if (th < 1.5) { t += dc; continue; }
      fine = true;
      calm = 0;
      t += (STEP0 + t * STEP_K) * jit; // dither the start
    }
    float dt = clamp(STEP0 + t * STEP_K, STEP0, 90.0);
    vec3 p = ro + rd * (t + dt * 0.5);
    if (hasTerrain > 0.5 && p.y < 1900.0) {
      vec2 tu = (p.xz + worldHalf) / (2.0 * worldHalf);
      if (tu.x > 0.0 && tu.y > 0.0 && tu.x < 1.0 && tu.y < 1.0 && p.y < textureLod(terrainData, tu, 0.0).r) { gDone = true; break; }
    }
    vec4 w = wthr(p.xz);
    float macro = macroOf(w, p, layer) * (1.0 - smoothstep(9000.0, 20000.0, t)); // the horizon never stacks into a wall
    float d = 0.0;
    if (macro >= 0.004) {
      d = coverShape(macro, shapeBase(p));
      d = detailErode(d, p, t);
    }
    if (d <= 0.002) {
      if (++calm >= 3) fine = false;
      t += dt * (macro < 0.004 ? 2.0 : 1.0);
      continue;
    }
    calm = 0;
    float ext = d * sigma;
    // light march toward the sun
    float od = 0.0, tl = 0.0, dl = 14.0;
    for (int k = 0; k < LIGHT_STEPS; k++) {
      tl += dl;
      od += lightDens(p + sunDir * (tl - dl * 0.5)) * dl;
      dl *= 2.0;
    }
    od *= sigma;
    float thick = layer == 0 ? w.x : w.y;
    float base = layer == 0 ? CF_BASE.x + w.z : CF_BASE.y + w.w;
    float hh = clamp((p.y - base) / max(thick, 1.0), 0.0, 1.0);
    vec3 sunL = vec3(0.0);
    float a = 1.0, b = 1.0, c = 1.0;
    for (int n = 0; n < 4; n++) {
      float ph = mix(hg(cs, -0.28 * c), hg(cs, 0.82 * c), 0.45);
      sunL += b * exp(-od * a) * ph;
      a *= lightK.z; b *= lightK.w; c *= 0.5;
    }
    sunL += 0.3 * exp(-od * 0.09) * (0.6 + 0.4 * hh); // slow multiple scattering: the heart of a cloud stays bright
    sunL *= lightK.x;
    float powder = mix(1.0, 1.0 - exp(-od * 2.2 - 0.12), 0.7 * (1.0 - smoothstep(-0.2, 0.9, cs)));
    sunL *= sunRad * powder;
    vec3 amb = mix(ambBot, ambTop, smoothstep(0.0, 1.0, hh)) * (0.5 + 0.5 * exp(-od * 0.5)) * lightK.y;
    vec3 S = sunL + amb;
    float stepT = exp(-ext * dt);
    float wgt = gT * (1.0 - stepT);
    gCol += wgt * S;
    gWD += wgt * (t + dt * 0.5);
    gT *= stepT;
    if (gEntry < 0.0 && gT < 0.86) gEntry = t;
    if (gT < 0.02) { gDone = true; break; }
    t += dt;
  }
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0 + pxJitter;
  vec4 vp = invProj * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize((camWorld * vec4(normalize(vp.xyz / vp.w), 0.0)).xyz);
  vec3 ro = cameraPosition;
  gCol = vec3(0.0); gT = 1.0; gEntry = -1.0; gWD = 0.0; gDone = false;
  float jit = ign(gl_FragCoord.xy + jitter);
  vec2 sa = slab(ro, rd, SLAB_A), sb = slab(ro, rd, SLAB_B);
  bool va = sa.x < sa.y, vb = sb.x < sb.y;
  if (va && vb) {
    if (sa.x < sb.x) { march(ro, rd, 0, sa, jit); march(ro, rd, 1, sb, jit); }
    else { march(ro, rd, 1, sb, jit); march(ro, rd, 0, sa, jit); }
  } else if (va) march(ro, rd, 0, sa, jit);
  else if (vb) march(ro, rd, 1, sb, jit);
  float alpha = 1.0 - gT;
  vec3 col = gCol;
  float zView = -1.0;
  if (alpha > 0.002) {
    float meanT = gWD / max(alpha, 1e-4);
    float f = heightFogAmount(rd * meanT);
    col = col * (1.0 - f) + heightFogColor(rd) * f * alpha;
    float camFwd = dot(rd, normalize((camWorld * vec4(0.0, 0.0, -1.0, 0.0)).xyz));
    gEntry = gEntry >= 0.0 ? gEntry : meanT;
    zView = gEntry * camFwd;
  }
  vec4 cur = vec4(col, gT);
  outColor = cur;
  outInfo = vec4(zView, 0.0, 0.0, 1.0);
}`;

// Temporal resolve: reproject last frame's resolved clouds, clip them to the colour range of the 3x3 neighbourhood
// of this frame's march (variance clipping), and blend. A still camera converges to a clean, anti-aliased image;
// motion falls back to the current samples.
const resolveFragment = /* glsl */ `
precision highp float;
uniform sampler2D curColor, curInfo, histColor, histInfo;
uniform mat4 invProj, camWorld, prevVP;
uniform vec2 windDelta, size;
uniform float histValid, blend;
varying vec2 vUv;
layout(location = 0) out highp vec4 outColor;
layout(location = 1) out highp vec4 outInfo;
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  ivec2 mx = ivec2(size) - 1;
  vec4 cur = texelFetch(curColor, ip, 0);
  float z = texelFetch(curInfo, ip, 0).x;
  // light spatial denoise of this frame's march: a cross filter weighted by opacity and depth similarity, so the
  // per-pixel step jitter never shows as stipple, while silhouettes and the sky gaps stay sharp
  {
    vec4 acc = cur * 2.0; float ws = 2.0;
    for (int k = 0; k < 4; k++) {
      ivec2 o = clamp(ip + ((k & 1) == 0 ? ivec2(1 - (k & 2), 0) : ivec2(0, 1 - ((k >> 1) & 1) * 2)), ivec2(0), mx);
      vec4 c = texelFetch(curColor, o, 0);
      float zz = texelFetch(curInfo, o, 0).x;
      float w = (1.0 - smoothstep(0.04, 0.3, abs(c.a - cur.a))) * ((z >= 0.0) == (zz >= 0.0) ? 1.0 - smoothstep(0.03, 0.2, abs(zz - z) / max(z, 40.0)) : 0.0);
      acc += c * w; ws += w;
    }
    cur = acc / ws;
  }
  outInfo = vec4(z, 0.0, 0.0, 1.0);
  if (histValid < 0.5) { outColor = cur; return; }
  vec4 m1 = vec4(0.0), m2 = vec4(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec4 c = texelFetch(curColor, clamp(ip + ivec2(i, j), ivec2(0), mx), 0);
    m1 += c; m2 += c * c;
  }
  m1 /= 9.0; m2 /= 9.0;
  vec4 sd = sqrt(max(m2 - m1 * m1, 0.0));
  vec4 lo = m1 - sd * 1.6 - 0.01, hi = m1 + sd * 1.6 + 0.01;
  // reproject: world position of this pixel's cloud (or the far sky) into last frame
  vec4 vp = invProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dv = normalize(vp.xyz / vp.w);
  vec3 P = (camWorld * vec4(dv * (z >= 0.0 ? z / -dv.z : 30000.0), 1.0)).xyz - vec3(windDelta.x, 0.0, windDelta.y);
  vec4 pc = prevVP * vec4(P, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (pc.w <= 0.0 || puv.x <= 0.0 || puv.y <= 0.0 || puv.x >= 1.0 || puv.y >= 1.0) { outColor = cur; return; }
  vec4 h = textureLod(histColor, puv, 0.0);
  h = clamp(h, lo, hi);
  float hz = textureLod(histInfo, puv, 0.0).x;
  float w = blend;
  if (z >= 0.0 && hz >= 0.0) w *= 1.0 - smoothstep(0.05, 0.3, abs(hz - z) / max(z, 40.0));
  else if ((z >= 0.0) != (hz >= 0.0)) w *= 0.6;
  vec2 e = min(puv, 1.0 - puv);
  w *= smoothstep(0.0, 0.02, min(e.x, e.y));
  outColor = mix(cur, h, w);
}`;

// Crepuscular rays: a radial blur toward the sun of (cloud transparency x sky glow), at low resolution.
const shaftFragment = /* glsl */ `
precision highp float;
uniform sampler2D cloudColor;
uniform vec2 sunUV, jitter;
uniform float aspect, strength;
uniform vec3 sunColor;
varying vec2 vUv;
layout(location = 0) out highp vec4 outColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 d = sunUV - vUv;
  float j = ign(gl_FragCoord.xy + jitter);
  float acc = 0.0;
  for (int i = 0; i < SHAFT_STEPS; i++) {
    float t = (float(i) + j) / float(SHAFT_STEPS);
    vec2 uv = vUv + d * t;
    vec2 q = (uv - sunUV) * vec2(aspect, 1.0);
    float glow = exp(-length(q) * 5.5) * 0.9 + exp(-length(q) * 22.0) * 2.0;
    bool inside = uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0;
    float T = inside ? textureLod(cloudColor, uv, 0.0).a : 1.0;
    acc += T * glow * (1.0 - t * 0.35);
  }
  acc /= float(SHAFT_STEPS);
  outColor = vec4(sunColor * acc * strength, 1.0);
}`;

const compositeShader = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D cloudColor, cloudInfo, shaftTex;
    uniform vec2 lowSize;
    uniform mat4 proj;
    varying vec2 vUv;
    layout(location = 0) out highp vec4 outColor;
    // Cubic B-spline via four bilinear fetches: smooth edges from the low-res march
    vec4 bicubic(vec2 uv) {
      vec2 tc = uv * lowSize;
      vec2 t1 = floor(tc - 0.5) + 0.5;
      vec2 f = tc - t1;
      vec2 f2 = f * f, f3 = f2 * f;
      vec2 omf = 1.0 - f;
      vec2 w0 = omf * omf * omf / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0, w3 = f3 / 6.0, w2 = 1.0 - w0 - w1 - w3;
      vec2 s0 = w0 + w1, s12 = w2 + w3;
      vec2 t12 = (t1 + 1.0 + w3 / s12) / lowSize, tm = (t1 - 1.0 + w1 / s0) / lowSize;
      vec4 c = vec4(0.0);
      c += texture(cloudColor, vec2(tm.x, tm.y)) * s0.x * s0.y;
      c += texture(cloudColor, vec2(t12.x, tm.y)) * s12.x * s0.y;
      c += texture(cloudColor, vec2(tm.x, t12.y)) * s0.x * s12.y;
      c += texture(cloudColor, vec2(t12.x, t12.y)) * s12.x * s12.y;
      return vec4(max(c.rgb, 0.0), clamp(c.a, 0.0, 1.0));
    }
    void main() {
      vec4 c = bicubic(vUv);
      vec3 shaft = texture(shaftTex, vUv).rgb;
      float alpha = 1.0 - c.a;
      if (alpha < 0.004 && dot(shaft, shaft) < 1e-7) discard;
      vec2 f = vUv * lowSize - 0.5;
      ivec2 i0 = ivec2(floor(f));
      ivec2 mx = ivec2(lowSize) - 1;
      float zMin = 1e9;
      for (int k = 0; k < 4; k++) {
        ivec2 o = i0 + ivec2(k & 1, k >> 1);
        float z = texelFetch(cloudInfo, clamp(o, ivec2(0), mx), 0).x;
        if (z >= 0.0) zMin = min(zMin, z);
      }
      if (zMin > 1e8) {
        // the cubic upsample reaches 4x4 texels: faint fringe pixels borrow the nearest cloud depth around them
        for (int k = 0; k < 16; k++) {
          ivec2 o = i0 + ivec2(k & 3, k >> 2) - 1;
          float z = texelFetch(cloudInfo, clamp(o, ivec2(0), mx), 0).x;
          if (z >= 0.0) zMin = min(zMin, z);
        }
      }
      zMin = min(zMin, 25000.0);
      float clipZ = proj[2][2] * -zMin + proj[3][2];
      gl_FragDepth = clamp((clipZ / zMin) * 0.5 + 0.5, 0.0, 1.0);
      outColor = vec4(c.rgb + shaft, alpha);
    }`,
};

export class Clouds {
  constructor(scene) {
    this.weather = new WeatherField(buildWeather());
    this.quality = 1;
    this.time = 0;
    this.frame = 0;
    this.fogColor = new THREE.Color();
    this.rts = null;
    this.baked = false;

    // weather map as a filterable half-float texture
    const src = this.weather.data;
    const half = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
    const wt = new THREE.DataTexture(half, CF.res, CF.res, THREE.RGBAFormat, THREE.HalfFloatType);
    wt.wrapS = wt.wrapT = THREE.RepeatWrapping;
    wt.magFilter = THREE.LinearFilter;
    wt.generateMipmaps = true;
    wt.minFilter = THREE.LinearMipmapLinearFilter;
    wt.needsUpdate = true;
    this.weatherTex = wt;
    this.scene = scene;
    installCloudShadows(wt);

    const lit = SKY.sunColor.clone();
    this.uniforms = {
      weather: { value: wt },
      shapeTex: { value: null },
      detailTex: { value: null },
      terrainData: { value: null },
      hasTerrain: { value: 0 },
      worldHalf: { value: WORLD.terrainHalf },
      time: { value: 0 },
      jitter: { value: new THREE.Vector2() },
      tune: { value: new THREE.Vector4(0.34, 0.66, 0.55, 1.0) },
      lightK: { value: new THREE.Vector4(0.9, 0.9, 0.25, 0.5) },
      pxJitter: { value: new THREE.Vector2() },
      sigma: { value: 0.06 },
      wind: { value: new THREE.Vector2() },
      invProj: { value: new THREE.Matrix4() },
      camWorld: { value: new THREE.Matrix4() },
      sunDir: { value: SKY.sunDir },
      sunRad: { value: new THREE.Vector3(lit.r, lit.g, lit.b).multiplyScalar(1.15) },
      ambTop: { value: new THREE.Vector3(0.5, 0.62, 0.85).multiplyScalar(0.62) },
      ambBot: { value: new THREE.Vector3(0.3, 0.34, 0.4).multiplyScalar(0.55) },
      fogColor: { value: this.fogColor },
      fogDensity: { value: 0.000105 },
    };

    this.resolveUniforms = {
      curColor: { value: null }, curInfo: { value: null }, histColor: { value: null }, histInfo: { value: null },
      invProj: this.uniforms.invProj, camWorld: this.uniforms.camWorld, prevVP: { value: new THREE.Matrix4() },
      windDelta: { value: new THREE.Vector2() }, size: { value: new THREE.Vector2(1, 1) }, histValid: { value: 0 }, blend: { value: 0.93 },
    };
    this.resolveMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.resolveUniforms, vertexShader: FULLSCREEN_VS, fragmentShader: resolveFragment,
      depthTest: false, depthWrite: false,
    });
    this.resolveQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.resolveMat);
    this.resolveQuad.frustumCulled = false;
    this.resolveScene = new THREE.Scene();
    this.resolveScene.add(this.resolveQuad);
    this.sunVis = 1;
    this.shaftUniforms = {
      cloudColor: { value: null },
      sunUV: { value: new THREE.Vector2(0.5, 0.5) },
      jitter: { value: new THREE.Vector2() },
      aspect: { value: 1.78 },
      strength: { value: 0 },
      sunColor: { value: new THREE.Vector3(lit.r, lit.g, lit.b) },
    };
    this.marchScene = new THREE.Scene();
    this.marchCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.marchQuad = null; // built once the quality (defines) is known

    this.compUniforms = {
      cloudColor: { value: null },
      cloudInfo: { value: null },
      shaftTex: { value: null },
      lowSize: { value: new THREE.Vector2(1, 1) },
      proj: { value: new THREE.Matrix4() },
    };
    this.composite = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.compUniforms,
      vertexShader: compositeShader.vertexShader,
      fragmentShader: compositeShader.fragmentShader,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.onBeforeRender = (renderer, sc, camera) => this.march(renderer, camera, sc);
    scene.add(this.mesh);
    this.setQuality(1);
  }

  setQuality(q) {
    this.quality = Math.max(0, Math.min(2, q | 0));
    const Q = QUALITY[this.quality];
    if (this.marchMat) this.marchMat.dispose();
    this.marchMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VS,
      fragmentShader: marchFragment(true),
      defines: { STEPS: Q.steps, STEP0: '5.0', STEP_K: Q.grow.toFixed(3), COARSE_K: Q.coarse.toFixed(3), LIGHT_STEPS: Q.light },
      depthTest: false,
      depthWrite: false,
    });
    if (this.marchQuad) {
      this.marchQuad.material = this.marchMat;
    } else {
      this.marchQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.marchMat);
      this.marchQuad.frustumCulled = false;
      this.marchScene.add(this.marchQuad);
    }
    if (this.shaftMat) this.shaftMat.dispose();
    this.shaftMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.shaftUniforms,
      vertexShader: FULLSCREEN_VS,
      fragmentShader: shaftFragment,
      defines: { SHAFT_STEPS: [14, 24, 36][this.quality] },
      depthTest: false,
      depthWrite: false,
    });
    if (this.shaftQuad) {
      this.shaftQuad.material = this.shaftMat;
    } else {
      this.shaftQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.shaftMat);
      this.shaftQuad.frustumCulled = false;
      this.shaftScene = new THREE.Scene();
      this.shaftScene.add(this.shaftQuad);
    }
    this.rtW = 0; // force a resize
  }

  // 0..1 how much of the sun is visible past terrain and islands (computed by the caller)
  setSunVisibility(v) {
    this.sunVis = v;
  }

  setTerrainData(tex, half) {
    this.uniforms.terrainData.value = tex;
    this.uniforms.hasTerrain.value = 1;
    if (half) this.uniforms.worldHalf.value = half;
  }

  update(camera) {
    // wall-clock drift, so every player sees (and hides in) the same clouds. The offset is reduced modulo a common
    // period of the weather map and both noise volumes (8,601,600 m, about nine days of wind) so that float32
    // shader maths stays precise.
    const now = this.timeOverride ?? Date.now() / 1000; // timeOverride (seconds): tests and screenshots
    this.time = now;
    this.weather.wx = (WIND.x * now) % DRIFT_PERIOD;
    this.weather.wz = (WIND.y * now) % DRIFT_PERIOD;
    this.uniforms.wind.value.set(this.weather.wx, this.weather.wz);
    if (this.scene.fog && this.scene.fog.setDrift) this.scene.fog.setDrift(this.weather.wx, this.weather.wz);
    this.uniforms.time.value = (now * 0.5) % 420; // vertical churn of the detail noise (period 420 m)
  }

  // 0..1: how deep inside a cloud a point is
  density(p) {
    return this.weather.density(p.x, p.y, p.z);
  }

  // a camera pose inside a thick cloud, for tests and screenshots
  findCore() {
    const o = [0, 0, 0, 0];
    let best = null, bd = 0;
    for (let z = -3000; z <= 3000; z += 60) {
      for (let x = -3000; x <= 3000; x += 60) {
        this.weather.column(x, z, o);
        const y = CF.layers[0].base + o[2] + o[0] * 0.4;
        const d = o[0];
        if (d > bd && this.density({ x, y, z }) > 0.9) { bd = d; best = [x, y, z]; }
      }
    }
    if (!best) return [0, 1500, 0, 500, 1500, 0];
    return [best[0] - 250, best[1], best[2], best[0] + 500, best[1] + 20, best[2]];
  }

  ensureTargets(renderer) {
    const size = renderer.getDrawingBufferSize(this._sz || (this._sz = new THREE.Vector2()));
    const Q = QUALITY[this.quality];
    const w = Math.max(160, Math.round(size.x * Q.scale)), h = Math.max(90, Math.round(size.y * Q.scale));
    if (this.rts && this.rtW === w && this.rtH === h) return;
    if (this.rts) { this.rts.forEach((r) => r.dispose()); this.marchRT.dispose(); }
    this.rtW = w; this.rtH = h;
    const make = () => {
      const rt = new THREE.WebGLRenderTarget(w, h, { count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      rt.textures[1].minFilter = rt.textures[1].magFilter = THREE.NearestFilter;
      return rt;
    };
    this.rts = [make(), make()];
    this.marchRT = make();
    this.marchRT.textures[0].minFilter = this.marchRT.textures[0].magFilter = THREE.NearestFilter;
    this.resolveUniforms.size.value.set(w, h);
    if (this.shaftRT) this.shaftRT.dispose();
    this.shaftRT = new THREE.WebGLRenderTarget(Math.ceil(w / 2), Math.ceil(h / 2), { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.compUniforms.shaftTex.value = this.shaftRT.texture;
    this.cur = 0;
    this.resolveUniforms.histValid.value = 0;
    this.compUniforms.lowSize.value.set(w, h);
  }

  march(renderer, camera, sc) {
    if (!this.baked) {
      this.uniforms.shapeTex.value = bake3D(renderer, 128, false).texture;
      this.uniforms.detailTex.value = bake3D(renderer, 48, true).texture;
      this.baked = true;
    }
    this.ensureTargets(renderer);
    const u = this.uniforms;
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    this.compUniforms.proj.value.copy(camera.projectionMatrix);
    const fr = this.frame++;
    u.jitter.value.set(((fr * 0.7548776662) % 1) * 64, ((fr * 0.5698402909) % 1) * 64);
    const fog = sc && sc.fog;
    if (fog) { this.fogColor.copy(fog.color); u.fogDensity.value = fog.density; }
    const prev = renderer.getRenderTarget();
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    this.marchCam.position.copy(camera.position); // the shader reads cameraPosition
    this.marchCam.updateMatrixWorld(true);
    const dst = this.rts[this.cur], src = this.rts[1 - this.cur];
    // Halton(2,3) sub-pixel jitter
    const hx = halton(fr % 16 + 1, 2) - 0.5, hy = halton(fr % 16 + 1, 3) - 0.5;
    u.pxJitter.value.set((hx * 2) / this.rtW, (hy * 2) / this.rtH);
    const now = performance.now();
    const dtw = this.timeOverride !== undefined ? 0 : this.lastMarch ? Math.min(3, (now - this.lastMarch) / 1000) : 0; // wind travelled since the last frame
    this.lastMarch = now;
    renderer.setRenderTarget(this.marchRT);
    renderer.render(this.marchScene, this.marchCam);
    const ru = this.resolveUniforms;
    ru.curColor.value = this.marchRT.textures[0];
    ru.curInfo.value = this.marchRT.textures[1];
    ru.histColor.value = src.textures[0];
    ru.histInfo.value = src.textures[1];
    ru.windDelta.value.set(WIND.x * dtw, WIND.y * dtw);
    renderer.setRenderTarget(dst);
    renderer.render(this.resolveScene, this.marchCam);
    this.compUniforms.cloudColor.value = dst.textures[0];
    this.compUniforms.cloudInfo.value = dst.textures[1];
    this.cur = 1 - this.cur;
    ru.histValid.value = this.resetHistory ? 0 : 1;
    this.resetHistory = false;
    ru.prevVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // god rays
    const su = this.shaftUniforms;
    this._sun = (this._sun || new THREE.Vector3()).copy(camera.position).addScaledVector(SKY.sunDir, 10000).project(camera);
    const sx = this._sun.x, sy = this._sun.y;
    const front = this._sun.z < 1 ? 1 : 0;
    const edge = Math.max(Math.abs(sx), Math.abs(sy));
    su.sunUV.value.set(sx * 0.5 + 0.5, sy * 0.5 + 0.5);
    su.aspect.value = camera.aspect;
    su.cloudColor.value = dst.textures[0];
    su.jitter.value.copy(u.jitter.value);
    const target = front * this.sunVis * (1 - Math.min(1, Math.max(0, (edge - 1.0) / 1.2)));
    this.shaftK = (this.shaftK || 0) + (target - (this.shaftK || 0)) * 0.15;
    su.strength.value = this.shaftK * 0.18;
    renderer.setRenderTarget(this.shaftRT);
    renderer.render(this.shaftScene, this.marchCam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = ac;
  }
}
