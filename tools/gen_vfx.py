#!/usr/bin/env python3
"""Generates the DRAGON ACES particle flipbooks (client/assets/vfx_*.png) from domain-warped
3D Perlin noise (curl-like swirl, burn-out erosion, baked shading).

    python3 tools/gen_vfx.py [fire|smoke|jet|shapes|all]

Needs numpy and Pillow only. All output is original (CC0) and deterministic.

Atlas channel layout (sampled by client/js/render/vfx-particles.js):
  vfx_fire.png   8x8 frames of 128px  R heat   G opacity   B fine flicker noise
  vfx_smoke.png  8x8 frames of 128px  R density G baked shade (lit from upper left)
  vfx_jet.png    4x8 frames of 256x128 R heat  G opacity   (flame jet blowing left to right, for breath tongues)
  vfx_shapes.png 4x4 shapes of 128px  RGB all the same: round, core, shard, flake, glint, drop, ring, scale, ...
"""
import sys
import os
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'client', 'assets')


# ------------------------------------------------------------------ helpers
def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def bilerp(f, x, y):
    """sample f (H,W) at float coords (x right, y down), clamped"""
    H, W = f.shape
    x = np.clip(x, 0, W - 1.001)
    y = np.clip(y, 0, H - 1.001)
    x0 = x.astype(np.int32)
    y0 = y.astype(np.int32)
    fx = x - x0
    fy = y - y0
    a = f[y0, x0] * (1 - fx) + f[y0, x0 + 1] * fx
    b = f[y0 + 1, x0] * (1 - fx) + f[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


def fbm_field(shape, rng, octaves=5, base=4):
    """value-noise fbm in [0,1] built by upsampling random grids"""
    H, W = shape
    out = np.zeros(shape)
    amp = 1.0
    tot = 0.0
    for o in range(octaves):
        n = base * (2 ** o)
        g = rng.random((n + 2, n + 2))
        ys = np.linspace(0, n, H, endpoint=False)
        xs = np.linspace(0, n, W, endpoint=False)
        X, Y = np.meshgrid(xs, ys)
        x0 = X.astype(int)
        y0 = Y.astype(int)
        fx = X - x0
        fy = Y - y0
        fx = fx * fx * (3 - 2 * fx)
        fy = fy * fy * (3 - 2 * fy)
        v = (g[y0, x0] * (1 - fx) + g[y0, x0 + 1] * fx) * (1 - fy) + (g[y0 + 1, x0] * (1 - fx) + g[y0 + 1, x0 + 1] * fx) * fy
        out += v * amp
        tot += amp
        amp *= 0.5
    return out / tot


def box_blur(f, r=1):
    out = f.copy()
    for _ in range(r):
        out = (np.roll(out, 1, 0) + np.roll(out, -1, 0) + np.roll(out, 1, 1) + np.roll(out, -1, 1) + out * 4) / 8
    return out



# ------------------------------------------------------------------ 3D gradient noise (periodic) for animated flames
class Noise3:
    """Perlin gradient noise on a periodic lattice, so animation in z can loop."""

    def __init__(self, seed=1, period=16):
        rng = np.random.default_rng(seed)
        g = rng.normal(size=(period, period, period, 3))
        self.g = g / np.linalg.norm(g, axis=-1, keepdims=True)
        self.P = period

    def __call__(self, x, y, z):
        P = self.P
        x0 = np.floor(x).astype(np.int64)
        y0 = np.floor(y).astype(np.int64)
        z0 = np.floor(z).astype(np.int64)
        fx, fy, fz = x - x0, y - y0, z - z0
        u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
        v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
        w = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
        out = 0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    gv = self.g[(x0 + dx) % P, (y0 + dy) % P, (z0 + dz) % P]
                    d = gv[..., 0] * (fx - dx) + gv[..., 1] * (fy - dy) + gv[..., 2] * (fz - dz)
                    wt = (u if dx else 1 - u) * (v if dy else 1 - v) * (w if dz else 1 - w)
                    out = out + d * wt
        return out * 1.6  # roughly [-1, 1]


NZ = [Noise3(7, 16), Noise3(13, 16), Noise3(29, 16)]


def fbm3(x, y, z, octaves=5, nz=0, gain=0.5, billow=False):
    tot = 0
    amp = 1.0
    out = 0
    for o in range(octaves):
        f = 2 ** o
        v = NZ[nz](x * f, y * f, z * f * 0.7 + o * 3.1)
        out = out + (1 - 2 * np.abs(v) if billow else v) * amp
        tot += amp
        amp *= gain
    return out / tot


def grid_xy(cell_w, cell_h=None):
    cell_h = cell_h or cell_w
    return np.meshgrid(np.linspace(-1, 1, cell_w), np.linspace(-1, 1, cell_h))


# ------------------------------------------------------------------ fireball puff (explosions, fireballs, wounds)
def make_fire_atlas(frames=64, grid=8, cell=128):
    atlas = np.zeros((grid * cell, grid * cell, 3), np.float32)
    X, Y = grid_xy(cell)
    rng = np.random.default_rng(11)
    for i in range(frames):
        a = i / (frames - 1)
        z = a * 2.4
        # curl-like domain warp: two noise fields displace the lookup so the edge licks and swirls
        wx = fbm3(X * 1.3 + 4.0, Y * 1.3, z, 3, 1)
        wy = fbm3(X * 1.3, Y * 1.3 + 9.0, z, 3, 2)
        qx = X + wx * (0.28 + 0.2 * a)
        qy = Y + wy * (0.28 + 0.2 * a) + a * 0.12  # lifts as it burns
        r = np.sqrt(qx * qx + qy * qy)
        R = 0.40 + 0.46 * np.sqrt(a)  # expanding fireball
        n = fbm3(qx * 2.3, qy * 2.3 - a * 1.2, z * 1.4, 5, 0)
        prof = 1.0 - r / R
        dens = prof * 1.15 + n * (0.45 + 0.55 * a)
        # burn out: the fire collapses to embers from the edge inward
        life = 1.0 - smoothstep(0.35, 0.98, a)
        dens = dens - (1 - life) * 0.9
        heat = smoothstep(0.05, 0.85, dens) * (1.0 - 0.55 * smoothstep(0.1, 0.85, a))
        opacity = smoothstep(0.0, 0.32, dens) * (0.35 + 0.65 * life)
        rr = np.sqrt(X * X + Y * Y)
        edge = smoothstep(1.0, 0.75, rr)
        flick = np.clip(0.5 + 0.5 * fbm3(X * 7, Y * 7, z * 3, 3, 1) + rng.random((cell, cell)) * 0.15, 0, 1)
        gi, gj = divmod(i, grid)
        sl = (slice(gi * cell, (gi + 1) * cell), slice(gj * cell, (gj + 1) * cell))
        atlas[sl + (0,)] = np.clip(heat, 0, 1) * edge
        atlas[sl + (1,)] = np.clip(opacity, 0, 1) * edge
        atlas[sl + (2,)] = flick * np.clip(opacity, 0, 1) * edge
    return atlas


# ------------------------------------------------------------------ smoke puff
def make_smoke_atlas(frames=64, grid=8, cell=128):
    atlas = np.zeros((grid * cell, grid * cell, 3), np.float32)
    X, Y = grid_xy(cell)
    for i in range(frames):
        a = i / (frames - 1)
        z = a * 1.2
        wx = fbm3(X * 0.9 + 2.0, Y * 0.9, z, 2, 1)
        wy = fbm3(X * 0.9, Y * 0.9 + 5.0, z, 2, 2)
        qx = X + wx * 0.16
        qy = Y + wy * 0.16
        r = np.sqrt(qx * qx + qy * qy)
        R = 0.62 + 0.28 * a
        n = fbm3(qx * 1.1 + 11, qy * 1.1, z * 1.6, 3, 0, 0.42)
        dens = (1.0 - r / R) * 1.5 + n * 0.85 - 0.1
        d = smoothstep(0.0, 0.75, dens)
        rr = np.sqrt(X * X + Y * Y)
        d = d * smoothstep(0.98, 0.7, rr)
        # pseudo-3D: treat the density as a height field and light it from the upper left
        h = box_blur(np.sqrt(np.clip(dens, 0, None)), 7)
        dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 26
        dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 26
        nl = np.stack([-dx, -dy, np.ones_like(dx)], -1)
        nl /= np.linalg.norm(nl, axis=-1, keepdims=True)
        lam = nl @ np.array([-0.5, -0.6, 0.62])
        shade = np.clip(0.25 + 0.75 * lam, 0, 1) * (0.55 + 0.45 * smoothstep(0.0, 1.0, dens))
        gi, gj = divmod(i, grid)
        sl = (slice(gi * cell, (gi + 1) * cell), slice(gj * cell, (gj + 1) * cell))
        atlas[sl + (0,)] = d
        atlas[sl + (1,)] = np.clip(shade, 0, 1) * d
    return atlas


# ------------------------------------------------------------------ flame jet for breath tongues (loops in time)
def make_jet_atlas(frames=32, gridx=4, gridy=8, cw=256, ch=128):
    atlas = np.zeros((gridy * ch, gridx * cw, 3), np.float32)
    rng = np.random.default_rng(4)
    gx, gy = np.meshgrid(np.linspace(0, 1, cw), np.linspace(-0.62, 0.62, ch))
    for i in range(frames):
        a = i / frames
        tz = (a * 4.0) % 8.0
        sx = gx * 3.6 - a * 5.0  # noise travels along +x, the direction of the jet
        wy = fbm3(sx * 0.9, gy * 0.9 + 3.0, tz, 3, 1) * (0.12 + 0.6 * gx)
        yy = gy + wy
        width = 0.12 + 0.5 * gx ** 0.85  # flaring cone
        prof = 1.0 - np.abs(yy) / width
        n = fbm3(sx * 1.7, yy * 2.2 + 7.0, tz, 5, 0)
        n2 = fbm3(sx * 4.0, yy * 5.0 + 2.0, tz * 1.3, 3, 2)
        taper = smoothstep(1.0, 0.18, gx)  # burns out downstream
        dens = prof * 1.05 + n * (0.5 + 0.9 * gx) + n2 * 0.18 - (1 - taper) * 0.85 - 0.12
        # a hot, narrow core with licking flames around it: heat has real contrast, not a flat plank
        heat = smoothstep(0.15, 0.95, dens) * (0.55 + 0.55 * (n * 0.5 + 0.5)) * (1.0 - 0.5 * gx)
        opacity = smoothstep(0.02, 0.42, dens) ** 1.2 * smoothstep(0.0, 0.05, gx) * smoothstep(0.9, 0.62, gx)
        edge = smoothstep(0.62, 0.42, np.abs(gy))
        flick = np.clip(0.5 + 0.5 * fbm3(gx * 9, gy * 9, tz, 3, 1) + rng.random((ch, cw)) * 0.15, 0, 1)
        gi, gj = divmod(i, gridx)
        sl = (slice(gi * ch, (gi + 1) * ch), slice(gj * cw, (gj + 1) * cw))
        atlas[sl + (0,)] = np.clip(heat, 0, 1) * edge
        atlas[sl + (1,)] = np.clip(opacity, 0, 1) * edge
        atlas[sl + (2,)] = flick * np.clip(opacity, 0, 1) * edge
    return atlas


# ------------------------------------------------------------------ misc shapes (4x4 of 128)
def make_shapes(cell=128, grid=4):
    atlas = np.zeros((grid * cell, grid * cell, 3), np.float32)
    g = np.linspace(-1, 1, cell)
    X, Y = np.meshgrid(g, g)
    R = np.sqrt(X * X + Y * Y)
    A = np.arctan2(Y, X)
    rng = np.random.default_rng(21)
    shapes = []
    # 0 soft round
    shapes.append(np.clip(1 - R, 0, 1) ** 1.6)
    # 1 hard bright core with halo (projectile head)
    shapes.append(np.clip(np.exp(-R * R * 14) + np.exp(-R * R * 2.5) * 0.35, 0, 1) * smoothstep(1.0, 0.8, R))
    # 2 shard / crystal: elongated diamond with facet shading
    d = np.abs(X) * 3.2 + np.abs(Y) * 0.9
    shard = smoothstep(1.0, 0.86, d) * (0.65 + 0.2 * np.sign(X) + 0.2 * (Y > 0))
    shapes.append(np.clip(shard, 0, 1))
    # 3 snow flake with six arms
    flake = np.zeros_like(R)
    for k in range(6):
        a = k * np.pi / 3
        along = X * np.cos(a) + Y * np.sin(a)
        across = -X * np.sin(a) + Y * np.cos(a)
        arm = smoothstep(0.07, 0.0, np.abs(across)) * smoothstep(0.95, 0.7, np.abs(along)) * (along > -0.05)
        for s in (0.35, 0.6):
            for sg in (-1, 1):
                bx = along - s
                by = across - sg * (along - s) * 0.9
                arm = np.maximum(arm, smoothstep(0.045, 0.0, np.abs(by)) * smoothstep(0.25, 0.0, np.abs(bx)) * (bx < 0.05) * (bx > -0.28))
        flake = np.maximum(flake, arm)
    flake = np.maximum(flake, smoothstep(0.18, 0.05, R))
    shapes.append(flake)
    # 4 four-point glint
    glint = np.exp(-np.abs(X) * 22) * np.exp(-np.abs(Y) * 2.6) + np.exp(-np.abs(Y) * 22) * np.exp(-np.abs(X) * 2.6)
    glint += np.exp(-R * R * 40) * 0.8
    shapes.append(np.clip(glint, 0, 1) * smoothstep(1.0, 0.85, R))
    # 5 teardrop pointing along +x (the direction a stretched sprite travels)
    hw = np.where(X > 0, np.clip(1 - X * 1.1, 0, 1) * 0.5, np.sqrt(np.clip(0.25 - (X * 0.55) ** 2, 0, None)))
    drop = smoothstep(hw + 0.04, hw - 0.04, np.abs(Y)) * (np.abs(X) < 0.92)
    shapes.append(drop.astype(np.float32))
    # 6 ring (soft)
    shapes.append(np.exp(-((R - 0.72) / 0.12) ** 2) * smoothstep(1.0, 0.9, R))
    # 7 irregular scale / armour plate shard: a jagged polygon with two lit facets and a dark edge
    prng = np.random.default_rng(5)
    ang = np.sort(prng.random(7) * 2 * np.pi)
    rad = 0.55 + prng.random(7) * 0.4
    from_poly = np.zeros_like(R)
    # distance-to-polygon via signed edge tests (convex-ish blob around the origin)
    pts = np.stack([np.cos(ang) * rad, np.sin(ang) * rad], 1)
    inside = np.ones_like(R, dtype=bool)
    dist_edge = np.full_like(R, 9.0)
    for i in range(7):
        p0, p1 = pts[i], pts[(i + 1) % 7]
        e = p1 - p0
        nrm = np.array([e[1], -e[0]]) / (np.linalg.norm(e) + 1e-9)
        sd = (X - p0[0]) * nrm[0] + (Y - p0[1]) * nrm[1]
        inside &= sd < 0.0
        dist_edge = np.minimum(dist_edge, np.abs(sd))
    body = smoothstep(0.0, 0.07, dist_edge) * inside
    facet = 0.55 + 0.45 * smoothstep(-0.6, 0.6, X * 0.8 - Y * 0.6)
    sc = body * facet * (0.75 + 0.25 * smoothstep(0.0, 0.25, dist_edge))
    shapes.append(sc)
    # 8 wisp: streaky smoke strand
    n = fbm_field((cell, cell), rng, 4, 4)
    shapes.append(smoothstep(0.45, 0.8, n) * smoothstep(1.0, 0.3, R))
    # 9 spark streak (tapered)
    shapes.append(np.exp(-np.abs(Y) * 18) * smoothstep(1.0, 0.0, np.abs(X)) ** 1.5)
    # 10 bubble
    bub = np.exp(-((R - 0.8) / 0.09) ** 2) * 0.8 + smoothstep(0.8, 0.0, R) * 0.12
    bub += np.exp(-(((X + 0.35) ** 2 + (Y + 0.35) ** 2) / 0.012)) * 0.9
    shapes.append(np.clip(bub, 0, 1) * smoothstep(1.0, 0.9, R))
    # 11 glob (blobby)
    shapes.append(smoothstep(0.55 + 0.25 * (fbm_field((cell, cell), rng, 3, 3) - 0.5), 0.4, R))
    # 12 jagged splinter
    shapes.append(smoothstep(1.0, 0.8, np.abs(X) * 1.15 + np.abs(Y) * 5.0 + np.abs(np.sin(X * 6.0)) * 0.1))
    # 13 lightning star
    shapes.append(smoothstep(0.9, 0.2, R * (1.0 + 0.45 * np.abs(np.sin(A * 4.5 + 0.4)))))
    # 14 cloudy blob
    nn = fbm_field((cell, cell), rng, 5, 3)
    shapes.append(smoothstep(0.0, 1.0, (1 - R) * 1.4 * (0.5 + nn)) * smoothstep(1.0, 0.7, R))
    # 15 leaf / membrane scrap
    shapes.append(smoothstep(0.35, 0.2, np.abs(Y * 2.2 + X * X * 0.9)) * smoothstep(1.0, 0.5, np.abs(X)))
    for i, s in enumerate(shapes):
        gi, gj = divmod(i, grid)
        for ch in range(3):
            atlas[gi * cell:(gi + 1) * cell, gj * cell:(gj + 1) * cell, ch] = np.clip(s, 0, 1)
    return atlas


def save(name, atlas):
    img = Image.fromarray((np.clip(atlas, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    print('wrote', name, img.size, os.path.getsize(path) // 1024, 'KB')


def main():
    what = [a for a in sys.argv[1:] if not a.startswith('-')] or ['all']
    if 'fire' in what or 'all' in what:
        save('vfx_fire.png', make_fire_atlas())
    if 'smoke' in what or 'all' in what:
        save('vfx_smoke.png', make_smoke_atlas())
    if 'jet' in what or 'all' in what:
        save('vfx_jet.png', make_jet_atlas())
    if 'shapes' in what or 'all' in what:
        save('vfx_shapes.png', make_shapes())


if __name__ == '__main__':
    main()
