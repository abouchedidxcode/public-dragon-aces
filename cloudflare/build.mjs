#!/usr/bin/env node
// Writes the complete static DRAGON ACES client into <outDir>:
//   client/index.html, client/css/*, client/assets/*   copied as-is
//   client/js/main.js           -> game.js            (esbuild bundle with three.js, ES module)
//   client/js/terrain-worker.js -> terrain-worker.js  (module worker: terrain meshing off the main thread)
//   client/js/castle-worker.js  -> castle-worker.js   (module worker: the Citadel's geometry and baked lighting)
// Usage: node cloudflare/build.mjs <outDir> [--watch] [--dev]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const game = path.resolve(here, '..');
const args = process.argv.slice(2);
const outArg = args.find((a) => !a.startsWith('--'));
if (!outArg) {
  console.error('usage: node cloudflare/build.mjs <outDir> [--watch] [--dev]');
  process.exit(1);
}
const out = path.resolve(game, outArg);
const watch = args.includes('--watch');
const dev = args.includes('--dev') || watch;
fs.mkdirSync(out, { recursive: true });

function copyStatic() {
  fs.copyFileSync(path.join(game, 'client/index.html'), path.join(out, 'index.html'));
  fs.cpSync(path.join(game, 'client/css'), path.join(out, 'css'), { recursive: true });
  fs.cpSync(path.join(game, 'client/assets'), path.join(out, 'assets'), { recursive: true });
  fs.cpSync(path.join(game, 'client/fonts'), path.join(out, 'fonts'), { recursive: true });
}
copyStatic();

const options = {
  entryPoints: {
    game: path.join(game, 'client/js/main.js'),
    'terrain-worker': path.join(game, 'client/js/terrain-worker.js'),
    'castle-worker': path.join(game, 'client/js/castle-worker.js'),
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [{ name: 'static', setup: (b) => b.onEnd(() => copyStatic()) }],
  });
  await ctx.watch();
  console.log('watching for changes...');
} else {
  await esbuild.build(options);
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(out);
  console.log(`dragon-aces client: ${files} files, ${(bytes / 1024).toFixed(0)} KB -> ${out}`);
}
