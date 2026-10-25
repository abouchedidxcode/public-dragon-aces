// Arcade dragon flight model, shared by the local player and the server's bots.
// A dragon flies where its nose points (with a little slip), trades height for speed, stalls when slow,
// flaps harder with throttle and burns stamina to boost. Body axes: forward -Z, up +Y, right +X.
import { WORLD, WEAPONS } from './constants.js';
import { clamp, lerp, qaxis, qmul, qnorm, qrot, qrotInv, vlen } from './math.js';

const THRUST = 30; // m/s^2 at full flap
const DRAG = THRUST / (96 * 96); // terminal level speed at full flap ~96 m/s
const BOOST = 36;
const BRAKE_DRAG = 3.2;
const G = 9.81;
export const STALL_SPEED = 30;
export const MAX_SPEED = 190;

export function createFlightState(pos, quat) {
  return {
    p: [pos[0], pos[1], pos[2]],
    q: [quat[0], quat[1], quat[2], quat[3]],
    vel: [0, 0, 0],
    speed: 75,
    sink: 0,
    stamina: 1,
    throttle: 0.6,
    boosting: false,
    braking: false,
    dodge: 0, // remaining dodge-roll time
    dodgeDir: 0,
    dodgeCd: 0,
    // angular velocity (body frame) for smooth control response
    wp: 0, wr: 0, wy: 0,
  };
}

const _f = [0, 0, 0], _u = [0, 0, 0], _r = [0, 0, 0], _tmpq = [0, 0, 0, 1], _tmpq2 = [0, 0, 0, 1];
const FWD = [0, 0, -1], UP = [0, 1, 0], RIGHT = [1, 0, 0];

export const forwardOf = (q, o = [0, 0, 0]) => qrot(o, q, FWD);
export const upOf = (q, o = [0, 0, 0]) => qrot(o, q, UP);
export const rightOf = (q, o = [0, 0, 0]) => qrot(o, q, RIGHT);

// Bank angle (rad), positive = right wing down.
export function bankOf(q) {
  qrot(_r, q, RIGHT);
  qrot(_u, q, UP);
  return Math.atan2(-_r[1], _u[1]);
}

/**
 * Advance one step.
 * input: { pitch, roll, yaw in [-1, 1], throttle 0..1, boost, brake, dodge (-1 | 0 | 1 to start a roll) }
 * breed: entry of BREEDS (speed, turn multipliers)
 */
export function stepFlight(s, input, dt, breed) {
  const spd = breed.speed;
  const turn = breed.turn;
  forwardOf(s.q, _f);

  // control authority grows with airspeed
  const auth = clamp((s.speed - 14) / 46, 0.28, 1) * turn;

  // dodge roll: a fast barrel roll with a sideways hop
  s.dodgeCd = Math.max(0, s.dodgeCd - dt);
  if (input.dodge && s.dodge <= 0 && s.dodgeCd <= 0 && s.stamina >= WEAPONS.dodge.stamina) {
    s.dodge = WEAPONS.dodge.duration;
    s.dodgeDir = input.dodge > 0 ? 1 : -1;
    s.dodgeCd = WEAPONS.dodge.cooldown;
    s.stamina -= WEAPONS.dodge.stamina;
  }

  let tp = clamp(input.pitch, -1, 1) * 1.55 * auth;
  let tr = clamp(input.roll, -1, 1) * 3.6 * Math.max(auth, 0.5);
  let ty = clamp(input.yaw, -1, 1) * 0.7 * auth;
  let dodgeEnded = false;
  if (s.dodge > 0) {
    // roll rate follows a bell on top of a base rate (still exactly one turn): a hard kick-off, fastest mid-roll
    const p = clamp(1 - s.dodge / WEAPONS.dodge.duration, 0, 1);
    tr = -s.dodgeDir * (Math.PI * 2) / WEAPONS.dodge.duration * (0.3634 + Math.sin(Math.PI * p));
    tp *= 0.3;
    s.dodge -= dt;
    dodgeEnded = s.dodge <= 0;
  }
  // smooth angular velocity (wing inertia); a touch snappier than before
  const k = 1 - Math.exp(-(s.dodge > 0 ? 30 : 11) * dt);
  s.wp += (tp - s.wp) * k;
  s.wr += (tr - s.wr) * k;
  s.wy += (ty - s.wy) * k;
  if (dodgeEnded) s.wr *= 0.15; // snap out of the barrel roll instead of drifting on

  // body-frame rotation
  qaxis(_tmpq, 1, 0, 0, s.wp * dt);
  qmul(s.q, s.q, _tmpq);
  qaxis(_tmpq, 0, 0, -1, s.wr * dt);
  qmul(s.q, s.q, _tmpq);
  qaxis(_tmpq, 0, 1, 0, -s.wy * dt);
  qmul(s.q, s.q, _tmpq);

  // banked turn: a rolled dragon's lift curves its path around world up
  const bank = bankOf(s.q);
  forwardOf(s.q, _f);
  const level = 1 - Math.abs(_f[1]);
  const yawWorld = -Math.sin(bank) * 0.55 * auth * level * clamp(s.speed / 60, 0, 1.4);
  qaxis(_tmpq2, 0, 1, 0, yawWorld * dt);
  qmul(s.q, _tmpq2, s.q);

  // stall: nose falls toward the ground
  const lift = clamp((s.speed - 16) / (STALL_SPEED - 4), 0, 1);
  if (lift < 1) {
    forwardOf(s.q, _f);
    rightOf(s.q, _r);
    const drop = (1 - lift) * 1.4 * dt * Math.sqrt(Math.max(0, 1 - _f[1] * _f[1])) * (_f[1] > -0.95 ? 1 : 0);
    qaxis(_tmpq2, _r[0], _r[1], _r[2], -drop);
    qmul(s.q, _tmpq2, s.q);
  }
  qnorm(s.q);
  forwardOf(s.q, _f);

  // speed
  s.throttle = clamp(input.throttle, 0, 1);
  s.boosting = !!input.boost && s.stamina > 0.02;
  s.braking = !!input.brake;
  let thrust = THRUST * (0.3 + 0.7 * s.throttle);
  if (s.boosting) {
    thrust += BOOST;
    s.stamina = Math.max(0, s.stamina - 0.24 * dt);
  } else if (s.dodge <= 0) {
    s.stamina = Math.min(1, s.stamina + (s.throttle < 0.5 ? 0.13 : 0.09) * dt);
  }
  // thin air above the ceiling
  const thin = clamp((s.p[1] - WORLD.ceiling) / 400, 0, 1);
  thrust *= 1 - thin * 0.85;
  const v = s.speed / spd;
  let acc = thrust - DRAG * v * v - G * _f[1] * 0.95;
  if (s.braking) acc -= BRAKE_DRAG * (s.speed > 40 ? 6 : 2);
  s.speed = clamp(s.speed + acc * dt * spd, 8, MAX_SPEED * spd);

  // sink when lift is lost; recover when flying
  s.sink += (-G * (1 - lift) - G * thin * 0.6) * dt;
  s.sink *= Math.exp(-2.4 * lift * dt);

  // velocity follows the nose with a little slip
  const slip = 1 - Math.exp(-4.5 * dt);
  s.vel[0] += (_f[0] * s.speed - s.vel[0]) * slip;
  s.vel[1] += (_f[1] * s.speed + s.sink - s.vel[1]) * slip;
  s.vel[2] += (_f[2] * s.speed - s.vel[2]) * slip;
  if (s.dodge > 0) {
    rightOf(s.q, _r);
    const hop = s.dodgeDir * 32 * dt;
    s.p[0] += _r[0] * hop; s.p[1] += _r[1] * hop; s.p[2] += _r[2] * hop;
  }
  s.p[0] += s.vel[0] * dt;
  s.p[1] += s.vel[1] * dt;
  s.p[2] += s.vel[2] * dt;
  return s;
}

const _d = [0, 0, 0];
/**
 * "Mouse aim" autopilot: fill input.pitch/roll/yaw so the dragon turns toward a world direction.
 * Rolls into the turn for big corrections and levels the wings once the target is nearly ahead.
 */
export function steerToward(s, dir, input, sharp = 1) {
  qrotInv(_d, s.q, dir);
  const l = vlen(_d) || 1;
  const x = _d[0] / l, y = _d[1] / l, z = _d[2] / l;
  const off = Math.acos(clamp(-z, -1, 1)); // angle off the nose
  // pitch toward target (positive pitch = nose up)
  const pitchErr = Math.atan2(y, -z);
  const yawErr = Math.atan2(x, -z);
  // roll so the target sits above the dragon's back; wings level when target is ahead
  const aggressive = clamp((off - 0.06) / 0.35, 0, 1);
  const rollToTarget = Math.atan2(x, y);
  // level roll uses the world-up reference
  const bank = bankOf(s.q);
  const levelErr = -bank;
  let rollErr = lerp(levelErr * 0.9, rollToTarget, aggressive);
  // don't fight a target that's directly behind by rolling inverted forever
  if (off > 2.6) rollErr = rollToTarget * 0.4 + levelErr * 0.6;
  input.roll = clamp(rollErr * 2.2 * sharp, -1, 1);
  input.pitch = clamp(pitchErr * 4.2 * sharp * (y > -0.2 || off < 0.5 ? 1 : 0.35), -1, 1);
  input.yaw = clamp(yawErr * 3, -1, 1);
  return off;
}
