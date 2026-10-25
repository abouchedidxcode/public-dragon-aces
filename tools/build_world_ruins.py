"""Ruined towers, walls, gates, pillars, steps and an altar for world_ruins.glb (see build_world_assets.py).

Pieces are chunky cut-stone shapes with noise-chipped edges, jagged broken tops and baked occlusion. Albedo
comes from the Poly Haven `large_sandstone_blocks` texture (triplanar in the shader), vertex colour rgb is a tint
multiplier and alpha the baked occlusion. Dark recessed quads fake windows and doorways.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from world_mesh import Mesh, vertex_normals, write_glb, unit, fbm, vnoise, loft  # noqa: E402

TAU = math.pi * 2
STONE = np.array([0.98, 0.9, 0.78])


def tint(P, seed, k=0.22):
    n = fbm(P * 0.35 + seed, 3, seed)
    t = 0.86 + k * 2 * (n - 0.5) + 0.12
    return t


def mesh_from(P, I, seed, ao=None, flat=False, dark=None):
    I = np.asarray(I)
    N = vertex_normals(P, I)
    t = tint(P, seed)
    C = np.stack([STONE[0] * t, STONE[1] * t, STONE[2] * t, np.ones(len(P)) if ao is None else ao], 1)
    if dark is not None:
        C[dark, :3] *= 0.12
        C[dark, 3] = 0.3
    m = Mesh()
    m.add(P, N, None, C, I)
    return m


def cyl_shell(r_bottom, r_top, y0, heights_fn, sides, rings, seed, wobble=0.1, inner=None):
    """Tapered cylinder wall. heights_fn(angle) -> top height at that angle (jagged breaks). Optionally an inner
    shell of radius `inner` (fraction of the outer radius) so broken tops show wall thickness."""
    P, I = [], []
    ao = []
    for shell, rf in enumerate([1.0] + ([inner] if inner else [])):
        base = len(P)
        for k in range(rings + 1):
            for s in range(sides):
                a = s / sides * TAU
                top = heights_fn(a)
                y = y0 + (top - y0) * k / rings
                t = (y - y0) / max(top - y0, 1e-3)
                rad = (r_bottom + (r_top - r_bottom) * ((y - y0) / 24.0)) * rf
                rad *= 1 + wobble * (vnoise(np.array([[math.cos(a) * 2.3, y * 0.35, math.sin(a) * 2.3]]), seed)[0] - 0.5) * 0.5
                P.append((math.cos(a) * rad, y, math.sin(a) * rad))
                ao.append(0.45 + 0.55 * min(1.0, (y - y0) / 5.0 + 0.2) if shell == 0 else 0.4)
        for k in range(rings):
            for s in range(sides):
                s2 = (s + 1) % sides
                a, b = base + k * sides + s, base + k * sides + s2
                c, d = a + sides, b + sides
                if shell == 0:
                    I += [(a, c, b), (b, c, d)]
                else:
                    I += [(a, b, c), (b, d, c)]
    return np.array(P), np.array(I), np.array(ao)


def tower(seed, broken=False, H=24.0, R=5.0):
    r = np.random.default_rng(seed)
    sides, rings = 20, 12
    phase = r.random() * 6
    if broken:
        def hf(a):
            return 14.0 + 3.0 * math.sin(a * 2 + phase) + 4.0 * max(0.0, math.sin(a * 3 + phase * 1.3)) + 1.2 * vnoise(np.array([[a * 3, 0, 1.0]]), seed)[0]
    else:
        def hf(a):
            return H
    P, I, ao = cyl_shell(R + 0.3, R - 0.7, -1.5, hf, sides, rings, seed, 0.12, inner=0.72)
    m = mesh_from(P, I, seed, ao)
    # ledge rings and a crenellated crown on the intact tower
    extra = Mesh()
    for y in ([6.0, 12.5] if broken else [6.0, 12.5, 18.0]):
        pp, ii = [], []
        for s in range(sides + 1):
            a = s / sides * TAU
            for dy, dr in ((-0.35, 0.0), (0.0, 0.42), (0.35, 0.0)):
                pp.append((math.cos(a) * (R + 0.25 - y * 0.029 + dr), y + dy, math.sin(a) * (R + 0.25 - y * 0.029 + dr)))
        for s in range(sides):
            for q in range(2):
                a0 = s * 3 + q
                b0 = (s + 1) * 3 + q
                ii += [(a0, a0 + 1, b0), (b0, a0 + 1, b0 + 1)]
        pp = np.array(pp)
        extra.merge(mesh_from(pp, np.array(ii), seed + int(y), None))
    m.merge(extra)
    if not broken:
        # merlons around the top
        for s in range(10):
            a = s / 10 * TAU + 0.15
            c = np.array([math.cos(a) * (R - 0.65), H, math.sin(a) * (R - 0.65)])
            m.merge(box(c, (1.3, 1.5, 1.6), a, seed + s, 2))
    # windows / doorway: dark recessed quads
    for y, a0, wd, hh in ([(3.2, 0.0, 1.6, 2.6), (9.0, 1.6, 0.9, 1.7), (15.0, 3.3, 0.9, 1.7)] if not broken else [(3.2, 0.0, 1.6, 2.6), (9.0, 1.6, 0.9, 1.7)]):
        a = a0 + phase
        rad = R + 0.3 - y * 0.029 + 0.04
        c = np.array([math.cos(a) * rad, y + hh / 2, math.sin(a) * rad])
        tang = np.array([-math.sin(a), 0, math.cos(a)])
        up = np.array([0, 1, 0])
        out = np.array([math.cos(a), 0, math.sin(a)])
        Pq = np.array([c - tang * wd / 2 - up * hh / 2, c + tang * wd / 2 - up * hh / 2, c + tang * wd / 2 + up * hh / 2, c - tang * wd / 2 + up * hh / 2])
        Cq = np.tile([0.012, 0.01, 0.01, 0.15], (4, 1))
        q = Mesh()
        q.add(Pq, np.tile(out, (4, 1)), None, Cq, np.array([(0, 1, 2), (0, 2, 3)]))
        m.merge(q)
    return m


def box(center, size, yaw, seed, res=3, chip=0.1, bottom=True):
    """A chipped box (subdivided faces displaced by noise). size = (x, y, z) full extents; centre at the box centre."""
    sx, sy, sz = size
    P, I, ao = [], [], []

    def face(o, u, v, nu, nv, n):
        base = len(P)
        for j in range(nv + 1):
            for i in range(nu + 1):
                P.append(o + u * i / nu + v * j / nv)
        for j in range(nv):
            for i in range(nu):
                a = base + j * (nu + 1) + i
                b, c, d = a + 1, a + nu + 1, a + nu + 2
                I.extend([(a, c, b), (b, c, d)] if n > 0 else [(a, b, c), (b, d, c)])

    hx, hy, hz = sx / 2, sy / 2, sz / 2
    X, Y, Z = np.array([sx, 0, 0]), np.array([0, sy, 0]), np.array([0, 0, sz])
    o = np.array([-hx, -hy, -hz])
    r = res
    face(o + Z, X, Y, r, r, 1)       # +z
    face(o, Y, X, r, r, 1)           # -z
    face(o + X, Y, Z, r, r, 1)       # +x
    face(o, Z, Y, r, r, 1)           # -x
    face(o + Y, Z, X, r, r, 1)       # +y
    if bottom:
        face(o, X, Z, r, r, 1)       # -y
    P = np.array(P)
    I = np.array(I)
    # fix winding so every face points outward
    cen = P[I].mean(1)
    fn = np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]])
    flip = np.einsum('ij,ij->i', fn, cen) < 0
    I[flip] = I[flip][:, ::-1]
    edge = np.minimum(np.minimum(hx - np.abs(P[:, 0]), hy - np.abs(P[:, 1])), hz - np.abs(P[:, 2]))
    n = vnoise(P * 1.7 + seed, seed) - 0.5
    P = P + unit(P) * (n * chip * (edge < 0.05))[:, None]
    cs, sn = math.cos(yaw), math.sin(yaw)
    Rm = np.array([[cs, 0, sn], [0, 1, 0], [-sn, 0, cs]])
    P = P @ Rm.T + center
    ao = np.clip(0.55 + 0.45 * (P[:, 1] - (center[1] - hy)) / max(sy, 1e-3) * 1.3, 0.5, 1.0)
    return mesh_from(P, I, seed, ao)


def wall(seed, variant=0, L=12.0, H=5.5, T=1.8):
    r = np.random.default_rng(seed)
    segs = 14
    P, I, ao = [], [], []
    # a wall profile along x: top height varies; variant 0 crenellated, 1 broken in the middle, 2 collapsed rubble
    xs = np.linspace(-L / 2, L / 2, segs + 1)

    def top(x):
        if variant == 0:
            return H + (0.0 if int((x + L) * 1.4) % 2 else 1.0) * 0.9
        if variant == 1:
            return H * (0.35 + 0.65 * smooth(abs(x) / (L / 2))) + 0.5 * vnoise(np.array([[x * 0.8, 0, seed]]), seed)[0]
        return 1.6 + 1.8 * vnoise(np.array([[x * 0.5, 0, seed]]), seed)[0]

    m = Mesh()
    # build as stacked boxes (courses) so the silhouette steps like masonry
    course = 0.9
    for i in range(segs):
        x0, x1 = xs[i], xs[i + 1]
        xc = (x0 + x1) / 2
        h = top(xc)
        nc = max(1, int(h / course))
        for c in range(nc):
            ch = min(course, h - c * course)
            if ch < 0.2:
                continue
            jitter = (r.random() - 0.5) * 0.12
            m.merge(box(np.array([xc, c * course + ch / 2, jitter]), (x1 - x0 + 0.02, ch, T + (r.random() - 0.5) * 0.1), 0.0, seed + i * 13 + c, 2, chip=0.07, bottom=False))
    if variant == 2:
        for q in range(7):
            s = 0.5 + r.random() * 0.9
            m.merge(box(np.array([(r.random() - 0.5) * L * 1.2, s / 2 * 0.6, (r.random() - 0.5) * 4.0]), (s, s * 0.7, s * 0.9), r.random() * TAU, seed + 100 + q, 2, chip=0.12))
    return m


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def pillar(seed, broken=False, H=10.0, R=1.0):
    r = np.random.default_rng(seed)
    sides = 12
    ph = r.random() * 6

    def hf(a):
        if broken:
            return 4.5 + 1.4 * math.sin(a * 2 + ph) + 0.7 * math.sin(a * 5 + ph)
        return H

    P, I, ao = cyl_shell(R * 1.05, R * 0.9, -1.2, hf, sides, 8, seed, 0.1)
    m = mesh_from(P, I, seed, ao)
    # square base block
    m.merge(box(np.array([0, 0.3, 0]), (R * 2.9, 1.5, R * 2.9), r.random(), seed + 1, 2, chip=0.08))
    if not broken:
        m.merge(box(np.array([0, H + 0.35, 0]), (R * 3.0, 0.8, R * 3.0), r.random(), seed + 2, 2, chip=0.08))
    return m


def arch(seed):
    r = np.random.default_rng(seed)
    m = Mesh()
    for sx in (-1, 1):
        for c in range(8):
            h = 1.9
            m.merge(box(np.array([sx * 5.6 + (r.random() - 0.5) * 0.12, c * h + h / 2 - 0.4, (r.random() - 0.5) * 0.1]), (3.9 - c * 0.04, h + 0.02, 3.4), 0, seed + c + sx * 20, 2, chip=0.07, bottom=False))
    # voussoirs: wedge blocks around a semicircle (a few missing)
    n = 13
    for k in range(n):
        a0 = math.pi * k / n
        a1 = math.pi * (k + 1) / n
        am = (a0 + a1) / 2
        if k in (4, 8) and seed % 2:
            continue
        R0, R1 = 3.5, 5.55
        cx, cy = 0.0, 12.4
        w = (R1 - R0)
        arc = (R0 + R1) / 2 * (a1 - a0)
        c = np.array([math.cos(am) * (R0 + R1) / 2, cy + math.sin(am) * (R0 + R1) / 2, 0])
        b = box(np.array([0, 0, 0]), (arc * 1.03, w, 3.4), 0, seed + k, 2, chip=0.06)
        P, N, UV, C, I = b.arrays()
        # rotate each block so its long side follows the arch: rotate about z by (am - pi/2)
        ang = am - math.pi / 2
        ca, sa = math.cos(ang), math.sin(ang)
        Rz = np.array([[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]])
        P = P @ Rz.T + c
        N = N @ Rz.T
        bm = Mesh()
        bm.add(P, N, UV, C, I)
        m.merge(bm)
    m.merge(box(np.array([0, 17.6, 0]), (1.7, 2.0, 3.5), 0, seed + 55, 2, chip=0.07))
    return m


def steps(seed, R=22.0):
    r = np.random.default_rng(seed)
    P, I, ao = [], [], []
    m = Mesh()
    levels = [(R, 0.0, 0.5), (R - 2.6, 0.5, 1.0), (R - 5.2, 1.0, 1.5)]
    for (rad, y0, y1) in levels:
        sides = 48
        pp, ii, aa = [], [], []
        for k, (y, rr) in enumerate(((y0 - 0.8, rad), (y1, rad), (y1, rad - 2.6))):
            for s in range(sides):
                a = s / sides * TAU
                n = vnoise(np.array([[math.cos(a) * 2.0, y, math.sin(a) * 2.0]]), seed)[0]
                drop = 0.6 * max(0.0, n - 0.62) * 3
                pp.append((math.cos(a) * rr, y - (drop if k == 1 or k == 2 else 0), math.sin(a) * rr))
                aa.append(0.7 if k == 0 else 1.0)
        for k in range(2):
            for s in range(sides):
                s2 = (s + 1) % sides
                a, b = k * sides + s, k * sides + s2
                c, d = a + sides, b + sides
                ii += [(a, c, b), (b, c, d)] if k == 0 else [(a, b, c), (b, d, c)]
        m.merge(mesh_from(np.array(pp), np.array(ii), seed + int(y1 * 10), np.array(aa)))
    return m


def altar(seed):
    m = Mesh()
    m.merge(box(np.array([0, 2.2, 0]), (7.0, 1.4, 7.0), 0.2, seed, 3, chip=0.1))
    m.merge(box(np.array([0, 3.7, 0]), (3.6, 1.6, 2.0), 0.0, seed + 1, 3, chip=0.1))
    for sx in (-1, 1):
        m.merge(box(np.array([sx * 2.6, 3.4, 2.2]), (0.9, 1.0, 0.9), 0.3, seed + 3 + sx, 2, chip=0.06))
    return m


def build(out_dir):
    meshes = {
        'tower0': tower(1, False),
        'tower1': tower(2, True),
        'wall0': wall(3, 0),
        'wall1': wall(4, 1),
        'wall2': wall(5, 2),
        'arch0': arch(6),
        'pillar0': pillar(7, False),
        'pillar1': pillar(8, True),
        'steps0': steps(9),
        'altar0': altar(10),
    }
    import build_world_bones as bones
    meshes.update({'rib0': bones.rib(21), 'rib1': bones.rib(22, R=9.5, thick=0.75, sweep=2.2), 'spine0': bones.spine(23), 'tail0': bones.tail(24), 'skull0': bones.skull(25)})
    write_glb(os.path.join(out_dir, 'world_ruins.glb'), meshes)
    for k, v in meshes.items():
        print(f'{k:10s} {v.tri_count():5d} tris')
    print('world_ruins.glb', os.path.getsize(os.path.join(out_dir, 'world_ruins.glb')) // 1024, 'KB')
    return meshes
