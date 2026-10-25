// Heads-up display: DOM gauges and banners plus a 2D overlay canvas for reticles, target brackets, lead
// markers, lock diamonds, hit markers, damage numbers and arcs, and the radar.
// Per-frame work only touches transforms, canvas pixels and text that actually changed.
import * as THREE from 'three';
import { ABILITIES, WEAPONS, WORLD } from '../../shared/constants.js';
import { renderScoreboard, Results } from './ui-panels.js';
import { $, breedColor, esc, store } from './ui-util.js';
import { LENS } from './render/lens.js';

export { breedColor, esc };
const _v = new THREE.Vector3();
const ease = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
// canvas text follows the page's UI font (the CSS variable --ui is the source of truth); read once in the constructor
let FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const readUiFont = () => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--ui').trim() || FONT;
  } catch {
    return FONT;
  }
};
// HUD palette (matches the --h-* variables in game.css)
const INK = '243,234,216';
const RED = '#ff6a4c';
const AMBER = '#f0a64e';
// seconds without combat, warnings or nearby dragons before the HUD settles into its quiet state
const CALM_AFTER = 4;
const NEAR = 650; // m: a dragon this close keeps the HUD awake
// ability name (as game.js writes it into #abil-tag) -> breed, for the icon and the cooldown length
const ABIL_BY_NAME = Object.fromEntries(Object.entries(ABILITIES).map(([breed, a]) => [a.name.toUpperCase(), { breed, cd: a.cooldown }]));
// the touch POWER button is labelled with the ability's short name
const ABIL_SHORT = { ember: 'Inferno', frost: 'Nova', storm: 'Chain', venom: 'Acid' };
// how long the touch-only "Tap for scores" line stays under the clock in a player's first match (s)
const SB_TIP_TIME = 480;

// kill streak banners by name: tier decides colour and size; kills is the streak length
const STREAK_TIER = { 'Double Kill': { tier: 2, kills: 2 }, 'Triple Kill': { tier: 3, kills: 3 }, Rampage: { tier: 4, kills: 4 }, ACE: { tier: 5, kills: 5 }, 'Sky Tyrant': { tier: 6, kills: 7 }, Dragonlord: { tier: 7, kills: 10 } };

const RADAR_RANGE = 1200;
const NO_COVER = new Map();
const NO_SET = new Set();
const LOCK_RED = '#ff5c3c'; // lock and seeker red (the lens rim in render/lens.js turns the same red)
const _pA = { x: 0, y: 0, behind: false, z: 0 }, _pB = { x: 0, y: 0, behind: false, z: 0 }; // reused projections
const _hv = new THREE.Vector3();

export class Hud {
  constructor() {
    this.el = $('hud');
    this.overlay = $('overlay');
    this.ctx = this.overlay.getContext('2d');
    this.radar = $('radar');
    this.rctx = this.radar.getContext('2d');
    this.feed = $('feed');
    this.vignette = $('vignette');
    this.audio = null; // set by main.js
    this.hitMarks = [];
    this.dmgNums = [];
    this.dmgArcs = [];
    this.msgTimer = 0;
    this.bannerTimer = 0;
    this.radarBg = null;
    this.radarPx = 190;
    this.txt = {};
    this.cache = {};
    this.lowHp = 0;
    this.beatT = 0;
    this.danger = false;
    this.hintTimer = 0;
    this.hintsOn = store.get('da.hints', '1') !== '0';
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.stats = { damage: 0, hits: 0, bestStreak: 0 };
    this.results_ = new Results();
    this.scoreKey = '';
    this.sbShown = false;
    this.forceScores = false;
    FONT = readUiFont();
    this.quiet = 0; // seconds since anything worth attention happened
    this.shownFor = 0; // seconds since the HUD appeared (the room line leaves after a few)
    this.abilText = null;
    this.abil = { breed: '', cd: 1, left: 0 };
    this.els = {
      hpGauge: document.querySelector('.gauge.hp'), stamGauge: document.querySelector('.gauge.stam'), heatGauge: document.querySelector('.gauge.heat'),
      seek: $('ab-seek'), abil: $('ab-abil'), abilTag: $('abil-tag'), spd: document.querySelector('.readout.spd'), tl: document.querySelector('.hud-tl'),
      tbSeek: document.querySelector('#touch .b-seek'), tbAbil: document.querySelector('#touch .b-abil'),
    };
    // touch: a pause button (sends Escape) and tap the timer for the standings
    $('btn-hud-pause').addEventListener('click', () => {
      for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { code: 'Escape', key: 'Escape' }));
    });
    document.querySelector('.plaque').addEventListener('click', () => {
      this.forceScores = !this.forceScores;
      this.sbTipT = 0;
    });
    // touch: the standings cover the clock on a phone, so a tap on them closes them too
    $('scoreboard').addEventListener('click', () => { this.forceScores = false; });
    this.sbTipT = 0;
    this.turnT = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
    if (document.fonts && document.fonts.load) document.fonts.load(`600 14px ${FONT}`).catch(() => {});
  }

  /** Something happened that deserves the full HUD for a while. */
  wake() {
    this.quiet = 0;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
    this.overlay.width = innerWidth * dpr;
    this.overlay.height = innerHeight * dpr;
    this.sizeRadar();
  }

  sizeRadar() {
    const css = this.radar.clientWidth || (innerWidth <= 700 ? 112 : 148);
    const px = Math.round(css * this.dpr);
    if (this.radar.width !== px) this.radar.width = this.radar.height = px;
    this.radarPx = px;
  }

  show(on) {
    this.el.classList.toggle('hidden', !on);
    if (!on) {
      this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      this.vignette.style.opacity = '0';
      this.lowHp = 0;
      return;
    }
    this.sizeRadar();
    this.forceScores = false;
    this.quiet = 0;
    this.shownFor = 0;
    this.resetStats();
    this.hintTimer = this.hintsOn ? 18 : 0;
    this.renderHints();
    $('hints').classList.toggle('show', this.hintTimer > 0);
    // touch, first match ever: say that the clock opens the standings
    if (this.touch && !store.get('da.sbtip', '')) {
      store.set('da.sbtip', '1');
      this.sbTipT = SB_TIP_TIME;
    }
    $('sb-tip').hidden = !(this.sbTipT > 0);
    // a phone held upright at the start of a battle: a short nudge to turn it
    this.turnT = this.touch && innerHeight > innerWidth ? 2.2 : 0;
    $('turn-card').hidden = !(this.turnT > 0);
  }

  // the first death ends the tutorial strip: it would sit over the respawn message
  hideHints() {
    if (this.hintTimer <= 0) return;
    this.hintTimer = 0;
    $('hints').classList.remove('show');
  }

  setHints(on) {
    this.hintsOn = on;
    if (!on) {
      this.hintTimer = 0;
      $('hints').classList.remove('show');
    }
  }

  renderHints() {
    const touch = this.touch;
    $('hints').innerHTML = touch
      ? '<span>Drag anywhere to aim</span><span>Left stick to roll</span><span>Hold Fire to shoot</span>'
      : '<span><kbd>Click</kbd>fireball</span><span><kbd>Right click</kbd>breath</span><span><kbd>F</kbd>seeker</span><span><kbd>R</kbd>ability</span><span><kbd>Q E</kbd>roll</span><span><kbd>Shift</kbd>boost</span><span><kbd>Tab</kbd>scores</span>';
  }

  resetStats() {
    this.stats = { damage: 0, hits: 0, bestStreak: 0 };
  }

  /** textContent that skips the write (and the layout it causes) when nothing changed. */
  text(id, value) {
    if (this.txt[id] === value) return;
    this.txt[id] = value;
    const el = this.cache['#' + id] || (this.cache['#' + id] = $(id));
    if (el) el.textContent = value;
  }

  /** classList.toggle that skips redundant writes. */
  toggle(id, cls, on) {
    const k = `${id}.${cls}`;
    if (this.cache[k] === on) return;
    this.cache[k] = on;
    $(id).classList.toggle(cls, on);
  }

  // terrain map for the radar, drawn once from the worker's global data
  // The terrain data covers 7.2 km; the radar shows 1.2 km around you (2.4 km across, 12 m per pixel at 200 px),
  // so the map is baked at 512 px (14 m per pixel).
  buildRadarMap(data, n) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = Math.floor((x / S) * n), j = Math.floor((y / S) * n);
        const h = data[(j * n + i) * 4];
        const k = (y * S + x) * 4;
        if (h < 0) {
          const d = Math.min(1, -h / 120);
          img.data[k] = 18 - d * 10; img.data[k + 1] = 70 - d * 36; img.data[k + 2] = 92 - d * 36;
        } else {
          const t = Math.min(1, h / 1100);
          img.data[k] = 70 + t * 130; img.data[k + 1] = 92 + t * 90; img.data[k + 2] = 58 + t * 120;
        }
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.radarBg = c;
  }

  message(text, secs = 2.5) {
    const m = $('center-msg');
    m.innerHTML = text;
    m.classList.add('show');
    this.msgTimer = secs;
  }

  /**
   * Banner text decides the style: "Slain NAME" is a one-line kill notice, streak names are announcements.
   * Banners sit low on the screen and stay briefly: callers' durations are shortened to at most 1.6 s.
   */
  banner(text, secs = 2) {
    const b = $('banner');
    const slain = /^Slain (.*)$/.exec(text);
    const streak = STREAK_TIER[text];
    secs = Math.max(0.9, Math.min(1.6, secs * 0.7));
    let cls = 'banner plain';
    let html = esc(text);
    if (slain) {
      cls = 'banner kill';
      html = `<small>Slain</small><span class="nm">${esc(slain[1] || 'dragon')}</span><em>+100</em>`;
    } else if (streak) {
      cls = `banner streak t${streak.tier}`;
      html = `${esc(text)}<em>${streak.kills} kills in a row</em>`;
      secs = Math.min(1.9, secs + 0.3);
      this.stats.bestStreak = Math.max(this.stats.bestStreak, streak.kills);
      if (this.audio) this.audio.streak(Math.min(3, streak.tier - 1));
    }
    b.className = cls;
    b.innerHTML = html;
    b.style.setProperty('--bd', `${secs}s`);
    void b.offsetWidth; // restart the animation
    b.classList.add('show');
    this.bannerTimer = secs;
    this.wake();
  }

  killFeed(html, mine) {
    const d = document.createElement('div');
    d.innerHTML = html;
    if (mine) d.className = 'me';
    this.feed.prepend(d);
    while (this.feed.children.length > 4) this.feed.lastChild.remove();
    setTimeout(() => d.remove(), 6000); // the CSS fades it out just before
  }

  hitMarker(kill = false) {
    this.hitMarks.push({ t: 0, kill });
    if (kill && this.audio) this.audio.kill();
    this.wake();
  }

  damageNumber(p, n, crit) {
    this.dmgNums.push({ p: p.clone(), n: Math.round(n), t: 0, crit, dx: (Math.random() - 0.5) * 30 });
    this.stats.damage += Math.round(n);
    this.stats.hits++;
    this.wake();
  }

  /** Damage from a direction (0 = ahead, positive = right): one arc per attacker per 0.5 s, nearby arcs merge. */
  damageFrom(angle, from = 0) {
    const now = performance.now() / 1000;
    if (from) {
      const last = this.dmgFrom || (this.dmgFrom = new Map());
      if (now - (last.get(from) || -1) < 0.5) return;
      last.set(from, now);
    }
    this.wake();
    for (const d of this.dmgArcs) {
      const diff = Math.atan2(Math.sin(angle - d.a), Math.cos(angle - d.a));
      if (Math.abs(diff) < 0.4) { d.a += diff * 0.5; d.t = 0; return; }
    }
    this.dmgArcs.push({ a: angle, t: 0 });
  }

  setWarn(text, blink = true) {
    const w = $('warn');
    if (text) this.wake();
    if (this.txt.warn !== text) {
      this.txt.warn = text;
      w.textContent = text;
    }
    if (this.cache.warnOn !== (!!text && blink)) {
      this.cache.warnOn = !!text && blink;
      w.classList.toggle('on', this.cache.warnOn);
    }
  }

  /**
   * level: true = a seeker is inbound (red, pulsing), 'ability' = an enemy ability is aimed at you (amber),
   * anything else = a lock or threat on you (red, steady).
   */
  setLockWarn(text, level) {
    const w = $('lockwarn');
    if (text) this.wake();
    if (this.txt.lockwarn !== text) {
      this.txt.lockwarn = text;
      w.textContent = text;
    }
    const m = level === true && !!text;
    const cls = !text ? 'lockwarn' : m ? 'lockwarn missile' : level === 'ability' ? 'lockwarn ability' : 'lockwarn lock';
    if (this.cache.lwCls !== cls) {
      this.cache.lwCls = cls;
      w.className = cls;
    }
    this.danger = m;
  }

  updateGauges(g) {
    const c = this.cache;
    const frac = Math.max(0, g.hp / g.maxHp);
    const hq = Math.round(frac * 400) / 400;
    if (c.hp !== hq) {
      const lag = $('hp-lag');
      if (c.hp !== undefined && hq > c.hp) {
        lag.style.transition = 'none';
        lag.style.transform = `scaleX(${hq})`;
        void lag.offsetWidth;
        lag.style.transition = '';
      } else lag.style.transform = `scaleX(${hq})`;
      $('hp-fill').style.transform = `scaleX(${hq})`;
      c.hp = hq;
    }
    this.text('hp-text', String(Math.ceil(Math.max(0, g.hp))));
    const el = this.els;
    const crit = g.hp > 0 && frac < 0.3;
    if (c.crit !== crit) {
      c.crit = crit;
      el.hpGauge.classList.toggle('crit', crit);
    }
    if (crit) this.wake();
    this.lowHp = crit ? 1 - frac / 0.3 : 0;
    // wings and heat only show while they are being used up
    const sq = Math.round(g.stamina * 200) / 200;
    if (c.stam !== sq) { c.stam = sq; $('stam-fill').style.transform = `scaleX(${sq})`; }
    this.flag(el.stamGauge, 'on', 'stamOn', sq < 0.98);
    const ht = Math.round(g.heat * 2) / 200;
    if (c.heat !== ht) { c.heat = ht; $('heat-fill').style.transform = `scaleX(${ht})`; }
    this.flag(el.heatGauge, 'on', 'heatOn', ht > 0.04 || g.overheated);
    this.text('heat-text', g.overheated ? 'Overheated' : '');
    this.flag(el.heatGauge, 'over', 'over', !!g.overheated);
    if (g.overheated) this.wake();
    const kmh = Math.round(g.speed * 3.6);
    this.text('spd', String(kmh));
    this.flag(el.spd, 'slow', 'slow', kmh < 125); // the stall is at about 110 km/h
    this.text('alt', String(Math.round(g.alt)));
    const th = Math.round(g.throttle * 50) * 2;
    if (c.thr !== th) { c.thr = th; $('thr-fill').style.height = `${th}%`; }
    this.updateKit(g);
    const cl = g.inCloud > 0.25;
    if (c.cloud !== cl) { c.cloud = cl; $('cloud-tag').classList.toggle('show', cl); }
  }

  /** classList.toggle on an element, skipping redundant writes (key names the cached state). */
  flag(node, cls, key, on) {
    if (!node || this.cache['f.' + key] === on) return;
    this.cache['f.' + key] = on;
    node.classList.toggle(cls, on);
  }

  /**
   * Seeker and breed ability as rings that fill while they recharge (desktop: .kit beside the hull; touch: the
   * SEEK and POWER buttons). game.js writes the ability state as text into the hidden #abil-tag
   * ("FROST NOVA 3.2s" / "FROST NOVA READY [R]"); it is parsed here, so game.js needs no HUD changes.
   */
  updateKit(g) {
    const el = this.els;
    const seekP = g.seekerCd > 0 ? 1 - g.seekerCd / WEAPONS.seeker.cooldown : 1;
    this.ring('seek', [el.seek, el.tbSeek], seekP, g.seekerCd <= 0, g.locked && g.seekerCd <= 0);
    const t = el.abilTag ? el.abilTag.textContent : '';
    if (t !== this.abilText) {
      this.abilText = t;
      const m = /^(.*?)\s+(?:READY|([\d.]+)s)/.exec(t);
      if (m) {
        const info = ABIL_BY_NAME[m[1]];
        if (info && info.breed !== this.abil.breed) {
          this.abil.breed = info.breed;
          this.abil.cd = info.cd;
          for (const n of [el.abil, el.tbAbil]) {
            const use = n && n.querySelector('svg:not(.ring) use');
            if (use) use.setAttribute('href', `#i-b-${info.breed}`);
          }
          if (el.tbAbil) {
            const label = el.tbAbil.querySelector('span');
            if (label) label.textContent = ABIL_SHORT[info.breed] || 'Power';
            el.tbAbil.setAttribute('aria-label', ABILITIES[info.breed].name);
          }
        }
        this.abil.left = m[2] ? parseFloat(m[2]) : 0;
      }
    }
    const left = this.abil.left;
    this.ring('abil', [el.abil, el.tbAbil], left > 0 ? 1 - Math.min(1, left / this.abil.cd) : 1, left <= 0, false);
  }

  ring(key, nodes, p, ready, locked) {
    const q = Math.round(Math.max(0, Math.min(1, p)) * 100);
    const c = this.cache;
    const was = c['r.' + key];
    if (was && was.q === q && was.ready === ready && was.locked === locked) return;
    c['r.' + key] = { q, ready, locked };
    const [ab, tb] = nodes;
    if (ab) {
      const rp = ab.querySelector('.rp');
      if (rp) rp.style.strokeDashoffset = String(100 - q);
      ab.classList.toggle('cool', !ready);
      ab.classList.toggle('locked', locked);
    }
    if (tb) {
      tb.style.setProperty('--p', String(q / 100));
      tb.classList.toggle('cd', !ready);
      tb.classList.toggle('locked', locked);
    }
    // a short pulse when it comes back
    if (was && ready && !was.ready) {
      for (const n of nodes) {
        if (!n) continue;
        n.classList.remove('ping');
        void n.offsetWidth;
        n.classList.add('ping');
      }
    }
  }

  tick(dt) {
    if (this.msgTimer > 0 && (this.msgTimer -= dt) <= 0) $('center-msg').classList.remove('show');
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) $('banner').classList.remove('show');
    if (this.hintTimer > 0 && (this.hintTimer -= dt) <= 0) $('hints').classList.remove('show');
    if (this.turnT > 0 && (this.turnT -= dt) <= 0) $('turn-card').hidden = true;
    if (this.cache.sbTip !== this.sbTipT > 0) {
      this.cache.sbTip = this.sbTipT > 0;
      $('sb-tip').hidden = !this.cache.sbTip;
    }
    if (this.sbTipT > 0) this.sbTipT -= dt;
    // quiet flight fades the secondary readouts; the room line leaves after 8 s and comes back with the scores
    this.quiet += dt;
    this.shownFor += dt;
    this.toggle('hud', 'calm', this.quiet > CALM_AFTER);
    this.flag(this.els.tl, 'away', 'tlAway', this.shownFor > 8 && !this.sbShown);
    // low-health heartbeat: a red vignette pulses with each lub-dub
    const base = Math.max(this.lowHp > 0 ? 0.12 + this.lowHp * 0.38 : 0, this.danger ? 0.14 : 0);
    const q = Math.round(base * 50) / 50;
    if (this.cache.vig !== q) {
      this.cache.vig = q;
      this.vignette.style.opacity = String(q);
    }
    if (this.lowHp > 0) {
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = 1.1 - this.lowHp * 0.55;
        if (this.audio) this.audio.heartbeat(this.lowHp);
        if (this.vignette.animate) {
          const hi = Math.min(0.85, base + 0.3);
          this.vignette.animate([{ opacity: base }, { opacity: hi, offset: 0.12 }, { opacity: base, offset: 0.3 }, { opacity: hi * 0.8, offset: 0.42 }, { opacity: base }], { duration: this.beatT * 800 });
        }
      }
    } else this.beatT = 0;
  }

  project(p, camera, out = {}) {
    _v.copy(p).project(camera);
    out.x = (_v.x * 0.5 + 0.5) * innerWidth;
    out.y = (-_v.y * 0.5 + 0.5) * innerHeight;
    out.behind = _v.z > 1;
    out.z = _v.z;
    return out;
  }

  label(c, text, x, y, size = 13, color = 'rgba(255,255,255,0.92)') {
    c.font = `600 ${size}px ${FONT}`;
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(0,0,0,0.65)';
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  /**
   * s: { camera, aimPoint, nosePoint, enemies:[{ent,pos,dist,inCloud,ally,color,maxHp,tag,lead,threat}],
   *      lock:{ent,progress,locked}, seekers:[pos], seekerTti:[s], dead, lenses, lensCover, lensHidden, lensNear, lensOn,
   *      aimedId, labelId, labelLens, focal, ... } (game.js updateHud reuses this object every frame)
   */
  draw(dt, s) {
    const c = this.ctx;
    const dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, innerWidth, innerHeight);
    if (this.results_.shown) return; // the results screen owns the view
    const W = innerWidth, H = innerHeight;
    c.lineCap = 'round';
    c.textAlign = 'center';
    const now = performance.now() / 1000;
    let nose = null;

    if (!s.dead) {
      nose = this.drawReticle(c, s);
    }

    // dragons: magnifier lens rims (the lens itself is rendered by render/lens.js), close-range marks, small carets
    this.drawTargets(c, s, now);

    // incoming seekers: a bearing wedge and time to impact on a ring around the reticle, ringed crosses on the
    // seekers themselves, plus arrows from the screen edge when they are out of view
    if (!s.dead) this.drawSeekerRing(c, s, nose, now);
    for (const sp of s.seekers) {
      const p = this.project(sp, s.camera, _pA);
      if (p.behind || p.x < 0 || p.x > W || p.y < 0 || p.y > H) {
        this.edgeArrow(c, sp, s.camera, RED, 0, true);
        continue;
      }
      const pr = 9 + Math.sin(now * 14) * 1.5;
      c.strokeStyle = RED;
      c.lineWidth = 1.6;
      c.beginPath();
      c.arc(p.x, p.y, pr, 0, Math.PI * 2);
      c.moveTo(p.x - 15, p.y - 15); c.lineTo(p.x - 7, p.y - 7);
      c.moveTo(p.x + 15, p.y - 15); c.lineTo(p.x + 7, p.y - 7);
      c.moveTo(p.x + 15, p.y + 15); c.lineTo(p.x + 7, p.y + 7);
      c.moveTo(p.x - 15, p.y + 15); c.lineTo(p.x - 7, p.y + 7);
      c.stroke();
    }

    this.drawHits(c, dt, s, W, H);
    this.drawRadar(s, now);
    this.toggle('hud', 'dead', !!s.dead); // the vitals step aside while you wait to respawn
  }

  /** Nose reticle (where fireballs fly) and the aim marker (where you steer). Returns the nose projection. */
  drawReticle(c, s) {
    const nose = this.project(s.nosePoint, s.camera);
    if (!nose.behind) {
      const x = nose.x, y = nose.y;
      for (const pass of [0, 1]) {
        c.strokeStyle = pass ? `rgba(${INK},0.92)` : 'rgba(0,0,0,0.28)';
        c.lineWidth = pass ? 1.4 : 3;
        c.beginPath();
        // a ring broken at the four points, with short wings either side
        for (let i = 0; i < 4; i++) {
          const a0 = i * (Math.PI / 2) + 0.32, a1 = a0 + Math.PI / 2 - 0.64;
          c.moveTo(x + Math.cos(a0) * 10, y + Math.sin(a0) * 10);
          c.arc(x, y, 10, a0, a1);
        }
        c.moveTo(x - 21, y); c.lineTo(x - 15, y);
        c.moveTo(x + 15, y); c.lineTo(x + 21, y);
        c.stroke();
      }
      c.fillStyle = `rgba(${INK},0.95)`;
      c.beginPath();
      c.arc(x, y, 1.4, 0, Math.PI * 2);
      c.fill();
    }
    const aim = this.project(s.aimPoint, s.camera);
    if (!aim.behind) {
      c.strokeStyle = `rgba(${INK},0.55)`;
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(aim.x, aim.y, 4, 0, Math.PI * 2);
      c.stroke();
      if (!nose.behind && Math.hypot(aim.x - nose.x, aim.y - nose.y) > 28) {
        c.strokeStyle = `rgba(${INK},0.28)`;
        c.setLineDash([2, 8]);
        c.beginPath();
        c.moveTo(nose.x, nose.y);
        c.lineTo(aim.x, aim.y);
        c.stroke();
        c.setLineDash([]);
      }
    }
    return nose;
  }

  /** Hit ticks at the centre, floating damage numbers and the arcs that show where damage came from. */
  drawHits(c, dt, s, W, H) {
    // hit markers: short ticks open out from the centre; a kill adds one thin red ring
    for (let i = this.hitMarks.length - 1; i >= 0; i--) {
      const h = this.hitMarks[i];
      h.t += dt;
      const dur = h.kill ? 0.55 : 0.28;
      if (h.t > dur) { this.hitMarks.splice(i, 1); continue; }
      const k = h.t / dur;
      const a = 1 - k * k;
      const e = ease(Math.min(1, k * 2.4));
      const r0 = 6 + e * 4;
      const r1 = r0 + (h.kill ? 9 : 6);
      c.strokeStyle = h.kill ? `rgba(255,106,76,${a})` : `rgba(${INK},${a})`;
      c.lineWidth = h.kill ? 2 : 1.6;
      c.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        c.moveTo(W / 2 + sx * r0, H / 2 + sy * r0);
        c.lineTo(W / 2 + sx * r1, H / 2 + sy * r1);
      }
      c.stroke();
      if (h.kill) {
        c.lineWidth = 1.2;
        c.strokeStyle = `rgba(255,106,76,${a * 0.7})`;
        c.beginPath();
        c.arc(W / 2, H / 2, 14 + ease(k) * 26, 0, Math.PI * 2);
        c.stroke();
      }
    }
    // floating damage numbers: small, rise and fade
    for (let i = this.dmgNums.length - 1; i >= 0; i--) {
      const d = this.dmgNums[i];
      d.t += dt;
      if (d.t > 0.9) { this.dmgNums.splice(i, 1); continue; }
      const p = this.project(d.p, s.camera);
      if (p.behind) continue;
      const k = d.t / 0.9;
      const pop = d.t < 0.1 ? 0.8 + (d.t / 0.1) * 0.2 : 1;
      const size = (d.crit ? 19 : 15) * pop;
      const y = p.y - 22 - ease(k) * 30;
      c.font = `600 ${size}px ${FONT}`;
      c.globalAlpha = Math.min(1, (1 - k) * 2.2);
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.strokeText(String(d.n), p.x + d.dx, y);
      c.fillStyle = d.crit ? AMBER : `rgb(${INK})`;
      c.fillText(String(d.n), p.x + d.dx, y);
      c.globalAlpha = 1;
    }
    // damage direction (angle: 0 = ahead, positive = to the right): a thin red arc on a small ring around the centre
    for (let i = this.dmgArcs.length - 1; i >= 0; i--) {
      const d = this.dmgArcs[i];
      d.t += dt;
      if (d.t > 1.1) { this.dmgArcs.splice(i, 1); continue; }
      const fade = 1 - d.t / 1.1;
      const r = Math.min(W, H) * 0.15;
      const a = d.a - Math.PI / 2;
      c.strokeStyle = `rgba(0,0,0,${0.3 * fade})`;
      c.lineWidth = 3.6;
      c.beginPath();
      c.arc(W / 2, H / 2, r, a - 0.28, a + 0.28);
      c.stroke();
      c.strokeStyle = `rgba(255,106,76,${0.9 * fade})`;
      c.lineWidth = 1.8;
      c.beginPath();
      c.arc(W / 2, H / 2, r, a - 0.28, a + 0.28);
      c.stroke();
    }
  }

  // ---- target lenses and marks. s.lenses come from LensDirector (render/lens.js): the lens shows the dragon, its rim
  // carries the information. Up close the lens hands over to the dragon itself with a short health arc under it.
  // Calm by rule: one warm ink, colour only as a small identity tick, red only for threats to you and for the lock,
  // and at most one name on screen (the lock target, else the dragon on your nose within 900 m).
  drawTargets(c, s, now) {
    const W = innerWidth, H = innerHeight;
    const cover = s.lensCover || NO_COVER;
    const hidden = s.lensHidden || NO_SET;
    const near = s.lensNear || NO_SET;
    const lockId = s.lock && s.lock.ent ? s.lock.ent.id : 0;
    const labelId = s.dead ? 0 : s.labelId || 0;
    const worldLabel = !!labelId && !s.labelLens; // the name goes on the dragon itself, not on a lens
    const focal = s.focal || H / (2 * Math.tan(THREE.MathUtils.degToRad(s.camera.fov) / 2));
    let a1 = null, a2 = null; // the two nearest hostiles out of view get an edge arrow (threats always do)
    for (const e of s.enemies) {
      const p = this.project(e.pos, s.camera, _pA);
      if (p.behind || p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) {
        if (e.threat) this.edgeArrow(c, e.pos, s.camera, RED, e.dist, true);
        else if (!e.ally && !e.inCloud && e.dist < 1600) {
          if (!a1 || e.dist < a1.dist) { a2 = a1; a1 = e; } else if (!a2 || e.dist < a2.dist) a2 = e;
        }
        continue;
      }
      if (e.inCloud && e.dist > 160) continue;
      const id = e.ent.id;
      const span = (LENS.span * focal) / Math.max(1, e.dist);
      const caretY = p.y - Math.max(5, span * 0.28) - 4;
      // out of sight behind terrain, rock, the Citadel or thick cloud: a dim caret, nothing else
      if (hidden.has(id)) { this.caret(c, p.x, caretY, e, 0.3); continue; }
      const cov = cover.get(id) || 0;
      const isLabel = id === labelId;
      // plain close-range marks only once the dragon is genuinely big on screen (or for your target with lenses off)
      const big = !e.ally && !s.dead && (near.has(id) || (isLabel && !s.lensOn));
      if (big) {
        if (cov < 0.98) this.drawNear(c, p.x, p.y, Math.max(16, Math.min(90, span * 0.55)), e, id === lockId ? s.lock : null, 1 - cov, isLabel && worldLabel);
      } else {
        const ca = Math.max(0, 1 - cov * 3); // no caret over a dragon that already has a lens
        if (ca > 0.02) this.caret(c, p.x, caretY, e, ca);
        if (isLabel && worldLabel && cov < 0.98) {
          c.save();
          c.globalAlpha = 1 - cov;
          this.targetLabel(c, e, p.x, p.y + Math.max(5, span * 0.3) + 13);
          c.restore();
        }
      }
      // lead pip: where to shoot, for the dragon you're on, always on top (never hidden under a lens)
      if (isLabel && e.lead && e.dist < 900) {
        const l = this.project(e.lead, s.camera, _pB);
        if (!l.behind) {
          for (const pass of [0, 1]) {
            c.strokeStyle = pass ? 'rgba(255,214,120,0.85)' : 'rgba(0,0,0,0.35)';
            c.lineWidth = pass ? 1.3 : 3;
            c.beginPath();
            c.arc(l.x, l.y, 4.5, 0, Math.PI * 2);
            c.stroke();
          }
          c.fillStyle = 'rgba(255,214,120,0.85)';
          c.fillRect(l.x - 0.75, l.y - 0.75, 1.5, 1.5);
        }
      }
    }
    if (a1) this.edgeArrow(c, a1.pos, s.camera, a1.color, a1.dist);
    if (a2) this.edgeArrow(c, a2.pos, s.camera, a2.color, a2.dist);
    if (!s.dead && s.lenses) for (const L of s.lenses) this.drawLensRim(c, L, L.lockP >= 0 ? s.lock : null, s);
  }

  /** The information on a lens rim: health under it, identity tick at 12 o'clock, a notch showing which way the
   *  dragon flies, the lock arc closing on the rim (the rim turns warm red once locked), and the name if it's yours. */
  drawLensRim(c, L, lock, s) {
    if (L.alpha < 0.02) return;
    const e = L.e, x = L.cx, y = L.cy, r = L.r;
    c.save();
    c.globalAlpha = L.alpha;
    c.lineCap = 'round';
    this.healthArc(c, x, y, r + 4.5, 0.92, e);
    // identity: breed colour (team colour in team battles), a short tick on the rim at 12 o'clock
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 4.4;
    c.beginPath(); c.arc(x, y, r, -Math.PI / 2 - 0.12, -Math.PI / 2 + 0.12); c.stroke();
    c.strokeStyle = e.color;
    c.lineWidth = 2.4;
    c.beginPath(); c.arc(x, y, r, -Math.PI / 2 - 0.12, -Math.PI / 2 + 0.12); c.stroke();
    // heading: the screen bearing of where it will be in a second, as a small notch pointing out through the rim
    const v = e.ent.vel;
    if (v) {
      const p0 = this.project(e.pos, s.camera, _pA);
      const p1 = this.project(_hv.copy(e.pos).add(v), s.camera, _pB);
      const dx = p1.x - p0.x, dy = p1.y - p0.y, len = Math.hypot(dx, dy);
      const k = p0.behind || p1.behind ? 0 : Math.min(1, Math.max(0, (len - 0.5) / 3.5));
      if (k > 0.02) {
        const ux = dx / len, uy = dy / len;
        const tx = x + ux * (r - 1), ty = y + uy * (r - 1), bx = x + ux * (r - 7.5), by = y + uy * (r - 7.5);
        c.globalAlpha = L.alpha * k;
        c.beginPath();
        c.moveTo(tx, ty); c.lineTo(bx - uy * 3.2, by + ux * 3.2); c.lineTo(bx + uy * 3.2, by - ux * 3.2); c.closePath();
        c.lineWidth = 2;
        c.strokeStyle = 'rgba(0,0,0,0.4)';
        c.stroke();
        c.fillStyle = `rgba(${INK},0.9)`;
        c.fill();
        c.globalAlpha = L.alpha;
      }
    }
    if (lock) this.lockArc(c, x, y, r, lock);
    if (L.label) this.targetLabel(c, e, x, y + r + 19.5);
    else if (e.tag) {
      c.textAlign = 'center';
      c.font = `700 11px ${this.uiFont()}`;
      c.fillStyle = '#ffd27a';
      c.fillText('★', x, y - r - 8);
    }
    c.restore();
  }

  /** Up close, no glass: a short health arc under the dragon with a small identity tick at its end, the lock arc
   *  closing around it (a full warm-red ring once locked) and the name if it's the dragon you're on. */
  drawNear(c, x, y, rr, e, lock, alpha, label) {
    if (alpha < 0.02) return;
    c.save();
    c.globalAlpha = alpha;
    c.lineCap = 'round';
    const ra = rr + 5, half = 0.5; // clear of the lock ring at rr
    this.healthArc(c, x, y, ra, half, e);
    const ux = Math.cos(Math.PI / 2 + half), uy = Math.sin(Math.PI / 2 + half);
    for (const pass of [0, 1]) {
      c.strokeStyle = pass ? e.color : 'rgba(0,0,0,0.35)';
      c.lineWidth = pass ? 2 : 4;
      c.beginPath(); c.moveTo(x + ux * (ra - 3), y + uy * (ra - 3)); c.lineTo(x + ux * (ra + 3), y + uy * (ra + 3)); c.stroke();
    }
    if (lock) this.lockArc(c, x, y, rr, lock);
    if (label) this.targetLabel(c, e, x, y + rr + 20);
    c.restore();
  }

  /** Health as an arc around the bottom, in warm ink (red below 35%), over a faint empty track. */
  healthArc(c, x, y, ra, half, e) {
    const hp = Math.max(0, Math.min(1, e.ent.hp / e.maxHp));
    const a0 = Math.PI / 2 - half, a1 = Math.PI / 2 + half;
    c.strokeStyle = 'rgba(0,0,0,0.32)';
    c.lineWidth = 3.6;
    c.beginPath(); c.arc(x, y, ra, a0, a1); c.stroke();
    c.strokeStyle = `rgba(${INK},0.22)`;
    c.lineWidth = 1.6;
    c.beginPath(); c.arc(x, y, ra, a0, a1); c.stroke();
    if (hp > 0.01) {
      c.strokeStyle = hp > 0.35 ? `rgba(${INK},0.9)` : LOCK_RED;
      c.beginPath(); c.arc(x, y, ra, a1, a1 - 2 * half * hp, true); c.stroke();
    }
  }

  /** Lock-on: an arc closing from the top down both sides of the rim; once locked, the whole rim in warm red. */
  lockArc(c, x, y, r, lock) {
    const locked = !!lock.locked;
    const reach = locked ? Math.PI : Math.PI * Math.min(1, Math.max(0, lock.progress));
    if (reach < 0.02) return;
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = locked ? 4 : 3.4;
    c.beginPath(); c.arc(x, y, r, -Math.PI / 2 - reach, -Math.PI / 2 + reach); c.stroke();
    c.strokeStyle = LOCK_RED;
    c.lineWidth = locked ? 2.1 : 1.5;
    c.beginPath(); c.arc(x, y, r, -Math.PI / 2 - reach, -Math.PI / 2 + reach); c.stroke();
  }

  /** "Name  420 m": the name in 600 weight, the distance lighter and dimmer. */
  targetLabel(c, e, x, y) {
    const font = this.uiFont();
    const name = `${e.tag || ''}${e.ent.name}`, dist = `${Math.round(e.dist)} m`;
    c.font = `600 11px ${font}`;
    const wN = c.measureText(name).width;
    c.font = `400 10px ${font}`;
    const wD = c.measureText(dist).width;
    const x0 = x - (wN + 5 + wD) / 2;
    c.textAlign = 'left';
    c.lineJoin = 'round';
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.font = `600 11px ${font}`;
    c.strokeText(name, x0, y);
    c.fillStyle = `rgba(${INK},0.94)`;
    c.fillText(name, x0, y);
    c.font = `400 10px ${font}`;
    c.strokeText(dist, x0 + wN + 5, y);
    c.fillStyle = `rgba(${INK},0.62)`;
    c.fillText(dist, x0 + wN + 5, y);
    c.textAlign = 'center';
  }

  /** A dragon without a lens: a small caret above it, in its colour (allies smaller and quieter). */
  caret(c, x, y, e, alpha) {
    const k = e.ally ? 3 : 4.2;
    c.save();
    c.globalAlpha = alpha * (e.ally ? 0.7 : 0.95);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const pass of [0, 1]) {
      c.strokeStyle = pass ? e.color : 'rgba(0,0,0,0.45)';
      c.lineWidth = pass ? 1.6 : 3.6;
      c.beginPath();
      c.moveTo(x - k, y - k); c.lineTo(x, y); c.lineTo(x + k, y - k);
      c.stroke();
    }
    c.restore();
  }

  /** Incoming seekers: a red wedge on a ring around the reticle at each one's bearing, and the time to impact. */
  drawSeekerRing(c, s, nose, now) {
    if (!s.seekers.length || !nose || nose.behind) return;
    const R0 = Math.max(46, Math.min(70, Math.min(innerWidth, innerHeight) * 0.1)), x = nose.x, y = nose.y; // clear of a lens on the pipper
    c.save();
    c.strokeStyle = 'rgba(255,92,60,0.25)';
    c.lineWidth = 1;
    c.beginPath(); c.arc(x, y, R0, 0, Math.PI * 2); c.stroke();
    let soon = Infinity, soonA = 0;
    for (let i = 0; i < s.seekers.length; i++) {
      _v.copy(s.seekers[i]).applyMatrix4(s.camera.matrixWorldInverse);
      const a = Math.atan2(-_v.y, _v.x);
      const tti = s.seekerTti && s.seekerTti[i] !== undefined ? s.seekerTti[i] : Infinity;
      if (tti < soon) { soon = tti; soonA = a; }
      c.globalAlpha = 0.75 + 0.25 * Math.sin(now * (tti < 1.5 ? 24 : 12));
      c.beginPath();
      c.arc(x, y, R0 + 5, a - 0.27, a - 0.08);
      c.lineTo(x + Math.cos(a) * (R0 + 11), y + Math.sin(a) * (R0 + 11));
      c.arc(x, y, R0 + 5, a + 0.08, a + 0.27);
      c.arc(x, y, R0 - 1.5, a + 0.27, a - 0.27, true);
      c.closePath();
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(0,0,0,0.4)';
      c.stroke();
      c.fillStyle = LOCK_RED;
      c.fill();
    }
    if (soon < 60) {
      const tx = x + Math.cos(soonA) * (R0 + 24), ty = y + Math.sin(soonA) * (R0 + 24) + 4;
      const text = `${soon.toFixed(1)} s`;
      c.globalAlpha = 1;
      c.textAlign = 'center';
      c.font = `600 11px ${this.uiFont()}`;
      c.lineJoin = 'round';
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0,0,0,0.55)';
      c.strokeText(text, tx, ty);
      c.fillStyle = LOCK_RED;
      c.fillText(text, tx, ty);
    }
    c.restore();
  }

  uiFont() {
    if (!this._uiFont) this._uiFont = getComputedStyle(document.documentElement).getPropertyValue('--ui').trim() || FONT;
    return this._uiFont;
  }

  /** Arrow on an ellipse near the screen edge pointing at something out of view (urgent: incoming seekers). */
  edgeArrow(c, pos, camera, col, dist, urgent = false) {
    // direction in camera space
    _v.copy(pos).applyMatrix4(camera.matrixWorldInverse);
    const ang = Math.atan2(-_v.y, _v.x);
    const W = innerWidth, H = innerHeight;
    const rx = W / 2 - 48, ry = H / 2 - 48;
    const x = W / 2 + Math.cos(ang) * rx, y = H / 2 + Math.sin(ang) * ry;
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.globalAlpha = urgent ? 0.65 + Math.sin(performance.now() / 90) * 0.35 : Math.max(0.3, 0.9 - dist / 1800);
    const k = urgent ? 1.35 : 1;
    // an open chevron with a dark hairline under it so it reads on cloud and on sea
    for (const pass of [0, 1]) {
      c.strokeStyle = pass ? col : 'rgba(0,0,0,0.35)';
      c.lineWidth = pass ? 2 : 4;
      c.beginPath();
      c.moveTo(-5 * k, -8 * k); c.lineTo(5 * k, 0); c.lineTo(-5 * k, 8 * k);
      c.stroke();
    }
    c.restore();
  }

  /**
   * Radar: heading-up map of 1.2 km around you. Kept sparse: faint terrain, the arena edge, one range ring, the
   * view wedge, dragons as arrowheads (chevron above / below for big height differences), shrines and seekers.
   * Also wakes the HUD when a dragon is near.
   */
  drawRadar(s, now) {
    const g = this.rctx;
    const S = this.radarPx;
    if (!S) return;
    const R = 100;
    const range = RADAR_RANGE; // m from you to the radar's edge: most of the 1.65 km arena is in view
    const me = s.mePos;
    const heading = s.heading; // radians, 0 = -Z
    let nearest = Infinity;
    for (const e of s.radarDots) if (!e.ally) nearest = Math.min(nearest, Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z));
    if (nearest < NEAR || (s.lock && s.lock.ent) || s.seekers.length) this.wake();
    g.setTransform(S / 200, 0, 0, S / 200, 0, 0);
    g.clearRect(0, 0, 200, 200);
    g.save();
    g.beginPath();
    g.arc(R, R, R - 1, 0, Math.PI * 2);
    g.clip();
    g.translate(R, R);
    g.rotate(-heading);
    if (this.radarBg) {
      const half = WORLD.terrainHalf;
      const k = R / range;
      g.globalAlpha = 0.34;
      g.drawImage(this.radarBg, (-half - me.x) * k, (-half - me.z) * k, half * 2 * k, half * 2 * k);
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(255,106,76,0.6)';
      g.lineWidth = 1.2;
      g.setLineDash([4, 5]);
      g.beginPath();
      g.arc(-me.x * k, -me.z * k, WORLD.radius * k, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    // field of view wedge
    g.fillStyle = `rgba(${INK},0.07)`;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, R, -Math.PI / 2 - 0.85, -Math.PI / 2 + 0.85);
    g.closePath();
    g.fill();
    // one range ring at half range
    g.strokeStyle = `rgba(${INK},0.12)`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(0, 0, R / 2, 0, Math.PI * 2);
    g.stroke();
    // charged shrines: small amber plus marks
    for (const p of s.shrines || []) {
      const x = ((p.x - me.x) / range) * R, y = ((p.z - me.z) / range) * R;
      if (Math.hypot(x, y) > R - 8) continue;
      g.save();
      g.translate(x, y);
      g.rotate(heading);
      g.fillStyle = AMBER;
      g.globalAlpha = 0.7;
      g.fillRect(-0.75, -3.5, 1.5, 7);
      g.fillRect(-3.5, -0.75, 7, 1.5);
      g.restore();
    }
    // incoming seekers
    for (const sp of s.seekers) {
      const x = ((sp.x - me.x) / range) * R, y = ((sp.z - me.z) / range) * R;
      const l = Math.hypot(x, y);
      const k = l > R - 6 ? (R - 6) / l : 1;
      g.fillStyle = `rgba(255,80,50,${0.6 + Math.sin(now * 14) * 0.4})`;
      g.beginPath();
      g.arc(x * k, y * k, 3, 0, Math.PI * 2);
      g.fill();
    }
    for (const e of s.radarDots) {
      const dx = ((e.pos.x - me.x) / range) * R, dz = ((e.pos.z - me.z) / range) * R;
      let x = dx, y = dz;
      const l = Math.hypot(x, y);
      const edge = l > R - 8;
      if (edge) { x *= (R - 8) / l; y *= (R - 8) / l; }
      g.save();
      g.translate(x, y);
      g.rotate(e.heading);
      g.fillStyle = e.color;
      g.globalAlpha = edge ? 0.5 : 1;
      const sz = e.dy > 150 ? 5 : e.dy < -150 ? 3.4 : 4.2;
      g.beginPath();
      g.moveTo(0, -sz * 1.5); g.lineTo(sz, sz); g.lineTo(0, sz * 0.4); g.lineTo(-sz, sz); g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 1;
      g.stroke();
      if (e.bounty) { g.strokeStyle = `rgb(${INK})`; g.lineWidth = 1.2; g.stroke(); }
      g.rotate(-e.heading); // altitude chevrons stay upright on screen
      g.rotate(heading);
      if (Math.abs(e.dy) > 150) {
        g.fillStyle = e.color;
        g.beginPath();
        const up = e.dy > 0 ? -1 : 1;
        g.moveTo(sz + 3, up * 1); g.lineTo(sz + 7, up * 1); g.lineTo(sz + 5, up * -3.5); g.closePath();
        g.fill();
      }
      if (s.lock && s.lock.pos === e.pos) {
        g.strokeStyle = s.lock.locked ? RED : AMBER;
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(0, -9); g.lineTo(9, 0); g.lineTo(0, 9); g.lineTo(-9, 0); g.closePath();
        g.stroke();
      }
      g.restore();
    }
    // north rides the rim and stays upright
    g.save();
    g.translate(0, -(R - 11));
    g.rotate(heading);
    g.font = `600 11px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillText('N', 0.5, 1.5);
    g.fillStyle = RED;
    g.fillText('N', 0, 1);
    g.restore();
    g.restore();
    // cardinal ticks on the rim (fixed to the screen: the map turns inside) and you in the middle
    g.strokeStyle = `rgba(${INK},0.35)`;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      g.moveTo(R + Math.cos(a) * (R - 1), R + Math.sin(a) * (R - 1));
      g.lineTo(R + Math.cos(a) * (R - 6), R + Math.sin(a) * (R - 6));
    }
    g.stroke();
    g.fillStyle = `rgb(${INK})`;
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.beginPath();
    g.moveTo(R, R - 8); g.lineTo(R + 5.5, R + 6); g.lineTo(R, R + 3); g.lineTo(R - 5.5, R + 6); g.closePath();
    g.fill();
    g.stroke();
  }

  // info: { mode: 'ffa' | 'tdm', teams: [goldKills, crimsonKills], result: { winner } }
  scoreboard(show, ents, meId, info = {}) {
    show = show || this.forceScores;
    if (show !== this.sbShown) {
      this.sbShown = show;
      $('scoreboard').classList.toggle('hidden', !show);
      if (show && this.audio) this.audio.ui('open');
      if (!show) this.scoreKey = '';
    }
    if (!show) return;
    const rows = [...ents.values()].sort((a, b) => b.score - a.score || b.kills - a.kills);
    const key = rows.map((e) => `${e.id}:${e.score}:${e.kills}:${e.deaths}:${e.team}:${e.bounty}`).join('|') + meId + info.mode + (info.teams || []).join();
    if (key === this.scoreKey) return;
    this.scoreKey = key;
    renderScoreboard($('sb-body'), $('sb-sub'), rows, meId, info);
  }

  results(show, board, meId, nextIn, info = {}) {
    this.results_.update(show, board, meId, nextIn, this.stats, this.audio, info);
  }
}
