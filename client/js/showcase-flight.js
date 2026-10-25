// The title screen's flight: one long, closed route through the real map, flown like a heavy animal (it trades
// height for speed, beats hard on climbs, glides and tucks in dives, banks into turns), plus the shot list the
// "camera crew" films it with. Pure math with no three.js and no DOM, so tests/showcase.test.mjs can check in Node
// that neither the dragon nor any camera ever goes through terrain, the Citadel, a sea stack or a sky island.
//
// Route (about 2 minutes, a loop): in from the open sea low over the water and up the eastern fjord, weaving
// between its sea stacks; a hard pull-up over the waterfall's head wall and a long, labouring climb over the pass
// to the Citadel; a banking circuit round the keep past the great spires; a steep dive off the massif's cliff into
// the moat canyon and a low run along it; out through the northern pass, threading its stone gate; down over the
// beach, round the cliffs of the satellite island, a climb and a long gliding turn high over the sea, then a
// descending turn back down to the waves at the fjord's mouth.

const G = 9.8;
const DT = 1 / 30; // the precomputed flight is a table at this time step

// B-spline control points [x, y, z, mark]. The curve does not pass through them exactly (it is a smooth
// approximation), which is what makes the flight read as one continuous motion; marks name moments for the shots.
export const ROUTE = [
  // the open sea, lined up on the fjord's mouth
  [2780, 34, 1420, 'sea'],
  [2560, 26, 1230],
  [2330, 24, 1060],
  [2110, 24, 958, 'mouth'],
  // the fjord: weave between the sea stacks, wingtips over the water
  [1940, 24, 900],
  [1800, 25, 885, 'stacks'],
  [1700, 25, 902],
  [1600, 26, 856],
  [1510, 30, 818],
  // the head wall: pull up hard over the waterfall and labour up the pass
  [1420, 62, 772, 'pullup'],
  [1330, 150, 712],
  [1255, 250, 638],
  [1180, 330, 560, 'pass'],
  [1090, 410, 488],
  [960, 490, 452],
  [820, 585, 430],
  [690, 680, 380],
  [580, 770, 290],
  [490, 850, 170, 'climb'],
  [420, 920, 30],
  [370, 970, -100],
  // round the Citadel: bank past the great towers (e, ne, nw) with the keep's spire inside the turn
  [290, 1005, -215, 'citadel'],
  [160, 1022, -310],
  [0, 1030, -345, 'spires'],
  [-150, 1027, -315],
  [-270, 1015, -225],
  [-330, 990, -100, 'divein'],
  // leave the turn on its tangent: a long straight dive off the massif's cliff
  [-380, 930, 40],
  [-430, 820, 180],
  [-490, 640, 340, 'dive'],
  [-550, 430, 500],
  [-610, 250, 660],
  [-650, 140, 790],
  // pull out low and run the moat canyon east, past its rock needle
  [-610, 115, 880, 'moat'],
  [-480, 112, 925],
  [-320, 114, 950],
  [-180, 118, 960],
  [-40, 122, 975],
  [100, 132, 992],
  // out through the northern pass and its stone gate
  [190, 145, 1025, 'turnout'],
  [255, 165, 1110],
  [282, 196, 1235],
  [305, 210, 1321, 'gate'],
  [328, 224, 1407],
  [358, 252, 1500],
  [398, 266, 1585],
  [440, 248, 1670],
  [490, 200, 1760, 'coast'],
  // down over the beach and round the satellite island's cliffs
  [540, 120, 1880],
  [560, 70, 2010],
  [570, 62, 2170, 'island'],
  [610, 70, 2380],
  [720, 90, 2560],
  [900, 130, 2690],
  // climb out and a long gliding turn high over the sea
  [1150, 230, 2760, 'climbout'],
  [1450, 360, 2780],
  [1780, 450, 2720],
  [2100, 490, 2600, 'glide'],
  [2400, 480, 2420],
  [2650, 440, 2180],
  [2840, 360, 1930],
  // a descending turn back down to the waves
  [2960, 230, 1720, 'descent'],
  [2960, 120, 1560],
];

// ---------------------------------------------------------------------------------------------- the flight table
const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// closed uniform cubic B-spline
function bspline(P, i, t, out) {
  const n = P.length;
  const p0 = P[(i - 1 + n) % n], p1 = P[i % n], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
  const t2 = t * t, t3 = t2 * t;
  const b0 = (1 - 3 * t + 3 * t2 - t3) / 6, b1 = (4 - 6 * t2 + 3 * t3) / 6, b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6, b3 = t3 / 6;
  for (let k = 0; k < 3; k++) out[k] = b0 * p0[k] + b1 * p1[k] + b2 * p2[k] + b3 * p3[k];
  return out;
}

// Gaussian blur of a periodic array of numbers (stride `w`), sigma in samples
function blurLoop(src, w, sigma) {
  const n = src.length / w, r = Math.ceil(sigma * 2.5), out = new Float32Array(src.length);
  const k = [];
  let ks = 0;
  for (let j = -r; j <= r; j++) ks += k[j + r] = Math.exp(-(j * j) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += src[(((i + j) % n) + n) % n * w + c] * k[j + r];
      out[i * w + c] = s / ks;
    }
  }
  return out;
}

/**
 * Precomputes the flight: positions along the route at a fixed time step, with the speed a heavy flier would have
 * (faster in dives, slower on climbs) and a coordinated bank into every turn.
 * Returns { duration, marks, sample(T, out) }.
 */
export function buildFlight(route = ROUTE) {
  // 1. dense polyline along the spline, by arc length
  const pts = [];
  const tmp = v3();
  for (let i = 0; i < route.length; i++) for (let s = 0; s < 40; s++) pts.push(bspline(route, i, s / 40, tmp).slice());
  const n0 = pts.length;
  const cum = new Float64Array(n0 + 1);
  for (let i = 0; i < n0; i++) cum[i + 1] = cum[i] + len(sub(pts[(i + 1) % n0], pts[i]));
  const L = cum[n0];
  const markS = {};
  route.forEach((p, i) => p[3] && (markS[p[3]] = cum[i * 40]));
  const at = (s, out) => {
    s = ((s % L) + L) % L;
    let lo = 0, hi = n0;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    const a = pts[lo], b = pts[(lo + 1) % n0], f = (s - cum[lo]) / (cum[lo + 1] - cum[lo] || 1);
    out[0] = a[0] + (b[0] - a[0]) * f;
    out[1] = a[1] + (b[1] - a[1]) * f;
    out[2] = a[2] + (b[2] - a[2]) * f;
    return out;
  };

  // 2. speed along the route: gravity along the path, wingbeats (harder when climbing), drag. Two laps so the
  // speed at the seam matches.
  const DS = 2;
  const ns = Math.ceil(L / DS);
  const vs = new Float64Array(ns + 1);
  const pa = v3(), pb = v3();
  let v = 95;
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i <= ns; i++) {
      vs[i] = v;
      at(i * DS, pa);
      at(i * DS + DS, pb);
      const sinG = (pb[1] - pa[1]) / DS;
      const thrust = sinG > -0.08 ? 3.2 + 7.5 * Math.max(0, sinG) : 0.7;
      const a = -G * sinG + thrust - 3.2 * (v / 96) ** 2;
      v = clamp(Math.sqrt(Math.max(1, v * v + 2 * a * DS)), 52, 165);
    }
  }
  const tAt = new Float64Array(ns + 1);
  for (let i = 1; i <= ns; i++) tAt[i] = tAt[i - 1] + (2 * DS) / (vs[i - 1] + vs[i]);
  const duration = tAt[ns] * (L / (ns * DS));
  const sOfT = (T) => {
    T = ((T % duration) + duration) % duration;
    const tt = T / (L / (ns * DS));
    let lo = 0, hi = ns;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (tAt[m] <= tt) lo = m;
      else hi = m;
    }
    return (lo + (tt - tAt[lo]) / (tAt[lo + 1] - tAt[lo] || 1)) * DS;
  };
  const tOfS = (s) => {
    const i = clamp(Math.floor(s / DS), 0, ns - 1), f = s / DS - i;
    return (tAt[i] + (tAt[i + 1] - tAt[i]) * f) * (L / (ns * DS));
  };
  const marks = {};
  for (const [k, s] of Object.entries(markS)) marks[k] = tOfS(s);

  // 3. the table at DT: position, then velocity and acceleration (smoothed), then the banked attitude
  const N = Math.round(duration / DT);
  const dt = duration / N;
  const P = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    at(sOfT(i * dt), pa);
    P[i * 3] = pa[0];
    P[i * 3 + 1] = pa[1];
    P[i * 3 + 2] = pa[2];
  }
  const idx = (i) => ((i % N) + N) % N;
  const V = new Float32Array(N * 3), A = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) V[i * 3 + c] = (P[idx(i + 1) * 3 + c] - P[idx(i - 1) * 3 + c]) / (2 * dt);
  const Vs = blurLoop(V, 3, 3);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) A[i * 3 + c] = (Vs[idx(i + 1) * 3 + c] - Vs[idx(i - 1) * 3 + c]) / (2 * dt);
  const As = blurLoop(A, 3, 16); // ~0.5 s: the bank leads and settles like a real roll, never snaps
  // per sample: forward f, up u (lift direction, bank capped), speed, climb (sin of the path angle), turn rate,
  // bank angle and pitch rate
  const F = new Float32Array(N * 3), U = new Float32Array(N * 3), S = new Float32Array(N * 6);
  // coordinated bank: lift points along (acceleration - gravity). A push-over into a dive never rolls the animal
  // over: the vertical part is floored, so only sideways acceleration banks it. Then the roll itself is smoothed.
  const B = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const f = norm([Vs[i * 3], Vs[i * 3 + 1], Vs[i * 3 + 2]]);
    const acc = [As[i * 3], As[i * 3 + 1] + G, As[i * 3 + 2]];
    const lv = norm(sub([0, 1, 0], f.map((x) => x * f[1])));
    const right = norm(cross(f, lv));
    B[i] = clamp(Math.atan2(dot(acc, right), Math.max(G * 0.8, dot(acc, lv))), -1.2, 1.2);
  }
  const Bs = blurLoop(B, 1, 11);
  for (let i = 0; i < N; i++) {
    const vel = [Vs[i * 3], Vs[i * 3 + 1], Vs[i * 3 + 2]];
    const sp = len(vel);
    const f = norm(vel);
    // level reference: world up made perpendicular to the flight direction
    const lv = norm(sub([0, 1, 0], f.map((x) => x * f[1])));
    const right = norm(cross(f, lv));
    const bank = Bs[i];
    const u = [0, 1, 2].map((k) => lv[k] * Math.cos(bank) + right[k] * Math.sin(bank));
    for (let c = 0; c < 3; c++) {
      F[i * 3 + c] = f[c];
      U[i * 3 + c] = u[c];
    }
    S[i * 6] = sp;
    S[i * 6 + 1] = f[1];
    S[i * 6 + 4] = bank;
  }
  // turn rate (yaw, rad/s) and pitch rate, from the forward vectors
  for (let i = 0; i < N; i++) {
    const a = idx(i - 1) * 3, b = idx(i + 1) * 3;
    const ya = Math.atan2(F[a], F[a + 2]), yb = Math.atan2(F[b], F[b + 2]);
    let dy = yb - ya;
    dy -= Math.PI * 2 * Math.round(dy / (Math.PI * 2));
    S[i * 6 + 2] = dy / (2 * dt);
    S[i * 6 + 3] = (Math.asin(clamp(F[b + 1], -1, 1)) - Math.asin(clamp(F[a + 1], -1, 1))) / (2 * dt);
  }
  // the dragon's effort: beat hard on climbs and when slow, glide when level and fast, tuck the wings in dives
  for (let i = 0; i < N; i++) {
    let c = 0;
    for (let j = -12; j <= 12; j++) c += S[idx(i + j) * 6 + 1];
    c /= 25; // the climb a moment either side: the animal plans ahead
    const sp = S[i * 6];
    S[i * 6 + 5] = clamp(0.4 + c * 2.4 + (95 - sp) * 0.012, 0, 1.3);
  }

  const lerpInto = (arr, i0, i1, f, out) => {
    for (let c = 0; c < 3; c++) out[c] = arr[i0 * 3 + c] + (arr[i1 * 3 + c] - arr[i0 * 3 + c]) * f;
    return out;
  };
  /** Fills out = { p, f, u, speed, climb, yawRate, pitchRate, bank, effort } at timeline time T (seconds). */
  function sample(T, out) {
    T = ((T % duration) + duration) % duration;
    const x = T / dt, i0 = Math.floor(x) % N, i1 = (i0 + 1) % N, f = x - Math.floor(x);
    lerpInto(P, i0, i1, f, out.p);
    lerpInto(F, i0, i1, f, out.f);
    lerpInto(U, i0, i1, f, out.u);
    const g = (k) => S[i0 * 6 + k] + (S[i1 * 6 + k] - S[i0 * 6 + k]) * f;
    out.speed = g(0);
    out.climb = g(1);
    out.yawRate = g(2);
    out.pitchRate = g(3);
    out.bank = g(4);
    out.effort = g(5);
    return out;
  }
  return { duration, length: L, marks, sample, newState: () => ({ p: v3(), f: v3(), u: v3(), speed: 0, climb: 0, yawRate: 0, pitchRate: 0, bank: 0, effort: 0 }) };
}

// ---------------------------------------------------------------------------------------------- the camera crew
// Shots run back to back with hard cuts, each starting at a mark of the route (plus seconds), so the cuts land on
// what the dragon is doing. Offsets are [side (+ right), forward (+ ahead), up] in metres in the dragon's heading
// frame (level, no bank).
//   track  a chase ship flying alongside on a long lens; the offset creeps from a to b over the shot
//   fixed  a camera parked beside the route (placed from the dragon's frame at time tc); the operator pans to
//          follow it past, zooming to hold its size. absY pins the camera's height.
// h is the height of the frame, in metres, at the dragon's distance: the lens follows from it (about 40 m puts the
// 24 m wingspan across a third of a 16:9 frame), so a far camera is a long lens and the framing always holds.
//   orbit  circles the dragon (angle from its nose, radians, + toward its right) during a glide
//   mount  over the shoulder: rides on the dragon's back, banking with it a little, looking `ahead` metres
export const SHOTS = [
  { from: ['sea', 0], type: 'track', a: [-70, -120, 8], b: [-60, -30, 4], h: [44, 40], lead: 8 },
  { from: ['stacks', -1.6], type: 'fixed', tc: ['stacks', 1.0], off: [-42, 10, 0], absY: 14, h: 60 },
  { from: ['pullup', -0.6], type: 'fixed', tc: ['pullup', 1.6], off: [-72, -10, 0], absY: 12, h: 64 },
  { from: ['pass', -1.3], type: 'mount', off: [1.2, -17, 4.8], ahead: 70 },
  { from: ['pass', 6.8], type: 'track', a: [95, 30, -10], b: [85, -6, 6], h: [42, 40], lead: 10 },
  { from: ['citadel', -2.2], type: 'track', a: [110, 20, 14], b: [95, -15, 8], h: [46, 42], lead: 8 },
  { from: ['spires', 1.2], type: 'fixed', tc: ['spires', 4.2], off: [-30, 20, 6], h: 56 },
  { from: ['divein', 1.5], type: 'track', a: [8, -48, 20], b: [4, -36, 13], h: [36, 34], lead: 24 },
  { from: ['dive', 3.0], type: 'fixed', tc: ['moat', -0.2], off: [34, 20, 0], absY: 100, h: 56 },
  { from: ['moat', 1.8], type: 'fixed', tc: ['moat', 4.2], off: [-40, 40, 0], absY: 76, h: 60 },
  { from: ['turnout', 1.0], type: 'fixed', tc: ['gate', 1.1], off: [22, 0, 8], h: 70 },
  { from: ['gate', 2.5], type: 'track', a: [-30, -70, 34], b: [-75, -12, 5], h: [40, 38], lead: 10 },
  { from: ['island', -0.6], type: 'fixed', tc: ['island', 2.5], off: [30, 30, 0], absY: 6, h: 62 },
  { from: ['climbout', -2.5], type: 'track', a: [-25, -70, -24], b: [-35, -52, -16], h: [40, 38], lead: 12 },
  { from: ['climbout', 6.5], type: 'orbit', r: 60, up: 6, a0: 2.2, rate: -0.13, h: 40 },
  { from: ['glide', 7.5], type: 'mount', off: [-1.2, -17, 4.8], ahead: 80 },
  { from: ['descent', 0.5], type: 'fixed', tc: ['descent', 3.6], off: [-34, 30, 0], absY: 8, h: 60 },
];

// the close hero angle a breed change cuts to: front three-quarter, low (looking up at it, so sky fills more of the
// frame behind), on the sunlit side
export const HERO = { side: 36, fwd: 24, up: -9, h: 30, lead: 5, dur: 2.8 };

// Where a breed change cuts to: moments of the flight picked for the close-up (the film jumps there). Each has the
// camera on the dragon's right (side +1), so the dragon faces screen right and roars and breathes across the open
// frame, away from the menu column; the sun behind the camera, so what is behind the dragon is lit too: open sky,
// sea or land at least 300 m back (no near rock in shade); the dragon below the low cloud layer's lowest base; the
// camera well above the trees.
// tests/showcase.test.mjs checks every one of these for the whole close-up.
export const HERO_SPOTS = [
  { at: ['climbout', 1.2], side: 1 }, // climbing out over the northern sea, open sky behind
  { at: ['moat', 2.1], side: 1 }, // low along the moat canyon: its sunlit far wall, then sky over the rim
  { at: ['descent', -3.6], side: 1 }, // the turn down to the waves, open sky behind
];

/** The i-th close-up spot (wraps): { t, side, scale } with t in timeline seconds. */
export function heroSpot(flight, i) {
  const s = HERO_SPOTS[((i % HERO_SPOTS.length) + HERO_SPOTS.length) % HERO_SPOTS.length];
  const D = flight.duration;
  return { t: (((flight.marks[s.at[0]] + s.at[1]) % D) + D) % D, side: s.side, scale: s.scale || 1 };
}
const SUN_H = norm([0.5543, 0, 0.3775]);
const sunSide = (h) => Math.sign(h.r[0] * SUN_H[0] + h.r[2] * SUN_H[2]) || 1;

/**
 * Chooses the breed-change close-up starting at time T: the sunlit side first, then the other side, then closer in,
 * until `clear(cameraPos, dragonPos)` holds for the whole close-up. Returns { side, scale }.
 */
export function pickHero(flight, T, clear) {
  const sun = sunSide(heading(flight, T, 1.0, {}));
  const cam = newCamera(), st = { p: v3(), f: v3(), u: v3() };
  for (const scale of [1, 0.75, 0.55]) {
    for (const side of [sun, -sun]) {
      let ok = true;
      for (let k = 0; k <= 28 && ok; k++) {
        const dt = (HERO.dur * k) / 28; // every ~10 m of flight: a sea stack is narrow
        cameraAt(flight, null, T + dt, cam, dt, { side, scale });
        ok = clear(cam.pos, flight.sample(T + dt, st).p);
      }
      if (ok) return { side, scale };
    }
  }
  return { side: sun, scale: 0.55 };
}

/** Resolves the shot list against a flight: absolute start/end times and closest-approach times. */
export function scheduleShots(flight, shots = SHOTS) {
  const D = flight.duration;
  const t = (m) => (((flight.marks[m[0]] + m[1]) % D) + D) % D;
  const out = shots.map((s) => ({ ...s, t0: t(s.from), tc: s.tc ? t(s.tc) : 0 }));
  out.sort((a, b) => a.t0 - b.t0);
  out.forEach((s, i) => (s.t1 = i + 1 < out.length ? out[i + 1].t0 : out[0].t0 + D));
  return out;
}

/** The shot playing at timeline time T. */
export function shotAt(sched, T, D) {
  T = ((T % D) + D) % D;
  for (const s of sched) if (T >= s.t0 && T < s.t1) return s;
  return sched[sched.length - 1]; // before the first start: the last shot runs over the seam
}

const _st = { p: v3(), f: v3(), u: v3() };
const _sa = { p: v3(), f: v3(), u: v3() };
const _sc = { p: v3(), f: v3(), u: v3() };
// level heading frame, averaged over the last `win` seconds so a chase ship eases into turns
function heading(flight, T, win, out) {
  let fx = 0, fz = 0;
  for (let k = 0; k < 5; k++) {
    flight.sample(T - (win * k) / 4, _sa);
    fx += _sa.f[0];
    fz += _sa.f[2];
  }
  const l = Math.hypot(fx, fz) || 1;
  out.f = [fx / l, 0, fz / l];
  out.r = [-fz / l, 0, fx / l];
  return out;
}
const place = (p, h, o, out) => {
  for (let k = 0; k < 3; k++) out[k] = p[k] + h.r[k] * o[0] + h.f[k] * o[1] + (k === 1 ? o[2] : 0);
  return out;
};
const wrap = (x, D) => ((x % D) + D) % D;
// vertical field of view (degrees) that shows h metres of height at distance d
const lens = (h, d) => (2 * Math.atan(h / (2 * Math.max(1, d))) * 180) / Math.PI;

/**
 * Where the camera is at time T: { pos, look, fov (vertical, for a 16:9 frame), roll, focus (the point to keep
 * sharp), shot }. `hero` (seconds into a breed-change close-up, or -1) overrides the shot, on the side and at the
 * distance `pick` gives (see pickHero). Deterministic in T.
 */
export function cameraAt(flight, sched, T, out, hero = -1, pick = null) {
  const D = flight.duration;
  const st = flight.sample(T, _st);
  const h = heading(flight, T, 1.0, {});
  out.roll = 0;
  out.focus = st.p;
  if (hero >= 0) {
    const side = pick ? pick.side : sunSide(h), sc = pick ? pick.scale : 1;
    out.heroSide = side;
    const push = sc * (1 - Math.min(1, hero / HERO.dur) * 0.18); // a slow push-in while it roars
    place(st.p, h, [HERO.side * side * push, HERO.fwd * push, HERO.up], out.pos);
    for (let k = 0; k < 3; k++) out.look[k] = st.p[k] + st.f[k] * HERO.lead;
    out.fov = lens(HERO.h, len(sub(out.pos, st.p)));
    out.shot = 'hero';
    return out;
  }
  const s = shotAt(sched, T, D);
  const e = clamp(wrap(T - s.t0, D) / (s.t1 - s.t0), 0, 1);
  const ease = e * e * (3 - 2 * e);
  out.shot = s.type;
  if (s.type === 'track') {
    const o = [0, 1, 2].map((k) => s.a[k] + (s.b[k] - s.a[k]) * ease);
    place(st.p, h, o, out.pos);
    for (let k = 0; k < 3; k++) out.look[k] = st.p[k] + st.f[k] * s.lead;
    out.fov = lens(s.h[0] + (s.h[1] - s.h[0]) * ease, len(o));
    out.roll = -st.bank * 0.12; // the ship leans a little with the turn
  } else if (s.type === 'fixed') {
    const sc = flight.sample(s.tc, _sc);
    const hc = heading(flight, s.tc, 0.01, {});
    place(sc.p, hc, s.off, out.pos);
    if (s.absY !== undefined) out.pos[1] = s.absY;
    // the operator pans a beat behind the action and zooms to hold the dragon's size
    const lag = flight.sample(T - 0.06, _sa).p;
    for (let k = 0; k < 3; k++) out.look[k] = lag[k];
    const d0 = len(sub(flight.sample(T - 0.35, _sa).p, out.pos));
    out.fov = clamp(lens(s.h, d0), 8, 55);
  } else if (s.type === 'orbit') {
    const a = s.a0 + s.rate * wrap(T - s.t0, D);
    place(st.p, h, [Math.sin(a) * s.r, Math.cos(a) * s.r, s.up], out.pos);
    for (let k = 0; k < 3; k++) out.look[k] = st.p[k] + st.f[k] * 4;
    out.fov = lens(s.h, Math.hypot(s.r, s.up));
  } else {
    // mount: in the dragon's own frame with half its bank
    const lv = norm(sub([0, 1, 0], st.f.map((x) => x * st.f[1])));
    const u = norm([0, 1, 2].map((k) => st.u[k] + lv[k]));
    const r = cross(st.f, u);
    for (let k = 0; k < 3; k++) out.pos[k] = st.p[k] + r[k] * s.off[0] + st.f[k] * s.off[1] + u[k] * s.off[2];
    for (let k = 0; k < 3; k++) out.look[k] = st.p[k] + st.f[k] * s.ahead + u[k];
    out.fov = 52;
    out.roll = -st.bank * 0.5;
    out.focus = out.look;
  }
  return out;
}
/** clear(p, q) for pickHero: the camera at p is out of the rock and nothing solid hides the dragon at q. */
export function clearView(world, pad = 4) {
  return (p, q) => {
    if (world.solidAt(p, pad)) return false;
    const d = len(sub(q, p)), x = v3();
    for (let s = 3; s < d - 14; s += 4) {
      for (let k = 0; k < 3; k++) x[k] = p[k] + ((q[k] - p[k]) * s) / d;
      if (world.solidAt(x, 0)) return false;
    }
    return true;
  };
}

export const newCamera = () => ({ pos: v3(), look: v3(), fov: 40, roll: 0, focus: null, shot: '', heroSide: 1 });
