#!/usr/bin/env node
// Renders scripted scenes through client/js/audio.js offline (headless Chromium, OfflineAudioContext) and writes
// raw interleaved stereo float32 files for tools/audio_analyze.py.
//
//   node tools/audio_render.mjs --out /tmp/renders --tag after [--audio path/to/audio.js] [--scenes cruise,dive,dogfight,boom] [--variants mix,wind]
//
// --audio renders an older copy of audio.js and --assets the matching client/assets/audio folder (for before/after
// numbers); the old file must import nothing but the samples. "wind" renders only the engine's continuous sounds (no events, no music);
// "mix" renders the scene with its events and the battle music.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = arg('out', '/tmp/da-renders');
const tag = arg('tag', 'after');
const audioFile = arg('audio', null);
const assetsDir = arg('assets', null); // render an older build: its client/assets/audio folder
const scenes = arg('scenes', 'cruise,dive,dogfight,boom').split(',');
if (scenes.includes('catalog') && !process.argv.includes('--variants')) process.argv.push('--variants', 'mix');
const variants = arg('variants', 'mix,wind').split(',');
fs.mkdirSync(out, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/__harness.html') file = path.join(root, 'tools/audio_harness.html');
  else if (url === '/js/audio.js' && audioFile) file = path.resolve(audioFile);
  else if (assetsDir && url.startsWith('/assets/audio/')) file = path.join(path.resolve(assetsDir), url.slice('/assets/audio/'.length));
  else file = path.join(root, 'client', url);
  if (!file.startsWith(root) && !(audioFile && file === path.resolve(audioFile)) && !(assetsDir && file.startsWith(path.resolve(assetsDir)))) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }).end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
for (const scene of scenes) {
  for (const variant of variants) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text()); });
    await page.goto(`${base}/__harness.html`);
    await page.waitForFunction('window.__ready', null, { timeout: 20000 });
    const t0 = Date.now();
    const r = await page.evaluate(([s, v, m]) => window.__render(s, v, m), [scene, variant, `${base}/js/audio.js?v=${tag}`]);
    const buf = Buffer.from(r.b64, 'base64');
    const name = `${tag}_${scene}_${variant}`;
    fs.writeFileSync(path.join(out, `${name}.f32`), buf);
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ sr: r.sr, frames: r.frames, meta: r.meta, probe: r.probe }));
    console.log(`${name}: ${(r.frames / r.sr).toFixed(1)} s rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await page.close();
  }
}
await browser.close();
server.close();
