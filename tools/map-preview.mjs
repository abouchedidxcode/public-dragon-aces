#!/usr/bin/env node
// Top-down shaded-relief PNG of the world, with the battle radius, castle site, landmarks, stacks, sky islands,
// rock arches and waterfalls marked. No GPU needed; handy for laying out the map.
//   node tools/map-preview.mjs out.png [metresPerPixel=6] [half=3300]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createWorld } from '../shared/world.js';
import { WORLD } from '../shared/constants.js';

const out = process.argv[2] || 'map.png';
const mpp = Number(process.argv[3]) || 6;
const half = Number(process.argv[4]) || 3300;
const N = Math.round((half * 2) / mpp);
const world = createWorld();
const t0 = performance.now();
const H = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = world.height(-half + i * mpp, -half + j * mpp);
console.error('heights', Math.round(performance.now() - t0), 'ms');

const rgba = new Uint8Array(N * N * 4);
const sun = [-0.55, 0.65, -0.5];
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const h = H[j * N + i];
    const hx = (H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)]) / (2 * mpp);
    const hz = (H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i]) / (2 * mpp);
    const l = Math.hypot(hx, 1, hz);
    const lit = Math.max(0.05, ((-hx * 2.2) * sun[0] + sun[1] + (-hz * 2.2) * sun[2]) / Math.hypot(hx * 2.2, 1, hz * 2.2));
    let c;
    if (h < 0) { const d = Math.min(1, -h / 120); c = [20 - d * 10, 80 - d * 40, 110 - d * 40]; }
    else if (h < 14) c = [200, 190, 140];
    else {
      const t = Math.min(1, h / 1000);
      c = h > 800 ? [235, 238, 245] : [60 + t * 120, 110 + t * 40 - t * t * 40, 55 + t * 100];
      const steep = Math.min(1, Math.hypot(hx, hz) * 1.5);
      c = c.map((v, k) => v * (1 - steep * 0.45) + [120, 110, 100][k] * steep * 0.45);
    }
    const k = (j * N + i) * 4;
    for (let q = 0; q < 3; q++) rgba[k + q] = Math.max(0, Math.min(255, c[q] * (0.2 + 1.1 * lit) * (h > 0 && Math.abs(((h % 100) + 100) % 100 - 50) > 48.5 ? 0.8 : 1)));
    rgba[k + 3] = 255;
  }
}
const px = (x, z, col) => {
  const i = Math.round((x + half) / mpp), j = Math.round((z + half) / mpp);
  if (i < 0 || j < 0 || i >= N || j >= N) return;
  const k = (j * N + i) * 4;
  rgba[k] = col[0]; rgba[k + 1] = col[1]; rgba[k + 2] = col[2];
};
const disc = (x, z, r, col) => { for (let a = 0; a < r * 1.2 + 4; a++) { const t = (a / (r * 1.2 + 4)) * Math.PI * 2; px(x + Math.cos(t) * r, z + Math.sin(t) * r, col); } };
const dot = (x, z, rad, col) => { for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) px(x + dx * mpp, z + dz * mpp, col); };
for (let a = 0; a < 6000; a++) {
  const t = (a / 6000) * Math.PI * 2;
  px(Math.cos(t) * WORLD.radius, Math.sin(t) * WORLD.radius, [0, 255, 0]);
  px(Math.cos(t) * (WORLD.radius + 600), Math.sin(t) * (WORLD.radius + 600), [0, 120, 0]);
  px(Math.cos(t) * world.castleSite.radius, Math.sin(t) * world.castleSite.radius, [255, 0, 255]);
  px(Math.cos(t) * 900, Math.sin(t) * 900, [160, 0, 160]);
}
for (const s of world.sites) { dot(s.x, s.z, 3, s.kind === 'fort' ? [255, 60, 40] : s.kind === 'temple' ? [255, 160, 30] : s.kind === 'bones' ? [255, 255, 255] : [255, 220, 0]); disc(s.x, s.z, s.r, [255, 255, 255]); }
for (const s of world.stacks) dot(s.x, s.z, 1, s.arch ? [0, 255, 255] : [255, 255, 0]);
for (const s of world.sky) { disc(s.x, s.z, s.r, [255, 255, 255]); dot(s.x, s.z, 1, [255, 255, 255]); }
for (const a of world.arches) { dot(a.x, a.z, 2, [0, 255, 255]); for (let q = -a.R; q <= a.R; q += mpp) px(a.x - Math.sin(a.yaw) * q, a.z + Math.cos(a.yaw) * q, [0, 255, 255]); }
for (const w of world.waterfalls) dot(w.x, w.z, 3, [60, 120, 255]);

const crc = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return (b) => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let j = 0; j < N; j++) { raw[j * (N * 4 + 1)] = 0; Buffer.from(rgba.buffer, j * N * 4, N * 4).copy(raw, j * (N * 4 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.error('sites', world.sites.map((s) => `${s.kind}@${Math.round(Math.hypot(s.x, s.z))}m h${s.y}`).join(' '));
console.error('stacks', world.stacks.length, 'sky', world.sky.map((s) => `${s.r}@${Math.round(Math.hypot(s.x, s.z))}m y${Math.round(s.y)}`).join(' '));
console.error('arches', world.arches.map((a) => `${a.kind}@${Math.round(Math.hypot(a.x, a.z))}m y${a.y}`).join(' '), 'falls', world.waterfalls.map((w) => w.y).join(','));
