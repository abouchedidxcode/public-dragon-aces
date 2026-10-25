// Threat cue: bots never lock on, so nothing used to warn you when one was lining up a shot. A hostile within
// THREAT.range whose nose points within THREAT.cone of you is a threat: it gets lens priority (render/lens.js),
// a red edge arrow, and "ON YOUR SIX" in the lock-warning slot when it sits behind you. A little hysteresis (a wider
// cone to drop out, a short hold) keeps a wobbling nose from flickering the warning. No WebGL; unit tested.
import * as THREE from 'three';

export const THREAT = {
  range: 600, // m
  cone: THREE.MathUtils.degToRad(8), // nose within this of you: threat
  keepCone: THREE.MathUtils.degToRad(12), // ... and stays one until its nose is this far off
  keepRange: 680,
  hold: 0.4, // s a threat lingers after it stops qualifying
  behind: -0.15, // dot(your forward, direction to it) below this: on your six
};

const _f = new THREE.Vector3(), _to = new THREE.Vector3();

export class ThreatDetector {
  constructor() {
    this.ids = new Set(); // current threats
    this.until = new Map(); // id -> time the threat lapses
    this.time = 0;
    this.six = false; // a threat is behind you
    this.seen = []; // hostiles looked at this frame (ents may be a one-shot iterator)
  }

  /**
   * me: { pos: Vector3, fwd: Vector3 (unit) } or null (dead); ents: iterable (once) of { id, pos, quat, alive }.
   * isHostile(ent) -> bool. Returns this.ids (the same Set every frame).
   */
  update(dt, me, ents, isHostile) {
    this.time += dt;
    this.ids.clear();
    this.six = false;
    this.seen.length = 0;
    if (!me) { this.until.clear(); return this.ids; }
    const cosIn = Math.cos(THREAT.cone), cosKeep = Math.cos(THREAT.keepCone);
    for (const e of ents) {
      if (!e.alive || !isHostile(e)) { this.until.delete(e.id); continue; }
      this.seen.push(e);
      _to.copy(me.pos).sub(e.pos); // from it to you
      const d = _to.length();
      const was = (this.until.get(e.id) || 0) > this.time;
      if (d < 1 || d > (was ? THREAT.keepRange : THREAT.range)) continue;
      _f.set(0, 0, -1).applyQuaternion(e.quat);
      const c = _f.dot(_to) / d;
      if (c >= cosIn || (was && c >= cosKeep)) this.until.set(e.id, this.time + THREAT.hold);
    }
    for (const [id, t] of this.until) {
      if (t <= this.time) { this.until.delete(id); continue; }
      this.ids.add(id);
    }
    if (this.ids.size) {
      for (const e of this.seen) {
        if (!this.ids.has(e.id)) continue;
        _to.copy(e.pos).sub(me.pos).normalize();
        if (_to.dot(me.fwd) < THREAT.behind) { this.six = true; break; }
      }
    }
    return this.ids;
  }
}
