// DRAGON ACES entry point: loads the world, runs the title screen (a showcase dragon over the island) and
// starts battles online (Durable Object room server) or offline (the same room code in the page).
import { BREED_IDS, WORLD } from '../../shared/constants.js';
import { createWorld } from '../../shared/world.js';
import { World3D } from './render/scene.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Hud } from './hud.js';
import { Connection } from './net.js';
import { Game } from './game.js';
import { Showcase } from './ui-showcase.js';
import { Tips, closeModal, closeSheet, initEmbers, initModals, initSettings, initSheet, initUiSounds, openModal, openSheet, overlayOpen, renderBreeds, showBreed } from './ui-menu.js';
import { $, store } from './ui-util.js';
import { initDev } from './dev.js';

const canvas = $('gl');
const w3 = new World3D(canvas);
const world = createWorld(WORLD.seed);
const input = new Input(canvas);
const audio = new Audio();
const hud = new Hud();
hud.audio = audio;
const tips = new Tips();
// the on-screen controls belong to battles only
const touchUI = (on) => input.isTouch && $('touch').classList.toggle('hidden', !on);
touchUI(false);
let game = null;
let conn = null;
let breed = BREED_IDS.includes(store.get('da.breed', '')) ? store.get('da.breed', '') : 'ember';
let showcase = null;
let musicWant = null;

// ------------------------------------------------------------------ boot
async function boot() {
  const fill = $('load-fill'), text = $('load-text');
  tips.start();
  audio.preload();
  // browsers only allow sound after a gesture: the first click or key starts the music
  const unlock = () => {
    audio.start();
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) removeEventListener(ev, unlock, true);
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) addEventListener(ev, unlock, true);
  try {
    await w3.load('assets/', (label, p) => {
      fill.style.width = `${Math.round(p * 100)}%`;
      text.textContent = label;
    });
  } catch (err) {
    console.error(err);
    text.textContent = 'Your browser could not start WebGL 2. Try a recent Chrome, Edge, Firefox or Safari.';
    return;
  }
  w3.addSkyIslands(world);
  const forcedQ = new URLSearchParams(location.search).get('q');
  w3.setQuality(Number(forcedQ ?? store.get('da.quality', '1')));
  await w3.terrainReady;
  hud.buildRadarMap(w3.terrainData.data, w3.terrainData.n);
  fill.style.width = '100%';
  text.textContent = 'Ready';
  buildMenu();
  showMenu();
  hideSplash();
  requestAnimationFrame(loop);
}

// the loading overlay doubles as the "entering the sky" transition
function showSplash(msg) {
  const l = $('loading');
  l.classList.remove('hidden');
  void l.offsetWidth;
  l.classList.remove('fade');
  $('load-text').textContent = msg;
  $('load-fill').style.width = '100%';
  tips.start();
}

function hideSplash() {
  const l = $('loading');
  l.classList.add('fade');
  tips.stop();
  setTimeout(() => l.classList.contains('fade') && l.classList.add('hidden'), 750);
}

// ------------------------------------------------------------------ menu
function buildMenu() {
  const name = $('name');
  name.value = store.get('da.name', '') || `Rider${Math.floor(100 + Math.random() * 900)}`;
  name.addEventListener('change', () => store.set('da.name', name.value.trim()));
  name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
  renderBreeds((id) => selectBreed(id, true), breed);
  selectBreed(breed, false);
  $('btn-quick').onclick = () => play({ mode: 'quick' });
  $('btn-create').onclick = () => play({ mode: 'create' });
  $('btn-join').onclick = () => play({ mode: 'code', code: $('code').value });
  $('code').addEventListener('keydown', (e) => e.key === 'Enter' && play({ mode: 'code', code: $('code').value }));
  $('code').addEventListener('input', () => ($('code').value = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  $('set-mode').value = store.get('da.mode', 'ffa');
  $('set-mode').onchange = () => store.set('da.mode', $('set-mode').value);
  $('btn-offline').onclick = () => play({ mode: 'offline' });
  $('btn-resume').onclick = () => resume();
  $('btn-leave').onclick = () => leave();
  $('btn-invite').onclick = async () => {
    if (!game) return;
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', game.code);
    const label = $('btn-invite').querySelector('b');
    try {
      await navigator.clipboard.writeText(url.href);
      label.textContent = 'Link copied!';
    } catch {
      label.textContent = url.href;
    }
    setTimeout(() => (label.textContent = 'Copy invite link'), 2500);
  };
  // modals and settings
  initEmbers();
  initModals(audio);
  initSheet(audio);
  initSettings({ audio, input, w3, hud });
  initUiSounds(audio);
  const open = (name) => openModal(name, audio);
  $('btn-howto').onclick = () => open('howto');
  $('btn-settings').onclick = () => open('settings');
  $('btn-credits').onclick = () => open('credits');
  $('btn-pause-settings').onclick = () => open('settings');
  $('btn-pause-howto').onclick = () => open('howto');
  // keyboard: 1-4 pick a dragon, Enter launches a quick battle
  addEventListener('keydown', (e) => {
    if (game || $('menu').classList.contains('hidden') || overlayOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= BREED_IDS.length) selectBreed(BREED_IDS[n - 1], true);
    else if (e.key === 'Enter' && e.target === document.body) play({ mode: 'quick' });
  });
  // invite links: ?room=CODE
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    // an invite link: open the sheet with the friend's code filled in, ready to join
    $('code').value = room.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    openSheet(null);
  }
  input.onLockChange = (locked) => {
    if (!locked && game && !game.paused && !input.isTouch) pause();
  };
}

function selectBreed(id, user = false) {
  const changed = id !== breed;
  breed = id;
  store.set('da.breed', id);
  showBreed(id);
  if (showcase) showcase.setBreed(id, user && changed);
  if (user && changed) audio.ui('pick');
  if (game && game.me) {
    game.conn.send({ t: 'breed', breed: id });
  }
}

function showMenu() {
  $('menu').classList.remove('hidden');
  if (!showcase) showcase = new Showcase(w3, breed, audio, world);
  showcase.show();
}

function hideMenu() {
  closeSheet();
  $('menu').classList.add('hidden');
  if (showcase) showcase.hide();
}

const PLAY_BUTTONS = '#menu .play button, #more button';
async function play(opts) {
  audio.start();
  const err = $('menu-error');
  err.textContent = '';
  const name = $('name').value.trim() || 'Rider';
  store.set('da.name', name);
  closeSheet();
  for (const b of document.querySelectorAll(PLAY_BUTTONS)) b.disabled = true;
  showSplash(opts.mode === 'offline' ? 'Rousing the bots' : 'Finding a sky');
  // messages that arrive between the welcome and the Game being built are queued, then replayed
  const early = [];
  conn = new Connection({
    onMessage: (m) => (game ? game.onMessage(m) : early.push(['m', m])),
    onSnapshot: (s) => (game ? game.onSnapshot(s) : early.push(['s', s])),
    onClose: () => {
      if (game) {
        leave();
        $('menu-error').textContent = 'Lost connection to the battle.';
      }
    },
  });
  try {
    const join = { name, breed, gm: $('set-mode') ? $('set-mode').value : 'ffa' };
    const welcome = opts.mode === 'offline' ? await conn.connectOffline(join) : await conn.connectOnline({ ...join, mode: opts.mode, code: opts.code });
    game = new Game({ world3d: w3, world, audio, input, hud, conn, welcome });
    game.onPause = () => pause();
    for (const [kind, m] of early.splice(0)) {
      if (m.t === 'welcome') continue;
      if (kind === 'm') game.onMessage(m);
      else game.onSnapshot(m);
    }
    input.enabled = true;
    touchUI(true);
    hideMenu();
    if (!welcome.isPublic && !conn.local) {
      const url = new URL(location.href);
      url.searchParams.set('room', welcome.code);
      history.replaceState(null, '', url);
    }
    input.lock();
  } catch (e) {
    err.textContent = e.message || String(e);
    if (opts.mode !== 'offline') err.textContent += ' You can still practice offline against bots.';
    audio.ui('error');
    conn.close();
    conn = null;
  } finally {
    for (const b of document.querySelectorAll(PLAY_BUTTONS)) b.disabled = false;
    hideSplash();
  }
}

function pause() {
  if (!game) return;
  game.paused = true;
  $('pause').classList.remove('hidden');
  $('btn-invite').classList.toggle('hidden', game.isPublic || !!game.conn.local);
  audio.setMuffled(true);
  input.unlock();
}

function resume() {
  if (!game) return;
  game.paused = false;
  closeModal();
  $('pause').classList.add('hidden');
  audio.setMuffled(false);
  input.lock();
}

function leave() {
  closeModal();
  $('pause').classList.add('hidden');
  audio.setMuffled(false);
  if (game) game.dispose();
  game = null;
  if (conn) conn.close();
  conn = null;
  input.enabled = false;
  touchUI(false);
  input.unlock();
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  showMenu();
}

// ------------------------------------------------------------------ loop
let last = performance.now();
let elapsed = 0;
let slowFrames = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (window.__dragonAces.busy) {
    last = now;
    return;
  }
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;
  window.__dragonAces.frames++;
  if (game) game.update(dt);
  else if (showcase) showcase.update(dt);
  // music follows the match: menu theme, battle bed, results sting
  const want = game ? (game.match.phase === 'results' ? 'results' : 'battle') : 'menu';
  if (want !== musicWant) {
    musicWant = want;
    audio.music(want);
  }
  w3.update(dt, elapsed);
  w3.updateGlare(world);
  w3.render();
  // automatic quality drop if the machine struggles badly
  if (dt > 0.045) slowFrames++;
  else slowFrames = Math.max(0, slowFrames - 1);
  if (slowFrames > 120 && w3.quality > 0) {
    slowFrames = 0;
    w3.setQuality(w3.quality - 1);
    $('set-q').value = String(w3.quality);
  }
}

// handle for automated browser tests
window.__dragonAces = {
  w3, input, play, audio, hud, frames: 0,
  get game() { return game; },
  get conn() { return conn; },
  get showcase() { return showcase; },
  // advance the simulation without rendering (tests on slow software GL)
  async simulate(secs, step = 1 / 30) {
    this.busy = true;
    for (let t = 0; t < secs; t += step) {
      // offline: move the local room's clock forward too, then let its messages arrive
      if (conn && conn.hub) for (const r of conn.hub.rooms.values()) { r.t0 -= step * 1000; r.update(); }
      await new Promise((r) => setTimeout(r, 0));
      elapsed += step;
      if (game) game.update(step);
      else if (showcase) showcase.update(step);
      w3.update(step, elapsed);
    }
    this.busy = false;
  },
};

initDev(); // F2 or ?dev=1: difficulty and cheat toggles for offline practice
boot();
