// Keyboard, mouse (pointer lock), gamepad and touch, folded into one per-frame control state.
//
// Mouse aim: moving the mouse swings an aim direction in the world (the camera follows it) and the dragon's
// autopilot banks and pulls toward it, like War Thunder's mouse-aim. Keys add direct roll and throttle.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false, middle: false };
    this.locked = false;
    this.sensitivity = Number(localStorage.getItem('da.sens') || 1);
    this.invertY = localStorage.getItem('da.invert') === '1';
    this.pressed = new Set(); // edge-triggered this frame
    this.touch = { active: false, aim: null, stick: { x: 0, y: 0 }, fire: false, breath: false, boost: false };
    this.enabled = false;

    addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (this.enabled && ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.left = this.mouse.right = this.mouse.middle = false;
      if (this.releaseTouch) this.releaseTouch();
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) {
        this.lock();
        return;
      }
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
      if (e.button === 1) {
        this.mouse.middle = true;
        this.pressed.add('Mouse1');
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
      if (e.button === 1) this.mouse.middle = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // browsers emit occasional huge deltas when the lock engages or the window refocuses: drop them
      if (performance.now() - this.lockedAt < 120 || Math.abs(e.movementX) > 350 || Math.abs(e.movementY) > 350) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    this.lockedAt = 0;
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      this.lockedAt = performance.now();
      if (!this.locked) this.mouse.left = this.mouse.right = false;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    this.setupTouch();
  }

  lock() {
    if (this.isTouch) return;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
    } catch {
      this.canvas.requestPointerLock();
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setupTouch() {
    this.isTouch = matchMedia('(pointer: coarse)').matches && 'ontouchstart' in window;
    if (!this.isTouch) return;
    const ui = document.getElementById('touch');
    if (!ui) return;
    ui.classList.remove('hidden');
    const stick = ui.querySelector('.stick');
    const knob = ui.querySelector('.knob');
    let stickId = null, aimId = null, last = null;
    const held = ['fire', 'breath', 'boost', 'seeker', 'dodge', 'ability'];
    // touchcancel (an iOS notification, Control Centre, a system gesture, an alert) must release exactly like
    // touchend, or a button or the stick stays held down
    const on = (el, types, fn, opts) => { for (const t of types) el.addEventListener(t, fn, opts); };
    const END = ['touchend', 'touchcancel'];
    const btn = (sel, key) => {
      const el = ui.querySelector(sel);
      el.addEventListener('touchstart', (e) => { e.preventDefault(); this.touch[key] = true; if (key === 'seeker') this.pressed.add('KeyF'); if (key === 'dodge') this.pressed.add('KeyE'); if (key === 'ability') this.pressed.add('KeyR'); }, { passive: false });
      on(el, END, (e) => { e.preventDefault(); if (e.type === 'touchcancel' || !e.targetTouches.length) this.touch[key] = false; }, { passive: false });
    };
    btn('.b-fire', 'fire');
    btn('.b-breath', 'breath');
    btn('.b-boost', 'boost');
    btn('.b-seek', 'seeker');
    btn('.b-dodge', 'dodge');
    btn('.b-abil', 'ability');
    const releaseStick = () => {
      stickId = null;
      this.touch.stick.x = this.touch.stick.y = 0;
      knob.style.transform = '';
    };
    // let go of everything (window blur, page hidden, a cancelled touch sequence)
    this.releaseTouch = () => {
      for (const k of held) this.touch[k] = false;
      releaseStick();
      aimId = null;
    };
    stick.addEventListener('touchstart', (e) => { e.preventDefault(); stickId = e.changedTouches[0].identifier; }, { passive: false });
    this.canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) if (aimId === null) { aimId = t.identifier; last = [t.clientX, t.clientY]; }
    });
    addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) {
          const r = stick.getBoundingClientRect();
          const x = (t.clientX - (r.left + r.width / 2)) / (r.width / 2), y = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
          const l = Math.max(1, Math.hypot(x, y));
          this.touch.stick.x = x / l;
          this.touch.stick.y = y / l;
          knob.style.transform = `translate(${(x / l) * 40}px, ${(y / l) * 40}px)`;
        } else if (t.identifier === aimId) {
          this.mouse.dx += (t.clientX - last[0]) * 2.2;
          this.mouse.dy += (t.clientY - last[1]) * 2.2;
          last = [t.clientX, t.clientY];
        }
      }
    }, { passive: true });
    // the stick and aim fingers end (or are cancelled) wherever they are lifted, so listen on the window
    on(window, END, (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) releaseStick();
        if (t.identifier === aimId) aimId = null;
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseTouch(); });
  }

  gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  }

  // Controller rumble through the Gamepad API (Chrome, Edge, Safari and Firefox expose it for most pads).
  // strong/weak are 0..1 motor strengths, ms the duration.
  rumble(strong, weak, ms = 100) {
    const pad = this.gamepad();
    const act = pad && (pad.vibrationActuator || (pad.hapticActuators && pad.hapticActuators[0]));
    if (!act || !act.playEffect) return;
    try {
      const p = act.playEffect('dual-rumble', {
        startDelay: 0, duration: Math.max(20, Math.min(600, ms)),
        strongMagnitude: Math.max(0, Math.min(1, strong)), weakMagnitude: Math.max(0, Math.min(1, weak)),
      });
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }

  // Called once per frame; returns the frame's controls and clears per-frame accumulators.
  read() {
    const k = this.keys;
    const pad = this.gamepad();
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.004, (now - (this.lastRead || now - 16)) / 1000));
    this.lastRead = now;
    // stick: dead zone, then a curve (fine aim near the centre, full speed at the rim)
    const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 1.7;
    const c = {
      aimDx: this.mouse.dx * 0.0022 * this.sensitivity,
      aimDy: this.mouse.dy * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1),
      roll: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      throttleUp: k.has('KeyW') || k.has('ArrowUp'),
      throttleDown: k.has('KeyS') || k.has('ArrowDown'),
      boost: k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Space') || this.touch.boost,
      fire: this.mouse.left || k.has('KeyJ') || this.touch.fire,
      breath: this.mouse.right || k.has('KeyK') || this.touch.breath,
      seeker: this.pressed.has('KeyF') || this.pressed.has('Mouse1') || this.pressed.has('KeyL'),
      dodge: this.pressed.has('KeyE') ? 1 : this.pressed.has('KeyQ') ? -1 : 0,
      ability: this.pressed.has('KeyR'), // breed ability (gamepad X)
      freeLook: k.has('KeyC') || k.has('AltLeft'),
      scoreboard: k.has('Tab'),
      mapToggle: this.pressed.has('KeyM'),
      escape: this.pressed.has('Escape'),
      stickX: this.touch.stick.x,
      stickY: this.touch.stick.y,
    };
    if (pad) {
      const ax = pad.axes;
      // rate based (rad/s), so the feel is the same at 60 and 144 fps
      c.aimDx += curve(dz(ax[0])) * 2.9 * dt * this.sensitivity;
      c.aimDy += curve(dz(ax[1])) * 2.2 * dt * this.sensitivity * (this.invertY ? -1 : 1);
      c.roll += dz(ax[2]);
      const b = pad.buttons;
      c.fire = c.fire || b[7].value > 0.3;
      c.breath = c.breath || b[6].value > 0.3;
      c.boost = c.boost || b[0].pressed || b[10].pressed;
      c.throttleUp = c.throttleUp || dz(ax[3]) < -0.5 || b[12].pressed;
      c.throttleDown = c.throttleDown || dz(ax[3]) > 0.5 || b[13].pressed;
      const edge = (i, name) => {
        this.padPrev = this.padPrev || [];
        const now = b[i] && b[i].pressed;
        const hit = now && !this.padPrev[i];
        this.padPrev[i] = now;
        return hit;
      };
      if (edge(3)) c.seeker = true;
      if (edge(2)) c.ability = true;
      if (edge(5)) c.dodge = 1;
      if (edge(4)) c.dodge = -1;
      c.scoreboard = c.scoreboard || b[8].pressed;
    }
    if (this.touch.stick.x || this.touch.stick.y) {
      c.roll += this.touch.stick.x;
      if (this.touch.stick.y < -0.5) c.throttleUp = true;
      if (this.touch.stick.y > 0.5) c.throttleDown = true;
    }
    c.roll = Math.max(-1, Math.min(1, c.roll));
    this.mouse.dx = this.mouse.dy = 0;
    this.pressed.clear();
    return c;
  }
}
