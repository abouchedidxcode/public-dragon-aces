// The title-screen showcase: a short film of the chosen dragon flying through the map, which doubles as the breed
// selection view. The route and the shot list live in showcase-flight.js (pure math, checked in Node by
// tests/showcase.test.mjs so the dragon and the cameras never go through rock). This file poses and animates the
// dragon along that flight, runs the camera (hard cuts between shots, the frame offset that keeps the dragon clear
// of the menu) and plays the breed-change flourish: a cut to one of the close-up spots chosen in showcase-flight.js
// (HERO_SPOTS: sunlit, open sky behind, the dragon facing away from the menu) while the new breed roars and breathes
// its element.
//
// Test hooks on window.__dragonAces: showcaseTime = t jumps the film to t seconds (consumed on the next frame),
// showcaseHold = true freezes the film's clock (the wings still beat), fixedCam = [x, y, z, tx, ty, tz] parks the
// camera, showcaseCam = [side, forward, up, lookSide] puts it at an offset from the dragon.
import * as THREE from 'three';
import { DragonView, BREED_LOOK } from './render/dragon.js';
import { buildFlight, scheduleShots, shotAt, cameraAt, heroSpot, newCamera, HERO } from './showcase-flight.js';

const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _x = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _vel = new THREE.Vector3(), _h = new THREE.Vector3();
const _c = new THREE.Vector3(), _l = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;

export class Showcase {
  constructor(w3, breed, audio, world = null) {
    this.w3 = w3;
    this.audio = audio;
    this.world = world; // optional: keeps the camera above ground
    this.heroPick = null;
    this.spot = 0; // next close-up spot (they take turns)
    this.view = new DragonView(breed);
    w3.scene.add(this.view.root);
    this.breed = breed;
    this.flight = buildFlight();
    this.sched = scheduleShots(this.flight);
    this.st = this.flight.newState();
    this.cam = newCamera();
    // open on the circuit round the Citadel: the castle behind the dragon is the strongest first frame
    this.T = this.flight.marks.citadel - 2.2;
    this.clock = 0;
    this.hero = -1; // seconds into a breed-change close-up, -1 when none
    this.lastShot = null;
    this.roar = 0;
    this.pop = 1;
    this.cut = document.getElementById('cut');
    this.flash = document.getElementById('flash');
    this.menu = document.getElementById('menu');
    this.roaring = false;
    this.visible = true;
  }

  // tools/castle_shots.mjs hides the dragon through `showcase.v`
  get v() {
    return this.view;
  }

  /** The film's clock, seconds into the loop. */
  get time() {
    return this.T;
  }

  /** Jumps the film to t seconds (wraps round the loop). */
  seek(t) {
    const D = this.flight.duration;
    this.T = ((t % D) + D) % D;
    this.hero = -1;
    this.lastShot = null;
  }

  show() {
    this.visible = true;
    this.view.root.visible = true;
    this.lastShot = null;
    if (this.cut) this.cut.style.opacity = '0';
  }

  hide() {
    this.visible = false;
    this.setRoaring(false);
    this.view.root.visible = false;
    this.w3.camera.clearViewOffset();
    this.w3.camera.up.set(0, 1, 0);
    if (this.cut) this.cut.style.opacity = '0';
  }

  /** Empties the effect pools, so the last breed's fire, frost, sparks or acid never hang about in the new shot. */
  clearEffects() {
    const fx = this.w3.fx;
    if (!fx) return;
    for (const p of fx.pools) p.clear();
    if (fx.arcs) for (const a of fx.arcs.arcs) a.life = 0; // retired (and their vertices zeroed) on the next update
    if (fx.lightReq) for (const r of fx.lightReq) r.on = false;
  }

  /** The title's left gradient deepens while the dragon roars across the frame (game.css #menu.roar). */
  setRoaring(on) {
    if (on === this.roaring) return;
    this.roaring = on;
    if (this.menu) this.menu.classList.toggle('roar', on);
  }

  /** Swaps the dragon. flourish: cut to a close-up spot while the new breed roars and breathes its element. */
  setBreed(id, flourish = true) {
    const prev = this.breed;
    this.breed = id;
    this.view.setBreed(id);
    if (id !== prev) this.clearEffects();
    if (!flourish) return;
    if (this.hero < 0) {
      // jump the film to the next close-up spot and cut to it
      const spot = heroSpot(this.flight, this.spot++);
      this.seek(spot.t);
      this.heroPick = { side: spot.side, scale: spot.scale };
      this.hero = 0;
      this.lastShot = 'jump'; // so the next frame registers a hard cut (no motion blur or history across it)
    } else this.hero = Math.min(this.hero, 0.4); // a second pick during the close-up stays on it and roars again
    this.roar = 1.25;
    this.pop = 0.9;
    const pal = BREED_LOOK[id].fire;
    if (this.flash && this.flash.animate) {
      const m = pal[1];
      this.flash.style.setProperty('--fc', `rgb(${Math.round(m[0] * 255)},${Math.round(m[1] * 255)},${Math.round(m[2] * 255)})`);
      this.flash.animate([{ opacity: 0 }, { opacity: 0.3, offset: 0.18 }, { opacity: 0 }], { duration: 750, easing: 'ease-out' });
    }
    if (this.audio) {
      const pitch = { ember: 1, frost: 0.93, storm: 1.14, venom: 1.05 }[id] || 1;
      this.audio.roar(null, pitch);
    }
  }

  update(dt) {
    if (!this.visible) return;
    const w3 = this.w3, v = this.view, cam = w3.camera, da = window.__dragonAces || {};
    if (typeof da.showcaseTime === 'number') {
      this.seek(da.showcaseTime);
      da.showcaseTime = undefined;
    }
    this.clock += dt;
    if (!da.showcaseHold) this.T = (this.T + dt) % this.flight.duration;
    if (this.hero >= 0) {
      this.hero += dt;
      if (this.hero > HERO.dur) this.hero = -1;
    }
    const st = this.flight.sample(this.T, this.st);

    // ---- the dragon: on the flight path, banked into its turns, nose a touch above the flight path on climbs
    _p.fromArray(st.p);
    _f.fromArray(st.f);
    _u.fromArray(st.u);
    _z.copy(_f).negate();
    _x.crossVectors(_u, _z).normalize();
    _u.crossVectors(_z, _x);
    v.root.position.copy(_p);
    v.root.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _u, _z));
    v.root.rotateX(0.04 + Math.max(0, st.climb) * 0.12);
    this.pop += (1 - this.pop) * (1 - Math.exp(-7 * dt));
    v.root.scale.setScalar(this.pop);
    v.root.updateMatrixWorld(true);
    this.roar = Math.max(0, this.roar - dt);
    const roaring = this.roar > 0.35;
    const heroLook = this.hero >= 0 ? this.cam.heroSide * 0.35 : 0; // in the close-up it roars toward the lens
    v.animate(dt, {
      throttle: Math.min(1, st.effort + (this.roar > 0 ? 0.25 : 0)),
      boost: st.effort > 1.15,
      dive: st.climb < -0.35,
      yawRate: clamp(-st.yawRate * 4, -2, 2),
      pitchRate: clamp(st.pitchRate * 3, -2, 2),
      lookYaw: st.bank * 0.35 + heroLook + Math.sin(this.clock * 0.5) * 0.12,
      lookPitch: st.climb * 0.25,
      breath: roaring,
    });
    v.setLight(w3.terrain.sunlit(_p.x, _p.y, _p.z), roaring ? 1 : 0, 0);
    if (this.roar > 0) {
      const pal = BREED_LOOK[this.breed].fire;
      v.mouthWorld(_o);
      _vel.copy(_f).multiplyScalar(st.speed);
      if (this.roar < 1.05 && this.roar > 0.4) w3.fx.breath(_o, _d.copy(_f).add(_l.set(0, -0.08, 0)).normalize(), _vel, pal, dt, this.breed);
      w3.fx.embers(_o, _vel, pal, dt * 2, this.breed);
    }

    // ---- the camera
    const forced = da.showcaseCam;
    const fixed = da.fixedCam; // tests: [x, y, z, tx, ty, tz]
    const aspect = innerWidth / Math.max(1, innerHeight);
    const c = cameraAt(this.flight, this.sched, this.T, this.cam, this.hero, this.heroPick);
    const shotId = this.hero >= 0 ? 'hero' : c.shot + this.sched.indexOf(shotAt(this.sched, this.T, this.flight.duration));
    if (shotId !== this.lastShot) {
      // a hard cut: no motion blur smeared across it
      if (this.lastShot !== null) w3.cameraCut();
      this.lastShot = shotId;
    }
    _c.fromArray(c.pos);
    _l.fromArray(c.look);
    let fov = c.fov;
    if (aspect < 1.2 && c.shot !== 'mount') {
      // portrait phones: a long lens on the dragon instead of the landscape frame's coverage, so the 24 m wingspan
      // fills about two thirds of the width (a little more in the close-up) in the open sky above the menu
      const across = c.shot === 'hero' ? 34 : 36; // metres across the frame at the dragon
      const halfW = across / 2 / Math.max(1, _c.distanceTo(_p));
      fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(halfW / aspect)), 6, 64);
    } else if (aspect < 1.2) fov = 64;
    else if (c.shot !== 'mount') fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * 1.08)); // a touch wider: the wings stay clear of the caption
    // handheld: a slow drift of the aim, in proportion to the distance (none on the shoulder mount)
    const dist = _c.distanceTo(_p);
    const hh = c.shot === 'mount' ? 0 : dist * 0.0022;
    _l.x += (Math.sin(this.clock * 0.9) + Math.sin(this.clock * 2.3) * 0.3) * hh;
    _l.y += Math.sin(this.clock * 1.3 + 1) * hh;
    _l.z += Math.sin(this.clock * 0.7 + 2) * hh;
    if (this.world) _c.y = Math.max(_c.y, this.world.floorAt(_c.x, _c.z) + 3);
    if (forced) {
      // legacy test hook: [side, forward, up, lookSide] around the dragon
      _x.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
      _c.copy(_p).addScaledVector(_x, forced[0]).addScaledVector(_f, forced[1]);
      _c.y += forced[2];
      _l.copy(_p).addScaledVector(_f, 2).addScaledVector(_x, forced[3] || 0);
      fov = 50;
    }
    cam.position.copy(_c);
    cam.up.set(0, 1, 0);
    cam.lookAt(_l);
    if (!forced) cam.rotateZ(c.roll);
    cam.fov = fov;
    cam.updateProjectionMatrix();
    // put the dragon where the title screen leaves room: right of the menu column and above the bottom bar on a
    // desktop, in the open sky above the menu on a phone
    if (fixed) {
      cam.clearViewOffset();
      cam.position.set(fixed[0], fixed[1], fixed[2]);
      cam.up.set(0, 1, 0);
      cam.lookAt(fixed[3], fixed[4], fixed[5]);
    } else if (!forced) {
      const W = innerWidth, H = innerHeight;
      const stacked = innerWidth <= 700;
      const hero = this.hero >= 0;
      // in the close-up the dragon sits a little left of its usual place, so its breath has the frame to cross
      const fx = stacked ? 0.5 : hero ? 0.6 : innerWidth < 900 ? 0.68 : 0.67;
      const fy = stacked ? 0.34 : c.shot === 'mount' ? 0.34 : 0.38;
      cam.setViewOffset(W, H, W * (0.5 - fx), H * (0.5 - fy), W, H);
    } else cam.clearViewOffset();
    this.setRoaring(this.hero >= 0);
    w3.focusShadow(_p);
    // depth of field: the head sharp (the eyes are what you look at); on the shoulder mount, the way ahead
    if (c.shot === 'mount' && this.hero < 0) w3.setFocus(cam.position.distanceTo(_l), 0.35);
    else {
      v.mouthWorld(_h).lerp(_p, 0.25);
      w3.setFocus(cam.position.distanceTo(_h), dist > 160 ? 0.5 : 0.85);
    }
    w3.grade.uniforms.whiteout.value = 0;
    w3.grade.uniforms.damage.value = 0;
    w3.grade.uniforms.boost.value = 0;
  }
}
