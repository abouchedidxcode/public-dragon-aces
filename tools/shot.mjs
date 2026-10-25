#!/usr/bin/env node
// Headless screenshots for checking visuals without a GPU (SwiftShader software GL, roughly 0.3-1 fps).
//   node tools/shot.mjs <url> <outPrefix> '<actions json>'
// Serve a build first: npm run build && node tools/serve.mjs dist 8080
// Actions run in order; each is an object with any of:
//   { "waitFor": "#menu", "timeout": 150000 }   wait for a selector (the menu appears once the world has loaded)
//   { "wait": 8000 }                           wait ms (several frames need several seconds in software GL)
//   { "click": "#btn-offline" }                click (offline practice vs bots, no server needed)
//   { "eval": "js" }                            evaluate in the page; the result is printed
//   { "key": "KeyJ" } / { "keyup": "KeyJ" }     hold / release a key
//   { "shot": "name" }                          screenshot to <outPrefix>-name.png
// Page hooks (window.__dragonAces): fixedCam = [x,y,z, tx,ty,tz] parks the title-screen camera;
// showcaseCam = [side, back, up, lookSide] moves it around the showcase dragon; simulate(secs) fast-forwards
// the game without rendering; game = the running Game. Add ?q=0|1|2 to force the graphics level.
// Viewport: W and H environment variables (default 960x540).
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const [url, out, actionsArg] = process.argv.slice(2);
const actions = actionsArg ? JSON.parse(actionsArg) : [];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W || 960), height: Number(process.env.H || 540) } });
const logs = [];
const live = !!process.env.LIVE; // LIVE=1 prints console lines as they arrive (kept if the browser crashes)
logs.push = function (...l) {
  if (live) for (const x of l) console.log(x);
  return Array.prototype.push.apply(this, l);
};
page.on('crash', () => logs.push('[crash] the page crashed'));
page.on('console', (m) => {
  if (!/useProgram|PCFSoft/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
for (const a of actions) {
  if (a.wait) await page.waitForTimeout(a.wait);
  if (a.waitFor) await page.waitForSelector(a.waitFor, { state: a.state || 'visible', timeout: a.timeout || 120000 }).catch(() => logs.push('waitFor failed ' + a.waitFor));
  if (a.click) await page.click(a.click).catch((e) => logs.push('click failed ' + e.message));
  if (a.eval) {
    try {
      const r = await page.evaluate(a.eval);
      if (r !== undefined) logs.push('[eval] ' + JSON.stringify(r));
    } catch (e) {
      logs.push('[eval error] ' + e.message);
    }
  }
  if (a.key) await page.keyboard.down(a.key);
  if (a.keyup) await page.keyboard.up(a.keyup);
  if (a.shot) {
    // a shot that times out (software GL under load) is logged rather than losing the console output
    await page.screenshot({ path: `${out}-${a.shot}.png`, timeout: 180000 }).then(
      () => logs.push('shot ' + a.shot),
      (e) => logs.push(`shot ${a.shot} failed: ${e.message.split('\n')[0]}`),
    );
  }
}
if (!live) console.log(logs.slice(0, 120).join('\n'));
await browser.close();
