// Small helpers shared by the HUD and the menu modules.
import { BREED_LOOK } from './render/dragon.js';

export const hex = (n) => '#' + n.toString(16).padStart(6, '0');
export const breedColor = (b) => hex(BREED_LOOK[b] ? BREED_LOOK[b].eye : 0xffffff);
// Muted per-breed tints for menus and tables (the eye colours above are too saturated for interface text).
export const BREED_TINT = { ember: '#e6a35a', frost: '#9ec8d4', storm: '#b6a4dc', venom: '#b9c66e' };
export const breedTint = (b) => BREED_TINT[b] || breedColor(b);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (id) => document.getElementById(id);

export const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
