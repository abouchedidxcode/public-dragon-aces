#!/usr/bin/env node
// Minimal server for the built client plus the online room server (cloudflare/server.js) on <page>/ws:
//   node tools/serve.mjs dist [port] [host]     -> http://127.0.0.1:8080/
// Pass host 0.0.0.0 to let other machines on your network join. Offline practice needs no room server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createServer as createRooms } from '../cloudflare/server.js';

const root = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3]) || 8080;
const host = process.argv[4] || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream',
  '.map': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};
const rooms = createRooms();
const wss = new WebSocketServer({ noServer: true });
const server = http
  .createServer((req, res) => {
    if (req.url.split('?')[0].endsWith('/api/stats')) {
      return rooms.fetch(req, '/api/stats').text().then((body) => res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body));
    }
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(root, url);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return res.writeHead(404).end('not found');
    const headers = { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    // byte ranges, so <audio> can seek (the music loops by seeking)
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const size = fs.statSync(file).size;
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start > end) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, host, () => console.log(`serving ${root} on http://${host}:${port}/ (rooms on /ws)`));
server.on('upgrade', (req, socket, head) => {
  if (!req.url.split('?')[0].endsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => rooms.onConnection(ws, req));
});
