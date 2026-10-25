// The sound system: every sound the client asks for ships, every sample sits at its category's loudness, the
// shared space model is sane, the voice limiter keeps 20 dragons from turning into mush, and the settings reach
// the buses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Audio, CATALOG, CATS, GROUPS, SAMPLES, TRACKS, TYPES, VoiceLimiter, AUDIBLE, MAX_VOICES, airCutoff, attenuation, reverbSend, taper } from '../client/js/audio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'client/assets/audio');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'tools/audio_spec.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'loudness.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const SR = 44100;

// ------------------------------------------------------------------ loudness (same definitions as tools/loudness.py)
function biquad(x, b, a) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
function kWeight(x) {
  let K = Math.tan(Math.PI * 1681.974450955533 / SR);
  const Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416), Q1 = 0.7071752369554196;
  let a0 = 1 + K / Q1 + K * K;
  const s1 = biquad(x, [(Vh + Vb * K / Q1 + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q1 + K * K) / a0], [1, 2 * (K * K - 1) / a0, (1 - K / Q1 + K * K) / a0]);
  K = Math.tan(Math.PI * 38.13547087602444 / SR);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  return biquad(s1, [1, -2, 1], [1, 2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0]);
}
const lufs = (ms) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
/** Mean square per block, channels summed. */
function blocks(chs, win, hop) {
  const w = Math.floor(win * SR), h = Math.floor(hop * SR);
  const n = Math.max(chs[0].length, w);
  const out = [];
  for (let s = 0; s + w <= n; s += h) {
    let e = 0;
    for (const c of chs) {
      const end = Math.min(s + w, c.length);
      for (let i = s; i < end; i++) e += c[i] * c[i];
    }
    out.push(e / w);
  }
  return out;
}
const activeLufs = (x) => {
  const ms = blocks([kWeight(x)], 0.05, 0.025);
  const max = Math.max(...ms);
  const keep = ms.filter((v) => v > max * 0.00316);
  return lufs(keep.reduce((a, b) => a + b, 0) / keep.length);
};
function integratedLufs(chs) {
  const ms = blocks(chs.map(kWeight), 0.4, 0.1);
  const abs = ms.filter((v) => lufs(v) > -70);
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const keep = abs.filter((v) => lufs(v) > rel);
  return lufs(keep.reduce((a, b) => a + b, 0) / keep.length);
}
function decode(file, ch = 1) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', String(ch), '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 29 });
  if (r.status !== 0) return null;
  const all = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2);
  if (ch === 1) return [all];
  return Array.from({ length: ch }, (_, c) => Float32Array.from({ length: all.length / ch }, (_, i) => all[i * ch + c]));
}
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const peakDb = (x) => 20 * Math.log10(x.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-12));

// ------------------------------------------------------------------ shipping
test('every sample the audio engine loads exists as an mp3, and nothing else ships', () => {
  assert.ok(SAMPLES.length > 55, `found ${SAMPLES.length} samples`);
  for (const n of SAMPLES) assert.ok(fs.existsSync(path.join(dir, `${n}.mp3`)), `${n}.mp3 is missing`);
  const music = Object.values(TRACKS).map((t) => t.file);
  const extra = fs.readdirSync(dir).filter((f) => f !== 'loudness.json' && !SAMPLES.includes(f.replace(/\.mp3$/, '')) && !music.includes(f));
  assert.deepEqual(extra, [], `unused files: ${extra.join(', ')}`);
});

test('music tracks exist', () => {
  assert.equal(Object.keys(TRACKS).length, 3);
  for (const t of Object.values(TRACKS)) assert.ok(fs.existsSync(path.join(dir, t.file)), `${t.file} is missing`);
});

test('audio stays within the 7 MB budget and every file is a real mp3', () => {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    const buf = fs.readFileSync(path.join(dir, f));
    total += buf.length;
    if (f.endsWith('.json')) continue;
    // ID3 tag or an MPEG frame sync
    assert.ok((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0), `${f} is not an mp3`);
  }
  assert.ok(total < 7 * 1024 * 1024, `audio is ${(total / 1048576).toFixed(2)} MB`);
});

test('README credits every source pack', () => {
  for (const who of ['Matthew Pablo', 'Darsycho', 'trazzz123', 'rubberduck', 'AntumDeluge', 'VishwaJai', 'Julien Matthey', 'Kenney', 'PagDev', 'qubodup', 'artisticdude']) {
    assert.ok(readme.includes(who), `README is missing ${who}`);
  }
});

// ------------------------------------------------------------------ loudness per category
test('the loudness spec and the engine agree on every sample and category', () => {
  const fromEngine = {};
  for (const [cat, names] of Object.entries(CATALOG)) for (const n of names) fromEngine[n] = cat;
  assert.deepEqual(Object.keys(fromEngine).sort(), Object.keys(spec.samples).sort());
  for (const n of Object.keys(fromEngine)) assert.equal(spec.samples[n], fromEngine[n], `${n}: engine says ${fromEngine[n]}, spec says ${spec.samples[n]}`);
  for (const cat of new Set(Object.values(spec.samples))) assert.ok(cat in spec.targets, `no loudness target for ${cat}`);
  for (const cat of Object.keys(CATALOG)) assert.ok(cat in CATS, `no space/mix entry for ${cat}`);
});

test('the build manifest has every sample inside its category target', () => {
  for (const n of SAMPLES) {
    const m = manifest[n];
    assert.ok(m, `${n} is missing from loudness.json (run tools/build_audio.py)`);
    const target = spec.targets[spec.samples[n]] + (spec.offsets[n] || 0);
    assert.ok(Math.abs(m.active - target) <= spec.tolerance, `${n}: ${m.active} LUFS, target ${target}`);
    assert.ok(m.peak <= -0.5, `${n} peaks at ${m.peak} dBFS`);
  }
  for (const t of Object.values(TRACKS)) {
    const m = manifest[t.file.replace('.mp3', '')];
    assert.ok(Math.abs(m.integrated - spec.music.integrated) <= 1, `${t.file}: ${m.integrated} LUFS`);
    assert.ok(m.peak <= spec.music.ceiling + 0.5, `${t.file} peaks at ${m.peak}`);
  }
});

test('measured from the shipped mp3s, every sample sits at its category target and below the peak ceiling', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const rows = [];
  for (const n of SAMPLES) {
    const [x] = decode(path.join(dir, `${n}.mp3`));
    const got = activeLufs(x);
    const target = spec.targets[spec.samples[n]] + (spec.offsets[n] || 0);
    rows.push([n, got, target, peakDb(x)]);
  }
  for (const [n, got, target, pk] of rows) {
    assert.ok(Math.abs(got - target) <= spec.tolerance, `${n}: measured ${got.toFixed(1)} LUFS, target ${target}`);
    assert.ok(pk <= -0.5, `${n} peaks at ${pk.toFixed(1)} dBFS`);
  }
  // consistency inside a category: samples with no offset are within 1.5 LU of each other
  for (const cat of Object.keys(spec.targets)) {
    const own = rows.filter(([n]) => spec.samples[n] === cat && !(n in spec.offsets));
    if (own.length < 2) continue;
    const vals = own.map((r) => r[1]);
    assert.ok(Math.max(...vals) - Math.min(...vals) <= 1.5, `${cat} spreads ${(Math.max(...vals) - Math.min(...vals)).toFixed(1)} LU`);
  }
});

test('the music is at its integrated target with headroom', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  for (const t of Object.values(TRACKS)) {
    const chs = decode(path.join(dir, t.file), 2);
    const l = integratedLufs(chs);
    assert.ok(Math.abs(l - spec.music.integrated) <= 1, `${t.file}: ${l.toFixed(1)} LUFS`);
    assert.ok(Math.max(peakDb(chs[0]), peakDb(chs[1])) <= spec.music.ceiling + 0.6, `${t.file} is too hot`);
  }
});

test('the mix hierarchy (category target + bus trim): explosions on top, wings under everything, the interface under the action', () => {
  const eff = {};
  for (const c of Object.keys(spec.targets)) eff[c] = spec.targets[c] + CATS[c].trim;
  for (const c of Object.keys(eff)) if (c !== 'explosion') assert.ok(eff.explosion >= eff[c] + 3, `explosions should be 3 dB over ${c}: ${eff.explosion} vs ${eff[c]}`);
  for (const c of ['voice', 'ability', 'weapon', 'impact', 'stinger']) {
    assert.ok(eff[c] > eff.flap + 5, `${c} should sit well over the wingbeats`);
    assert.ok(eff[c] >= eff.ui + 3, `${c} should be over the interface sounds`);
    assert.ok(Math.abs(eff[c] - eff.weapon) <= 3, `${c} is within 3 dB of the weapons`);
  }
  assert.ok(eff.alert < eff.weapon && eff.alert > eff.flap, 'alerts are clear but gentle');
});

// ------------------------------------------------------------------ one acoustic space
test('distance attenuation is the same model for every category: full inside the reference, then falling', () => {
  for (const [name, c] of Object.entries(CATS)) {
    if (!c.ref) continue;
    assert.equal(attenuation(name, 0), 1);
    assert.equal(attenuation(name, c.ref), 1);
    let prev = 1;
    for (let d = c.ref; d <= c.max; d += c.ref / 2) {
      const a = attenuation(name, d);
      assert.ok(a <= prev + 1e-12 && a > 0, `${name} at ${d} m`);
      prev = a;
    }
    // inverse-distance: past the reference, twice as far costs about 6 dB (more for roll-off > 1)
    const r = attenuation(name, c.ref * 3) / attenuation(name, c.ref * 6);
    assert.ok(r > 1.4 && r < 2.4, `${name} roll-off ratio ${r}`);
    // nothing positional is still audible at its own cull distance: the cull and the model agree
    assert.ok(attenuation(name, c.max) * Math.pow(10, c.trim / 20) < 0.35, `${name} is still loud at ${c.max} m`);
  }
  // the loud things carry further than the quiet ones
  assert.ok(CATS.explosion.ref > CATS.weapon.ref && CATS.weapon.ref > CATS.flap.ref);
});

test('air absorption closes the highs with distance and the reverb send grows', () => {
  let c = Infinity, r = -1;
  for (const d of [0, 50, 150, 400, 1000, 2500, 6000]) {
    assert.ok(airCutoff(d) <= c && airCutoff(d) >= 1100 && airCutoff(d) <= 18000);
    assert.ok(reverbSend(d) >= r && reverbSend(d) <= 0.6);
    c = airCutoff(d);
    r = reverbSend(d);
  }
  assert.ok(airCutoff(0) > 15000 && airCutoff(2000) < 3000);
  assert.equal(reverbSend(40), 0);
});

test('the sliders have a squared taper', () => {
  assert.equal(taper(0), 0);
  assert.equal(taper(1), 1);
  assert.ok(taper(0.5) < 0.3);
});

// ------------------------------------------------------------------ voice limiting
test('every sound type has a category, a cap and a priority; every sample can be reached', () => {
  const reach = new Set();
  for (const [k, T] of Object.entries(TYPES)) {
    assert.ok(T.cat in CATS, `${k}: unknown category ${T.cat}`);
    assert.ok(T.cap >= 1 && T.cap <= 8 && T.pri >= 1 && T.pri <= 10, k);
    assert.ok(T.pitch <= 0.06 && T.vol <= 1.01, `${k}: the random variation is tasteful (<= 6% pitch, 1 dB)`);
    for (const n of GROUPS[k] || [k]) reach.add(n);
  }
  for (const n of SAMPLES) if (!['breath_loop', 'sea_loop'].includes(n)) assert.ok(reach.has(n), `${n} is never played`);
  for (const n of Object.keys(CATALOG).flatMap((c) => CATALOG[c])) assert.ok(spec.samples[n]);
});

test('a voice type never exceeds its cap, and the quietest voice is the one that goes', () => {
  const lim = new VoiceLimiter({ fb: { cat: 'weapon', cap: 3, pri: 3, gap: 0, pitch: 0, vol: 0 } }, 99);
  const mk = (amp, t) => ({ type: 'fb', amp, pri: 3, t0: t, dur: 1.4 });
  const start = (amp, t) => {
    const v = mk(amp, t);
    const r = lim.admit('fb', amp, t);
    if (!r.ok) return null;
    if (r.steal) lim.remove(r.steal);
    lim.add(v);
    return { v, steal: r.steal };
  };
  const a = start(0.5, 0).v, b = start(0.9, 0.01).v, c = start(0.2, 0.02).v;
  assert.equal(lim.count('fb'), 3);
  assert.equal(start(0.1, 0.03), null, 'a newcomer quieter than all three is dropped');
  const s = start(0.7, 0.04);
  assert.equal(s.steal, c, 'the quietest (0.2) is stolen');
  assert.equal(lim.count('fb'), 3);
  assert.ok(lim.voices.has(a) && lim.voices.has(b) && lim.voices.has(s.v));
});

test('a sound that is nearly over counts as quiet', () => {
  const lim = new VoiceLimiter({ x: { cat: 'weapon', cap: 2, pri: 3, gap: 0, pitch: 0, vol: 0 } }, 99);
  const old = { type: 'x', amp: 0.8, pri: 3, t0: 0, dur: 1 }, fresh = { type: 'x', amp: 0.6, pri: 3, t0: 0.9, dur: 1 };
  lim.add(old); lim.add(fresh);
  const r = lim.admit('x', 0.55, 0.95);
  assert.ok(r.ok && r.steal === old, 'the loud one that is nearly finished makes room');
});

test('the retrigger gap drops machine-gun repeats unless the new one is clearly louder', () => {
  const lim = new VoiceLimiter({ x: { cat: 'weapon', cap: 9, pri: 3, gap: 0.05, pitch: 0, vol: 0 } }, 99);
  lim.add({ type: 'x', amp: 0.5, pri: 3, t0: 0, dur: 1 });
  assert.equal(lim.admit('x', 0.5, 0.02).ok, false);
  assert.equal(lim.admit('x', 0.9, 0.02).ok, true);
  assert.equal(lim.admit('x', 0.5, 0.2).ok, true);
});

test('the global cap steals across types by loudness and priority', () => {
  const T = { a: { cat: 'weapon', cap: 9, pri: 2, gap: 0 }, b: { cat: 'weapon', cap: 9, pri: 9, gap: 0 } };
  const lim = new VoiceLimiter(T, 3);
  const va = { type: 'a', amp: 0.3, pri: 2, t0: 0, dur: 5 }, vb = { type: 'b', amp: 0.3, pri: 9, t0: 0, dur: 5 }, vc = { type: 'a', amp: 0.6, pri: 2, t0: 0, dur: 5 };
  lim.add(va); lim.add(vb); lim.add(vc);
  const r = lim.admit('b', 0.3, 0.1);
  assert.ok(r.ok && r.steal === va, 'a low-priority quiet voice makes room for a high-priority one');
  assert.equal(lim.admit('a', 0.05, 0.1).ok, false);
});

test('20 dragons firing: fireballs, flaps, impacts and explosions stay within their caps and the loudest survive', () => {
  const lim = new VoiceLimiter();
  const rnd = (() => { let s = 7; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  const dragons = Array.from({ length: 20 }, () => ({ d: 30 + rnd() * 1400, next: rnd() * 0.3 }));
  const dur = { fireball: 1.4, flap: 0.7, impact: 0.6, explode: 2.0 };
  const maxSeen = {};
  const started = {};
  const live = [];
  let dropped = 0, requested = 0;
  const start = (type, d, t) => {
    requested++;
    const amp = attenuation(TYPES[type].cat, d) * Math.pow(10, CATS[TYPES[type].cat].trim / 20);
    if (amp < AUDIBLE) return;
    const r = lim.admit(type, amp, t);
    if (!r.ok) { dropped++; return; }
    if (r.steal) lim.remove(r.steal);
    const v = { type, amp, pri: TYPES[type].pri, t0: t, dur: dur[type] };
    lim.add(v);
    live.push(v);
    started[type] = (started[type] || 0) + 1;
  };
  for (let t = 0; t < 12; t += 1 / 60) {
    for (const v of live.slice()) if (t > v.t0 + v.dur) { lim.remove(v); live.splice(live.indexOf(v), 1); }
    for (const g of dragons) {
      if (t >= g.next) { start('fireball', g.d, t); start('flap', g.d, t); g.next = t + 0.28; }
      if (rnd() < 0.02) start('impact', g.d, t);
      if (rnd() < 0.004) start('explode', g.d, t);
    }
    for (const type of Object.keys(TYPES)) {
      const n = lim.count(type);
      maxSeen[type] = Math.max(maxSeen[type] || 0, n);
      assert.ok(n <= TYPES[type].cap, `${type}: ${n} voices > cap ${TYPES[type].cap}`);
    }
    assert.ok(lim.voices.size <= MAX_VOICES);
  }
  assert.equal(maxSeen.fireball, TYPES.fireball.cap, 'the cap is actually reached in this fight');
  assert.ok(dropped > requested * 0.3, 'most of the 70 shots a second are not started');
  // what plays is what is loudest here: the fireball voices alive at the end belong to the nearest dragons
  const alive = [...lim.voices].filter((v) => v.type === 'fireball').map((v) => v.amp).sort((a, b) => b - a);
  const all = dragons.map((g) => attenuation('weapon', g.d)).sort((a, b) => b - a);
  assert.ok(alive[0] >= all[Math.min(2, all.length - 1)] * 0.7, 'the nearest fire is heard');
});

// ------------------------------------------------------------------ the engine against the game
test('every audio method the game calls exists', () => {
  const calls = new Set();
  for (const f of fs.readdirSync(path.join(root, 'client/js'))) {
    if (!f.endsWith('.js') || f === 'audio.js') continue;
    const src = fs.readFileSync(path.join(root, 'client/js', f), 'utf8');
    for (const m of src.matchAll(/\baudio\.([a-zA-Z]+)\(/g)) calls.add(m[1]);
  }
  assert.ok(calls.size > 15, `found ${calls.size} audio calls`);
  for (const c of calls) assert.equal(typeof Audio.prototype[c], 'function', `audio.${c}() is called but not defined`);
  // the abilities, the alert kinds and the death all use samples and none of the old raw synth tones
  const game = fs.readFileSync(path.join(root, 'client/js/game.js'), 'utf8');
  assert.ok(!/audio\.tone\(/.test(game), 'game.js still plays raw synth tones');
  for (const k of ['inferno', 'nova', 'chain', 'acid']) assert.ok(game.includes(`audio.ability('${k}'`), `${k} has no sound`);
  assert.ok(game.includes('audio.death()'));
});

test('the settings menu has a slider for each bus and wires it to the engine', () => {
  const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
  const menu = fs.readFileSync(path.join(root, 'client/js/ui-menu.js'), 'utf8');
  for (const [id, fn] of [['set-vol', 'setVolume'], ['set-music', 'setMusicVolume'], ['set-sfx', 'setSfxVolume'], ['set-amb', 'setAmbienceVolume']]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is not in index.html`);
    assert.ok(menu.includes(`bindRange('${id}'`) && menu.includes(`audio.${fn}(v)`), `${id} is not bound to ${fn}`);
    assert.equal(typeof Audio.prototype[fn], 'function');
  }
});

test('the engine can be built on a stub context: buses, the wind graph, ducking and pause', () => {
  const nodes = [];
  const param = (v = 0) => {
    const p = { value: v, calls: [] };
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) p[m] = (...a) => { p.calls.push([m, ...a]); return p; };
    return p;
  };
  const node = (extra = {}) => {
    const n = { gain: param(1), frequency: param(350), Q: param(1), detune: param(0), pan: param(0), connect: (d) => d, disconnect() {}, start() {}, stop() {}, ...extra };
    n.connect = (d) => d;
    nodes.push(n);
    return n;
  };
  const ctx = {
    currentTime: 1, sampleRate: 48000, state: 'running', destination: node(), listener: {},
    createGain: () => node(), createBiquadFilter: () => node(), createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createWaveShaper: () => node(), createConvolver: () => node(), createBufferSource: () => node({ playbackRate: param(1) }),
    createBuffer: (c, n) => ({ numberOfChannels: c, length: n, duration: n / 48000, getChannelData: () => new Float32Array(n) }),
    createStereoPanner: () => node(), createPanner: () => node(), createOscillator: () => node(),
  };
  const g = globalThis;
  g.window = { AudioContext: function () { return ctx; } };
  g.document = { addEventListener() {}, hidden: false };
  g.fetch = () => Promise.resolve({ ok: false });
  g.setInterval = () => 0;
  try {
    const a = new Audio();
    a.start();
    for (const bus of ['sfx', 'uiBus', 'ambBus', 'musicBus', 'master', 'mix', 'ambDuck', 'musicDuck', 'ambGate', 'windCut']) assert.ok(a[bus], `${bus} exists`);
    for (const cat of Object.keys(CATS)) assert.ok(a.cats[cat], `category bus ${cat}`);
    for (const layer of ['rumble', 'body', 'whoosh', 'gust', 'hush']) assert.ok(a.w[layer]);
    // pause closes the ambience gate; the music/ambience duck dips and returns
    a.setMuffled(true);
    assert.ok(a.ambGate.gain.calls.some((c) => c[0] === 'setTargetAtTime' && c[1] === 0));
    a.setMuffled(false);
    a.duck({ music: 0.4, amb: 0.2 });
    assert.ok(a.musicDuck.gain.calls.some((c) => c[0] === 'setTargetAtTime' && c[1] === 0.4) && a.musicDuck.gain.calls.some((c) => c[0] === 'setTargetAtTime' && c[1] === 1));
    // the wind never steps: every parameter move is a ramp or a time-constant approach, never a bare .value write
    a.update({ speed: 150, boost: true, inCloud: 0.4, turn: 1, climb: -0.5, ground: 30 });
    for (const L of Object.values(a.w)) for (const p of [L.g.gain, ...L.f.map((f) => f.frequency)]) assert.ok(p.calls.length === 0 || p.calls.every((c) => c[0] === 'setTargetAtTime'), 'wind parameters are smoothed');
    assert.equal(a.windCut.gain.calls.at(-1)[0], 'setTargetAtTime');
    // volumes
    a.setAmbienceVolume(0.5);
    assert.equal(a.ambBus.gain.calls.at(-1)[1], taper(0.5));
  } finally {
    delete g.window; delete g.document; delete g.fetch;
  }
});

test('a dragon flying past close by whooshes once at closest approach; far passes and respawns do not', () => {
  const run = (offset, speed, jump = false) => {
    const a = new Audio();
    a.ctx = {};
    const calls = [];
    a.passBy = (rel, sp) => calls.push([rel, sp]);
    for (let x = -500; x <= 500; x += speed / 60) a.trackPassBy(7, { x, y: 0, z: -offset }, 1 / 60);
    if (jump) { a.trackPassBy(8, { x: 900, y: 0, z: 0 }, 1 / 60); a.trackPassBy(8, { x: 20, y: 0, z: 0 }, 1 / 60); a.trackPassBy(8, { x: 22, y: 0, z: 0 }, 1 / 60); }
    return calls;
  };
  const near = run(40, 150);
  assert.equal(near.length, 1);
  assert.ok(Math.abs(near[0][0].x) < 6 && Math.abs(near[0][0].z + 40) < 1, 'at the point of closest approach');
  assert.ok(near[0][1] > 140 && near[0][1] < 160, 'the relative speed is handed on');
  assert.equal(run(300, 150).length, 0, 'too far away to hear');
  assert.equal(run(40, 20).length, 0, 'too slow to whoosh');
  assert.equal(run(40, 150, true).length, 1, 'a teleport is not a fly-by');
});

test('damage over time gets a grunt now and then, not one per tick', () => {
  const a = new Audio();
  a.ctx = { currentTime: 0 };
  let plays = 0;
  a.play = () => { plays++; return true; };
  a.duck = () => {};
  for (let i = 0; i < 100; i++) { a.ctx.currentTime = i * 0.1; a.hurt(true); }
  assert.ok(plays >= 5 && plays <= 7, `${plays} grunts in 10 s of burning`);
  plays = 0;
  a.lastHurt = -9;
  a.hurt();
  a.ctx.currentTime += 0.05;
  a.hurt();
  assert.equal(plays, 2, 'direct hits always grunt (the voice limiter spaces them)');
});
