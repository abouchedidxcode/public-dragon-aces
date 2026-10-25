// Baked lighting for the Citadel. The sun never moves and the castle never changes, so the big shadows and the soft
// occlusion are computed once, at load time, from a voxel model of the colliders and the massif:
//   * sun visibility (towers shadowing walls, bridges shadowing courtyards, the massif shadowing the base),
//   * ambient occlusion (rays out to 40 m: courtyard corners, under the viaducts, between the spires),
//   * exposure to rain (a ray straight up: what sits under a ledge stays dry; what does not gets streaked).
// They are stored in a 3D texture (buildLightVolume) that the stone shader samples per pixel, just off the surface
// along its normal. Per-vertex baking showed up as diagonal bands on big triangles; a volume has no triangles.
// probe() is the single-point version, still used for the few instanced parts that carry their own light (windows,
// banners). The real-time shadow map still adds crisp shadows near the camera; the mountain shadow texture and the
// cloud shadows come from the shared lighting in the shader.
import { CASTLE, hit } from '../../../shared/castle.js';

export const VOL = { CELL: 10, HALF: 560, YMIN: -110, YMAX: 810 }; // cell size, metres around the centre, local heights
const { CELL, HALF, YMIN, YMAX } = VOL;

export class Voxels {
  constructor(world) {
    this.nx = Math.ceil((HALF * 2) / CELL);
    this.nz = this.nx;
    this.ny = Math.ceil((YMAX - YMIN) / CELL);
    const { nx, ny, nz } = this;
    const raw = new Uint8Array(nx * ny * nz);
    const p = [0, 0, 0];
    const Y0 = CASTLE.y0;
    for (let k = 0; k < nz; k++) {
      const z = CASTLE.z - HALF + (k + 0.5) * CELL;
      for (let i = 0; i < nx; i++) {
        const x = CASTLE.x - HALF + (i + 0.5) * CELL;
        const h = world.height(x, z) - Y0; // terrain top in local metres
        for (let j = 0; j < ny; j++) {
          const y = YMIN + (j + 0.5) * CELL;
          let s = y < h ? 1 : 0;
          if (!s) {
            p[0] = x; p[1] = Y0 + y; p[2] = z;
            if (hit(p, 2.5)) s = 1;
          }
          raw[(k * ny + j) * nx + i] = s;
        }
      }
    }
    // one pass of a 3x3x3 box blur so the shadow edges are soft instead of 8 m stair steps
    const out = new Uint8Array(raw.length);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          let sum = 0, n = 0;
          for (let dk = -1; dk <= 1; dk++) {
            const kk = k + dk;
            if (kk < 0 || kk >= nz) continue;
            for (let dj = -1; dj <= 1; dj++) {
              const jj = j + dj;
              if (jj < 0 || jj >= ny) continue;
              const base = (kk * ny + jj) * nx;
              for (let di = -1; di <= 1; di++) {
                const ii = i + di;
                if (ii < 0 || ii >= nx) continue;
                sum += raw[base + ii];
                n++;
              }
            }
          }
          out[(k * ny + j) * nx + i] = Math.round((sum / n) * 255);
        }
      }
    }
    this.d = out;
  }

  // occupancy 0..1 at a local-space point (x, z world; y local)
  at(x, y, z) {
    const i = ((x - CASTLE.x + HALF) / CELL) | 0, j = ((y - YMIN) / CELL) | 0, k = ((z - CASTLE.z + HALF) / CELL) | 0;
    if (i < 0 || i >= this.nx || k < 0 || k >= this.nz) return 0;
    if (j < 0) return 1;
    if (j >= this.ny) return 0;
    return this.d[(k * this.ny + j) * this.nx + i] * (1 / 255);
  }
}

// 14 directions on the sphere (a golden-spiral set), used for the occlusion rays
const DIRS = [];
for (let i = 0; i < 14; i++) {
  const y = 1 - (2 * (i + 0.5)) / 14;
  const r = Math.sqrt(1 - y * y);
  const a = i * 2.399963;
  DIRS.push([Math.cos(a) * r, y, Math.sin(a) * r]);
}
const AO_D = [5, 12, 26, 55];
const AO_W = [1, 0.85, 0.6, 0.4];
const AO_WSUM = AO_W.reduce((a, b) => a + b, 0);

// sun visibility, ambient occlusion and rain exposure for a point and its normal (local y)
export function probe(vox, px, py, pz, nx, ny, nz, sun, out) {
  // start outside the surface's own voxel
  const ox = px + nx * 5, oy = py + ny * 5, oz = pz + nz * 5;
  // sun
  let opt = 0, step = 5, t = 4;
  const sd = nx * sun[0] + ny * sun[1] + nz * sun[2];
  if (sd < -0.05) {
    // faces away from the sun: dark, with a smooth fade (no point marching)
    out[1] = 0;
  } else {
    while (t < 900 && opt < 40) {
      const x = ox + sun[0] * t, y = oy + sun[1] * t, z = oz + sun[2] * t;
      if (x < CASTLE.x - HALF || x > CASTLE.x + HALF || z < CASTLE.z - HALF || z > CASTLE.z + HALF || y > YMAX) break;
      opt += vox.at(x, y, z) * step;
      t += step;
      step *= 1.1;
    }
    out[1] = Math.exp(-opt / 9);
  }
  // ambient occlusion
  let occ = 0, wsum = 0;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const c = d[0] * nx + d[1] * ny + d[2] * nz;
    if (c < 0.12) continue;
    let o = 0;
    for (let k = 0; k < 4; k++) {
      const x = ox + d[0] * AO_D[k], y = oy + d[1] * AO_D[k], z = oz + d[2] * AO_D[k];
      o += vox.at(x, y, z) * AO_W[k];
    }
    occ += (o / AO_WSUM) * c;
    wsum += c;
  }
  out[0] = wsum > 0 ? Math.max(0.28, 1 - Math.min(1, (occ / wsum) * 1.15)) : 1;
  // rain exposure
  let rain = 0;
  for (let k = 0; k < 4; k++) rain = Math.max(rain, vox.at(px + nx * 3, py + 3 + k * k * 4 + 3, pz + nz * 3));
  out[2] = 1 - rain;
}

// bake a MeshBuilder's vertices: dat = [ao, sun, exposure, material]
export function bakeMesh(vox, mb, sun) {
  const out = [1, 1, 1];
  const { pos, nrm, dat } = mb;
  const Y0 = CASTLE.y0;
  void Y0;
  for (let v = 0; v < mb.n; v++) {
    const p = v * 3;
    probe(vox, pos[p], pos[p + 1], pos[p + 2], nrm[p], nrm[p + 1], nrm[p + 2], sun, out);
    const d = v * 4;
    dat[d] = Math.max(0, Math.min(255, Math.round(dat[d] * out[0])));
    dat[d + 1] = Math.round(out[1] * 255);
    dat[d + 2] = Math.round(out[2] * 255);
  }
}


// ------------------------------------------------------------------------------------------------ the light volume
// RGBA8, x fastest, then y (up), then z: R sun transmittance, G rain exposure, B ambient openness, A 255.
// Every cell is computed from its centre; cells inside stone are then filled from their open neighbours so that
// trilinear filtering next to a wall never leaks the wall's own darkness into the air in front of it.
const AO_DIRS = [];
for (let i = 0; i < 10; i++) {
  const y = 1 - (2 * (i + 0.5)) / 10;
  const r = Math.sqrt(1 - y * y);
  const a = i * 2.399963 + 0.4;
  AO_DIRS.push([Math.cos(a) * r, y, Math.sin(a) * r]);
}
const AO_R = [12, 26, 48];
const AO_RW = [1, 0.8, 0.55];
export const AO_BASE = 0.42; // occupancy around a point 5 m off a flat wall: this reads as 'fully open'

export function buildLightVolume(vox, sun) {
  const { nx, ny, nz } = vox;
  const data = new Uint8Array(nx * ny * nz * 4);
  const solid = new Uint8Array(nx * ny * nz);
  const wsum = AO_RW.reduce((a, b) => a + b, 0) * AO_DIRS.length;
  for (let k = 0; k < nz; k++) {
    const z = CASTLE.z - HALF + (k + 0.5) * CELL;
    for (let j = 0; j < ny; j++) {
      const y = YMIN + (j + 0.5) * CELL;
      for (let i = 0; i < nx; i++) {
        const x = CASTLE.x - HALF + (i + 0.5) * CELL;
        const c = (k * ny + j) * nx + i;
        const o = c * 4;
        if (vox.d[c] > 140) { solid[c] = 1; continue; }
        // sun
        let opt = 0, step = 6, t = 6;
        while (t < 1100 && opt < 40) {
          const px = x + sun[0] * t, py = y + sun[1] * t, pz = z + sun[2] * t;
          if (px < CASTLE.x - HALF || px > CASTLE.x + HALF || pz < CASTLE.z - HALF || pz > CASTLE.z + HALF || py > YMAX) break;
          opt += vox.at(px, py, pz) * step;
          t += step;
          step *= 1.12;
        }
        data[o] = Math.round(Math.exp(-opt / 9) * 255);
        // ambient: how much of the sphere around the cell is stone
        let occ = 0;
        for (let d = 0; d < AO_DIRS.length; d++) {
          const dd = AO_DIRS[d];
          for (let r = 0; r < AO_R.length; r++) occ += vox.at(x + dd[0] * AO_R[r], y + dd[1] * AO_R[r], z + dd[2] * AO_R[r]) * AO_RW[r];
        }
        occ /= wsum;
        data[o + 2] = Math.round((1 - Math.min(0.85, Math.max(0, (occ - AO_BASE) * 1.9))) * 255);
        // rain: stone overhead within 50 m
        let up = 0;
        for (let q = 1; q <= 5; q++) up += vox.at(x, y + q * 10, z);
        data[o + 1] = Math.round(Math.max(0, 1 - up * 0.8) * 255);
        data[o + 3] = 255;
      }
    }
  }
  // fill the solid cells from their open neighbours, twice, so the filled shell is two cells deep
  for (let pass = 0; pass < 2; pass++) {
    const fresh = [];
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const c = (k * ny + j) * nx + i;
          if (!solid[c]) continue;
          let r = 0, g = 0, b = 0, n = 0;
          for (let dk = -1; dk <= 1; dk++) {
            const kk = k + dk;
            if (kk < 0 || kk >= nz) continue;
            for (let dj = -1; dj <= 1; dj++) {
              const jj = j + dj;
              if (jj < 0 || jj >= ny) continue;
              for (let di = -1; di <= 1; di++) {
                const ii = i + di;
                if (ii < 0 || ii >= nx) continue;
                const cc = (kk * ny + jj) * nx + ii;
                if (solid[cc]) continue;
                r += data[cc * 4]; g += data[cc * 4 + 1]; b += data[cc * 4 + 2]; n++;
              }
            }
          }
          if (n) fresh.push(c, r / n, g / n, b / n);
        }
      }
    }
    for (let q = 0; q < fresh.length; q += 4) {
      const c = fresh[q];
      data[c * 4] = fresh[q + 1]; data[c * 4 + 1] = fresh[q + 2]; data[c * 4 + 2] = fresh[q + 3]; data[c * 4 + 3] = 255;
      solid[c] = 0;
    }
  }
  // what is still unfilled is deep inside stone: dark, dry, closed
  for (let c = 0; c < solid.length; c++) if (solid[c]) { data[c * 4] = 0; data[c * 4 + 1] = 0; data[c * 4 + 2] = 90; data[c * 4 + 3] = 255; }
  return { data, nx, ny, nz };
}

// CPU trilinear lookup of a volume at a world position (x, z world; y local), for calibration and tests
export function sampleVolume(vol, x, y, z, out) {
  const fx = (x - CASTLE.x + HALF) / CELL - 0.5, fy = (y - YMIN) / CELL - 0.5, fz = (z - CASTLE.z + HALF) / CELL - 0.5;
  const { nx, ny, nz, data } = vol;
  const cl = (v, n) => Math.max(0, Math.min(n - 1, v));
  const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
  const tx = fx - i0, ty = fy - j0, tz = fz - k0;
  out[0] = out[1] = out[2] = 0;
  for (let dk = 0; dk < 2; dk++) {
    for (let dj = 0; dj < 2; dj++) {
      for (let di = 0; di < 2; di++) {
        const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
        const c = ((cl(k0 + dk, nz) * ny + cl(j0 + dj, ny)) * nx + cl(i0 + di, nx)) * 4;
        out[0] += data[c] * w; out[1] += data[c + 1] * w; out[2] += data[c + 2] * w;
      }
    }
  }
  out[0] /= 255; out[1] /= 255; out[2] /= 255;
  return out;
}
