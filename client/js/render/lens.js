// Target lenses: a magnifying glass that follows a far dragon so you can actually see it.
//
// LensDirector (no WebGL, unit tested) decides every frame which dragons get a lens (at most 2 on touch / small
// screens, 3 otherwise), where it sits, how strongly it magnifies and how visible it is; which hostiles are out of
// sight (no lens, no marks), which are big enough for plain close-range marks, and which ONE dragon gets a name.
// LensRenderer draws them:
//
//   1. per lens, a narrow view from the MAIN camera's own position and orientation, zoomed around the dragon
//      (an off-axis projection), so the lens is a true telescope: same perspective, roll, haze and lighting as the
//      world. Only the dragons inside the lens (their far mesh) and the fire/trail effects (q>=1) are drawn, into a small HDR target
//      (128 / 192 / 256 px by quality) with a transparent background;
//   2. one small quad per lens straight onto the canvas after the post pass: the background is the main frame's
//      HDR scene buffer (sky, clouds, terrain), heavily blurred and a little darker, like the shallow depth of field
//      of a long lens. The main frame's own tiny dragon and hot sparks around it are painted out of that background
//      (by depth and brightness) before the sharp dragon is laid over it. Then lens refraction and a chromatic fringe
//      near the rim, an inner vignette, the same AgX tone map and grade as the main view (TONEMAP_GLSL), a hint of
//      glass and a thin rim (warm red when locked).
//
// The HUD (hud.js) draws the information on the rim: health arc in warm ink, an identity tick at 12 o'clock, a
// heading tick, the lock arc. As a dragon closes in, its on-screen size grows, the magnification it needs falls
// towards 1 and the lens fades and shrinks away (between LENS.handOn and LENS.handOff; earlier for the dragon
// you're on), leaving the plain world view.
import * as THREE from 'three';
import { TONEMAP_GLSL } from './post.js';
import { DRAGON_SCALE } from '../../../shared/constants.js';

export const LENS = {
  span: 23 * DRAGON_SCALE, // a battle dragon's wingspan in metres (the code dragon's membranes reach +-11.6 m, then DRAGON_SCALE)
  fill: 1.5, // full wingspan inside the lens, in lens radii, up close (1.5 = 75% of the diameter; in flight the wings
  // are swept and foreshortened, so the dragon usually fills about half of it). Shrinks with range: see lensFill()
  fillFar: 0.55, // ... to this share of `fill` from fillFarFrom metres on, so size inside the glass still reads as range
  fillNear: 300,
  fillFarFrom: 1600,
  mMax: 18, // strongest magnification
  handOn: 1.65, // magnification below which the lens starts to fade ...
  handOff: 1.12, // ... and is gone (the dragon is big enough on its own)
  // the dragon you're on (aimed or locked) hands over early inside focusDist, so the real dragon and the lead pip
  // under your reticle are not covered by glass
  focusHandOn: 2.6,
  focusHandOff: 1.5,
  focusDist: 650,
  aimDist: 900, // "the dragon you're on" (name label, lead pip) only within this range
  focusR: 1.2, // the dragon you're on gets a slightly bigger glass
  maxDist: 1900, // the arena radius is 1650 m
  maxMembers: 3, // dragons merged into one lens when they bunch up on screen
  gap: 1.15, // lenses keep at least (r1 + r2) x gap between centres; closer dragons share one lens
};

// ?lens=0 (or the Settings checkbox, stored as da.lens) falls back to minimal markers
export const lensPref = {
  on: (() => {
    if (typeof location === 'undefined') return true;
    const q = new URLSearchParams(location.search).get('lens');
    if (q === '0' || q === '1') return q === '1';
    try { return localStorage.getItem('da.lens') !== '0'; } catch { return true; }
  })(),
};

const _v = new THREE.Vector3();
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const approach = (v, t, rate, dt) => (v < t ? Math.min(t, v + rate * dt) : Math.max(t, v - rate * dt));

/** Lens radius in CSS px for a viewport. */
export function lensRadius(W, H) {
  return Math.max(34, Math.min(58, Math.min(W, H) * 0.068));
}

/** Focal length in CSS px of a perspective camera for a viewport height. */
export function focalPx(camera, H) {
  return H / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

/** Wingspan inside the lens, in lens radii, for a dragon at distance d (m): smaller the further away it is. */
export function lensFill(d) {
  const k = Math.min(1, Math.max(0, (d - LENS.fillNear) / (LENS.fillFarFrom - LENS.fillNear)));
  return LENS.fill * (1 - (1 - LENS.fillFar) * k);
}

/** How many lenses at once: 2 on touch screens and small viewports, 3 otherwise (never more than the renderer allows). */
export function maxLensesFor(W, H, touch, rendererMax = 3) {
  return Math.min(rendererMax, touch || Math.min(W, H) < 500 ? 2 : 3);
}

export class LensDirector {
  constructor() {
    this.state = new Map(); // primary id -> smoothed lens state (each keeps its own reusable lens object)
    this.occ = new Map(); // id -> { t, v } throttled line-of-sight results
    this.time = 0;
    this.frame = 0;
    // scratch reused every frame (no per-frame Maps, arrays or records: Safari GC hitches)
    this.pool = [];
    this.all = [];
    this.cands = [];
    this.placed = [];
    this.placedPool = [];
    this.items = [];
    this.out = { lenses: [], cover: new Map(), hidden: new Set(), near: new Set(), aimedId: 0, labelId: 0, labelLens: 0, focal: 1, R: 1 };
  }

  /**
   * ctx: { camera, W, H, enemies: [{ ent, pos, dist, inCloud, ally, color, maxHp, ... }], lockId, lockP, locked,
   *        nose: {x,y}|null, attackers: Set<id>, maxLenses, touch, enabled, blocked(pos) -> bool (line of sight test) }
   * Returns the same object every frame: {
   *   lenses: [...], cover: Map(id -> how much a lens already shows it, 0..1),
   *   hidden: Set(ids of hostiles out of sight behind terrain, rocks, the Citadel or thick cloud),
   *   near: Set(ids big enough on screen for the plain close-range marks),
   *   aimedId (nearest the nose, within LENS.aimDist), labelId (the one dragon that gets a name: the lock target
   *   while there is one, else the aimed one), labelLens (id of the lens that carries that name; 0 = it goes on the
   *   dragon itself), focal, R }.
   */
  update(dt, ctx) {
    this.time += dt;
    this.frame++;
    const { camera, W, H } = ctx;
    const R = lensRadius(W, H);
    const focal = focalPx(camera, H);
    const out = this.out;
    out.lenses.length = 0;
    out.cover.clear();
    out.hidden.clear();
    out.near.clear();
    out.focal = focal;
    out.R = R;
    const lockId = ctx.lockId || 0;

    // project everything once; line of sight for every hostile on screen (throttled per dragon)
    const all = this.all;
    all.length = 0;
    let aimed = null, aimedD = Math.min(W, H) * 0.12, lockRec = null;
    for (const e of ctx.enemies) {
      _v.copy(e.pos).project(camera);
      if (_v.z > 1 || _v.z < -1) continue;
      const x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
      if (x < -R || x > W + R || y < -R || y > H + R) continue;
      const rec = this.pool[all.length] || (this.pool[all.length] = {});
      all.push(rec);
      rec.e = e; rec.id = e.ent.id; rec.x = x; rec.y = y; rec.dist = e.dist; rec.score = 0;
      rec.s = (LENS.span * focal) / Math.max(1, e.dist); // natural wingspan on screen, px
      rec.mNat = Math.min(LENS.mMax, (lensFill(e.dist) * R) / rec.s);
      rec.hidden = !e.ally && this.occluded(rec.id, e.pos, ctx.blocked);
      if (rec.hidden) out.hidden.add(rec.id);
      if (rec.id === lockId) lockRec = rec;
      if (!e.ally && !rec.hidden && ctx.nose && e.dist <= LENS.aimDist && !(e.inCloud && e.dist > 160)) {
        const d = Math.hypot(x - ctx.nose.x, y - ctx.nose.y) - rec.s * 0.5;
        if (d < aimedD) { aimedD = d; aimed = rec; }
      }
    }
    out.aimedId = aimed ? aimed.id : 0;
    // one "your target": the lock target while there is one, else the aimed dragon
    out.labelId = lockRec ? (lockRec.hidden ? 0 : lockId) : out.aimedId;
    out.labelLens = 0;
    for (const r of all) {
      const st = this.state.get(r.id);
      r.focus = !r.e.ally && (r.id === out.labelId || r.id === out.aimedId);
      const k = st ? st.focusK : r.focus && r.dist < LENS.focusDist ? 1 : 0;
      r.handOn = LENS.handOn + (LENS.focusHandOn - LENS.handOn) * k;
      r.mEff = r.mNat * (r.focus ? LENS.focusR : 1);
      if (!r.hidden && r.mEff <= r.handOn) out.near.add(r.id);
    }

    // candidates and their priority
    const cands = this.cands;
    cands.length = 0;
    if (ctx.enabled) {
      for (const r of all) {
        const e = r.e;
        if (e.ally || r.hidden || (e.inCloud && e.dist > 160) || e.dist > LENS.maxDist || r.mNat <= LENS.handOff) continue;
        if (r.x < R * 0.4 || r.x > W - R * 0.4 || r.y < R * 0.4 || r.y > H - R * 0.4) continue;
        let score = 0;
        if (r.id === lockId) score += 1000;
        if (ctx.attackers && ctx.attackers.has(r.id)) score += 400;
        if (ctx.nose) score += 300 * Math.max(0, 1 - Math.hypot(r.x - ctx.nose.x, r.y - ctx.nose.y) / (Math.min(W, H) * 0.3));
        score += 200 * Math.max(0, 1 - e.dist / 1600);
        const st = this.state.get(r.id);
        if (st && st.sel) score += 120; // hysteresis: don't flicker between two
        if (e.ent.bounty) score += 40;
        r.score = score;
        cands.push(r);
      }
      cands.sort((a, b) => b.score - a.score);
    }

    // place lenses: dragons that bunch up on screen share one lens; lenses never overlap; at most maxLenses
    const maxL = maxLensesFor(W, H, ctx.touch, ctx.maxLenses ?? 3);
    const placed = this.placed;
    placed.length = 0;
    for (const c of cands) {
      const rc = c.focus ? R * LENS.focusR : R;
      let merged = false;
      for (const L of placed) {
        if (Math.hypot(c.x - L.cx, c.y - L.cy) > (L.r + rc) * LENS.gap) continue;
        merged = true; // overlapping: never a second lens on top of this one
        if (L.n >= LENS.maxMembers) break;
        let cx = c.x, cy = c.y;
        for (let i = 0; i < L.n; i++) { cx += L.members[i].x; cy += L.members[i].y; }
        cx /= L.n + 1; cy /= L.n + 1;
        let m = c.mNat;
        for (let i = 0; i <= L.n; i++) {
          const q = i < L.n ? L.members[i] : c;
          m = Math.min(m, q.mNat, (0.84 * L.r) / (Math.hypot(q.x - cx, q.y - cy) + q.s * 0.5));
        }
        if (m < 1.3) break;
        L.members[L.n++] = c; L.cx = cx; L.cy = cy; L.m = m;
        break;
      }
      if (!merged && placed.length < maxL) {
        const L = this.placedPool[placed.length] || (this.placedPool[placed.length] = { members: [] });
        L.primary = c; L.members[0] = c; L.n = 1; L.cx = c.x; L.cy = c.y; L.r = rc;
        L.m = Math.min(LENS.mMax, c.mEff);
        placed.push(L);
      }
    }

    // smooth: every lens keeps its state by its primary dragon, fades in and out, eases its magnification
    const k = 1 - Math.exp(-dt * 7);
    for (const L of placed) {
      const p = L.primary, id = p.id;
      let st = this.state.get(id);
      if (!st) {
        st = {
          alpha: 0, lnm: Math.log(L.m), ox: L.cx - p.x, oy: L.cy - p.y, r: L.r, sel: true, seen: 0, n: 1, p,
          focusK: p.focus && p.dist < LENS.focusDist ? 1 : 0, members: [], lens: { views: [], members: [] },
        };
        this.state.set(id, st);
      }
      st.sel = true;
      st.seen = this.frame;
      st.lnm += (Math.log(L.m) - st.lnm) * k;
      st.ox += (L.cx - p.x - st.ox) * k;
      st.oy += (L.cy - p.y - st.oy) * k;
      st.r += (L.r - st.r) * k;
      st.alpha = approach(st.alpha, 1, 5, dt);
      st.p = p;
      st.n = L.n;
      for (let i = 0; i < L.n; i++) st.members[i] = L.members[i];
    }
    for (const [id, st] of this.state) {
      if (st.seen === this.frame) continue;
      st.sel = false;
      let rec = null;
      for (const r of all) if (r.id === id) { rec = r; break; }
      const gone = !rec || !ctx.enabled || rec.hidden;
      st.alpha = approach(st.alpha, 0, gone ? 12 : 6, dt);
      if (st.alpha <= 0.001 || !rec) { this.state.delete(id); continue; }
      st.lnm += (Math.log(Math.max(1, rec.mEff)) - st.lnm) * k;
      st.ox *= 1 - k; st.oy *= 1 - k;
      st.p = rec;
      st.n = 1;
      st.members[0] = rec;
    }
    // early hand-off for the dragon you're on, eased so a change of target never pops
    for (const st of this.state.values()) st.focusK = approach(st.focusK, st.p.focus && st.p.dist < LENS.focusDist ? 1 : 0, 3, dt);

    // output, selected lenses first, then the ones fading out (the renderer caps how many it draws)
    const items = this.items;
    items.length = 0;
    for (const st of this.state.values()) items.push(st);
    items.sort((a, b) => (b.sel - a.sel) || (b.alpha - a.alpha));
    for (const st of items) {
      const p = st.p, id = p.id;
      const m = Math.max(1, Math.exp(st.lnm));
      const hOn = LENS.handOn + (LENS.focusHandOn - LENS.handOn) * st.focusK;
      const hOff = LENS.handOff + (LENS.focusHandOff - LENS.handOff) * st.focusK;
      const hand = smooth(hOff, hOn, m);
      const a = st.alpha * st.alpha * (3 - 2 * st.alpha) * hand;
      if (a <= 0.004) continue;
      const cx = p.x + st.ox, cy = p.y + st.oy;
      const r = st.r * (0.78 + 0.22 * a);
      if (!st.sel) {
        // a lens on its way out never overlaps one that is showing
        let clash = false;
        for (const o of out.lenses) if (o.sel && Math.hypot(o.cx - cx, o.cy - cy) < (o.r + r) * 1.02) { clash = true; break; }
        if (clash) { this.state.delete(id); continue; }
      }
      // anything else that falls inside the lens field is drawn sharp too (and painted out of the background)
      const lens = st.lens;
      const views = lens.views;
      views.length = 0;
      let far = 0, near = Infinity;
      for (const o of all) {
        const inside = Math.hypot(o.x - cx, o.y - cy) * m < r * 1.15 + o.s * m * 0.5;
        if (!inside || o.hidden) continue;
        views.push(o.e.ent);
        far = Math.max(far, o.dist);
        near = Math.min(near, o.dist);
      }
      if (!views.length) { views.push(p.e.ent); far = near = p.dist; }
      let ring = 0; // the dragons' footprint in the main frame around the centre (px), for painting them out
      lens.members.length = 0;
      for (let i = 0; i < st.n; i++) {
        const mem = st.members[i];
        ring = Math.max(ring, Math.hypot(mem.x - cx, mem.y - cy) + mem.s * 0.55);
        lens.members.push(mem.id);
      }
      lens.id = id; lens.e = p.e; lens.cx = cx; lens.cy = cy; lens.r = r; lens.m = m; lens.alpha = a; lens.sel = st.sel;
      lens.ring = ring + 1.5;
      lens.near = near - LENS.span * 0.5 - 8;
      lens.far = far + LENS.span * 0.5 + 8;
      lens.lockP = id === lockId ? ctx.lockP : -1;
      lens.locked = id === lockId && !!ctx.locked;
      lens.aimed = id === out.aimedId;
      lens.label = false;
      out.lenses.push(lens);
      for (const mid of lens.members) out.cover.set(mid, Math.max(out.cover.get(mid) || 0, a));
    }
    // one name per dragon per frame, on whichever of its lens or its own marks is more visible
    if (out.labelId) {
      for (const L of out.lenses) {
        if (L.id === out.labelId && L.alpha >= 1 - (out.cover.get(L.id) || 0)) { L.label = true; out.labelLens = L.id; break; }
      }
    }
    return out;
  }

  /** Line of sight (terrain, sky rocks, the Citadel, thick cloud), cached per dragon for 0.15 s. test(pos) -> blocked. */
  occluded(id, pos, test) {
    if (!test) return false;
    let c = this.occ.get(id);
    if (c && this.time - c.t < 0.15) return c.v;
    if (!c) { c = { t: 0, v: false }; this.occ.set(id, c); }
    c.t = this.time;
    c.v = !!test(pos);
    if (this.occ.size > 64) for (const [key, o] of this.occ) if (this.time - o.t > 5) this.occ.delete(key);
    return c.v;
  }
}

// ------------------------------------------------------------------------------------------- rendering
// Per-lens constants are worked out once per vertex (four per lens), not per pixel: the colour right behind the dragon
// (an average of a ring around its footprint, ignoring the dragon itself) and the background blur radius.
const COMP_COMMON = /* glsl */ `
uniform sampler2D tLens, tScene, tDepth;
uniform vec2 uC, uSpan, uRes, uRingPx;
uniform float uRpx, uAlpha, uLocked, uNear, uFar, uExposure, uAgxPower, uAgxSat, uDepthOn;
uniform vec4 uProj;
varying vec2 vP;
varying vec3 vFill;
varying vec2 vBlur;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float linZ(float d) { return uProj.y / (d * 2.0 - 1.0 + uProj.x); }
`;

const COMP_VERT = /* glsl */ `
${COMP_COMMON}
uniform vec2 uCenter, uHalf; // NDC
uniform float uMargin;
void main() {
  vP = position.xy * uMargin;
  gl_Position = vec4(uCenter + position.xy * uHalf, 0.0, 1.0);
  vec3 acc = vec3(0.0); float w = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    for (int j = 0; j < 2; j++) {
      vec2 uv = uC + vec2(cos(a), sin(a)) * uRingPx * (1.0 + float(j) * 0.6);
      float z = uDepthOn > 0.5 ? linZ(textureLod(tDepth, uv, 0.0).r) : 1e9;
      float k = z < uFar && z > uNear ? 0.02 : 1.0;
      acc += textureLod(tScene, uv, 0.0).rgb * k; w += k;
    }
  }
  vFill = acc / w;
  // a heavy blur (a long lens's shallow depth of field): 0.1 lens radii, never under 1.25 source pixels
  vBlur = max(vec2(1.25) / uRes, 0.1 * uSpan);
}`;

// 12 taps on a Vogel disc plus the centre
const BLUR_TAPS = (() => {
  const t = ['vec2(0.0)'];
  for (let i = 1; i <= 12; i++) {
    const r = Math.sqrt((i - 0.5) / 12), a = i * 2.39996323;
    t.push(`vec2(${(Math.cos(a) * r).toFixed(4)}, ${(Math.sin(a) * r).toFixed(4)})`);
  }
  return `const vec2 TAPS[13] = vec2[13](${t.join(', ')});`;
})();

const COMP_FRAG = /* glsl */ `
${COMP_COMMON}
${TONEMAP_GLSL}
${BLUR_TAPS}

// what is behind the dragon: a heavily blurred, slightly darker copy of the main frame (sky, cloud, terrain). Taps
// that land on the main frame's own tiny dragon (by depth, inside its footprint) or on a hot additive spark next to
// it take the surrounding colour instead, so neither smears into a blob behind the sharp dragon.
vec3 background(vec2 p) {
  vec2 uv0 = uC + p * uSpan;
  float fl = max(luma(vFill), 1e-4);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 13; i++) {
    vec2 uv = uv0 + TAPS[i] * vBlur;
    vec3 c = texture2D(tScene, uv).rgb;
    float foot = 1.0 - smoothstep(1.0, 1.35, length((uv - uC) / uRingPx));
    if (foot > 0.0) {
      float k = smoothstep(1.4, 3.0, luma(c) / fl);
      if (uDepthOn > 0.5) {
        float z = linZ(texture2D(tDepth, uv).r);
        if (z < uFar && z > uNear) k = 1.0;
      }
      c = mix(c, vFill, k * foot);
    }
    acc += c;
  }
  return acc * (0.85 / 13.0);
}

void main() {
  float r = length(vP);
  float px = 1.0 / uRpx; // one device pixel in lens units
  if (r > 1.0 + 12.0 * px) discard;
  float a = uAlpha;
  // outside the glass: a soft contact shadow lifts the lens off the world
  if (r > 1.0 + px) {
    float sh = (1.0 - smoothstep(1.0, 1.0 + 9.0 * px, r)) * 0.28;
    gl_FragColor = vec4(0.0, 0.0, 0.0, sh * a);
    return;
  }
  // refraction: the glass compresses the image towards its edge, with a little lateral colour on the sharp dragon
  float bend = 1.0 - 0.10 * r * r * r;
  vec2 q = vP * bend;
  vec3 bg = background(q);
  vec4 l = texture2D(tLens, q * 0.5 + 0.5);
  vec3 col = l.rgb + bg * (1.0 - clamp(l.a, 0.0, 1.0));
  float ca = 0.016 * smoothstep(0.5, 1.0, r);
  if (ca > 0.0005) {
    vec4 lr = texture2D(tLens, q * (1.0 - ca) * 0.5 + 0.5), lb = texture2D(tLens, q * (1.0 + ca) * 0.5 + 0.5);
    col.r = lr.r + bg.r * (1.0 - clamp(lr.a, 0.0, 1.0));
    col.b = lb.b + bg.b * (1.0 - clamp(lb.a, 0.0, 1.0));
  }
  col *= 1.0 - 0.30 * pow(smoothstep(0.45, 1.0, r), 1.6); // inner vignette
  col *= uExposure;
  col = toSRGB(AgX(col));
  col = grade(col);
  // glass: a faint sky reflection in the upper left and a darker bezel just inside the rim
  vec2 n = vP / max(r, 1e-4);
  float spec = smoothstep(0.62, 0.97, r) * pow(max(0.0, dot(n, normalize(vec2(-0.55, 0.83)))), 4.0);
  col += vec3(0.95, 0.97, 1.0) * spec * 0.16;
  col += vec3(0.9, 0.95, 1.0) * 0.035 * (1.0 - smoothstep(0.0, 0.9, length(vP - vec2(-0.42, 0.5))));
  col *= 1.0 - 0.35 * smoothstep(1.0 - 5.0 * px, 1.0 - 1.5 * px, r);
  // the rim itself: a thin warm-white line, warm red and a little thicker once locked
  float w = mix(1.1, 1.8, uLocked) * px;
  float rim = 1.0 - smoothstep(w * 0.5, w * 0.5 + px, abs(r - (1.0 - w * 0.5)));
  vec3 rimCol = mix(vec3(1.0, 0.95, 0.86), vec3(1.0, 0.36, 0.235), uLocked);
  col = mix(col, rimCol, rim * mix(0.75, 0.95, uLocked));
  float inside = 1.0 - smoothstep(1.0 - px * 0.5, 1.0 + px * 0.5, r);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), a * max(inside, rim));
}`;

const QUALITY_LENS = [
  { size: 128, samples: 0, budget: 2, max: 2, fx: false },
  { size: 192, samples: 4, budget: 3, max: 3, fx: true },
  { size: 256, samples: 4, budget: 4, max: 3, fx: true },
];

export class LensRenderer {
  constructor(w3) {
    this.w3 = w3;
    this.renderer = w3.renderer;
    this.items = [];
    this.slots = new Map(); // lens id -> { rt, frame, mesh }
    this.free = [];
    this.frame = 0;
    this.quality = 1;
    this.cam = new THREE.PerspectiveCamera();
    this.cam.matrixAutoUpdate = false;
    this.cam.matrixWorldAutoUpdate = false;
    this.compScene = new THREE.Scene();
    this.compScene.matrixWorldAutoUpdate = false;
    this.compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.geo = new THREE.PlaneGeometry(2, 2);
    this.stats = { renders: 0, calls: 0 };
    this._hidden = [];
    this._order = [];
    this._shown = [];
    this._keep = new Set();
    this._cc = new THREE.Color();
  }

  get params() { return QUALITY_LENS[this.quality]; }
  get maxLenses() { return this.params.max; }

  setQuality(q) {
    if (q === this.quality && this.slots.size) return;
    this.quality = q;
    for (const s of this.slots.values()) this.disposeSlot(s);
    for (const s of this.free) this.disposeSlot(s);
    this.slots.clear();
    this.free = [];
  }

  disposeSlot(s) {
    s.rt.dispose();
    s.mesh.material.dispose();
    this.compScene.remove(s.mesh);
  }

  makeSlot() {
    const p = this.params;
    const rt = new THREE.WebGLRenderTarget(p.size, p.size, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, samples: p.samples,
    });
    const u = {
      tLens: { value: rt.texture }, tScene: { value: null }, tDepth: { value: null },
      uC: { value: new THREE.Vector2() }, uSpan: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2(1, 1) },
      uRingPx: { value: new THREE.Vector2() },
      uRpx: { value: 50 }, uAlpha: { value: 0 }, uLocked: { value: 0 }, uNear: { value: 0 }, uFar: { value: 100 }, uExposure: { value: 1 },
      uAgxPower: { value: 1.3 }, uAgxSat: { value: 1.2 }, uDepthOn: { value: 1 },
      uProj: { value: new THREE.Vector4() },
      uCenter: { value: new THREE.Vector2() }, uHalf: { value: new THREE.Vector2() }, uMargin: { value: 1.2 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: COMP_VERT, fragmentShader: COMP_FRAG, uniforms: u,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.compScene.add(mesh);
    return { rt, mesh, frame: -1, m: 1 };
  }

  /** this frame's lenses from LensDirector.update(); [] hides them all */
  set(items) { this.items = items || []; }

  render() {
    this.stats.renders = 0;
    this.stats.calls = 0;
    const items = this.items;
    const n = Math.min(items.length, this.maxLenses + 1);
    this.frame++;
    // recycle the targets of lenses that are gone (a recycled target must render before it is shown again)
    for (let i = 0; i < n; i++) {
      const s = this.slots.get(items[i].id);
      if (s) s.live = this.frame;
    }
    for (const [id, s] of this.slots) {
      if (s.live === this.frame) continue;
      s.mesh.visible = false;
      s.frame = -1;
      this.slots.delete(id);
      this.free.push(s);
    }
    if (!n) return;
    const post = this.w3.post;
    if (!post || !post.sceneRT) return;
    const r = this.renderer, scene = this.w3.scene, cam = this.w3.camera;
    const W = innerWidth, H = innerHeight;
    for (let i = 0; i < n; i++) {
      const l = items[i];
      if (!this.slots.has(l.id)) { const s = this.free.pop() || this.makeSlot(); s.frame = -1; s.live = this.frame; this.slots.set(l.id, s); }
    }

    // which lenses get a fresh render this frame: new ones and the primary always, the rest round-robin
    const order = this._order;
    order.length = 0;
    for (let i = 0; i < n; i++) {
      const s = this.slots.get(items[i].id);
      s.key = s.frame < 0 ? -2 : i === 0 ? -1 : s.frame;
      s.item = items[i];
      order.push(s);
    }
    order.sort((a, b) => a.key - b.key);
    const todo = Math.min(order.length, this.params.budget);

    // ---- 1. lens views: only dragons (and fire / trails at q>=1) against a transparent background
    const info = r.info;
    const callsBefore = info.render.calls;
    const autoReset = info.autoReset;
    info.autoReset = false;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.shadowMap.autoUpdate;
    const prevSceneAuto = scene.matrixWorldAutoUpdate;
    r.getClearColor(this._cc);
    const prevAlpha = r.getClearAlpha();
    r.shadowMap.autoUpdate = false; // the shadow map from the main pass is reused, never re-rendered here
    scene.matrixWorldAutoUpdate = false; // matrices are current from the main pass
    const keep = this._keep;
    keep.clear();
    const fx = this.w3.fx, trails = this.w3.trails;
    const pools = fx && fx.pools ? fx.pools : [];
    if (this.params.fx) {
      if (fx) {
        for (const p of pools) if (p.mesh) keep.add(p.mesh);
        if (fx.ribbons && fx.ribbons.mesh) keep.add(fx.ribbons.mesh);
        if (fx.arcs && fx.arcs.mesh) keep.add(fx.arcs.mesh);
      }
      if (trails && trails.mesh) keep.add(trails.mesh);
    }
    const hidden = this._hidden;
    hidden.length = 0;
    for (const o of scene.children) {
      if (o.isLight || keep.has(o) || !o.visible) continue; // lights stay so the dragon shaders see the same light set
      o.visible = false;
      hidden.push(o);
    }
    r.setClearColor(0x000000, 0);
    cam.updateMatrixWorld();
    const shown = this._shown;
    for (let t = 0; t < todo; t++) {
      const s = order[t], l = s.item;
      this.setupCamera(l, cam, W, H);
      // particles fade by the share of the screen they cover: tell them how much this lens zooms (vfx-particles uZoom)
      for (const p of pools) if (p.uniforms && p.uniforms.uZoom) p.uniforms.uZoom.value = l.m;
      // the dragons keep the mesh the main view picked: the lens shows a far dragon at about a lens radius, smaller
      // than the size at which the main view switches to the full mesh (140 m x DRAGON_SCALE), so the 22-26k triangle one is enough
      shown.length = 0;
      for (const ent of l.views) {
        const v = ent.view;
        if (!v || !v.root) continue;
        v.root.visible = true;
        shown.push(v);
      }
      r.setRenderTarget(s.rt);
      r.clear();
      r.render(scene, this.cam);
      for (const v of shown) v.root.visible = false;
      s.frame = this.frame;
      s.m = l.m;
      this.stats.renders++;
    }
    for (const p of pools) if (p.uniforms && p.uniforms.uZoom) p.uniforms.uZoom.value = 1;
    for (const o of hidden) o.visible = true;
    r.shadowMap.autoUpdate = prevAuto;
    scene.matrixWorldAutoUpdate = prevSceneAuto;
    r.setClearColor(this._cc, prevAlpha);

    // ---- 2. composite every lens onto the canvas
    const pu = post.uniforms;
    const dpr = r.getPixelRatio();
    const sceneTex = post.sceneRT.texture, depthTex = post.sceneRT.depthTexture;
    const sw = post.sceneRT.width, sh = post.sceneRT.height;
    const whiteout = pu.whiteout.value;
    for (let i = 0; i < n; i++) {
      const l = items[i];
      const s = this.slots.get(l.id);
      const u = s.mesh.material.uniforms;
      const margin = 1 + 12 / l.r;
      u.tScene.value = sceneTex;
      u.tDepth.value = depthTex;
      u.uDepthOn.value = depthTex ? 1 : 0;
      u.uRes.value.set(sw, sh);
      u.uC.value.set(l.cx / W, 1 - l.cy / H);
      u.uSpan.value.set(l.r / l.m / W, l.r / l.m / H);
      u.uRingPx.value.set(l.ring / W, l.ring / H);
      u.uRpx.value = l.r * dpr;
      u.uAlpha.value = s.frame < 0 ? 0 : l.alpha * (1 - Math.min(1, whiteout * 1.4)); // not rendered yet: not shown
      u.uLocked.value = l.locked ? 1 : 0;
      u.uNear.value = l.near;
      u.uFar.value = l.far;
      u.uExposure.value = post.exposure * post.exposureMul;
      u.uAgxPower.value = pu.uAgxPower.value;
      u.uAgxSat.value = pu.uAgxSat.value;
      u.uProj.value.copy(pu.uProj.value);
      u.uCenter.value.set((l.cx / W) * 2 - 1, 1 - (l.cy / H) * 2);
      u.uHalf.value.set(((l.r * margin) / W) * 2, ((l.r * margin) / H) * 2);
      u.uMargin.value = margin;
      s.mesh.visible = u.uAlpha.value > 0.004;
    }
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(null);
    r.render(this.compScene, this.compCam);
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    this.stats.calls = info.render.calls - callsBefore;
    info.autoReset = autoReset;
  }

  // the main camera, zoomed by l.m around the lens centre: an off-axis projection that maps the lens disc onto
  // the square target. Same position and orientation, so haze, lighting and roll match the world exactly.
  setupCamera(l, cam, W, H) {
    const c = this.cam;
    c.near = cam.near; c.far = cam.far;
    c.matrixWorld.copy(cam.matrixWorld);
    c.matrixWorldInverse.copy(cam.matrixWorldInverse);
    c.position.copy(cam.position);
    c.quaternion.copy(cam.quaternion);
    const px = (l.cx / W) * 2 - 1, py = 1 - (l.cy / H) * 2;
    const sx = (l.m * W) / (2 * l.r), sy = (l.m * H) / (2 * l.r);
    const P = c.projectionMatrix.copy(cam.projectionMatrix).elements;
    for (let col = 0; col < 4; col++) {
      const w = P[col * 4 + 3];
      P[col * 4] = sx * (P[col * 4] - px * w);
      P[col * 4 + 1] = sy * (P[col * 4 + 1] - py * w);
    }
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
  }
}
