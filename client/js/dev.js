// Dev mode: F2 (or ?dev=1) opens a small panel with difficulty and cheat toggles for offline practice.
// The settings go straight onto the in-browser room (room.dev, see shared/room.js) and onto your own dragon.
// Online rooms run on the server, so nothing here reaches them. Saved in localStorage (da.dev).
import { store } from './ui-util.js';

const SKILLS = { easy: 0.05, normal: null, hard: 0.85, ace: 1 };
// off until you open the panel once (F2 or ?dev=1); then endless stamina and invisibility are on by default
const DEFAULTS = { on: false, skill: 'normal', bots: 8, ghost: true, holdFire: false, god: false, free: true };

let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(store.get('da.dev', '{}')) }; } catch {}

const hooks = () => window.__dragonAces || {};
const rooms = () => {
  const conn = hooks().conn;
  return conn && conn.hub ? [...conn.hub.rooms.values()] : [];
};
const active = () => cfg.on;

function apply() {
  for (const r of rooms()) {
    if (!cfg.on) Object.assign(r.dev, { skill: null, bots: null, ghost: false, holdFire: false, god: false, free: false });
    else Object.assign(r.dev, { skill: SKILLS[cfg.skill], bots: cfg.bots, ghost: cfg.ghost, holdFire: cfg.holdFire, god: cfg.god, free: cfg.free });
    if (cfg.free) for (const e of r.ents.values()) if (!e.isBot) e.abilReady = 0;
  }
  badge.classList.toggle('hidden', !active());
  note.textContent = hooks().conn && !hooks().conn.hub && hooks().game ? 'Online sky: these only work in Practice vs Bots.' : '';
}

// your own dragon: no heat, full stamina, cooldowns ready (the room's side is room.dev.free)
function tick() {
  const g = hooks().game;
  if (cfg.on && cfg.free && g && rooms().length) {
    g.heat = 0;
    g.overheated = false;
    g.seekerCd = 0;
    g.abilCd = 0;
    if (g.fs) g.fs.stamina = 1;
  }
  requestAnimationFrame(tick);
}

const css = `
#dev-panel{position:fixed;top:12px;right:12px;z-index:9999;width:260px;padding:12px 14px;border-radius:10px;
  background:rgba(12,10,8,.92);border:1px solid rgba(255,190,90,.45);color:#f3e6d0;font:13px/1.35 system-ui,sans-serif;
  box-shadow:0 8px 30px rgba(0,0,0,.5)}
#dev-panel h4{margin:0 0 8px;font-size:13px;letter-spacing:.12em;color:#ffc247}
#dev-panel label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;cursor:pointer}
#dev-panel select,#dev-panel input[type=range]{width:120px}
#dev-panel .row{display:flex;gap:6px;margin-top:10px}
#dev-panel button{flex:1;padding:5px;border-radius:6px;border:1px solid rgba(255,190,90,.4);background:#2a2118;color:#f3e6d0;cursor:pointer}
#dev-panel small{display:block;margin-top:8px;color:#b9a88c}
#dev-badge{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9998;padding:2px 8px;border-radius:5px;
  background:#ffc247;color:#1a1208;font:700 11px system-ui,sans-serif;letter-spacing:.1em;pointer-events:none}
#dev-panel.hidden,#dev-badge.hidden{display:none}`;

const panel = document.createElement('div');
panel.id = 'dev-panel';
panel.className = 'hidden';
panel.innerHTML = `<h4>DEV MODE</h4>
  <label><b>Dev mode on</b> <input data-k="on" type="checkbox"></label>
  <label>Bot difficulty <select data-k="skill"><option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option><option value="ace">Ace</option></select></label>
  <label>Dragons in sky <span><input data-k="bots" type="range" min="1" max="20" step="1"> <b data-out="bots"></b></span></label>
  <label>Invisible to bots <input data-k="ghost" type="checkbox"></label>
  <label>Bots hold fire <input data-k="holdFire" type="checkbox"></label>
  <label>God mode (no damage) <input data-k="god" type="checkbox"></label>
  <label>No heat, stamina or cooldowns <input data-k="free" type="checkbox"></label>
  <div class="row"><button data-act="reset" type="button">Reset</button><button data-act="close" type="button">Close (F2)</button></div>
  <small>Practice vs Bots only. Changes apply at once.</small><small class="note"></small>`;
const badge = document.createElement('div');
badge.id = 'dev-badge';
badge.className = 'hidden';
badge.textContent = 'DEV';
const note = panel.querySelector('.note');

function paint() {
  for (const el of panel.querySelectorAll('[data-k]')) {
    if (el.type === 'checkbox') el.checked = !!cfg[el.dataset.k];
    else el.value = String(cfg[el.dataset.k]);
  }
  panel.querySelector('[data-out="bots"]').textContent = cfg.bots;
}

function save() {
  store.set('da.dev', JSON.stringify(cfg));
  paint();
  apply();
}

export function toggleDevPanel(show = panel.classList.contains('hidden')) {
  panel.classList.toggle('hidden', !show);
  if (show && document.exitPointerLock) document.exitPointerLock();
  if (show && !cfg.on) { cfg.on = true; save(); } // opening the panel switches dev mode on
  apply();
}

export function initDev() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.append(panel, badge);
  panel.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    cfg[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? Number(e.target.value) : e.target.value;
    save();
  });
  panel.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'reset') { cfg = { ...DEFAULTS, on: true }; save(); }
    if (act === 'close') toggleDevPanel(false);
  });
  // keep the panel's keys and clicks away from the flight controls
  for (const ev of ['keydown', 'mousedown', 'pointerdown', 'wheel']) panel.addEventListener(ev, (e) => e.stopPropagation());
  addEventListener('keydown', (e) => {
    if (e.code === 'F2' || (e.code === 'Backquote' && !e.repeat)) {
      e.preventDefault();
      toggleDevPanel();
    }
  });
  paint();
  if (/[?&]dev=1/.test(location.search)) toggleDevPanel(true);
  setInterval(apply, 300); // new rooms (each practice battle) pick the settings up within a moment
  requestAnimationFrame(tick);
}
