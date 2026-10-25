// Small allocation-light vector/quaternion helpers for the shared simulation (server, bots, flight model).
// Vectors are [x, y, z] arrays, quaternions [x, y, z, w]. The client uses three.js; these match its conventions:
// a dragon's local forward is -Z, up is +Y, right is +X.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const vset = (o, x, y, z) => ((o[0] = x), (o[1] = y), (o[2] = z), o);
export const vcopy = (o, a) => ((o[0] = a[0]), (o[1] = a[1]), (o[2] = a[2]), o);
export const vadd = (o, a, b) => vset(o, a[0] + b[0], a[1] + b[1], a[2] + b[2]);
export const vsub = (o, a, b) => vset(o, a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vscale = (o, a, s) => vset(o, a[0] * s, a[1] * s, a[2] * s);
export const vaddScaled = (o, a, b, s) => vset(o, a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s);
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vdist2 = (a, b) => {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
};
export const vcross = (o, a, b) =>
  vset(o, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
export function vnorm(o, a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return vset(o, a[0] / l, a[1] / l, a[2] / l);
}

export const qident = () => [0, 0, 0, 1];
export function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
  return q;
}
// o = a * b
export function qmul(o, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = ax * bw + aw * bx + ay * bz - az * by;
  o[1] = ay * bw + aw * by + az * bx - ax * bz;
  o[2] = az * bw + aw * bz + ax * by - ay * bx;
  o[3] = aw * bw - ax * bx - ay * by - az * bz;
  return o;
}
export function qaxis(o, ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  o[0] = ax * s; o[1] = ay * s; o[2] = az * s; o[3] = Math.cos(angle / 2);
  return o;
}
// rotate vector v by quaternion q
export function qrot(o, q, v) {
  const x = v[0], y = v[1], z = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  o[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  o[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  o[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return o;
}
// inverse-rotate (q is unit)
export function qrotInv(o, q, v) {
  const c = [-q[0], -q[1], -q[2], q[3]];
  return qrot(o, c, v);
}
// quaternion that makes local -Z look along dir with up hint (like three.js Object3D.lookAt for cameras)
export function qlook(o, dir, up = [0, 1, 0]) {
  const z = vnorm([0, 0, 0], [-dir[0], -dir[1], -dir[2]]);
  let x = vcross([0, 0, 0], up, z);
  if (vlen(x) < 1e-5) x = vcross([0, 0, 0], [0, 0, 1], z);
  vnorm(x, x);
  const y = vcross([0, 0, 0], z, x);
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    o[3] = 0.25 / s; o[0] = (m21 - m12) * s; o[1] = (m02 - m20) * s; o[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    o[3] = (m21 - m12) / s; o[0] = 0.25 * s; o[1] = (m01 + m10) / s; o[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    o[3] = (m02 - m20) / s; o[0] = (m01 + m10) / s; o[1] = 0.25 * s; o[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    o[3] = (m10 - m01) / s; o[0] = (m02 + m20) / s; o[1] = (m12 + m21) / s; o[2] = 0.25 * s;
  }
  return qnorm(o);
}

// Deterministic PRNG (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
