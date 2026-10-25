// Sound: recorded effects (CC0 / CC-BY, see README Credits) played through WebAudio, a synthesised wind bed,
// a streamed music bed and the original procedural voices kept as a fallback for samples that fail to load.
//
// One acoustic space for everything:
//   * every positional voice goes through the same distance model (CATS: reference distance, roll-off, audibility
//     floor), the same air absorption (a low-pass that closes with distance) and the same reverb send (wet/dry
//     grows with distance), so a far explosion, roar and fireball all sit in the same room;
//   * samples are loudness-normalised offline per category (tools/build_audio.py, tools/audio_spec.json), so the
//     numbers in CATS.trim and in the methods below are the whole mix; there are no per-sample surprises.
//
// Graph:
//   voices -> category bus (trim) -> sfx ------\
//   ui sounds ------------------------> ui ----+
//   wind, passes, sea -> ambience (pause gate) -> ambience duck --+--> mix -> glue compressor -> make-up
//   music tracks -> music (user volume) -> music duck ------------+        -> limiter -> soft clip -> master
//   distant voices -> reverb send -> convolver -> sfx                       -> hush (death) -> muffle (pause) -> out
//
// Settings (localStorage): master "da.vol", music "da.music", effects "da.sfx" (effects and interface sounds),
// ambience and wind "da.amb". All four sliders use a squared taper.
//
// Voice limiting: every sound type has a cap (VoiceLimiter). A new voice that would exceed it steals the quietest
// one of that type (quietness = loudness at the listener x how much of the sound is left), or is dropped if it is
// the quietest itself. A global cap does the same across types, weighting by priority.

const BASE = 'assets/audio/';

/** Samples by loudness category (tools/audio_spec.json holds the same names and the targets). */
export const CATALOG = {
  explosion: ['explode_1', 'explode_2', 'explode_3', 'explode_big'],
  voice: ['roar_1', 'roar_2', 'roar_3', 'roar_4', 'roar_5', 'roar_deep', 'hurt_1', 'hurt_2', 'hurt_3'],
  ability: ['nova_charge', 'nova_burst', 'chain_charge', 'chain_zap', 'chain_miss', 'acid_spit', 'acid_burst', 'inferno', 'chill'],
  weapon: ['fireball_1', 'fireball_2', 'fireball_3', 'seeker', 'breath_start', 'overheat'],
  impact: ['impact_1', 'impact_2', 'impact_3', 'impact_seeker', 'splash_1', 'splash_2', 'splash_3'],
  stinger: ['hit', 'kill', 'streak_1', 'streak_2', 'streak_3', 'heal'],
  alert: ['warn_seeker', 'warn_lock', 'heartbeat'],
  flap: ['flap_1', 'flap_2', 'flap_3', 'flap_4', 'dodge'],
  loop: ['breath_loop', 'sea_loop'],
  ui: ['ui_hover', 'ui_click', 'ui_confirm', 'ui_back', 'ui_open', 'ui_close', 'ui_error', 'ui_toggle', 'ui_pick', 'ui_tab'],
};
export const SAMPLES = Object.values(CATALOG).flat();
export const GROUPS = {
  roar: ['roar_1', 'roar_2', 'roar_3', 'roar_4', 'roar_5'],
  hurt: ['hurt_1', 'hurt_2', 'hurt_3'],
  flap: ['flap_1', 'flap_2', 'flap_3', 'flap_4'],
  fireball: ['fireball_1', 'fireball_2', 'fireball_3'],
  explode: ['explode_1', 'explode_2', 'explode_3'],
  impact: ['impact_1', 'impact_2', 'impact_3'],
  splash: ['splash_1', 'splash_2', 'splash_3'],
  streak: ['streak_1', 'streak_2', 'streak_3'],
};
export const TRACKS = {
  menu: { file: 'music_menu.mp3', loopStart: 0, gain: 1.0, loop: true },
  battle: { file: 'music_battle.mp3', loopStart: 24, gain: 0.7, loop: true },
  results: { file: 'music_results.mp3', loopStart: 0, gain: 1.0, loop: false },
};

/**
 * Space and mix per category. ref: distance (m) up to which a sound is at full level; roll: roll-off past it
 * (1 = inverse distance); max: beyond this it is not played at all; trim: mix level in dB on top of the offline
 * normalisation (see audio_spec.json). Categories without ref are not positional.
 */
export const CATS = {
  explosion: { ref: 160, roll: 0.9, max: 6000, trim: 6.5 },
  voice: { ref: 150, roll: 0.9, max: 5000, trim: 0.5 },
  ability: { ref: 110, roll: 1.0, max: 3500, trim: 1 },
  weapon: { ref: 60, roll: 1.0, max: 2200, trim: 1 },
  impact: { ref: 70, roll: 1.0, max: 2400, trim: 2 },
  flap: { ref: 45, roll: 1.1, max: 800, trim: -1.5 },
  loop: { trim: 5 },
  stinger: { trim: 1 },
  alert: { trim: 1 },
  ui: { trim: 5 },
};
/** Below this loudness at the listener (linear) a positional voice is not worth starting. */
export const AUDIBLE = 0.012;
export const MAX_VOICES = 40;
/** Effects and interface sounds sit this far below full scale at slider 1 (headroom for the music and the wind). */
const SFX_BASE = 0.75;

/** Distance attenuation shared by every positional sound (linear gain). */
export function attenuation(cat, d) {
  const c = CATS[cat];
  if (!c || !c.ref || d <= c.ref) return 1;
  return c.ref / (c.ref + c.roll * (d - c.ref));
}
/** Air absorption: low-pass cutoff (Hz) at a distance. */
export function airCutoff(d) {
  return Math.max(1100, Math.min(18000, 18000 / (1 + d / 250)));
}
/** Reverb send relative to the dry level: nothing up close, a wash far away. */
export function reverbSend(d) {
  return 0.55 * Math.pow(Math.max(0, Math.min(1, (d - 80) / 1400)), 0.8);
}
/** Slider position to gain. */
export const taper = (v) => v * v;
const db = (x) => Math.pow(10, x / 20);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Per sound type: cat = category, cap = most simultaneous voices, pri = priority (1 low .. 10 high), gap = least
 * seconds between two starts, pitch = random playback-rate spread (+-), vol = random level spread (+-dB),
 * life = the most seconds it plays (the rest fades out; for long tails that would pile up into a wash).
 */
export const TYPES = {
  fireball: { cat: 'weapon', cap: 6, pri: 3, gap: 0.04, pitch: 0.03, vol: 0.8, life: 0.9 },
  seeker: { cat: 'weapon', cap: 3, pri: 5, gap: 0.2, pitch: 0.02, vol: 0.6 },
  breath_start: { cat: 'weapon', cap: 2, pri: 4, gap: 0.25, pitch: 0.02, vol: 0.5 },
  overheat: { cat: 'weapon', cap: 1, pri: 6, gap: 0.5, pitch: 0.01, vol: 0 },
  explode: { cat: 'explosion', cap: 4, pri: 6, gap: 0.08, pitch: 0.04, vol: 0.7 },
  explode_big: { cat: 'explosion', cap: 2, pri: 8, gap: 0.2, pitch: 0.03, vol: 0.5 },
  impact: { cat: 'impact', cap: 6, pri: 3, gap: 0.03, pitch: 0.05, vol: 1.0 },
  impact_seeker: { cat: 'impact', cap: 2, pri: 5, gap: 0.1, pitch: 0.03, vol: 0.5 },
  splash: { cat: 'impact', cap: 3, pri: 3, gap: 0.08, pitch: 0.05, vol: 0.8 },
  roar: { cat: 'voice', cap: 3, pri: 6, gap: 0.3, pitch: 0.03, vol: 0.6 },
  roar_deep: { cat: 'voice', cap: 1, pri: 7, gap: 0.5, pitch: 0.02, vol: 0.4 },
  hurt: { cat: 'voice', cap: 2, pri: 8, gap: 0.25, pitch: 0.03, vol: 0.7 },
  flap: { cat: 'flap', cap: 5, pri: 1, gap: 0.04, pitch: 0.04, vol: 0.9 },
  dodge: { cat: 'flap', cap: 2, pri: 4, gap: 0.2, pitch: 0.03, vol: 0.5 },
  nova_charge: { cat: 'ability', cap: 2, pri: 6, gap: 0.2, pitch: 0.02, vol: 0.4 },
  nova_burst: { cat: 'ability', cap: 2, pri: 7, gap: 0.2, pitch: 0.02, vol: 0.4 },
  chain_charge: { cat: 'ability', cap: 2, pri: 6, gap: 0.2, pitch: 0.02, vol: 0.4 },
  chain_zap: { cat: 'ability', cap: 3, pri: 7, gap: 0.1, pitch: 0.03, vol: 0.5 },
  chain_miss: { cat: 'ability', cap: 2, pri: 5, gap: 0.1, pitch: 0.03, vol: 0.5 },
  acid_spit: { cat: 'ability', cap: 2, pri: 5, gap: 0.2, pitch: 0.03, vol: 0.5 },
  acid_burst: { cat: 'ability', cap: 2, pri: 6, gap: 0.2, pitch: 0.03, vol: 0.5 },
  inferno: { cat: 'ability', cap: 2, pri: 7, gap: 0.3, pitch: 0.02, vol: 0.4 },
  chill: { cat: 'ability', cap: 1, pri: 5, gap: 0.3, pitch: 0.01, vol: 0 },
  hit: { cat: 'stinger', cap: 3, pri: 7, gap: 0.05, pitch: 0.03, vol: 0.5 },
  kill: { cat: 'stinger', cap: 1, pri: 9, gap: 0.2, pitch: 0.01, vol: 0 },
  streak: { cat: 'stinger', cap: 1, pri: 10, gap: 0.5, pitch: 0, vol: 0 },
  heal: { cat: 'stinger', cap: 1, pri: 6, gap: 0.3, pitch: 0, vol: 0 },
  warn_seeker: { cat: 'alert', cap: 1, pri: 9, gap: 0.3, pitch: 0, vol: 0 },
  warn_lock: { cat: 'alert', cap: 1, pri: 8, gap: 0.3, pitch: 0, vol: 0 },
  heartbeat: { cat: 'alert', cap: 1, pri: 7, gap: 0.3, pitch: 0, vol: 0 },
};
for (const n of CATALOG.ui) TYPES[n] = { cat: 'ui', cap: 2, pri: 4, gap: 0.02, pitch: n === 'ui_hover' ? 0.05 : 0.015, vol: n === 'ui_hover' ? 1.0 : 0.3 };

/**
 * Decides which voices live. Pure bookkeeping (no WebAudio), so it can be tested on its own.
 *   admit(type, amp, now, dur) -> { ok, steal } : may a new voice of this type with loudness amp start? steal is
 *                                the voice that has to be stopped to make room (or null)
 *   add(voice) / remove(voice)  : the caller registers what it started
 * A voice is { type, amp, pri, t0, dur }.
 */
export class VoiceLimiter {
  constructor(types = TYPES, globalCap = MAX_VOICES) {
    this.types = types;
    this.globalCap = globalCap;
    this.voices = new Set();
    this.last = {};
  }

  /** Loudness left in a voice now: its level at the listener, fading with how much of the sound has played. */
  level(v, now) {
    const left = v.dur > 0 ? clamp(1 - (now - v.t0) / v.dur, 0, 1) : 1;
    return v.amp * (0.3 + 0.7 * left);
  }

  count(type) {
    let n = 0;
    for (const v of this.voices) if (v.type === type) n++;
    return n;
  }

  admit(type, amp, now) {
    const T = this.types[type];
    if (!T) return { ok: true, steal: null };
    const gap = this.last[type] === undefined ? Infinity : now - this.last[type];
    // a retrigger inside the gap is dropped unless it is clearly louder than everything of its type
    if (gap < T.gap) {
      let loudest = 0;
      for (const v of this.voices) if (v.type === type) loudest = Math.max(loudest, this.level(v, now));
      if (amp < loudest * 1.5) return { ok: false, steal: null };
    }
    let quiet = null, ql = Infinity, n = 0;
    for (const v of this.voices) {
      if (v.type !== type) continue;
      n++;
      const l = this.level(v, now);
      if (l < ql) { ql = l; quiet = v; }
    }
    if (n >= T.cap) {
      if (amp <= ql) return { ok: false, steal: null };
      return { ok: true, steal: quiet };
    }
    if (this.voices.size >= this.globalCap) {
      // across types: the voice with the least (loudness x priority) goes, if the newcomer outranks it
      let w = null, wl = Infinity;
      for (const v of this.voices) {
        const l = this.level(v, now) * (0.4 + 0.12 * v.pri);
        if (l < wl) { wl = l; w = v; }
      }
      if (amp * (0.4 + 0.12 * T.pri) <= wl) return { ok: false, steal: null };
      return { ok: true, steal: w };
    }
    return { ok: true, steal: null };
  }

  add(v) {
    this.voices.add(v);
    this.last[v.type] = v.t0;
  }

  remove(v) {
    this.voices.delete(v);
  }
}

const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

function setPos(node, x, y, z) {
  if (node.positionX) {
    node.positionX.value = x;
    node.positionY.value = y;
    node.positionZ.value = z;
  } else node.setPosition(x, y, z);
}

// small seeded generator so the noise beds are the same every run
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.volume = Number(store.get('da.vol', 0.85));
    this.musicVolume = Number(store.get('da.music', 0.8));
    this.sfxVolume = Number(store.get('da.sfx', 0.9));
    this.ambienceVolume = Number(store.get('da.amb', 0.8));
    this.listener = { x: 0, y: 0, z: 0 };
    this.right = { x: 1, y: 0, z: 0 };
    this.raw = new Map(); // name -> Promise<ArrayBuffer> (fetched before the context exists)
    this.buffers = new Map();
    this.limiter = new VoiceLimiter();
    this.last = {}; // last variant per group, to avoid immediate repeats
    this.musicState = null;
    this.tracks = {};
    this.muffled = false;
    this.paused = false;
    this.breathWas = false;
    this.fetched = false;
    this.ready = null;
    this.sv = {}; // smoothed wind drivers
    this.gust = { t0: -99, att: 1, dec: 2, amp: 0, next: 0 };
    this.passes = new Map();
    this.lastUpdate = null;
  }

  /** Starts downloading the sample files (call once the page is idle; decoding waits for start()). */
  preload() {
    if (this.fetched) return;
    this.fetched = true;
    for (const n of SAMPLES) {
      this.raw.set(n, fetch(`${BASE}${n}.mp3`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(n)))).catch(() => null));
    }
  }

  /** Must run from a user gesture the first time. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.buildGraph(ctx);
    this.preload();
    this.ready = this.decodeAll().then(() => this.startLoops());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    this.musicTimer = setInterval(() => this.musicTick(), 250);
    if (this.musicState) this.music(this.musicState, true);
  }

  buildGraph(ctx) {
    const node = (type) => Object.assign(ctx.createBiquadFilter(), { type });
    // ---- output: glue compressor, make-up, limiter, soft clip, then the master volume and the filters
    this.mix = ctx.createGain();
    const glue = (this.glue = ctx.createDynamicsCompressor());
    glue.threshold.value = -22;
    glue.knee.value = 18;
    glue.ratio.value = 2.2;
    glue.attack.value = 0.02;
    glue.release.value = 0.35;
    this.makeup = ctx.createGain();
    this.makeup.gain.value = 1.0;
    const lim = (this.peakLimiter = ctx.createDynamicsCompressor());
    lim.threshold.value = -4;
    lim.knee.value = 3;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.12;
    const clip = ctx.createWaveShaper(); // the last safety net: nothing leaves above -0.2 dBFS
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1, a = Math.abs(x);
      curve[i] = Math.sign(x) * (a < 0.85 ? a : 0.85 + 0.13 * Math.tanh((a - 0.85) / 0.13));
    }
    clip.curve = curve;
    clip.oversample = '2x';
    this.master = ctx.createGain();
    this.master.gain.value = taper(this.volume);
    this.hush = node('lowpass');
    this.hush.frequency.value = 22000;
    this.muffle = node('lowpass');
    this.muffle.frequency.value = 22000;
    this.mix.connect(glue).connect(this.makeup).connect(lim).connect(clip).connect(this.master).connect(this.hush).connect(this.muffle).connect(ctx.destination);

    // ---- the four buses
    this.sfx = ctx.createGain(); // effects (weapons, impacts, explosions, voices, wings, abilities, stingers, alerts)
    this.sfx.gain.value = taper(this.sfxVolume) * SFX_BASE;
    this.sfx.connect(this.mix);
    this.uiBus = ctx.createGain(); // interface sounds follow the effects slider
    this.uiBus.gain.value = taper(this.sfxVolume) * SFX_BASE;
    this.uiBus.connect(this.mix);
    this.ambBus = ctx.createGain(); // wind, air passes, sea
    this.ambBus.gain.value = taper(this.ambienceVolume);
    this.ambDuck = ctx.createGain();
    this.ambGate = ctx.createGain(); // closed while paused
    this.ambBus.connect(this.ambGate).connect(this.ambDuck).connect(this.mix);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = taper(this.musicVolume);
    this.musicDuck = ctx.createGain();
    this.musicBus.connect(this.musicDuck).connect(this.mix);
    this.duckState = { music: { until: 0, level: 1 }, amb: { until: 0, level: 1 } };

    // ---- category buses: the trim of each category in one place
    this.cats = {};
    for (const [c, def] of Object.entries(CATS)) {
      const g = ctx.createGain();
      g.gain.value = db(def.trim);
      g.connect(c === 'ui' ? this.uiBus : this.sfx);
      this.cats[c] = g;
    }

    // ---- one room for all distant sounds: a short, dark open-air reverb
    this.reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = this.makeImpulse(ctx, 2.0);
    const dark = node('lowpass');
    dark.frequency.value = 3800;
    const ret = ctx.createGain();
    ret.gain.value = 0.9;
    this.reverbIn.connect(conv).connect(dark).connect(ret).connect(this.sfx);

    // ---- noise (wind and the procedural fallbacks)
    this.noise = this.makeNoise(ctx, 2, 'white');
    this.buildWind(ctx);
    this.loops = {};
  }

  /** Decaying stereo noise with the highs dying faster than the lows: air, not a hall. */
  makeImpulse(ctx, secs) {
    const n = Math.floor(ctx.sampleRate * secs);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    const r = rng(7);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = 0.15 + 0.8 * Math.pow(1 - t, 1.5); // one-pole low-pass opens as the tail rings down
        lp += (r() * 2 - 1 - lp) * (1 - Math.exp(-0.9 * k));
        d[i] = lp * Math.exp(-6.9 * (i / ctx.sampleRate) / (secs * 0.75)) * (i < 480 ? i / 480 : 1);
      }
    }
    return buf;
  }

  /** Looping stereo noise ('white' | 'pink' | 'brown'), normalised, with a cross-faded seam. */
  makeNoise(ctx, secs, kind, seed = 1) {
    const sr = ctx.sampleRate, n = Math.floor(sr * secs), xf = Math.min(Math.floor(sr * 0.5), n >> 2);
    const buf = ctx.createBuffer(2, n, sr);
    const r = rng(seed * 7919);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const total = n + xf;
      const tmp = new Float32Array(total);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
      for (let i = 0; i < total; i++) {
        const w = r() * 2 - 1;
        if (kind === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          tmp[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.2; b6 = w * 0.115926;
        } else if (kind === 'brown') {
          br = (br + 0.02 * w) / 1.02;
          tmp[i] = br * 3.5;
        } else tmp[i] = w * 0.6;
      }
      for (let i = 0; i < n; i++) d[i] = tmp[i];
      // equal-power cross-fade of the extra tail into the head: the loop point is seamless
      for (let i = 0; i < xf; i++) {
        const a = i / xf;
        d[i] = tmp[i] * Math.sin(a * Math.PI / 2) + tmp[n + i] * Math.cos(a * Math.PI / 2);
      }
      let e = 0;
      for (let i = 0; i < n; i++) e += d[i] * d[i];
      const k = 0.25 / Math.sqrt(e / n);
      for (let i = 0; i < n; i++) d[i] *= k;
    }
    return buf;
  }

  async decodeAll() {
    const ctx = this.ctx;
    const decode = (ab) => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
    await Promise.all(SAMPLES.map(async (n) => {
      try {
        const ab = await this.raw.get(n);
        if (ab) this.buffers.set(n, await decode(ab.slice(0)));
      } catch (e) {
        console.warn('audio: could not decode', n);
      }
    }));
  }

  // ------------------------------------------------------------ continuous layers
  /** Wind: filtered noise layers (rumble, body, whoosh, gusts, cloud hush). Nothing in it loops audibly or hisses. */
  buildWind(ctx) {
    const pink = this.makeNoise(ctx, 9, 'pink', 3), brown = this.makeNoise(ctx, 9, 'brown', 5), pink2 = this.makeNoise(ctx, 11, 'pink', 8);
    this.windCut = ctx.createGain(); // clouds and pauses close this one
    this.windCut.connect(this.ambBus);
    const layer = (buf, filters, offset) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      let n = src;
      const fs = filters.map(([type, f, q]) => {
        const b = ctx.createBiquadFilter();
        b.type = type;
        b.frequency.value = f;
        b.Q.value = q;
        n = n.connect(b);
        return b;
      });
      n.connect(g).connect(this.windCut);
      src.start(0, offset);
      return { src, f: fs, g };
    };
    this.w = {
      rumble: layer(brown, [['highpass', 55, 0.7], ['lowpass', 150, 0.7]], 0.3),
      body: layer(pink, [['bandpass', 380, 0.55], ['lowpass', 1400, 0.5]], 2.1),
      whoosh: layer(pink2, [['bandpass', 700, 0.7], ['lowpass', 1400, 0.55], ['lowpass', 1700, 0.5]], 4.7),
      gust: layer(pink, [['bandpass', 480, 0.45], ['lowpass', 1500, 0.5]], 6.2),
      hush: layer(brown, [['lowpass', 260, 0.7]], 1.4),
    };
    this.cloudNow = 0;
  }

  startLoops() {
    const ctx = this.ctx;
    const loop = (name, rate = 1, filterType = 'lowpass', freq = 20000, dest = this.cats.loop) => {
      const buf = this.buffers.get(name);
      if (!buf) return null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = rate;
      const f = ctx.createBiquadFilter();
      f.type = filterType;
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(dest);
      src.start(0, Math.random() * buf.duration);
      return { src, f, g };
    };
    this.breathSample = loop('breath_loop', 1, 'lowpass', 7000);
    if (this.breathSample) {
      const rb = loop('breath_loop', 0.84, 'lowpass', 1800);
      if (rb) {
        // the other dragons' breath comes from somewhere: pan it
        rb.g.disconnect();
        if (ctx.createStereoPanner) {
          rb.pan = ctx.createStereoPanner();
          rb.g.connect(rb.pan).connect(this.cats.loop);
        } else rb.g.connect(this.cats.loop);
      }
      this.remoteBreathSample = rb;
    }
    this.seaLoop = loop('sea_loop', 1, 'lowpass', 4200, this.ambBus);
    this.loopsReady = true;
    this.applyAmbience();
  }

  // ------------------------------------------------------------ settings
  setVolume(v) {
    this.volume = v;
    store.set('da.vol', String(v));
    if (this.master) this.master.gain.setTargetAtTime(taper(v), this.ctx.currentTime, 0.02);
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    store.set('da.music', String(v));
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(taper(v), this.ctx.currentTime, 0.05);
  }

  /** Effects: weapons, impacts, explosions, voices, wings, abilities, alerts and the interface sounds. */
  setSfxVolume(v) {
    this.sfxVolume = v;
    store.set('da.sfx', String(v));
    if (this.sfx) {
      this.sfx.gain.setTargetAtTime(taper(v) * SFX_BASE, this.ctx.currentTime, 0.02);
      this.uiBus.gain.setTargetAtTime(taper(v) * SFX_BASE, this.ctx.currentTime, 0.02);
    }
  }

  /** Ambience and wind: the wind bed, air passes and the sea under the menu. */
  setAmbienceVolume(v) {
    this.ambienceVolume = v;
    store.set('da.amb', String(v));
    if (this.ambBus) this.ambBus.gain.setTargetAtTime(taper(v), this.ctx.currentTime, 0.05);
  }

  /** Waves and a little wind under the menu music. */
  applyAmbience() {
    if (this.seaLoop) this.seaLoop.g.gain.setTargetAtTime(this.musicState === 'menu' ? 1 : 0, this.ctx.currentTime, 0.8);
  }

  /**
   * Dips the music and the ambience for a moment (big explosions, your own death, stingers). Amounts are the
   * levels to dip to (1 = no dip). Attack and release are smooth ramps; overlapping ducks only ever go deeper.
   */
  duck({ music = 1, amb = 1, attack = 0.05, hold = 0.5, release = 1.0 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const one = (key, node, amt) => {
      if (amt >= 1) return;
      const st = this.duckState[key];
      const level = t < st.until ? Math.min(st.level, amt) : amt;
      const g = node.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.setTargetAtTime(level, t, attack / 3);
      g.setTargetAtTime(1, t + attack + hold, release / 3);
      st.level = level;
      st.until = t + attack + hold + release * 0.6;
    };
    one('music', this.musicDuck, music);
    one('amb', this.ambDuck, amb);
  }

  /** Pause menu: everything goes dull and quiet and the air stops. */
  setMuffled(on) {
    this.muffled = on;
    this.paused = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.muffle.frequency.setTargetAtTime(on ? 650 : 22000, t, 0.08);
    this.ambGate.gain.cancelScheduledValues(t);
    this.ambGate.gain.setValueAtTime(this.ambGate.gain.value, t);
    this.ambGate.gain.setTargetAtTime(on ? 0 : 1, t, on ? 0.025 : 0.3);
  }

  onVisibility() {
    if (!this.ctx) return;
    if (document.hidden) {
      for (const k in this.tracks) this.tracks[k].el.pause();
      this.ctx.suspend();
    } else {
      this.ctx.resume();
      const t = this.tracks[this.musicState];
      if (t && t.playing) t.el.play().catch(() => {});
    }
  }

  // ------------------------------------------------------------ music
  /** state: 'menu' | 'battle' | 'results' | null. Crossfades from whatever plays now. */
  music(state, force = false) {
    if (state === this.musicState && !force) return;
    this.musicState = state;
    if (!this.ctx) return; // start() replays the wanted state
    this.applyAmbience();
    for (const k in this.tracks) if (k !== state) this.fadeTrack(this.tracks[k], 0, 1.6, true);
    if (!state) return;
    const def = TRACKS[state];
    let t = this.tracks[state];
    if (!t) {
      const el = new window.Audio(BASE + def.file);
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      const g = this.ctx.createGain();
      g.gain.value = 0;
      try {
        this.ctx.createMediaElementSource(el).connect(g).connect(this.musicBus);
      } catch {
        g.disconnect();
        el.volume = def.gain * 0.5;
      }
      t = this.tracks[state] = { el, g, def, playing: false, level: 0, restarting: false };
    }
    if (!t.playing || t.el.ended) {
      t.el.currentTime = 0;
      t.el.play().catch(() => {});
    }
    t.playing = true;
    t.restarting = false;
    this.fadeTrack(t, def.gain, state === 'results' ? 0.4 : 2.5);
  }

  fadeTrack(t, level, secs, stopAfter = false) {
    t.level = level;
    const now = this.ctx.currentTime;
    t.g.gain.cancelScheduledValues(now);
    t.g.gain.setValueAtTime(t.g.gain.value, now);
    t.g.gain.linearRampToValueAtTime(level, now + secs);
    if (stopAfter && t.playing) {
      t.playing = false;
      clearTimeout(t.stopTimer);
      t.stopTimer = setTimeout(() => {
        if (!t.playing) t.el.pause();
      }, secs * 1000 + 100);
    }
  }

  musicTick() {
    const t = this.tracks[this.musicState];
    if (!t || !t.playing || document.hidden) return;
    const el = t.el;
    if (!t.def.loop || !isFinite(el.duration)) return;
    const left = el.duration - el.currentTime;
    if (left < 3 && !t.restarting) {
      // the end of the track fades away, then the loop begins again from its loop point
      t.restarting = true;
      this.fadeTrack(t, 0, Math.max(0.5, left - 0.2));
      setTimeout(() => {
        if (this.musicState && this.tracks[this.musicState] === t && t.playing) {
          el.currentTime = t.def.loopStart;
          el.play().catch(() => {});
          this.fadeTrack(t, t.def.gain, 2.5);
        }
        t.restarting = false;
      }, Math.max(300, (left - 0.1) * 1000));
    }
  }

  // ------------------------------------------------------------ listener and space
  /** Called every frame with the camera. */
  setListener(p, q) {
    this.listener.x = p.x;
    this.listener.y = p.y;
    this.listener.z = p.z;
    if (q) {
      const { x, y, z, w } = q;
      this.right.x = 1 - 2 * (y * y + z * z);
      this.right.y = 2 * (x * y + w * z);
      this.right.z = 2 * (x * z - w * y);
    }
    if (!this.ctx) return;
    const L = this.ctx.listener;
    setPos(L, p.x, p.y, p.z);
    if (q && L.forwardX) {
      // forward = -Z and up = +Y rotated by the camera quaternion
      const { x, y, z, w } = q;
      const fx = -2 * (x * z + w * y), fy = -2 * (y * z - w * x), fz = -(1 - 2 * (x * x + y * y));
      const ux = 2 * (x * y - w * z), uy = 1 - 2 * (x * x + z * z), uz = 2 * (y * z + w * x);
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    }
  }

  distTo(p) {
    return Math.hypot(p.x - this.listener.x, p.y - this.listener.y, p.z - this.listener.z);
  }

  distGain(p, ref = 60) {
    if (!p) return 1;
    return ref / (ref + this.distTo(p));
  }

  // ------------------------------------------------------------ one-shot voices
  pick(group) {
    const list = GROUPS[group];
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === this.last[group]) i = (i + 1) % list.length;
    this.last[group] = i;
    return list[i];
  }

  /**
   * Plays a decoded sample once. Returns false only if it isn't available (so the caller can synthesise it);
   * a voice that is culled, too quiet or limited still counts as handled.
   * type: a TYPES key (also the sample name, or a GROUPS name for a random variant)
   * at: world position (spatialised through the shared space model) or null for your own dragon / the interface
   * gain: linear level relative to the category; rate: playback rate; delay: seconds
   */
  play(type, { at = null, gain = 1, rate = 1, delay = 0, sample = null } = {}) {
    if (!this.ctx) return false;
    const T = TYPES[type];
    const name = sample || (GROUPS[type] ? this.pick(type) : type);
    const buf = this.buffers.get(name);
    if (!buf || !T) return false;
    const ctx = this.ctx;
    const cat = CATS[T.cat];
    const now = ctx.currentTime;
    let dist = 0, amp = gain * db(cat.trim);
    if (at && cat.ref) {
      dist = this.distTo(at);
      if (dist > cat.max) return true;
      amp *= attenuation(T.cat, dist);
      if (amp < AUDIBLE) return true;
    }
    // small, even variation on repeats: pitch within a few percent, level within a dB
    const r = rate * (1 + (Math.random() * 2 - 1) * T.pitch);
    const lv = db((Math.random() * 2 - 1) * T.vol);
    const dur = Math.min(buf.duration / r, T.life || 99);
    const lamp = amp * lv * (at ? 1 : 1.6); // your own dragon's sounds outrank everything of their kind out there
    const verdict = this.limiter.admit(type, lamp, now);
    if (!verdict.ok) return true;
    if (verdict.steal) this.stealVoice(verdict.steal, now);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = r;
    const g = ctx.createGain();
    g.gain.value = gain * lv * (at && cat.ref ? attenuation(T.cat, dist) : 1);
    src.connect(g);
    let tail = g;
    const nodes = [g];
    if (at && cat.ref) {
      // air absorption, then direction (the panner does direction only: distance is modelled above)
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = airCutoff(dist);
      f.Q.value = 0.5;
      tail.connect(f);
      tail = f;
      nodes.push(f);
      const send = reverbSend(dist);
      if (send > 0.01) {
        const s = ctx.createGain();
        s.gain.value = send;
        f.connect(s).connect(this.reverbIn);
        nodes.push(s);
      }
      const p = ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'linear';
      p.rolloffFactor = 0;
      setPos(p, at.x, at.y, at.z);
      tail.connect(p);
      tail = p;
      nodes.push(p);
    }
    tail.connect(this.cats[T.cat]);
    const v = { type, amp: lamp, pri: T.pri, t0: now + delay, dur, src, g, nodes };
    this.limiter.add(v);
    src.onended = () => {
      this.limiter.remove(v);
      src.disconnect();
      for (const n of nodes) n.disconnect();
    };
    src.start(now + delay);
    if (T.life && buf.duration / r > T.life) {
      // a sound with a long tail is cut short with a fade, so a stream of them stays articulate
      const t1 = now + delay + T.life;
      g.gain.setValueAtTime(g.gain.value, t1 - 0.3);
      g.gain.linearRampToValueAtTime(0, t1);
      src.stop(t1 + 0.02);
    }
    return true;
  }

  stealVoice(v, now) {
    // a quick fade, not a cut: no click
    this.limiter.remove(v);
    try {
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setValueAtTime(v.g.gain.value, now);
      v.g.gain.linearRampToValueAtTime(0, now + 0.03);
      v.src.stop(now + 0.05);
    } catch {}
  }

  // ------------------------------------------------------------ per-frame continuous sounds
  /**
   * Called every frame. speed (m/s), boost, breath (own flame), inCloud (0..1 density at the camera),
   * remoteBreath (loudness 0..1 of the nearest other dragon's flame) and remoteBreathAt (its position),
   * turn (rad/s the flight direction swings), climb (vertical speed / speed, negative in a dive),
   * ground (height above the terrain in m, or -1).
   */
  update({ speed = 0, boost = false, breath = false, inCloud = 0, remoteBreath = 0, remoteBreathAt = null, turn = 0, climb = 0, ground = -1 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dt = this.lastUpdate === null ? 0.033 : clamp(t - this.lastUpdate, 0.001, 0.25);
    this.lastUpdate = t;
    this.updateWind(t, dt, { speed, boost, inCloud, turn, climb, ground });
    if (breath && !this.breathWas) this.play('breath_start', { gain: 1 });
    this.breathWas = breath;
    if (this.breathSample) {
      this.breathSample.g.gain.setTargetAtTime(breath ? 1 : 0, t, breath ? 0.05 : 0.2);
      const rb = this.remoteBreathSample;
      rb.g.gain.setTargetAtTime(Math.min(0.8, remoteBreath * 1.2), t, 0.15);
      rb.f.frequency.setTargetAtTime(900 + 1700 * clamp(remoteBreath, 0, 1), t, 0.2);
      if (rb.pan && remoteBreathAt && remoteBreath > 0.02) {
        const dx = remoteBreathAt.x - this.listener.x, dy = remoteBreathAt.y - this.listener.y, dz = remoteBreathAt.z - this.listener.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        rb.pan.pan.setTargetAtTime(clamp((dx * this.right.x + dy * this.right.y + dz * this.right.z) / d, -1, 1) * 0.9, t, 0.15);
      }
    } else if (this.loopsReady) {
      // procedural flame if the recording is missing
      this.fallbackBreath = this.fallbackBreath || this.loopNoise(900, 0.0, 'bandpass', 0.7);
      this.fallbackBreath.g.gain.setTargetAtTime(breath ? 0.3 : 0, t, breath ? 0.05 : 0.15);
    }
  }

  /** First-order smoothing of a driver; returns the smoothed value. */
  sm(key, target, tau, dt) {
    const v = this.sv[key] === undefined ? target : this.sv[key];
    return (this.sv[key] = v + (target - v) * (1 - Math.exp(-dt / tau)));
  }

  gustLevel(t, s) {
    const G = this.gust;
    if (t >= G.next) {
      // a new gust: slow rise, slower fall, every few seconds, never the same twice
      G.t0 = t;
      G.att = 0.8 + Math.random() * 1.2;
      G.dec = 1.5 + Math.random() * 2.5;
      G.amp = 0.3 + Math.random() * 0.7;
      G.next = t + 2.5 + Math.random() * 5.5;
    }
    const x = t - G.t0;
    const e = x < G.att ? Math.pow(Math.sin((x / G.att) * Math.PI / 2), 2) : Math.exp(-(x - G.att) / G.dec * 1.6);
    return G.amp * e * (0.3 + 0.7 * s);
  }

  updateWind(t, dt, { speed, boost, inCloud, turn, climb, ground }) {
    const W = this.w;
    const s = this.sm('s', clamp((speed - 20) / 165, 0, 1), 0.5, dt);
    const bst = this.sm('boost', boost ? 1 : 0, 0.4, dt);
    const dive = this.sm('dive', clamp(-climb * 1.6, 0, 1), 0.6, dt);
    const tn = this.sm('turn', clamp(turn / 1.8, 0, 1), 0.3, dt);
    const grd = this.sm('ground', ground >= 0 ? Math.pow(clamp(1 - ground / 90, 0, 1), 1.6) : 0, 0.5, dt);
    const man = clamp(Math.max(bst * 0.9, dive, tn * 0.9), 0, 1); // how hard the air is being worked
    const gust = this.sm('gust', this.gustLevel(t, s), 0.35, dt);
    // slow, uneven breathing of the whole bed: two incommensurate sines, a few percent
    const wob = 1 + 0.07 * Math.sin(t * 0.69) + 0.05 * Math.sin(t * 1.13 + 1.7);

    const set = (L, v, tau = 0.12) => L.g.gain.setTargetAtTime(Math.max(0, v), t, tau);
    set(W.rumble, 0.12 * (0.4 + 0.6 * s) * (1 + 0.25 * bst) * wob);
    W.rumble.f[1].frequency.setTargetAtTime(110 + 170 * s, t, 0.2);
    set(W.body, 0.09 * Math.pow(s, 1.3) * (1 + 0.6 * man) * wob);
    W.body.f[0].frequency.setTargetAtTime(280 + 420 * s + 140 * gust, t, 0.2);
    set(W.whoosh, 0.2 * Math.pow(s, 2) * (0.25 + 0.75 * man) + 0.12 * s * grd);
    W.whoosh.f[0].frequency.setTargetAtTime(430 + 650 * Math.pow(s, 1.2) * (0.75 + 0.45 * man), t, 0.2);
    W.whoosh.f[1].frequency.setTargetAtTime(800 + 600 * s, t, 0.2);
    set(W.gust, 0.12 * gust);
    W.gust.f[0].frequency.setTargetAtTime(360 + 380 * gust, t, 0.25);

    // clouds: the air is cut sharply (it muffles to a soft hush), and returns slowly when you leave
    const c = clamp(inCloud * 3.5, 0, 1);
    const target = 1 - 0.94 * c;
    const closing = target < this.cloudNow;
    this.cloudNow = target;
    this.windCut.gain.setTargetAtTime(target, t, closing ? 0.05 : 0.5);
    set(W.hush, 0.1 * c * (0.4 + 0.6 * s), 0.2);
  }

  /**
   * A body of air rushing past: a dragon (or rock) crossing close by at relSpeed m/s. rel = where it passes,
   * relative to you. A band of noise falls in pitch (the Doppler drop) and swells and fades, panned across.
   */
  passBy(rel, relSpeed = 100) {
    if (!this.ctx || this.paused) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (t - (this.lastPass || -9) < 0.25) return;
    this.lastPass = t;
    const d = Math.hypot(rel.x, rel.y, rel.z);
    const k = clamp(relSpeed / 150, 0.2, 1.3) * clamp(70 / (70 + d), 0.15, 1);
    if (k < 0.08) return;
    const dur = clamp(0.55 + 70 / Math.max(relSpeed, 40), 0.7, 1.5);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    const f0 = 640 * (0.8 + 0.4 * Math.random());
    bp.frequency.setValueAtTime(f0 * 1.45, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.1 * k, t + dur * 0.32);
    g.gain.setTargetAtTime(0, t + dur * 0.32, dur * 0.2);
    let out = g;
    src.connect(bp).connect(lp).connect(g);
    if (ctx.createStereoPanner) {
      const side = (rel.x * this.right.x + rel.y * this.right.y + rel.z * this.right.z) >= 0 ? 1 : -1;
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(0.7 * side, t);
      p.pan.linearRampToValueAtTime(-0.7 * side, t + dur * 0.8);
      g.connect(p);
      out = p;
    }
    out.connect(this.ambBus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur * 1.6);
    src.onended = () => { src.disconnect(); out.disconnect(); g.disconnect(); };
  }

  /**
   * Feed it the position of each other dragon every frame; when one flies past close and fast it triggers a
   * pass-by whoosh at the moment of closest approach.
   */
  trackPassBy(id, pos, dt) {
    if (!this.ctx || dt <= 0) return;
    const rx = pos.x - this.listener.x, ry = pos.y - this.listener.y, rz = pos.z - this.listener.z;
    const d = Math.hypot(rx, ry, rz);
    let s = this.passes.get(id);
    if (!s) this.passes.set(id, (s = { d, rx, ry, rz, approach: false, cool: 0 }));
    const closing = (s.d - d) / dt; // m/s along the line between us
    const speed = Math.hypot(rx - s.rx, ry - s.ry, rz - s.rz) / dt; // m/s across the sky, relative to you
    s.cool -= dt;
    if (speed > 450) s.approach = false; // it was moved (a respawn), not flown
    else if (closing > 8) s.approach = true;
    else if (s.approach && closing <= 0) {
      // it was closing and has stopped closing: that was the closest approach
      if (d < 120 && speed > 45 && s.cool <= 0) {
        this.passBy({ x: rx, y: ry, z: rz }, speed);
        s.cool = 1.5;
      }
      s.approach = false;
    }
    s.d = d; s.rx = rx; s.ry = ry; s.rz = rz;
  }

  // ------------------------------------------------------------ procedural voices (fallbacks)
  loopNoise(freq, gain, type = 'lowpass', q = 0.8) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.cats.weapon);
    src.start();
    return { src, f, g };
  }

  burst({ freq = 800, type = 'lowpass', q = 1, dur = 0.3, gain = 0.5, attack = 0.005, sweep = null, at = null, cat = 'weapon' }) {
    if (!this.ctx) return;
    const g0 = gain * (at ? attenuation(cat, this.distTo(at)) : 1);
    if (g0 < 0.004) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(g0, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(this.cats[cat]);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  tone({ freq = 440, type = 'sine', dur = 0.15, gain = 0.2, slide = null, at = null, delay = 0, cat = 'alert' }) {
    if (!this.ctx) return;
    const g0 = gain * (at ? attenuation(cat, this.distTo(at)) : 1);
    if (g0 < 0.004) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(g0, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.cats[cat]);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------ game sounds
  flap(strength, at = null) {
    if (this.play('flap', { at, gain: 0.55 + 0.45 * clamp(strength, 0, 1), rate: 0.94 + strength * 0.1 })) return;
    this.burst({ freq: 140 + strength * 60, dur: 0.32, gain: 0.22 * strength, attack: 0.05, sweep: 70, at, cat: 'flap' });
  }

  fireball(at = null) {
    if (this.play('fireball', { at, gain: at ? 1 : 0.8 })) return;
    this.burst({ freq: 2200, type: 'bandpass', q: 0.6, dur: 0.35, gain: 0.25, sweep: 400, at });
    this.burst({ freq: 300, dur: 0.25, gain: 0.3, at });
  }

  seeker(at = null) {
    if (this.play('seeker', { at, gain: at ? 1 : 0.9 })) return;
    this.burst({ freq: 1200, type: 'bandpass', q: 1.2, dur: 0.9, gain: 0.3, sweep: 300, at });
    this.tone({ freq: 220, type: 'sawtooth', dur: 0.6, gain: 0.06, slide: 110, at, cat: 'weapon' });
  }

  explosion(at = null, big = 1) {
    const near = at ? this.distTo(at) : 0;
    const type = big >= 1.25 ? 'explode_big' : 'explode';
    const gain = big >= 1.25 ? 1.3 : clamp(0.8 + 0.25 * big, 0.8, 1.1); // a crash or a big blast is clearly the biggest thing in the sky
    if (this.play(type, { at, gain })) {
      // the closer and bigger it is, the more the music and the air step back for a moment
      if (near < 450) {
        const k = clamp(1 - near / 450, 0, 1) * clamp(big / 1.3, 0.6, 1.2);
        this.duck({ music: 1 - 0.5 * k, amb: 1 - 0.65 * k, attack: 0.04, hold: 0.35 + 0.5 * k, release: 1.1 });
      }
      return;
    }
    this.burst({ freq: 900 * big, dur: 1.4 * big, gain: 0.7, attack: 0.004, sweep: 60, at, cat: 'explosion' });
    this.tone({ freq: 70, type: 'sine', dur: 0.9, gain: 0.4, slide: 30, at, cat: 'explosion' });
  }

  impact(at = null, seeker = false) {
    if (this.play(seeker ? 'impact_seeker' : 'impact', { at })) return;
    this.burst({ freq: 1500, dur: 0.25, gain: 0.4, sweep: 200, at, cat: 'impact' });
  }

  hitMarker(kill = false) {
    if (this.play('hit', { gain: kill ? 1.1 : 0.8, rate: kill ? 0.85 : 1 })) return;
    this.tone({ freq: 900, type: 'sine', dur: 0.06, gain: 0.1 });
  }

  /** A confirmed kill: a heavy tick with a low thump. */
  kill() {
    if (this.play('kill')) return;
    this.tone({ freq: 660, type: 'triangle', dur: 0.3, gain: 0.1, slide: 990 });
  }

  /** Kill streak sting: level 1 (double) .. 3 (rampage and beyond). */
  streak(level = 1) {
    const n = `streak_${clamp(Math.round(level), 1, 3)}`;
    if (this.play('streak', { sample: n })) {
      this.duck({ music: 0.5, amb: 0.8, attack: 0.05, hold: 0.8, release: 1.2 });
      return;
    }
    [392, 523, 659, 784].forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.1, delay: i * 0.09, cat: 'stinger' }));
  }

  /** soft: damage over time (burning, poison): a grunt now and then, not one per tick. */
  hurt(soft = false) {
    const t = this.ctx ? this.ctx.currentTime : 0;
    if (soft && t - (this.lastHurt ?? -9) < 1.6) return;
    this.lastHurt = t;
    if (this.play('hurt', { rate: 0.97 })) {
      this.duck({ amb: 0.7, attack: 0.03, hold: 0.15, release: 0.6 });
      return;
    }
    this.burst({ freq: 500, dur: 0.3, gain: 0.4, sweep: 120, cat: 'voice' });
    this.tone({ freq: 110, type: 'triangle', dur: 0.25, gain: 0.2, slide: 60, cat: 'voice' });
  }

  /** Your dragon dies: the world drops away for a moment, the music and the air duck, the highs close. */
  death() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.duck({ music: 0.3, amb: 0.12, attack: 0.06, hold: 1.6, release: 2.2 });
    const f = this.hush.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(f.value, t);
    f.setTargetAtTime(1400, t, 0.12);
    f.setTargetAtTime(22000, t + 1.4, 0.5);
  }

  dodge(at = null) {
    if (this.play('dodge', { at })) return;
    this.burst({ freq: 1800, type: 'bandpass', q: 0.8, dur: 0.3, gain: 0.25, sweep: 500, at, cat: 'flap' });
  }

  /** One lub-dub of the low-health heartbeat. strength 0..1 */
  heartbeat(strength = 1) {
    if (!this.ctx) return;
    if (this.play('heartbeat', { gain: 0.45 + 0.35 * clamp(strength, 0, 1) })) return;
    const g = 0.2 + strength * 0.3;
    this.tone({ freq: 62, type: 'sine', dur: 0.2, gain: g, slide: 38 });
    this.tone({ freq: 55, type: 'sine', dur: 0.2, gain: g * 0.75, slide: 34, delay: 0.17 });
  }

  /** kind: 'seeker' (a missile is coming), 'lock' (someone locked on to you), 'bolt' (lightning charging at you). */
  warning(kind = 'seeker') {
    if (this.play(kind === 'lock' ? 'warn_lock' : 'warn_seeker')) return;
    this.tone({ freq: 760, type: 'triangle', dur: 0.1, gain: 0.08 });
    this.tone({ freq: 570, type: 'triangle', dur: 0.1, gain: 0.08, delay: 0.12 });
  }

  /** Breath ran out: pressure released. */
  overheat() {
    if (this.play('overheat', { gain: 0.85 })) return;
    this.tone({ freq: 160, type: 'triangle', dur: 0.3, gain: 0.1, slide: 70, cat: 'weapon' });
  }

  /** Frost status landed on you. */
  chill() {
    if (this.play('chill')) return;
    this.tone({ freq: 1568, type: 'sine', dur: 0.35, gain: 0.08, slide: 700, cat: 'ability' });
  }

  /**
   * Breed abilities. kind: inferno | nova | chain | acid. phase: charge | fire | miss. at: where it happens
   * (null for your own).
   */
  ability(kind, phase = 'fire', at = null) {
    const key = { inferno: { fire: 'inferno', charge: 'inferno' }, nova: { charge: 'nova_charge', fire: 'nova_burst' }, chain: { charge: 'chain_charge', fire: 'chain_zap', miss: 'chain_miss' }, acid: { charge: 'acid_spit', fire: 'acid_burst' } }[kind];
    const type = key && key[phase];
    if (!type) return;
    if (this.play(type, { at })) {
      if (phase !== 'charge' && (!at || this.distTo(at) < 400)) this.duck({ music: 0.7, amb: 0.8, attack: 0.04, hold: 0.3, release: 0.9 });
      return;
    }
    if (phase === 'charge') this.burst({ freq: 600, type: 'bandpass', q: 0.8, dur: 0.4, gain: 0.2, sweep: 2500, at, cat: 'ability' });
    else this.burst({ freq: 900, dur: 0.6, gain: 0.4, sweep: 120, at, cat: 'ability' });
  }

  /** A dragon roar. pitch < 0.9 gives the deep end-of-battle bellow. */
  roar(at = null, pitch = 1, gain = 1) {
    if (!this.ctx) return;
    const deep = pitch < 0.9;
    const ok = deep ? this.play('roar_deep', { at, gain }) : this.play('roar', { at, gain, rate: clamp(pitch, 0.9, 1.15) });
    if (ok) {
      if (!at || this.distTo(at) < 300) this.duck({ music: 0.65, amb: 0.8, attack: 0.08, hold: 0.9, release: 1.3 });
      return;
    }
    this.roarProc(at, pitch);
  }

  // a buzzy saw through vocal formants with a pitch fall
  roarProc(at, pitch) {
    const g0 = 0.4 * (at ? attenuation('voice', this.distTo(at)) : 1);
    if (g0 < 0.01) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 1.3;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(130 * pitch, t);
    o.frequency.linearRampToValueAtTime(175 * pitch, t + 0.25);
    o.frequency.exponentialRampToValueAtTime(65 * pitch, t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 28;
    const lg = ctx.createGain();
    lg.gain.value = 18 * pitch;
    lfo.connect(lg).connect(o.frequency);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(g0, t + 0.08);
    out.gain.setValueAtTime(g0, t + dur * 0.6);
    out.gain.exponentialRampToValueAtTime(0.001, t + dur);
    for (const [f, q, a] of [[650, 6, 1], [1100, 8, 0.6], [2400, 10, 0.3]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * pitch;
      bp.Q.value = q;
      const ga = ctx.createGain();
      ga.gain.value = a * 0.6;
      o.connect(bp).connect(ga).connect(out);
    }
    out.connect(this.cats.voice);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.1);
    lfo.stop(t + dur + 0.1);
  }

  /** Shrine heal and streak rewards. */
  heal() {
    if (this.play('heal')) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, type: 'sine', dur: 0.5, gain: 0.08, delay: i * 0.07, cat: 'stinger' }));
  }

  splash(at = null) {
    if (this.play('splash', { at })) return;
    this.burst({ freq: 2500, type: 'highpass', q: 0.5, dur: 1.2, gain: 0.4, at, cat: 'impact' });
    this.tone({ freq: 90, dur: 0.5, gain: 0.3, slide: 40, at, cat: 'impact' });
  }

  // ------------------------------------------------------------ interface
  /** Menu and HUD sounds: hover, click, confirm, back, open, close, error, toggle, pick, tab. */
  ui(name = 'click') {
    if (!this.ctx) return;
    const gains = { hover: 0.8, click: 1, confirm: 1, back: 1, open: 1, close: 1, error: 1, toggle: 1, pick: 1, tab: 1 };
    if (this.play(`ui_${name}`, { gain: gains[name] ?? 1 })) return;
    this.tone({ freq: name === 'hover' ? 1800 : 1200, type: 'sine', dur: 0.05, gain: 0.05, cat: 'ui' });
  }
}
