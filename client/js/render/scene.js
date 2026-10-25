// Renderer, camera, lighting, post-processing and the static world (sky, terrain, ocean, clouds, sky islands).
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { SKY, configureSky, patchFog, createFog, createSky, tameEnvironment, buildFogTable } from './atmosphere.js';
import { Terrain, loadTerrainTextures } from './terrain.js';
import { createOcean } from './ocean.js';
import { Clouds } from './clouds.js';
import { createSkyIslands } from './islands.js';
import { createWaterfalls } from './falls.js';
import { Shrines } from './shrines.js';
import { Effects } from './fx.js';
import { Trails } from './trails.js';
import { Vegetation } from './vegetation.js';
import { Props } from './props.js';
import { Castle } from './castle.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadDragonModel } from './dragon.js';
import { WORLD } from '../../../shared/constants.js';
import { PostPipeline, QUALITY } from './post.js';
import { LensRenderer } from './lens.js';

export class World3D {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // tone mapping happens in the final post pass (post.js), not in the renderer
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;
    this.quality = 1;
    this.renderScale = 1; // dynamic resolution (0.625..1) on top of the tier's pixel ratio, see governor()
    this.perf = { gpuMs: 0, frameMs: 16, scale: 1, timer: false };
    // ?gov=0 (and automated browsers) keep the resolution fixed so screenshots are repeatable
    this.govOff = /[?&]gov=0/.test(location.search) || !!navigator.webdriver;
    this.govSlow = 0; this.govFast = 0; this.govNoUp = 0; this.govHold = performance.now() + 6000;
    this.timeScale = 1; // <1 slows particles and trails (kill-cam slow motion); the game logic never reads it
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 1, 26000);
    this.camera.position.set(0, 1200, 3000);
  }

  async load(base, progress = () => {}) {
    this.base = base;
    const scene = this.scene;
    const step = (label, p) => progress(label, p);
    step('Reading the sky', 0.05);
    const skyJson = await fetch(`${base}sky.json`).then((r) => r.json()).catch(() => null);
    configureSky(skyJson);

    const texLoader = new THREE.TextureLoader();
    const [skyTex, waterTex, env] = await Promise.all([
      texLoader.loadAsync(`${base}sky.jpg`),
      texLoader.loadAsync(`${base}waternormals.jpg`),
      new HDRLoader().setDataType(THREE.FloatType).loadAsync(`${base}env.hdr`),
    ]);
    buildFogTable(skyTex.image); // haze colours sampled from the HDRI (before any material compiles)
    patchFog();
    scene.fog = createFog();
    step('Lighting the world', 0.25);
    env.mapping = THREE.EquirectangularReflectionMapping;
    tameEnvironment(env);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromEquirectangular(env).texture;
    scene.environment = this.envMap;
    scene.environmentIntensity = 0.9;
    env.dispose();
    pmrem.dispose();

    this.sky = createSky(skyTex);
    scene.add(this.sky);

    const sun = new THREE.DirectionalLight(SKY.sunColor, 4.2);
    sun.position.copy(SKY.sunDir).multiplyScalar(400);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 900;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.05;
    sun.shadow.radius = 3;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    step('Painting the land', 0.35);
    this.terrainTex = await loadTerrainTextures(base);
    step('Raising mountains', 0.5);
    this.ocean = createOcean(waterTex, skyTex);
    scene.add(this.ocean);
    // world: forests (instanced trees in three detail levels, placed by the terrain worker)
    this.vegetation = new Vegetation(scene, new URL('terrain-worker.js', document.baseURI), this.renderer);
    await this.vegetation.load(base);
    this.props = new Props(scene, this.terrainTex);
    await this.props.load(base);
    this.vegetation.onBlock = (b) => this.props.addBlock(b);
    this.crystals = {};
    try {
      const cg = await new GLTFLoader().loadAsync(`${base}world_crystals.glb`);
      cg.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.setAttribute('aCol', o.geometry.getAttribute('color'));
        o.geometry.deleteAttribute('color');
        this.crystals[o.name] = o.geometry;
      });
    } catch (e) {
      console.warn('crystals', e);
    }
    this.terrainReady = new Promise((resolve) => {
      this.terrain = new Terrain(scene, this.terrainTex, (tex, data, n) => {
        this.ocean.setTerrainData(tex);
        this.clouds.setTerrainData(tex, WORLD.terrainHalf);
        this.vegetation.setTerrainData(tex);
        this.props.setTerrainData(tex);
        this.terrainDataTex = tex;
        if (this.castle) this.castle.setTerrainData(tex);
        this.fx.setTerrain(tex);
        this.terrainData = { data, n };
        resolve();
      });
    });
    this.clouds = new Clouds(scene);
    this.fx = new Effects(scene);
    await this.fx.load(base);
    this.trails = new Trails(scene);
    step('Hatching dragons', 0.65);
    await loadDragonModel(`${base}dragon.glb`);
    this.setupPost();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    step('Waiting for the mountains', 0.8);
  }

  addSkyIslands(world) {
    this.props.buildLandmarks(world);
    this.islands = createSkyIslands(world, this.terrainTex, { vegetation: this.vegetation, props: this.props, crystals: this.crystals });
    this.scene.add(this.islands);
    this.falls = createWaterfalls(world, this.vegetation.shared.uTime);
    this.scene.add(this.falls);
    this.shrines = new Shrines(this.scene, world.shrines);
    this.props.buildNeedles(world, world.castle.castleSpec().needles.map((n) => ({ x: world.castle.CASTLE.x + n.x, z: world.castle.CASTLE.z + n.z, r: n.r, top: n.top, seed: n.seed })));
    // the Citadel at the centre of the map: geometry and baked lighting come from a worker, so it appears a moment after the world
    this.castle = new Castle(this.scene, this.renderer);
    this.castle.setQuality(this.quality);
    if (this.terrainDataTex) this.castle.setTerrainData(this.terrainDataTex);
    if (!/[?&]castle=0/.test(location.search)) this.castle.start(this.base); // ?castle=0 leaves the Citadel's meshes out (A/B timing)
  }

  setupPost() {
    this.post = new PostPipeline(this.renderer, this.scene, this.camera);
    // heat haze and shockwave refraction: the VFX pool draws offsets into a half-res buffer, the final pass bends
    // the scene by it (self-disabling when idle, see post.distort and vfx-distort.js)
    this.post.distort = this.fx.makeDistortPass(this.camera);
    // `grade.uniforms` is the game's handle on the lens: whiteout, damage, boost, speed, pop, sunVis...
    this.grade = { uniforms: this.post.uniforms };
    // target lenses: magnified views of far dragons composited after the post pass (lens.js)
    this.lens = new LensRenderer(this);
  }

  setQuality(q) {
    this.quality = q;
    this.applyPixelRatio();
    this.renderer.shadowMap.enabled = q >= 1;
    this.sun.castShadow = q >= 1;
    if (this.terrain) this.terrain.setQuality(q);
    if (this.vegetation) this.vegetation.setQuality(q);
    if (this.props) this.props.setQuality(q);
    if (this.castle) this.castle.setQuality(q);
    this.post.setQuality(q);
    if (this.lens) this.lens.setQuality(q);
    if (this.clouds) this.clouds.setQuality(q);
    if (this.ocean) this.ocean.setQuality(q);
    if (this.fx) this.fx.setQuality(q);
    this.resize();
  }

  applyPixelRatio() {
    const cap = QUALITY[this.quality].pixelRatio;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap) * this.renderScale);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.post) {
      const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      if (s.x !== this.post.size.x || s.y !== this.post.size.y) this.post.setSize(s.x, s.y);
    }
    if (this.fx) this.fx.setScale((h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))));
  }

  // depth of field: focus distance in metres and strength 0..1 (0 = off). Title screen and the kill cam use it.
  setFocus(dist, amount) {
    this.post.uniforms.uDofFocus.value = dist;
    this.post.uniforms.uDofAmount.value = amount;
  }

  // a hard camera cut: forget the previous frame so there is no motion blur across it
  cameraCut() { this.post.cut(); }

  // keep the shadow frustum around the point of interest (the local dragon)
  focusShadow(p) {
    const s = this.sun;
    s.target.position.copy(p);
    s.position.copy(p).addScaledVector(SKY.sunDir, 450);
  }

  // sun glare: project the sun and test whether terrain, sky islands or clouds block it
  updateGlare(world) {
    const cam = this.camera;
    const g = this.grade.uniforms;
    const p = new THREE.Vector3().copy(cam.position).addScaledVector(SKY.sunDir, 10000).project(cam);
    let vis = p.z < 1 && Math.abs(p.x) < 1.3 && Math.abs(p.y) < 1.3 ? 1 : 0;
    let solidVis = 1; // terrain/islands only (clouds are handled by the god-ray pass itself)
    if (vis && world) {
      const q = [0, 0, 0];
      for (let d = 20; d < 4000; d *= 1.35) {
        q[0] = cam.position.x + SKY.sunDir.x * d;
        q[1] = cam.position.y + SKY.sunDir.y * d;
        q[2] = cam.position.z + SKY.sunDir.z * d;
        if (world.solidAt(q)) { vis = 0; solidVis = 0; break; }
        const c = this.clouds.density({ x: q[0], y: q[1], z: q[2] });
        vis *= 1 - Math.min(1, c * 3);
        if (vis < 0.02) break;
      }
    }
    g.sunVis.value += (vis - g.sunVis.value) * 0.2;
    this._solidVis = (this._solidVis ?? 1) + (solidVis - (this._solidVis ?? 1)) * 0.2;
    if (this.clouds) this.clouds.setSunVisibility(this._solidVis);
    // the eye adjusts when the sun is in view: a gentle exposure dip
    const near = Math.max(0, 1 - Math.hypot(p.x, p.y) / 1.5);
    this.post.exposureMul += ((1 - 0.14 * g.sunVis.value * near * near) - this.post.exposureMul) * 0.05;
    g.sunPos.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    g.aspect.value = cam.aspect;
  }

  update(dt, t) {
    const cam = this.camera;
    this.terrain.update(cam, t);
    this.vegetation.update(cam, t);
    this.props.update(cam, t);
    this.ocean.update(t, cam);
    this.clouds.update(cam);
    this.fx.update(dt * this.timeScale, cam);
    this.trails.update(dt * this.timeScale, cam);
    this.grade.uniforms.time.value = t;
    if (this.islands) this.islands.userData.update(t, this.renderer);
    if (this.falls) this.falls.userData.update(this.renderer);
    if (this.shrines) this.shrines.update(dt, t, this.fx, cam);
    if (this.castle) this.castle.update(cam, t, dt, this.fx);
  }

  render() {
    // keep the sky dome on the camera for THIS frame (its own onBeforeRender runs after matrices are built,
    // which is one frame late: fine until the camera cuts across the map, e.g. the kill cam)
    if (this.sky) {
      this.camera.updateMatrixWorld();
      this.sky.position.copy(this.camera.position);
      this.sky.updateMatrixWorld();
    }
    const q = this.timerBegin();
    this.post.render();
    if (this.lens) this.lens.render();
    this.timerEnd(q);
    this.governor();
  }

  // ---- GPU timing (EXT_disjoint_timer_query_webgl2: Chrome and Edge) feeds the resolution governor
  timerBegin() {
    if (this.timerExt === undefined) {
      const gl = this.renderer.getContext();
      this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') || null;
      this.timerQueries = [];
      this.perf.timer = !!this.timerExt;
    }
    const ext = this.timerExt;
    if (!ext) return null;
    const gl = this.renderer.getContext();
    // collect finished queries from earlier frames
    const pending = this.timerQueries;
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const done = pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6;
        this.perf.gpuMs += (ms - this.perf.gpuMs) * 0.1;
      }
      gl.deleteQuery(done);
    }
    if (pending.length > 4) return null;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    return q;
  }

  timerEnd(q) {
    if (!q) return;
    const gl = this.renderer.getContext();
    gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    this.timerQueries.push(q);
  }

  // Dynamic resolution: if the GPU can't hold ~60 fps, shave the render resolution in steps before anything
  // else; creep back up when there is a lot of headroom. Without GPU timers (Safari, Firefox) it only reacts to
  // clearly slow frames. The page's own auto quality drop (main.js) still handles the worst cases.
  governor() {
    const now = performance.now();
    const p = this.perf;
    const gap = now - (this.lastFrameAt || now);
    this.lastFrameAt = now;
    if (gap > 250) this.govHold = now + 2000; // tab switch or a stall: not a verdict on the GPU
    else p.frameMs += (gap - p.frameMs) * 0.08;
    if (this.govOff || now < this.govHold) return;
    // a GPU with slack clocks itself down (Apple silicon), which stretches the timed GPU work toward the frame
    // budget: a high gpuMs at a steady 60 fps is not slow, so the timer only counts once frames are really missed
    const slow = p.timer && p.gpuMs > 0.01 ? p.gpuMs > 13.5 && p.frameMs > 18 : p.frameMs > 24;
    const fast = p.timer ? p.gpuMs > 0.01 && p.gpuMs < 7.5 && p.frameMs < 18 : p.frameMs < 14;
    this.govSlow = slow ? this.govSlow + 1 : Math.max(0, this.govSlow - 2);
    this.govFast = fast ? this.govFast + 1 : 0;
    if (this.govSlow > 45 && this.renderScale > 0.64) {
      this.setRenderScale(this.renderScale - 0.125);
      this.govHold = now + 2500;
      this.govNoUp = now + 25000; // don't oscillate
    } else if (this.govFast > 500 && this.renderScale < 1 && now > this.govNoUp) {
      this.setRenderScale(Math.min(1, this.renderScale + 0.125));
      this.govHold = now + 2500;
      this.govNoUp = now + 25000;
    }
  }

  setRenderScale(s) {
    this.renderScale = s;
    this.perf.scale = s;
    this.govSlow = this.govFast = 0;
    this.applyPixelRatio();
    this.resize();
  }
}
