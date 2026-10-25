// Title-screen widgets that need no 3D: the breed picker, how-to / settings / credits modals, loading tips and the
// interface sounds. main.js wires these to the showcase and to starting a battle.
import { ABILITIES, BREEDS, BREED_IDS } from '../../shared/constants.js';
import { $, BREED_TINT, breedTint, store } from './ui-util.js';
import { dragonModelChoice } from './render/dragon.js';
import { lensPref } from './render/lens.js';

const STAT_MAX = { hp: 125, speed: 1.09, turn: 1.12, fbDamage: 23, breathDps: 76 };

export const TIPS = [
  ['Flight tip', 'Dive to build speed, then climb to trade it for height. Below about 110 km/h your dragon stalls.'],
  ['Flight tip', 'Shoot at the gold lead marker, not at the dragon. Fireballs take time to arrive.'],
  ['Combat tip', 'Hold your aim on a dragon for a second to lock a seeker, then press F.', 'Hold your aim on a dragon for a second to lock a seeker, then tap Seek.'],
  ['Combat tip', 'A barrel roll at close range shakes off an incoming seeker. Watch for the red warning.'],
  ['Survival', 'Fly through the glowing orb above a sky island to heal 40 HP. It recharges in 25 seconds.'],
  ['Survival', 'Clouds hide you from radar and locks. Duck into one when you are outgunned.'],
  ['Breath', 'Flame breath is brutal up close but burns heat fast. At 100 heat you cannot fire until it cools.'],
  ['Breeds', 'Frost Wyrms shrug off hits, Storm Wyverns outrun everything and Venom Serpents melt anything in breath range.'],
  ['Matches', 'A battle lasts eight minutes, or until a dragon reaches fifteen kills (a team, twenty). A kill scores 100 and an assist 50.'],
  ['Sky lore', 'A dragon that crashes within ten seconds of being hit still counts as your kill.'],
];

/** Cycles tips in the loading overlay. */
export class Tips {
  constructor() {
    this.i = Math.floor(Math.random() * TIPS.length);
    this.timer = null;
  }

  show() {
    const [head, body, touchBody] = TIPS[this.i % TIPS.length];
    $('tip-head').textContent = head;
    $('tip-text').textContent = touchBody && matchMedia('(pointer: coarse)').matches ? touchBody : body;
  }

  start() {
    this.show();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const el = document.querySelector('.loading .tip');
      el.classList.add('out');
      setTimeout(() => {
        this.i++;
        this.show();
        el.classList.remove('out');
      }, 420);
    }, 4600);
  }

  stop() {
    clearInterval(this.timer);
  }
}

// One line per signature ability; the full text lives in shared ABILITIES and How to play.
const ABIL_LINE = {
  ember: 'a napalm wake that burns pursuers',
  frost: 'a freezing shockwave, then armour',
  storm: 'a bolt that arcs from foe to foe',
  venom: 'a lingering cloud of acid ahead',
};

let current = null;

/** The breed picker: prev / next arrows and one dot per breed (a radiogroup). The showcase dragon is the picture. */
export function renderBreeds(onPick, initial) {
  current = initial;
  const wrap = $('breeds');
  wrap.innerHTML = BREED_IDS.map((id, i) =>
    `<button class="bdot" type="button" role="radio" aria-checked="false" aria-label="${BREEDS[id].name} (${i + 1})" data-id="${id}" style="--c:${BREED_TINT[id]}"><i></i></button>`).join('');
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.bdot');
    if (btn) onPick(btn.dataset.id);
  });
  const step = (d) => onPick(BREED_IDS[(BREED_IDS.indexOf(current) + d + BREED_IDS.length) % BREED_IDS.length]);
  $('breed-prev').onclick = () => step(-1);
  $('breed-next').onclick = () => step(1);
  // left / right arrows cycle breeds anywhere on the title screen (1-4 are handled in main.js)
  addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if ($('menu').classList.contains('hidden') || overlayOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const inDots = t && t.closest && t.closest('#breeds');
    step(e.key === 'ArrowRight' ? 1 : -1);
    if (inDots) wrap.querySelector(`[data-id="${current}"]`).focus();
    e.preventDefault();
  });
}

export function showBreed(id) {
  const b = BREEDS[id];
  const a = ABILITIES[id];
  const changed = id !== current;
  current = id;
  for (const el of document.querySelectorAll('.bdot')) {
    const on = el.dataset.id === id;
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.tabIndex = on ? 0 : -1;
  }
  const pick = $('breed-pick');
  pick.style.setProperty('--c', breedTint(id));
  $('breed-name').textContent = b.name;
  $('breed-blurb').textContent = b.blurb;
  $('breed-abil').textContent = a ? a.name : '';
  $('breed-abil-text').textContent = ABIL_LINE[id] || '';
  const rows = [
    ['Hide', b.hp / STAT_MAX.hp], ['Speed', (b.speed - 0.6) / (STAT_MAX.speed - 0.6)], ['Agility', (b.turn - 0.6) / (STAT_MAX.turn - 0.6)],
    ['Fireball', b.fbDamage / STAT_MAX.fbDamage], ['Breath', b.breathDps / STAT_MAX.breathDps],
  ];
  const grid = $('breed-stats');
  if (!grid.children.length) grid.innerHTML = rows.map(([k]) => `<div><dt>${k}</dt><dd><i style="--v:0"></i></dd></div>`).join('');
  const bars = grid.querySelectorAll('dd i');
  rows.forEach(([, v], i) => bars[i].style.setProperty('--v', String(Math.max(0.08, Math.min(1, v)))));
  // replay the caption's entrance on a change
  if (changed) {
    pick.classList.remove('swap');
    void pick.offsetWidth;
    pick.classList.add('swap');
  }
}

// ------------------------------------------------------------------ modals
let lastFocus = null;
export function openModal(name, audio) {
  const m = $('modal');
  for (const p of m.querySelectorAll('.pane')) p.classList.toggle('hidden', p.id !== `m-${name}`);
  const title = m.querySelector(`#m-${name} h2`);
  if (title) m.setAttribute('aria-label', title.textContent);
  m.classList.remove('hidden');
  lastFocus = document.activeElement;
  // focus the card, not the close button: a focus ring on X made it the loudest thing on the card
  const card = m.querySelector('.modal-card');
  card.scrollTop = 0;
  card.focus({ preventScroll: true });
  if (audio) audio.ui('open');
  // touch devices get touch wording: [data-touch] holds the touch text, the original markup is kept to swap back
  const touch = matchMedia('(pointer: coarse)').matches;
  m.classList.toggle('touch-copy', touch);
  for (const el of m.querySelectorAll('[data-touch]')) {
    if (el.dataset.desk === undefined) el.dataset.desk = el.innerHTML;
    if (touch) el.textContent = el.dataset.touch;
    else el.innerHTML = el.dataset.desk;
  }
  if (name === 'howto') {
    $('keys-desktop').classList.toggle('hidden', touch);
    $('keys-touch').classList.toggle('hidden', !touch);
  }
}

export function closeModal(audio) {
  const m = $('modal');
  if (m.classList.contains('hidden')) return false;
  m.classList.add('hidden');
  if (audio) audio.ui('close');
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  return true;
}

export const modalOpen = () => !$('modal').classList.contains('hidden');

// ------------------------------------------------------------------ "More ways to fly" sheet
// Private sky, joining a friend's code and the battle type, kept off the title screen until asked for.
let sheetFocus = null;
export const sheetOpen = () => !$('more').classList.contains('hidden');
/** Any title-screen overlay (modal or sheet) is up: the breed keys and Enter stand down. */
export const overlayOpen = () => modalOpen() || sheetOpen();

export function openSheet(audio, focusCode = false) {
  const m = $('more');
  if (!m.classList.contains('hidden')) return;
  m.classList.remove('hidden');
  $('btn-more').setAttribute('aria-expanded', 'true');
  sheetFocus = document.activeElement;
  const el = focusCode ? $('code') : m.querySelector('.sheet-card');
  el.focus({ preventScroll: true });
  if (audio) audio.ui('open');
}

export function closeSheet(audio) {
  const m = $('more');
  if (m.classList.contains('hidden')) return false;
  m.classList.add('hidden');
  $('btn-more').setAttribute('aria-expanded', 'false');
  if (audio) audio.ui('close');
  if (sheetFocus && sheetFocus.focus && document.contains(sheetFocus)) sheetFocus.focus({ preventScroll: true });
  sheetFocus = null;
  return true;
}

export function initSheet(audio) {
  $('btn-more').onclick = () => (sheetOpen() ? closeSheet(audio) : openSheet(audio));
  $('more-x').onclick = () => closeSheet(audio);
  $('more').addEventListener('pointerdown', (e) => {
    if (e.target === $('more')) closeSheet(audio);
  });
}

export function initModals(audio) {
  $('modal-x').onclick = () => closeModal(audio);
  $('modal').addEventListener('pointerdown', (e) => {
    if (e.target === $('modal')) closeModal(audio);
  });
  addEventListener('keydown', (e) => {
    // one Escape closes the top overlay only: a modal, else the sheet
    if (e.key !== 'Escape') return;
    if (modalOpen()) closeModal(audio);
    else if (sheetOpen()) closeSheet(audio);
    else return;
    e.stopPropagation();
  }, true);
}

// ------------------------------------------------------------------ settings
function bindRange(id, value, fmt, apply) {
  const el = $(id);
  const out = el.parentElement.querySelector('output');
  const paint = () => {
    const f = (Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min));
    el.style.setProperty('--fill', `${Math.round(f * 100)}%`);
    out.textContent = fmt(Number(el.value));
  };
  el.value = value;
  paint();
  el.addEventListener('input', () => {
    paint();
    apply(Number(el.value));
  });
}

/** The floating embers are gone from the title screen; kept as a no-op so callers need not change. */
export function initEmbers() {}

export function initSettings({ audio, input, w3, hud }) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  bindRange('set-vol', audio.volume, pct, (v) => audio.setVolume(v));
  bindRange('set-music', audio.musicVolume, pct, (v) => audio.setMusicVolume(v));
  bindRange('set-sfx', audio.sfxVolume, pct, (v) => audio.setSfxVolume(v));
  bindRange('set-amb', audio.ambienceVolume, pct, (v) => audio.setAmbienceVolume(v));
  bindRange('set-sens', input.sensitivity, (v) => v.toFixed(2), (v) => { input.sensitivity = v; store.set('da.sens', String(v)); });
  const q = $('set-q'), inv = $('set-inv'), hints = $('set-hints');
  q.value = String(w3.quality);
  inv.checked = input.invertY;
  hints.checked = hud.hintsOn;
  q.onchange = () => { w3.setQuality(Number(q.value)); store.set('da.quality', q.value); };
  // the dragon is built once at load, so switching model reloads the page (dropping any ?dragon= override)
  const dm = $('set-dragon');
  dm.value = dragonModelChoice();
  dm.onchange = () => {
    store.set('da.dragon', dm.value);
    const u = new URL(location.href);
    u.searchParams.delete('dragon');
    location.href = u.toString();
  };
  inv.onchange = () => { input.invertY = inv.checked; store.set('da.invert', inv.checked ? '1' : '0'); audio.ui('toggle'); };
  hints.onchange = () => { hud.setHints(hints.checked); store.set('da.hints', hints.checked ? '1' : '0'); audio.ui('toggle'); };
  // target lenses (render/lens.js); off falls back to small markers (also ?lens=0)
  const lens = $('set-lens');
  if (lens) {
    lens.checked = lensPref.on;
    lens.onchange = () => { lensPref.on = lens.checked; store.set('da.lens', lens.checked ? '1' : '0'); audio.ui('toggle'); };
  }
  const fs = $('btn-fs');
  const root = document.documentElement;
  // iPhone Safari has no element full screen (only video), so the button would do nothing there
  const iPhone = /iPhone|iPod/.test(navigator.userAgent);
  if (iPhone || !(root.requestFullscreen || root.webkitRequestFullscreen)) fs.classList.add('hidden');
  fs.onclick = () => {
    const on = document.fullscreenElement || document.webkitFullscreenElement;
    if (on) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
  };
  // a short blip when a volume slider is released, so you can judge the level
  for (const id of ['set-sfx', 'set-vol', 'set-amb']) $(id).addEventListener('change', () => audio.ui('confirm'));
}

// ------------------------------------------------------------------ interface sounds
export function initUiSounds(audio) {
  const SEL = '.mbtn, .lbtn, .bdot, .arrow, .modal-x, .srow, #btn-join';
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest && e.target.closest(SEL);
    if (!el || el.disabled || (e.relatedTarget && el.contains(e.relatedTarget))) return;
    if (e.pointerType === 'mouse') audio.ui('hover');
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest(SEL);
    if (!el || el.disabled) return;
    if (el.classList.contains('bdot') || el.classList.contains('arrow') || el.classList.contains('modal-x') || el.id === 'btn-more') return; // these play their own sounds
    audio.ui(el.classList.contains('primary') ? 'confirm' : el.id === 'btn-leave' ? 'back' : 'click');
  });
}
