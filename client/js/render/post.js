// The lens: a hand-rolled HDR post pipeline (replaces EffectComposer so nothing is ever copied around).
//
//   scene (half-float, MSAA at q>=1, depth texture)
//     -> [q>=1] ambient occlusion: half-res depth-only AO + depth-aware blur
//     -> dual-filter bloom pyramid (Karis-averaged, soft knee, scatter-blended on the way up)
//     -> ONE final pass straight to the canvas:
//          depth of field | camera motion blur + boost zoom | chromatic aberration (extremes only)
//          + AO + bloom with lens dirt + sun glare/ghosts -> tone map (AgX / ACES) -> grade
//          -> vignette, cloud whiteout, damage tint -> grain + dither -> sRGB
//     -> [q0] FXAA pass (the only anti-aliasing at q0, no MSAA)
//
// Quality tiers (see QUALITY below): 0 fast, 1 high, 2 ultra. Everything heavy is compiled out per tier.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export const QUALITY = [
  // samples: MSAA; ao: AO taps (0 = off); aoScale: AO resolution; bloom: pyramid levels; bloomDiv: first level divisor
  // mb: motion blur taps (0 = radial zoom only); dof: DOF taps (0 = off); grain: film grain
  { samples: 0, ao: 0, aoScale: 0.5, bloom: 4, bloomDiv: 4, mb: 0, dof: 0, grain: false, fxaa: true, pixelRatio: 1 },
  { samples: 4, ao: 0, aoScale: 0.5, bloom: 5, bloomDiv: 2, mb: 8, dof: 16, grain: false, fxaa: false, pixelRatio: 1.5 },
  { samples: 4, ao: 12, aoScale: 0.6, bloom: 6, bloomDiv: 2, mb: 12, dof: 28, grain: true, fxaa: false, pixelRatio: 2 },
];

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// ---------------------------------------------------------------- bloom
const BLOOM_PRE = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold, uKnee, uBase;
varying vec2 vUv;
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  vec3 hot = c * (max(rq, br - uThreshold) / max(br, 1e-4));
  return hot + c * uBase; // a whisper of everything: atmospheric haze glow
}
vec3 tap(vec2 o) { return prefilter(min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(64.0))); }
float kw(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main() {
  vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
  // Karis average: bright outliers can't dominate the first mip (no fireflies, no flicker)
  float w0 = kw(g0), w1 = kw(g1), w2 = kw(g2), w3 = kw(g3), w4 = kw(g4);
  vec3 r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3) * 0.125 + g4 * w4 * 0.5;
  r /= (w0 + w1 + w2 + w3) * 0.125 + w4 * 0.5;
  gl_FragColor = vec4(r, 1.0);
}`;

const BLOOM_DOWN = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  vec3 r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  gl_FragColor = vec4(r, 1.0);
}`;

const BLOOM_UP = /* glsl */ `
uniform sampler2D tLow, tHigh; uniform vec2 uTexel; uniform float uScatter;
varying vec2 vUv;
vec3 tap(vec2 o) { return texture2D(tLow, vUv + o * uTexel).rgb; }
void main() {
  vec3 low = tap(vec2(-1, 1)) + tap(vec2(1, 1)) + tap(vec2(-1, -1)) + tap(vec2(1, -1));
  low = low * 0.0625 + (tap(vec2(0, 1)) + tap(vec2(0, -1)) + tap(vec2(1, 0)) + tap(vec2(-1, 0))) * 0.125 + tap(vec2(0)) * 0.25;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, low, uScatter), 1.0);
}`;

// ---------------------------------------------------------------- ambient occlusion (depth only, no extra scene pass)
const DEPTH_GLSL = /* glsl */ `
uniform vec4 uProj; // A, B (view z from ndc), 1/P00, 1/P11
uniform vec2 uProjOff; // P02, P12: non-zero when the camera has a view offset (the title screen)
float linZ(float d) { return uProj.y / (d * 2.0 - 1.0 + uProj.x); }
vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0 + uProjOff) * vec2(uProj.z, uProj.w) * z, -z); }
`;

const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth; uniform vec2 uRes; uniform float uRadius, uTime;
${DEPTH_GLSL}
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 posAt(vec2 uv) { float z = linZ(texture2D(tDepth, uv).r); return viewPos(uv, z); }
void main() {
  float d0 = texture2D(tDepth, vUv).r;
  float z = linZ(d0);
  if (d0 > 0.99999 || z > 1500.0) { gl_FragColor = vec4(1.0, z, 0.0, 1.0); return; }
  vec2 px = 1.0 / uRes;
  vec3 P = viewPos(vUv, z);
  vec3 pr = posAt(vUv + vec2(px.x, 0.0)), pl = posAt(vUv - vec2(px.x, 0.0)), pu = posAt(vUv + vec2(0.0, px.y)), pd = posAt(vUv - vec2(0.0, px.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  // world radius -> pixels, clamped so close geometry doesn't cost a fortune
  float rpx = clamp(uRadius * (1.0 / uProj.w) * 0.5 * uRes.y / z, 3.0, 36.0);
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0;
  for (int i = 0; i < AO_TAPS; i++) {
    float fi = (float(i) + 0.5) / float(AO_TAPS);
    float a = rot + fi * 12.566371 * 1.618;
    float r = fi * fi * 0.85 + 0.15;
    vec2 suv = vUv + vec2(cos(a), sin(a)) * r * rpx * px;
    vec3 S = posAt(suv);
    vec3 v = S - P;
    float dist = length(v) + 1e-4;
    float h = max(0.0, dot(v, N) / dist - 0.12);
    occ += h * (1.0 - smoothstep(0.35 * uRadius, uRadius, dist));
  }
  occ /= float(AO_TAPS);
  float ao = clamp(1.0 - occ * 2.1, 0.0, 1.0);
  gl_FragColor = vec4(ao, z, 0.0, 1.0);
}`;

const AO_BLUR = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uDir; // texel step
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tSrc, vUv).rg;
  float sum = c.x, wsum = 1.0;
  for (int i = -3; i <= 3; i++) {
    if (i == 0) continue;
    vec2 s = texture2D(tSrc, vUv + uDir * float(i)).rg;
    float w = exp(-float(i * i) * 0.12) * exp(-abs(s.y - c.y) / (c.y * 0.04 + 0.05));
    sum += s.x * w; wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, c.y, 0.0, 1.0);
}`;

// tone map + film grade shared with the target lenses (lens.js), so both are exposed and graded alike.
// Needs luma() and the uAgxPower / uAgxSat uniforms declared before it.
export const TONEMAP_GLSL = /* glsl */ `
// ---- tone mapping
vec3 acesFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 ACES(vec3 c) {
  const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  return clamp(O * acesFit(I * c * (1.0 / 0.6)), 0.0, 1.0);
}
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 AgX(vec3 color) {
  const mat3 R709to2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 R2020to709 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  color = inset * (R709to2020 * color);
  color = clamp((log2(max(color, 1e-10)) + 12.47393) / 16.500, 0.0, 1.0);
  color = agxContrast(color);
  // look: "punchy" power + saturation in the log-encoded domain
  float l = luma(color);
  color = pow(max(color, 0.0), vec3(uAgxPower));
  color = l + (color - l) * uAgxSat;
  color = outset * color;
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(R2020to709 * color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

// ---- film grade (display referred, after the tone map)
vec3 grade(vec3 c) {
  float l = luma(c);
  // soft S-curve
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, 0.26);
  // split toning: cool teal shadows, warm gold highlights
  float sh = 1.0 - smoothstep(0.0, 0.5, l);
  float hi = smoothstep(0.5, 1.0, l);
  c += vec3(-0.010, 0.006, 0.016) * sh;
  c *= mix(vec3(1.0), vec3(1.035, 1.0, 0.94), hi);
  // vibrance: lift the dull colours more than the saturated ones
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / (mx + 1e-4);
  float lum = luma(c);
  c = lum + (c - lum) * (1.05 + (1.0 - sat) * 0.20);
  return c;
}
`;

// ---------------------------------------------------------------- final composite
const FINAL_FRAG = /* glsl */ `
uniform sampler2D tDiffuse, tDepth, tBloom, tAO, tDirt, tDist;
uniform vec2 uRes, uAORes;
uniform mat4 uReproj;
uniform float uExposure, uBloomI, uDirtI, uAOStrength, uMB, uZoom, uCA, uDofFocus, uDofAmount, uGrainAmt, uPop, uLetter, uAgxPower, uAgxSat;
uniform vec2 uFoe;
uniform float uDistort, uDistortK;
uniform float whiteout, damage, boost, time, sunVis, aspect, speed;
uniform vec2 sunPos;
${DEPTH_GLSL}
varying vec2 vUv;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---- sun glare and lens ghosts (screen space, occlusion tested on the CPU)
vec3 flare(vec2 uv, float dirt) {
  if (sunVis <= 0.001) return vec3(0.0);
  vec2 a = vec2(aspect, 1.0);
  vec2 d = (uv - sunPos) * a;
  float r = length(d);
  vec3 c = vec3(1.0, 0.92, 0.8) * (exp(-r * 9.0) * 0.30 + exp(-r * 40.0) * 0.55 + exp(-r * 3.0) * 0.05);
  // anamorphic streak
  c += vec3(0.8, 0.9, 1.0) * exp(-abs(d.y) * 190.0) * exp(-abs(d.x) * 3.2) * 0.16;
  // starburst from the lens dirt / aperture
  float ang = atan(d.y, d.x);
  c += vec3(1.0, 0.9, 0.75) * exp(-r * 7.0) * (0.5 + 0.5 * cos(ang * 6.0 + 0.3)) * 0.05;
  vec2 axis = vec2(0.5) - sunPos;
  for (int i = 0; i < 5; i++) {
    float k = 0.32 + float(i) * 0.34;
    vec2 gp = sunPos + axis * k * 2.0;
    vec2 gd = (uv - gp) * a;
    float gr = length(gd);
    float size = 0.018 + float(i) * 0.016;
    // hexagonal-ish ghost with a soft rim
    float hex = max(abs(gd.x) * 0.866 + abs(gd.y) * 0.5, abs(gd.y));
    float shape = smoothstep(size, size * 0.55, mix(gr, hex, 0.6));
    float rim = smoothstep(size * 0.65, size, gr) * shape;
    vec3 tint = vec3(0.5 + 0.18 * float(i), 0.62, 0.95 - 0.16 * float(i));
    c += tint * (shape * 0.035 + rim * 0.05);
  }
  float prox = exp(-length((vec2(0.5) - sunPos) * a) * 1.6); // dirt blooms when the sun is near the frame
  return c * sunVis * (1.0 + dirt * 3.0 * prox);
}

${TONEMAP_GLSL}
vec3 sceneTap(vec2 uv) { return texture2D(tDiffuse, uv).rgb; }

void main() {
  vec2 uv = vUv;
  vec2 cen = uv - 0.5;
  float r = length(cen * vec2(aspect, 1.0));
  // heat haze / shockwave refraction from the VFX offset buffer: bends every scene fetch below
  vec2 dd = vec2(0.0);
  if (uDistort > 0.5) {
    dd = clamp(texture2D(tDist, vUv).xy, vec2(-1.5), vec2(1.5)) * uDistortK;
    dd.x /= aspect;
    uv += dd;
  }
  float zc = 0.0, d0 = 1.0;
  float noise = ign(gl_FragCoord.xy);
  #ifdef USE_DEPTH
    d0 = texture2D(tDepth, uv).r;
    zc = linZ(d0);
  #endif

  // ---- gather: depth of field (title / kill cam), else motion blur + zoom
  vec3 col = sceneTap(uv);
  bool done = false;
  #if DOF_TAPS > 0
  if (uDofAmount > 0.001) {
    float f = uDofFocus;
    float cc = clamp(abs(zc - f) / max(zc, 1.0), 0.0, 1.0) * uDofAmount * 0.011;
    // blurred background gathers; in-focus pixels stay sharp
    if (cc > 0.0004) {
      vec3 acc = col; float wsum = 1.0;
      for (int i = 0; i < DOF_TAPS; i++) {
        float fi = (float(i) + 0.5) / float(DOF_TAPS);
        float a = float(i) * 2.399963 + noise * 6.2831;
        float rr = sqrt(fi) * cc;
        vec2 suv = uv + vec2(cos(a) / aspect, sin(a)) * rr;
        vec3 s = sceneTap(suv);
        float zs = linZ(texture2D(tDepth, suv).r);
        float cs = clamp(abs(zs - f) / max(zs, 1.0), 0.0, 1.0) * uDofAmount * 0.011;
        float w = smoothstep(rr * 0.6, rr * 1.1 + 1e-5, cs);
        if (zs < zc) w = max(w, smoothstep(0.0, 1.0, cs / (rr + 1e-5)) * 0.6 * step(cc * 0.35, cs));
        w *= 1.0 + 3.0 * smoothstep(1.5, 6.0, luma(s)); // bokeh highlights
        acc += min(s, vec3(24.0)) * w; wsum += w;
      }
      col = acc / wsum;
    }
    done = true;
  }
  #endif
  #ifndef NO_BLUR
  if (!done && (uMB > 0.0 || uZoom > 0.0)) {
    vec2 vel = vec2(0.0);
    #ifdef USE_MB
      if (uMB > 0.0) {
        vec4 cp = uReproj * vec4(viewPos(uv, zc), 1.0);
        vel = (uv - (cp.xy / cp.w * 0.5 + 0.5)) * uMB * (d0 > 0.99999 ? 0.45 : 1.0);
      }
    #endif
    // boost zoom blur streams out of the point the dragon is flying toward
    vel += (uv - uFoe) * uZoom * smoothstep(0.08, 0.45, r);
    float len = length(vel);
    float maxLen = 0.04;
    if (len > maxLen) vel *= maxLen / len;
    if (len > 0.0004) {
      vec3 acc = col; float wsum = 1.0;
      for (int i = 0; i < MB_TAPS; i++) {
        float t = (float(i) + noise) / float(MB_TAPS) - 0.5;
        vec2 suv = uv + vel * t;
        vec3 s = sceneTap(suv);
        float w = 1.0;
        #ifdef USE_MB
          // nothing closer than this pixel smears onto it (keeps the dragon's silhouette crisp)
          float zs = linZ(texture2D(tDepth, suv).r);
          w = zs > zc * 0.93 ? 1.0 : 0.0;
        #endif
        acc += s * w; wsum += w;
      }
      col = acc / wsum;
    }
  }
  #endif

  // ---- chromatic aberration: only when asked (boost, big hits), growing toward the edges
  if (uCA > 0.001 || uDistort > 0.5) {
    vec2 off = cen * (0.25 + r * 1.6) * uCA * 0.0075 + dd * 0.12; // a hint of dispersion on strong refraction
    col.r = mix(col.r, sceneTap(uv + off).r, 0.9);
    col.b = mix(col.b, sceneTap(uv - off).b, 0.9);
  }

  // ---- ambient occlusion (depth-aware upsample of the half-res buffer)
  #ifdef USE_AO
    if (d0 < 0.99999 && zc < 1500.0 && uAOStrength > 0.0) {
      vec2 p = uv * uAORes - 0.5;
      vec2 ip = floor(p), fp = p - ip;
      float sum = 0.0, wsum = 1e-4;
      for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
        vec2 q = (ip + vec2(float(i), float(j)) + 0.5) / uAORes;
        vec2 s = texture2D(tAO, q).rg;
        float bw = (i == 0 ? 1.0 - fp.x : fp.x) * (j == 0 ? 1.0 - fp.y : fp.y);
        float w = bw * exp(-abs(s.y - zc) / (zc * 0.03 + 0.05)) + 1e-5;
        sum += s.x * w; wsum += w;
      }
      float ao = sum / wsum;
      float fade = 1.0 - smoothstep(350.0, 1400.0, zc);
      col *= mix(1.0, ao, uAOStrength * fade);
    }
  #endif

  // ---- bloom with lens dirt
  vec2 duv = (uv - 0.5) * vec2(aspect / 1.6, 1.0) + 0.5;
  float dirt = texture2D(tDirt, duv).r;
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * uBloomI * (1.0 + dirt * uDirtI);
  col += flare(uv, dirt);

  // ---- pop: a one-frame punch on kills (brightness + zoom-free)
  col *= 1.0 + uPop * 0.35;

  // ---- tone map
  col *= uExposure;
  #ifdef TONEMAP_ACES
    col = ACES(col);
  #else
    col = AgX(col);
  #endif
  col = toSRGB(col);
  col = grade(col);

  // ---- vignette: grows a little with speed
  float vig = smoothstep(0.42, 1.05, r) * (0.30 + speed * 0.10);
  col *= 1.0 - vig;
  // cloud whiteout
  col = mix(col, vec3(0.88, 0.9, 0.94), whiteout);
  // damage: the picture drains and darkens toward the edges, like blood leaving the head; no red paint
  // (kept to the screen edges so the pilot can always see what they are fighting)
  float edge = smoothstep(0.35, 0.95, r);
  float dmg = min(damage, 1.0);
  vec3 grey = vec3(luma(col));
  vec3 hurt = mix(grey, col, 0.3) * vec3(0.6, 0.56, 0.54);
  col = mix(col, hurt, dmg * 0.8 * edge);
  col = mix(col, mix(grey, col, 0.7), dmg * 0.3 * (1.0 - edge));

  // ---- cinematic bars during the death cam
  col *= 1.0 - smoothstep(0.5 - 0.065 * uLetter, 0.5 - 0.065 * uLetter + 0.004, abs(cen.y)) * step(0.001, uLetter);

  // ---- grain and dither (the dither stops the sky gradient banding)
  #ifdef GRAIN
    float g = (ign(gl_FragCoord.xy + fract(time * 7.13) * 91.7) - 0.5) * uGrainAmt;
    col += g * (0.4 + 0.6 * (1.0 - abs(luma(col) * 2.0 - 1.0)));
  #endif
  col += (noise - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// FXAA (q0 only): cheap edge-directed blur on the sRGB result
const FXAA_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 M = texture2D(tSrc, vUv).rgb;
  vec3 NW = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb, NE = texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
  vec3 SW = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb, SE = texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
  float lM = lum(M), lNW = lum(NW), lNE = lum(NE), lSW = lum(SW), lSE = lum(SE);
  float lmin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lmax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lmax - lmin < max(0.0312, lmax * 0.125)) { gl_FragColor = vec4(M, 1.0); return; }
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 A = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 B = A * 0.5 + 0.25 * (texture2D(tSrc, vUv + dir * -0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lB = lum(B);
  gl_FragColor = vec4((lB < lmin || lB > lmax) ? A : B, 1.0);
}`;

// ---------------------------------------------------------------- lens dirt texture (procedural)
function makeDirtTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  let s = 1234567;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 150; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 4 + Math.pow(rnd(), 2.4) * 70;
    const a = 0.04 + rnd() * 0.22;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`);
    gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // a few thin smears
  g.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    g.strokeStyle = `rgba(255,255,255,${0.05 + rnd() * 0.1})`;
    g.lineWidth = 1 + rnd() * 3;
    g.beginPath();
    const x = rnd() * size, y = rnd() * size;
    g.moveTo(x, y);
    g.quadraticCurveTo(x + (rnd() - 0.5) * 120, y + (rnd() - 0.5) * 120, x + (rnd() - 0.5) * 160, y + (rnd() - 0.5) * 160);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

const mat = (frag, uniforms, defines = {}) =>
  new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, toneMapped: false });

const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };

export class PostPipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = 1;
    this.exposure = 1.2;
    this.exposureMul = 1; // eased dip when looking into the sun (set from World3D.updateGlare)
    this.tonemap = 'agx';
    this.size = new THREE.Vector2(2, 2);
    this.prevVP = new THREE.Matrix4();
    this.prevCamPos = new THREE.Vector3();
    this.havePrev = false;
    this.dirty = true;
    this.lastT = performance.now();
    this._vp = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this.levels = [];
    this.dirt = makeDirtTexture();

    // uniforms shared with the game: `grade.uniforms` keeps its historic names (whiteout, damage, boost, time, sunPos, sunVis, aspect)
    const U = THREE.UniformsUtils;
    this.uniforms = {
      tDiffuse: { value: null }, tDepth: { value: null }, tBloom: { value: null }, tAO: { value: null }, tDirt: { value: this.dirt },
      uRes: { value: new THREE.Vector2(1, 1) }, uAORes: { value: new THREE.Vector2(1, 1) },
      uReproj: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Vector4() }, uProjOff: { value: new THREE.Vector2() },
      tDist: { value: null }, uDistort: { value: 0 }, uDistortK: { value: 0.07 },
      uExposure: { value: 1 }, uBloomI: { value: 0.4 }, uDirtI: { value: 1.1 }, uAOStrength: { value: 0.85 },
      uMB: { value: 0 }, uZoom: { value: 0 }, uCA: { value: 0 }, uFoe: { value: new THREE.Vector2(0.5, 0.5) },
      uDofFocus: { value: 50 }, uDofAmount: { value: 0 }, uGrainAmt: { value: 0.028 }, uPop: { value: 0 }, uLetter: { value: 0 },
      uAgxPower: { value: 1.3 }, uAgxSat: { value: 1.22 },
      whiteout: { value: 0 }, damage: { value: 0 }, boost: { value: 0 }, time: { value: 0 },
      sunPos: { value: new THREE.Vector2(-9, -9) }, sunVis: { value: 0 }, aspect: { value: 1 }, speed: { value: 0 },
    };
    this.finalMat = mat(FINAL_FRAG, this.uniforms);

    this.preMat = mat(BLOOM_PRE, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.0 }, uKnee: { value: 0.7 }, uBase: { value: 0.035 } });
    this.downMat = mat(BLOOM_DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = mat(BLOOM_UP, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.78 } });
    this.quad = new FullScreenQuad(this.preMat);

    this.aoUniforms = { tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uRadius: { value: 5 }, uTime: { value: 0 }, uProj: this.uniforms.uProj, uProjOff: this.uniforms.uProjOff };
    this.aoMat = mat(AO_FRAG, this.aoUniforms, { AO_TAPS: 6 });
    this.aoBlurMat = mat(AO_BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });

    this.fxaaMat = mat(FXAA_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  }

  get params() { return QUALITY[this.quality]; }

  // sizes and tiers change rarely; targets are rebuilt lazily on the next frame
  setQuality(q) {
    this.quality = q;
    this.dirty = true;
  }

  setSize(w, h) {
    this.size.set(w, h);
    this.dirty = true;
  }

  rebuild() {
    const p = this.params, { x: w, y: h } = this.size;
    this.dispose(true);
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { ...rtOpts, depthBuffer: true, samples: p.samples });
    this.sceneRT.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.sceneRT.depthTexture.format = THREE.DepthFormat;
    this.sceneRT.depthTexture.minFilter = this.sceneRT.depthTexture.magFilter = THREE.NearestFilter;
    // bloom pyramid
    this.levels = [];
    let lw = Math.max(2, Math.floor(w / p.bloomDiv)), lh = Math.max(2, Math.floor(h / p.bloomDiv));
    for (let i = 0; i < p.bloom; i++) {
      this.levels.push({ w: lw, h: lh, down: new THREE.WebGLRenderTarget(lw, lh, rtOpts), up: i < p.bloom - 1 ? new THREE.WebGLRenderTarget(lw, lh, rtOpts) : null });
      lw = Math.max(2, Math.floor(lw / 2));
      lh = Math.max(2, Math.floor(lh / 2));
    }
    if (p.ao) {
      const aw = Math.max(2, Math.floor(w * p.aoScale)), ah = Math.max(2, Math.floor(h * p.aoScale));
      this.aoA = new THREE.WebGLRenderTarget(aw, ah, { ...rtOpts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.aoB = new THREE.WebGLRenderTarget(aw, ah, { ...rtOpts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.uniforms.uAORes.value.set(aw, ah);
    }
    if (p.fxaa) this.ldrRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    // compile-time variants
    const d = { DOF_TAPS: p.dof, MB_TAPS: Math.max(6, p.mb) };
    if (p.mb || p.dof || p.ao) d.USE_DEPTH = '';
    if (p.mb) d.USE_MB = '';
    if (!p.mb && !p.dof) { /* radial zoom only */ }
    if (p.ao) d.USE_AO = '';
    if (p.grain) d.GRAIN = '';
    if (this.tonemap === 'aces') d.TONEMAP_ACES = '';
    this.finalMat.defines = d;
    this.finalMat.needsUpdate = true;
    this.aoMat.defines = { AO_TAPS: p.ao || 6 };
    this.aoMat.needsUpdate = true;
    this.uniforms.uRes.value.set(w, h);
    if (this.distort) this.distort.setSize(w, h);
    this.uniforms.tDepth.value = this.sceneRT.depthTexture;
    this.uniforms.uAOStrength.value = p.ao ? 0.95 : 0;
    this.aoUniforms.uRadius.value = 7;
    this.uniforms.uGrainAmt.value = 0.026;
    this.havePrev = false;
    this.dirty = false;
  }

  setTonemap(name) {
    this.tonemap = name;
    this.dirty = true;
  }

  dispose(keepStatic) {
    if (this.sceneRT) this.sceneRT.dispose();
    for (const l of this.levels) { l.down.dispose(); if (l.up) l.up.dispose(); }
    if (this.aoA) { this.aoA.dispose(); this.aoB.dispose(); this.aoA = this.aoB = null; }
    if (this.ldrRT) { this.ldrRT.dispose(); this.ldrRT = null; }
    this.levels = [];
    if (!keepStatic) this.dirt.dispose();
  }

  pass(material, target, uniforms) {
    const r = this.renderer;
    for (const k in uniforms) material.uniforms[k].value = uniforms[k];
    this.quad.material = material;
    r.setRenderTarget(target);
    this.quad.render(r);
  }

  // Marks a camera cut (respawn, kill-cam jump): no motion blur across it.
  cut() { this.havePrev = false; }

  render() {
    const r = this.renderer, cam = this.camera, u = this.uniforms, p = this.params;
    if (this.dirty) this.rebuild();
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(1 / 240, (now - this.lastT) / 1000));
    this.lastT = now;
    cam.updateMatrixWorld();

    // 1. the scene
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, cam);

    // heat haze and shockwave refraction (VFX): offsets into a half-res buffer, applied by the final pass
    const dist = this.distort;
    if (dist && dist.enabled) {
      dist.renderOffsets(r);
      u.tDist.value = dist.rt.texture;
      u.uDistortK.value = dist.strength;
      u.uDistort.value = 1;
    } else u.uDistort.value = 0;

    // camera matrices for depth reconstruction and reprojection
    const P = cam.projectionMatrix.elements;
    u.uProj.value.set(P[10], P[14], 1 / P[0], 1 / P[5]);
    u.uProjOff.value.set(P[8], P[9]);
    this._vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    let mb = 0;
    if (p.mb && this.havePrev && cam.position.distanceToSquared(this.prevCamPos) < 150 * 150) mb = this.motionBlurScale * Math.min(1.6, Math.max(0.02, (1 / 90) / dt));
    u.uMB.value = mb;
    // current view space -> previous clip space
    u.uReproj.value.copy(this.prevVP).multiply(cam.matrixWorld);
    this.prevVP.copy(this._vp);
    this.prevCamPos.copy(cam.position);
    this.havePrev = true;

    // 2. ambient occlusion
    if (p.ao && this.aoA) {
      this.aoUniforms.tDepth.value = this.sceneRT.depthTexture;
      this.pass(this.aoMat, this.aoA, { tDepth: this.sceneRT.depthTexture, uRes: this.aoUniforms.uRes.value.set(this.aoA.width, this.aoA.height) });
      this.pass(this.aoBlurMat, this.aoB, { tSrc: this.aoA.texture, uDir: this.aoBlurMat.uniforms.uDir.value.set(1 / this.aoA.width, 0) });
      this.pass(this.aoBlurMat, this.aoA, { tSrc: this.aoB.texture, uDir: this.aoBlurMat.uniforms.uDir.value.set(0, 1 / this.aoA.height) });
      u.tAO.value = this.aoA.texture;
    }

    // 3. bloom pyramid
    const L = this.levels;
    this.preMat.uniforms.uTexel.value.set(1 / this.sceneRT.width, 1 / this.sceneRT.height);
    this.pass(this.preMat, L[0].down, { tSrc: this.sceneRT.texture });
    for (let i = 1; i < L.length; i++) {
      this.downMat.uniforms.uTexel.value.set(1 / L[i - 1].w, 1 / L[i - 1].h);
      this.pass(this.downMat, L[i].down, { tSrc: L[i - 1].down.texture });
    }
    let low = L[L.length - 1].down.texture;
    for (let i = L.length - 2; i >= 0; i--) {
      this.upMat.uniforms.uTexel.value.set(1 / L[i + 1].w, 1 / L[i + 1].h);
      this.pass(this.upMat, L[i].up, { tLow: low, tHigh: L[i].down.texture });
      low = L[i].up.texture;
    }
    u.tBloom.value = low;

    // 4. final composite
    u.tDiffuse.value = this.sceneRT.texture;
    u.uExposure.value = this.exposure * this.exposureMul;
    this.quad.material = this.finalMat;
    r.setRenderTarget(p.fxaa ? this.ldrRT : null);
    this.quad.render(r);
    if (p.fxaa) {
      this.fxaaMat.uniforms.tSrc.value = this.ldrRT.texture;
      this.fxaaMat.uniforms.uTexel.value.set(1 / this.size.x, 1 / this.size.y);
      this.quad.material = this.fxaaMat;
      r.setRenderTarget(null);
      this.quad.render(r);
    }
  }
}

PostPipeline.prototype.motionBlurScale = 1;
