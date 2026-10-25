#!/usr/bin/env node
// Headless screenshots of the Citadel (SwiftShader, so about 1 fps: keep the viewport small).
//   W=640 H=360 node tools/castle_shots.mjs <url> <outPrefix> '<cameras json>' [waitMs]
// cameras: [{ "name": "far", "pos": [x, y, z], "look": [x, y, z], "wait": 9000 }, ...] in world metres (the castle's
// courtyard floor is y 560, the keep's finial 1172). The script waits for the menu and for the castle worker, hides
// the showcase dragon, turns the title screen's depth of field off, parks the camera with `fixedCam`, and after each
// shot prints the draw calls and triangles of the last frame (renderer.info) plus the castle's detail levels.
// Serve a build first: npm run build && node tools/serve.mjs dist 8080 (add ?q=0|1|2 to the URL).
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const [url, out, camsArg, waitArg] = process.argv.slice(2);
const cams = JSON.parse(camsArg);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W || 640), height: Number(process.env.H || 360) } });
const logs = [];
page.on('console', (m) => {
  if (!/useProgram|PCFSoft|GPU stall/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
await page.waitForSelector('#menu', { state: 'visible', timeout: 300000 }).catch(() => logs.push('menu never appeared'));
// NOCASTLE=1 (an older build without the castle) skips the wait; NOSHOT=1 only reports renderer.info
const ok = process.env.NOCASTLE
  ? true
  : await page
      .waitForFunction(() => window.__dragonAces && window.__dragonAces.w3.castle && window.__dragonAces.w3.castle.ready, null, { timeout: 240000, polling: 1000 })
      .then(() => true, () => false);
logs.push('castle ready: ' + ok);
if (process.env.CLEARSKY) {
  const pts = [];
  for (const c of cams) for (let t = 0; t <= 1; t += 0.05) pts.push([0, 1, 2].map((i) => c.pos[i] + (c.look[i] - c.pos[i]) * t));
  for (let x = -600; x <= 600; x += 300) for (let z = -600; z <= 600; z += 300) for (let y = 640; y <= 1500; y += 215) pts.push([x, y, z]);
  await page.evaluate((p) => { window.__clearSky = p; }, pts);
}
await page.evaluate(() => {
  const da = window.__dragonAces;
  const w3 = da.w3;
  try { da.showcase.v.root.visible = false; } catch (e) { /* no showcase */ }
  for (const el of document.body.children) if (el.tagName !== 'CANVAS' && el.tagName !== 'SCRIPT') el.style.display = 'none';
  w3.setFocus = () => { w3.post.uniforms.uDofAmount.value = 0; };
  // the shadow map follows what the camera looks at, not the (hidden) showcase dragon
  const dir = w3.sun.position.clone().sub(w3.sun.target.position).normalize();
  w3.focusShadow = () => {
    const t = window.__shotTarget || [0, 600, 0];
    w3.sun.target.position.set(t[0], t[1], t[2]);
    w3.sun.position.set(t[0], t[1], t[2]).addScaledVector(dir, 450);
  };
  // CLEARSKY=1: freeze the cloud drift at the offset that leaves the Citadel and the cameras' lines of sight clearest
  // (weather drifts with wall-clock time, so a shot can otherwise end up inside a cloud)
  if (window.__clearSky) {
    const cl = w3.clouds, pts = window.__clearSky;
    let best = 0, bs = 1e9;
    for (let k = 0; k < 400; k++) {
      cl.weather.wx = k * 700;
      cl.weather.wz = k * 310;
      let sum = 0;
      for (const p of pts) sum += cl.density({ x: p[0], y: p[1], z: p[2] });
      if (sum < bs) { bs = sum; best = k; }
    }
    const wx = best * 700, wz = best * 310;
    cl.update = function () {
      this.weather.wx = wx; this.weather.wz = wz;
      this.uniforms.wind.value.set(wx, wz);
      if (this.scene.fog && this.scene.fog.setDrift) this.scene.fog.setDrift(wx, wz);
    };
  }
  // renderer.info over a whole frame
  w3.renderer.info.autoReset = false;
  const r = w3.render.bind(w3);
  w3.render = () => {
    w3.renderer.info.reset();
    r();
    const i = w3.renderer.info;
    window.__frameInfo = { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures };
  };
});
for (const c of cams) {
  await page.evaluate((c) => {
    window.__shotTarget = c.look;
    window.__dragonAces.fixedCam = [...c.pos, ...c.look];
    if (c.fov) { window.__dragonAces.w3.camera.fov = c.fov; }
  }, c);
  await page.waitForTimeout(c.wait || Number(waitArg) || 9000);
  const info = await page.evaluate(() => {
    const w3 = window.__dragonAces.w3;
    const k = w3.castle;
    return { frame: window.__frameInfo, castle: k && k.ready ? k.measure(w3.camera, w3.sun) : null, lod: k && k.info.lod, buildMs: k && k.info.buildMs, quality: w3.quality, scale: w3.renderScale };
  });
  logs.push(`${c.name}: ${JSON.stringify(info)}`);
  if (process.env.NOSHOT) continue;
  await page.screenshot({ path: `${out}-${c.name}.png`, timeout: 180000 }).then(
    () => logs.push('shot ' + c.name),
    (e) => logs.push(`shot ${c.name} failed: ${e.message.split('\n')[0]}`),
  );
}
console.log(logs.slice(0, 160).join('\n'));
await browser.close();
