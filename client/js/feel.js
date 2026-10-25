// Game feel: the chase camera, the death and respawn shots, hit-stop and kill-cam slow motion, shake,
// FOV punch, the lens state fed to the post pipeline and controller rumble.
//
// Everything here is client-side. Game owns one Feel and calls it from a handful of places:
//   tick(dt)            top of Game.update: returns the simulation dt (hit-stop) and sets the visual time scale
//   camera(dt, aim)     replaces the old updateCamera
//   hurt / dealt / kill / death / explosion / spawn    events
import * as THREE from 'three';
import { bankOf, rightOf } from '../../shared/flight.js';
import { DRAGON_SCALE } from '../../shared/constants.js';

const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
// Dragons are drawn DRAGON_SCALE times life-size so foes read at range. The camera boom grows by the same factor, so
// your own dragon fills exactly as much of the screen as before and the chase camera feels the same; only the
// lengths scale here, never the springs, rates or FOV.
const BOOM = DRAGON_SCALE;
const UP = new V3(0, 1, 0);
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3(), _f = new V3();
const _q = new THREE.Quaternion();
const _sp = [0, 0, 0];

// smooth pseudo-random in [-1, 1]: a few detuned sines read as organic shake (white noise just jitters)
const DOT = new Set(['br', 'nap', 'acid']); // damage over time: light feedback
const wob = (t, s) => (Math.sin(t + s) * 0.5 + Math.sin(t * 2.17 + s * 1.7) * 0.3 + Math.sin(t * 4.31 + s * 0.6) * 0.2);

export class Feel {
  constructor(game) {
    this.g = game;
    this.t = 0;
    this.hitStop = 0;
    this.hitStopCd = 0;
    this.slowmo = null;
    this.vis = 1; // visual time scale (particles, trails, wrecks): <1 in kill-cam slow motion
    // smoothed state
    this.dir = new V3(0, 0, -1);
    this.boost = 0; this.brake = 0; this.speedN = 0; this.low = 0; this.wall = 0; this.stall = 0;
    this.roll = 0;
    this.fov = 66; this.fovVel = 0;
    this.clear = 1; // fraction of the camera boom that is free of terrain
    this.kick = new V3(); // rotation kicks: x pitch, y yaw, z roll (rad), decays
    this.pop = 0; this.ca = 0; this.letter = 0;
    this.wasBoost = false; this.wasDodge = false; this.lastShot = 0;
    this.swoop = 0;
    this.deadT = 0; this.deathFlag = false; this.orbitInit = false; this.orbitA = 0; this.orbitR = 40; this.cutDone = false;
    this.rumbleAt = 0; this.rumbleLevel = 0;
    this.foe = new V3();
    this.pos = new V3(); // rendered camera position before shake
  }

  // ------------------------------------------------------------------ time
  tick(dt) {
    const g = this.g;
    let sim = dt;
    this.hitStopCd = Math.max(0, this.hitStopCd - dt);
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      sim = dt * 0.04; // a freeze, not a stop: input and the camera stay alive
    }
    let vis = 1;
    const s = this.slowmo;
    if (s) {
      s.t += dt;
      if (s.t < 0.06) vis = 1 - (1 - s.scale) * (s.t / 0.06);
      else if (s.t < s.hold) vis = s.scale;
      else if (s.t < s.hold + s.ramp) {
        const u = (s.t - s.hold) / s.ramp;
        vis = s.scale + (1 - s.scale) * u * u * (3 - 2 * u);
      } else this.slowmo = null;
    }
    if (g.me.alive) this.deadT = 0;
    else {
      this.deadT += dt;
      // the fall of our own dragon plays in slow motion
      const u = this.deadT;
      vis = Math.min(vis, u < 0.1 ? 1 - 5 * u : u < 1.2 ? 0.5 : 0.5 + (u - 1.2) * 0.8);
      vis = Math.min(1, vis);
    }
    this.vis = vis;
    g.w3.timeScale = vis;
    return sim;
  }

  stop(sec) {
    if (this.hitStopCd > 0) return;
    this.hitStop = Math.max(this.hitStop, sec);
    this.hitStopCd = 0.45;
  }

  // ------------------------------------------------------------------ events
  spawn() {
    this.swoop = 1;
    this.deathFlag = false;
    this.orbitInit = false;
    this.cutDone = false;
    this.deadT = 0;
    this.slowmo = null;
    this.hitStop = 0;
    this.dir.set(0, 0, -1);
    this.dirInit = false;
    this.g.w3.cameraCut();
  }

  hurt(m, attacker) {
    const g = this.g;
    const big = !DOT.has(m.k);
    const dmg = m.n || 10;
    g.shake = Math.min(1.15, g.shake + (big ? 0.26 + Math.min(0.3, dmg / 110) : 0.06));
    if (big) {
      this.stop(dmg >= 30 ? 0.075 : 0.035);
      this.ca = Math.min(1, this.ca + 0.5);
      let s = Math.random() < 0.5 ? -1 : 1;
      if (attacker) {
        _a.copy(attacker.pos).sub(g.me.pos).applyQuaternion(_q.copy(g.w3.camera.quaternion).invert());
        s = Math.sign(_a.x) || s;
      }
      this.kick.z += -s * (0.025 + dmg * 0.0006);
      this.kick.y += -s * 0.012;
      this.kick.x += 0.014;
    }
    this.rumble(big ? 0.85 : 0.2, big ? 0.6 : 0.35, big ? 170 : 60);
  }

  dealt(m) {
    const g = this.g;
    if (!DOT.has(m.k)) {
      g.shake = Math.min(1, g.shake + 0.05);
      this.stop(m.n >= 30 ? 0.06 : 0.022);
      this.rumble(0.1, 0.45, 55);
    } else this.rumble(0, 0.16, 50);
  }

  kill() {
    const g = this.g;
    this.slowmo = { t: 0, hold: 0.32, ramp: 0.55, scale: 0.28 };
    this.stop(0.06);
    this.hitStopCd = 0;
    this.fovVel += 36;
    this.pop = 0.55;
    this.ca = Math.max(this.ca, 0.6);
    g.shake = Math.min(1, g.shake + 0.28);
    this.rumble(0.8, 1, 280);
  }

  death() {
    if (this.deathFlag) return;
    this.deathFlag = true;
    const g = this.g;
    g.shake = Math.max(g.shake, 1);
    this.hitStopCd = 0;
    this.stop(0.09);
    this.ca = 1;
    this.rumble(1, 1, 450);
  }

  // shake from an explosion anywhere: strongest on top of it, nothing beyond ~280 m
  explosion(pos, power = 1) {
    const g = this.g;
    const d = pos.distanceTo(g.w3.camera.position);
    const a = power * clamp(1 - d / 280, 0, 1) ** 2;
    if (a < 0.01) return;
    g.shake = Math.min(1.1, Math.max(g.shake, g.shake + a * 0.6));
    if (a > 0.25) this.rumble(a * 0.7, a * 0.9, 140);
  }

  // controller rumble, limited so the actuator is never flooded; stronger effects override weaker ones
  rumble(strong, weak, ms) {
    const now = performance.now();
    const level = strong + weak * 0.6;
    if (now < this.rumbleAt && level < this.rumbleLevel) return;
    this.rumbleAt = now + Math.min(ms, 90);
    this.rumbleLevel = level;
    if (this.g.input.rumble) this.g.input.rumble(strong, weak, ms);
  }

  // ------------------------------------------------------------------ camera
  camera(dt, aim) {
    const g = this.g, w3 = g.w3, cam = w3.camera, me = g.me, fs = g.fs, world = g.world;
    g.camera = cam;
    const alive = me.alive;
    const K = (r) => 1 - Math.exp(-r * dt);
    const u = w3.grade.uniforms;
    this.t += dt;
    w3.setFocus(0, 0);

    // --- signals from the flight
    let speed = 0, vy = 0, bank = 0, dodging = false;
    if (alive) { speed = fs.speed; vy = fs.vel[1]; bank = bankOf(fs.q); dodging = fs.dodge > 0; }
    const boosting = alive && fs.boosting;
    this.boost += ((boosting ? 1 : 0) - this.boost) * K(boosting ? 8 : 3);
    this.brake += ((alive && fs.braking ? 1 : 0) - this.brake) * K(6);
    this.speedN += (clamp((speed - 60) / 130, 0, 1) - this.speedN) * K(3);
    this.stall += ((alive ? clamp((50 - speed) / 24, 0, 1) : 0) - this.stall) * K(5);
    let lowT = 0, wallT = 0;
    if (alive) {
      const fast = clamp((speed - 55) / 70, 0, 1);
      const agl = fs.p[1] - world.floorAt(fs.p[0], fs.p[2]);
      const ahead = fs.p[1] + fs.vel[1] * 0.6 - world.floorAt(fs.p[0] + fs.vel[0] * 0.6, fs.p[2] + fs.vel[2] * 0.6);
      lowT = clamp(1 - Math.min(agl, ahead) / 120, 0, 1) * fast;
      // canyon walls beside the wings
      const r = rightOf(fs.q, _sp);
      for (let side = -1; side <= 1; side += 2) {
        const h = world.floorAt(fs.p[0] + r[0] * side * 40, fs.p[2] + r[2] * side * 40);
        wallT = Math.max(wallT, clamp((h - fs.p[1] + 25) / 50, 0, 1));
      }
      wallT *= fast;
    }
    this.low += (lowT - this.low) * K(4);
    this.wall += (wallT - this.wall) * K(6);

    // --- edge events: boost punch, barrel roll snap, recoil
    if (boosting && !this.wasBoost) {
      this.fovVel += 46;
      g.shake = Math.min(1, g.shake + 0.22);
      this.ca = Math.max(this.ca, 0.7);
      this.kick.x += -0.01;
      this.rumble(0.45, 0.25, 170);
    }
    this.wasBoost = boosting;
    if (dodging && !this.wasDodge) {
      this.fovVel += 34;
      this.ca = Math.max(this.ca, 0.55);
      g.shake = Math.min(1, g.shake + 0.12);
      this.rumble(0.35, 0.5, 150);
    }
    this.wasDodge = dodging;
    if (g.shotSeq !== this.lastShot) {
      this.lastShot = g.shotSeq;
      if (alive) { this.kick.x += 0.0035; this.fovVel += 3; this.rumble(0, 0.18, 35); }
    }
    if (alive && g.breathing) { g.shake = Math.max(g.shake, 0.07); this.rumble(0.05, 0.3, 60); }
    // sustained rumble: speed, low flying, stall
    if (alive) {
      const sustained = this.boost * 0.22 + this.low * 0.3 + this.wall * 0.3 + this.stall * 0.35;
      if (sustained > 0.08) this.rumble(sustained * 0.5, sustained * 0.7, 90);
    }

    // --- decays
    this.pop = Math.max(0, this.pop - dt * 4);
    this.ca = Math.max(0, this.ca - dt * 2.4);
    this.kick.multiplyScalar(Math.exp(-8 * dt));

    // --- view direction: the mouse aim (plus free look), smoothed a touch
    const dir = _a.copy(aim);
    if (g.freeLook.lengthSq() > 1e-4) {
      dir.applyAxisAngle(_b.set(0, 1, 0), g.freeLook.x);
      const side = _b.crossVectors(dir, UP).normalize();
      dir.applyAxisAngle(side, g.freeLook.y);
    }
    if (!this.dirInit) { this.dir.copy(dir); this.dirInit = true; }
    this.dir.lerp(dir, K(alive ? 30 : 4)).normalize();
    const D = this.dir;

    let focus, lookAt = _f, want = _c, fovT = 66, springRate = 1, lookRate = 5;
    const swoop = this.swoop;
    if (alive) {
      focus = _d.copy(me.pos);
      const dist = (20.5 + Math.min(13, speed * 0.055) + this.boost * 3.4 - this.brake * 2.2 - this.low * 2.6 + this.stall * 1.5) * BOOM;
      want.copy(focus).addScaledVector(D, -dist);
      want.y += (5.4 - this.low * 1.7 + Math.max(0, D.y) * 3) * BOOM;
      lookAt.copy(focus).addScaledVector(D, 70);
      fovT = 65 + this.speedN * 7 + this.boost * 6 + this.low * 3.5 + this.wall * 1.5 + clamp((-vy - 40) / 140, 0, 1) * 3 - this.brake * 3 - this.stall * 4;
      if (swoop > 0) {
        this.swoop = Math.max(0, swoop - dt / 1.7);
        fovT += 22 * swoop ** 2.4;
      }
      // camera-frame spring: tight along the view, loose sideways and up so turns have weight
      const right = _e.crossVectors(D, UP).normalize();
      const up2 = _b.crossVectors(right, D).normalize();
      const err = _a.copy(g.camPos).sub(want);
      let ef = err.dot(D), er = err.dot(right), eu = err.dot(up2);
      ef *= Math.exp(-17 * dt);
      const kl = Math.exp(-(6.2 + this.stall * 3) * dt);
      er = clamp(er * kl, -7.5, 7.5);
      eu = clamp(eu * kl, -5, 5);
      g.camPos.copy(want).addScaledVector(D, ef).addScaledVector(right, er).addScaledVector(up2, eu);
      if (!isFinite(g.camPos.x)) g.camPos.copy(want);
      // a flick can swing the boom through the wings: never closer than ~a wingspan
      const off = _a.copy(g.camPos).sub(focus);
      const od = off.length();
      if (od < 14.5 * BOOM && od > 1e-3) g.camPos.copy(focus).addScaledVector(off, (14.5 * BOOM) / od);
      this.pos.copy(g.camPos);
      if (swoop > 0) {
        const e = swoop ** 2.4;
        this.pos.addScaledVector(D, -105 * e).addScaledVector(right, 34 * e);
        this.pos.y += 52 * e;
      }
    } else {
      // death cam: orbit the falling wreck, then cut to whoever killed us
      const corpse = me.corpse;
      focus = _d.copy(corpse ? corpse.p : me.pos);
      const killer = g.killer;
      const toKiller = killer && killer.alive && this.deadT > 1.9 && killer.view.root.visible;
      if (!this.orbitInit) {
        this.orbitInit = true;
        _a.copy(g.camPos).sub(focus);
        this.orbitA = Math.atan2(_a.z, _a.x);
        this.orbitR = clamp(Math.hypot(_a.x, _a.z), 24 * BOOM, 70 * BOOM);
      }
      if (!toKiller) {
        this.orbitA += dt * 0.42;
        this.orbitR += (52 * BOOM - this.orbitR) * K(1.2);
        want.set(focus.x + Math.cos(this.orbitA) * this.orbitR, focus.y + (14 + Math.min(20, this.deadT * 6)) * BOOM, focus.z + Math.sin(this.orbitA) * this.orbitR);
        lookAt.copy(focus);
        lookAt.y -= 7 * BOOM;
        fovT = 52;
        w3.setFocus(want.distanceTo(focus), 0.55);
        springRate = 4;
      } else {
        focus.copy(killer.pos); // collision and shadows follow the killer, not the wreck
        const kf = _e.set(0, 0, -1).applyQuaternion(killer.quat);
        const kr = _b.crossVectors(kf, UP).normalize();
        want.copy(killer.pos).addScaledVector(kf, -52 * BOOM).addScaledVector(kr, 16 * BOOM);
        want.y += 12 * BOOM;
        lookAt.copy(killer.pos).addScaledVector(kf, 30 * BOOM);
        lookAt.y -= 9 * BOOM; // the killer sits in the upper third, clear of the "slain by" text
        fovT = 58;
        springRate = 12;
        lookRate = 14;
        if (!this.cutDone) {
          this.cutDone = true;
          g.camPos.copy(want);
          g.camLook.copy(lookAt);
          this.fovVel += 26;
          w3.cameraCut();
        }
        w3.setFocus(want.distanceTo(killer.pos), 0.5);
      }
      g.camPos.lerp(want, K(springRate));
      this.pos.copy(g.camPos);
      if (this.cutDone && toKiller) w3.setFocus(this.pos.distanceTo(killer.pos), 0.5);
      else w3.setFocus(this.pos.distanceTo(focus), 0.55);
    }

    // --- terrain collision: the boom shortens (fast) when anything solid is between us and the dragon
    let free = 1;
    const fx = focus.x, fy = focus.y, fz = focus.z;
    for (let i = 1; i <= 7; i++) {
      const t = i / 7;
      _sp[0] = fx + (this.pos.x - fx) * t;
      _sp[1] = fy + (this.pos.y - fy) * t;
      _sp[2] = fz + (this.pos.z - fz) * t;
      if (world.solidAt(_sp, 3.2)) { free = (i - 1) / 7; break; }
    }
    free = Math.max(0.12, free);
    this.clear += (free - this.clear) * (free < this.clear ? K(26) : K(2.6));
    if (this.clear < 0.999) {
      this.pos.x = fx + (this.pos.x - fx) * this.clear;
      this.pos.y = fy + (this.pos.y - fy) * this.clear;
      this.pos.z = fz + (this.pos.z - fz) * this.clear;
    }
    const floorY = world.floorAt(this.pos.x, this.pos.z) + 3.5;
    if (this.pos.y < floorY) this.pos.y = floorY;

    // --- orientation
    g.camLook.lerp(lookAt, alive ? 1 : K(lookRate));
    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(g.camLook);

    // bank with the dragon (sin keeps it smooth through loops); level and steady during a barrel roll
    const rollT = alive && !dodging ? Math.sin(bank) * 0.34 : 0;
    this.roll += (rollT - this.roll) * K(dodging ? 10 : 6);
    let rz = -this.roll * (1 - swoop * 0.5) + this.kick.z - 0.5 * swoop ** 2.4;
    let rx = this.kick.x, ry = this.kick.y;

    // --- shake: trauma squared, smooth noise, plus the sustained rumbles of speed
    if (g.shake > 0) g.shake = Math.max(0, g.shake - dt * 1.7);
    const tr = Math.min(1, g.shake);
    const amp = tr * tr * 0.05;
    const tt = this.t * 78;
    rx += wob(tt, 1.3) * amp;
    ry += wob(tt * 0.93, 7.1) * amp;
    rz += wob(tt * 0.8, 3.7) * amp * 1.6;
    // fine tremor: boost, low flying between canyon walls, stall buffet
    const trem = this.boost * 0.0016 + this.low * 0.0032 + this.wall * 0.0045 + this.stall * 0.008;
    if (trem > 0) {
      const t2 = this.t * 190;
      rx += wob(t2, 2.2) * trem;
      ry += wob(t2 * 1.1, 5.9) * trem;
      rz += wob(t2 * 0.9, 8.4) * trem * 1.5;
    }
    cam.rotateZ(rz);
    cam.rotateX(rx);
    cam.rotateY(ry);

    // --- FOV: a spring with a little overshoot, so boost and rolls punch
    this.fovVel += ((fovT - this.fov) * 70 - this.fovVel * 12) * dt;
    this.fov += this.fovVel * dt;
    cam.fov = clamp(this.fov, 40, 105);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    w3.focusShadow(focus);
    if (alive) w3.fx.speedMotes(cam.position, _a.set(...fs.vel).normalize(), speed, dt);
    g.audio.setListener(cam.position, cam.quaternion);

    // --- the lens
    if (alive) {
      _e.set(...fs.vel).normalize().multiplyScalar(2000).add(cam.position).project(cam);
      this.foe.set(_e.x * 0.5 + 0.5, _e.y * 0.5 + 0.5, _e.z);
    }
    if (this.foe.z > 1 || !alive) this.foe.set(0.5, 0.5, 0);
    u.uFoe.value.set(this.foe.x, this.foe.y);
    u.uZoom.value = alive ? this.boost * 0.035 + this.low * 0.012 + this.wall * 0.012 + clamp(swoop, 0, 1) ** 2 * 0.05 : 0;
    // colour fringing stays a hint: the same response as before, scaled to a third and capped at 0.4
    u.uCA.value = Math.min(0.4, (this.boost * 0.45 + this.ca) / 3);
    u.speed.value = this.speedN;
    u.uPop.value = this.pop;
    this.letter += ((!alive && this.deadT > 0.4 ? 1 : 0) - this.letter) * K(3);
    u.uLetter.value = this.letter;
    w3.post.motionBlurScale = alive ? 1 + this.low * 0.5 + this.wall * 0.4 : 0.5;
  }
}
