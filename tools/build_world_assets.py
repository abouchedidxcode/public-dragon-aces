#!/usr/bin/env python3
"""Builds the procedural world props and writes them into client/assets/ as GLB files.

  python3 tools/build_world_assets.py [--preview out.png] [trees|rocks|ruins|crystals ...]

  world_trees.glb    fir, pine, oak, birch, palm and shrub at three detail levels (_hi, _lo, _far)
  world_rocks.glb    boulders, slabs, scree, spires and sea stacks
  world_ruins.glb    broken towers, walls, arches and columns for the landmark sites
  world_crystals.glb glowing crystal clusters for the sky islands

Everything is generated with numpy (tools/world_mesh.py) and written as plain glTF, so no Blender is needed.
Vertex data the renderer relies on:
  COLOR_0   rgb = linear albedo, a = baked ambient occlusion (1 open ... 0.3 deep inside a crown)
  TEXCOORD0 x = edge factor 0..1 (the shader nibbles the silhouette there), y = 1 on trunks and branches;
            palm fronds use (2 + along, across) so the shader can cut the leaflets out
  NORMAL    foliage uses "proxy" normals pulled toward the crown's ellipsoid, which makes clumps read as soft
            volumes instead of faceted card soup.
Units are metres, y up, the trunk base at y = 0 (trunks continue ~1 m below ground to hide terrain mismatch).
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from world_mesh import Mesh, loft, sphere_blob, icosphere, write_glb, preview, unit, vnoise, fbm, vertex_normals, orient_outward  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'client', 'assets')

TAU = math.pi * 2


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c0, c1, t):
    return tuple(lerp(a, b, t) for a, b in zip(c0, c1))


# ----------------------------------------------------------------------------------------------------------
# conifers


def fir(seed=1, H=26.0, R0=5.0, layers=11, K=10, trunk=True, jag=0.3, lo=False, droop=1.0, bark=(0.05, 0.038, 0.03), leaf=(0.026, 0.062, 0.034), tip=(0.055, 0.105, 0.045)):
    """Spruce / fir: stacked drooping skirts with pointed branch tips."""
    r = np.random.default_rng(seed)
    m = Mesh()
    if trunk:
        tt = 0.86 if lo else 0.98
        path = [(0, -1.4, 0), (0, 0, 0), (0, H * 0.3 * tt, 0), (0, H * 0.7 * tt, 0), (0, H * tt, 0)]
        m.merge(loft(path, [0.62, 0.55, 0.4, 0.2, 0.04], 6 if not lo else 5, lambda t, a: bark + (0.9,), cap_bottom=False))
    crown_c = np.array([0, H * 0.5, 0])
    crown_r = np.array([R0 * 1.2, H * 0.62, R0 * 1.2])
    y0 = 3.0 if not lo else 1.5
    for i in range(layers):
        t = i / (layers - 1)
        y = y0 + t * (H - y0 - 1.4)
        R = R0 * (1 - t) ** 0.85 * (0.9 + 0.2 * r.random()) + 0.3
        drop = R * (0.62 + 0.15 * r.random()) * droop
        off = r.random() * TAU
        rows = []
        # apex, mid ring, outer ring (alternating tip / notch), underside ring
        P, UV, C = [(0, y + R * 0.3 + (0.9 if i == layers - 1 else 0), 0)], [(0, 0)], []
        base = mix(leaf, tip, t * 0.8 + 0.2 * r.random())
        ao_layer = lerp(0.62, 1.0, t)
        C.append(base + (ao_layer * 0.7,))
        for k in range(K):
            a = off + (k + 0.5 * (k % 2) * 0.3) / K * TAU
            P.append((math.cos(a) * R * 0.5, y + R * 0.12, math.sin(a) * R * 0.5))
            UV.append((0.05, 0))
            C.append(base + (ao_layer * 0.75,))
        for k in range(K):
            a = off + k / K * TAU + (r.random() - 0.5) * 0.15
            long_ = (k % 2 == 0)
            rr = R * (1.0 if long_ else 0.7) * (1 + (r.random() - 0.5) * jag)
            yy = y - drop * (1.0 if long_ else 0.55) * (0.85 + 0.3 * r.random())
            P.append((math.cos(a) * rr, yy, math.sin(a) * rr))
            UV.append((1.0 if long_ else 0.8, 0))
            C.append(mix(base, tip, 0.5 if long_ else 0.2) + (1.0 if long_ else 0.9,))
        for k in range(K):
            a = off + (k + 0.5) / K * TAU
            P.append((math.cos(a) * R * 0.28, y - drop * 0.3, math.sin(a) * R * 0.28))
            UV.append((0.2, 0))
            C.append(mix(leaf, bark, 0.35) + (0.3,))
        P = np.array(P)
        mid0, out0, und0 = 1, 1 + K, 1 + 2 * K
        I = []
        for k in range(K):
            k1 = (k + 1) % K
            I.append((0, mid0 + k, mid0 + k1))
            # mid -> outer strip: outer point k sits between mid k and k+1 roughly
            I.append((mid0 + k, out0 + k, out0 + k1))
            I.append((mid0 + k, out0 + k1, mid0 + k1))
            # outer -> underside
            I.append((out0 + k, und0 + k, out0 + k1))
            I.append((und0 + k, und0 + k1, out0 + k1))
        I = np.array(I)
        fn_c = np.array([0, y, 0])
        I = orient_outward(P, I, fn_c + np.array([0, -R * 2.0, 0]) * 0)  # outward from the axis
        # proxy normals
        gn = vertex_normals(P, I)
        pn = unit((P - crown_c) / crown_r ** 2)
        N = unit(gn * 0.4 + pn * 0.6)
        # underside normals face down so they pick up the dark bounce
        N[und0:und0 + K] = unit(N[und0:und0 + K] * 0.5 + np.array([0, -0.5, 0]))
        m.add(P, N, np.array(UV), np.array(C), I)
    return m


def fir_far(seed=2, H=26.0, R0=5.0, leaf=(0.026, 0.062, 0.034), tip=(0.05, 0.1, 0.045)):
    """Two stacked 7-sided cones for far distances (28 triangles)."""
    m = Mesh()
    r = np.random.default_rng(seed)
    for j, (y0, y1, R) in enumerate(((1.5, H * 0.66, R0 * 1.1), (H * 0.36, H, R0 * 0.75))):
        K = 7
        P = [(0, y1, 0)] + [(math.cos(k / K * TAU + j) * R, y0, math.sin(k / K * TAU + j) * R) for k in range(K)] + [(0, y0 + 0.5, 0)]
        P = np.array(P)
        I = [(0, 1 + (k + 1) % K, 1 + k) for k in range(K)] + [(K + 1, 1 + k, 1 + (k + 1) % K) for k in range(K)]
        I = np.array(I)
        I = orient_outward(P, I, np.array([0, (y0 + y1) / 2, 0]))
        c = np.array([mix(leaf, tip, 0.9)] + [mix(leaf, tip, 0.2)] * K + [leaf])
        C = np.hstack([c, np.array([[1.0]] + [[0.9]] * K + [[0.4]])])
        crown_c = np.array([0, H * 0.5, 0])
        gn = vertex_normals(P, I)
        pn = unit((P - crown_c) / np.array([R0 * 1.3, H * 0.6, R0 * 1.3]) ** 2)
        m.add(P, unit(gn * 0.4 + pn * 0.6), None, C, I)
    return m


def pine(seed=3, H=28.0, lo=False, bark=(0.07, 0.045, 0.03), leaf=(0.034, 0.07, 0.048)):
    """Scots pine: tall bare trunk, a few irregular needle pads high up."""
    r = np.random.default_rng(seed)
    m = Mesh()
    path = [(0, -1.4, 0), (0, 0, 0)] + [((r.random() - 0.5) * 0.9 * (k / 5.0), H * k / 5.0, (r.random() - 0.5) * 0.9 * (k / 5.0)) for k in range(1, 6)]
    rad = [0.7, 0.62, 0.52, 0.42, 0.32, 0.2, 0.05]
    m.merge(loft(path, rad, 6 if not lo else 5, lambda t, a: mix(bark, (0.12, 0.07, 0.04), t) + (1.0,), cap_bottom=False))
    top = np.array(path[-2])
    crown_c = np.array([0.0, H * 0.72, 0.0])
    crown_r = np.array([5.4, H * 0.34, 5.4])
    n = 5 if lo else 8
    for i in range(n):
        a = r.random() * TAU + i * 1.7
        t = i / (n - 1)
        y = H * (0.44 + 0.54 * t)
        env = 4.6 * (1 - t) ** 0.75 + 1.1
        rad_off = 0.0 if i == n - 1 else env * (0.35 + 0.5 * r.random())
        c = np.array([math.cos(a) * rad_off, y, math.sin(a) * rad_off])
        rw = env * (0.62 + 0.25 * r.random()) + 0.9
        radii = (rw, 1.5 + 0.7 * r.random(), rw)

        def col(p, nrm, d, base=leaf):
            h = (p[1] - H * 0.55) / (H * 0.45)
            ao = lerp(0.55, 1.0, np.clip(0.5 + 0.5 * nrm[1] + 0.25 * (p[1] - c[1]) / radii[1], 0, 1))
            return mix(base, (0.06, 0.1, 0.05), np.clip(h, 0, 1) * 0.5) + (ao,)

        m.merge(sphere_blob(c, radii, 1 if not lo else 0, 0.42, 1.7, seed + i, col, crown_c, crown_r, 0.7, 0.6))
        if not lo and i > 0:
            # a branch stub reaching the pad
            m.merge(loft([(0, y - 3.5, 0), tuple(c * np.array([0.5, 1, 0.5]) + np.array([0, -2.0, 0])), tuple(c + np.array([0, -1, 0]))], [0.28, 0.2, 0.1], 4, lambda t, a: bark + (0.9,), cap_bottom=False))
    return m


def blob_cone_far(H=28.0):
    return fir_far(seed=5, H=H, R0=3.4, leaf=(0.034, 0.07, 0.048), tip=(0.05, 0.095, 0.05))


# ----------------------------------------------------------------------------------------------------------
# broadleaf


def broadleaf(seed=7, H=15.0, W=7.0, clumps=10, detail=1, bark=(0.075, 0.055, 0.04), leaf=(0.032, 0.068, 0.03), leaf2=(0.07, 0.115, 0.036), white=False, lo=False, branches=True):
    r = np.random.default_rng(seed)
    m = Mesh()
    trunk_h = H * (0.34 if not lo else 0.55)
    path = [(0, -1.4, 0), (0, 0, 0), ((r.random() - 0.5) * 0.4, trunk_h * 0.5, (r.random() - 0.5) * 0.4), ((r.random() - 0.5) * 0.7, trunk_h, (r.random() - 0.5) * 0.7)]
    rad = [0.75 if not white else 0.32, 0.62 if not white else 0.27, 0.42 if not white else 0.2, 0.3 if not white else 0.14]

    def bark_col(t, a):
        if white:
            band = 1.0 if (vnoise(np.array([[a * 2.0, t * 14.0, 0.3]]))[0] > 0.78) else 0.0
            c = mix((0.5, 0.48, 0.43), (0.04, 0.035, 0.03), band)
            return c + (0.95,)
        return bark + (0.9,)

    m.merge(loft(path, rad, 6 if not lo else 4, bark_col, cap_bottom=False))
    crown_c = np.array([0.0, H * 0.66, 0.0])
    crown_r = np.array([W * 0.6, H * 0.4, W * 0.6])
    n = clumps if not lo else 3
    for i in range(n):
        if i == 0:
            c = np.array([0.0, H * (0.78 if not lo else 0.66), 0.0])
        else:
            # clumps sit on a shell around the crown centre: lumpy silhouette, hollow dark core
            a = (i / (n - 1)) * TAU * 2.3 + r.random() * 0.6
            el = 0.1 + 0.8 * r.random()
            rr = W * 0.34 * (0.7 + 0.5 * r.random())
            c = np.array([math.cos(a) * rr * (1 - el * 0.5), H * ((0.4 + 0.42 * el) if not lo else 0.56), math.sin(a) * rr * (1 - el * 0.5)])
        ra = W * (0.2 + 0.1 * r.random()) * (1.0 if not lo else 1.9)
        radii = (ra, ra * (0.7 + 0.15 * r.random()), ra)
        tint = r.random()

        def col(p, nrm, d, c=c, radii=radii, tint=tint):
            up = np.clip(0.5 + 0.5 * nrm[1], 0, 1)
            depth = np.linalg.norm((p - crown_c) / crown_r)
            ao = np.clip(lerp(0.3, 1.1, depth ** 1.8), 0.28, 1.0) * lerp(0.62, 1.0, up)
            return mix(mix(leaf, leaf2, tint * 0.7), leaf2, up * 0.6) + (ao,)

        m.merge(sphere_blob(c, radii, detail if not lo else 0, 0.38, 1.9, seed * 5 + i, col, crown_c, crown_r, 0.72, 0.55, yaw=r.random() * TAU, squash_bottom=0.3))
        if branches and not lo and i > 0 and i <= 4:
            p0 = np.array(path[-1])
            m.merge(loft([tuple(p0), tuple(lerp(p0, c, 0.55) + np.array([0, 0.3, 0])), tuple(c * np.array([0.8, 0.95, 0.8]))], [0.24 if not white else 0.1, 0.16 if not white else 0.07, 0.06], 4, lambda t, a: bark_col(0.5, a), cap_bottom=False))
    return m


def round_far(H=15.0, W=7.0, leaf=(0.05, 0.1, 0.028), leaf2=(0.1, 0.16, 0.04), seed=9):
    m = Mesh()
    V, F = icosphere(0)
    P = V * np.array([W * 0.55, H * 0.32, W * 0.55]) + np.array([0, H * 0.65, 0])
    # a little trunk stub keeps the crown from floating on slopes
    P = np.vstack([P, [(0, -1.4, 0), (0.4, H * 0.3, 0), (-0.4, H * 0.3, 0.4)]])
    r = np.random.default_rng(seed)
    Cv = np.array([np.append(mix(leaf, leaf2, 0.5 * (v[1] + 1) * 0.5 + 0.2 * r.random()), lerp(0.5, 1.0, 0.5 + 0.5 * v[1])) for v in V])
    Cv = np.vstack([Cv, np.array([[0.07, 0.05, 0.04, 0.8]] * 3)])
    N = np.vstack([unit(V * np.array([1.0, 0.8, 1.0]) + np.array([0, 0.25, 0])), np.array([[0, 0.5, 1]] * 3)])
    m.add(P, N, None, Cv, np.vstack([F, [(len(V), len(V) + 1, len(V) + 2)]]))
    return m


# ----------------------------------------------------------------------------------------------------------
# palm


def palm(seed=11, H=10.0, lo=False, bark=(0.13, 0.1, 0.075), frond=(0.04, 0.1, 0.028), frond2=(0.09, 0.17, 0.04)):
    r = np.random.default_rng(seed)
    lean = (r.random() - 0.5) * 2
    K = 7 if not lo else 4
    path = []
    for k in range(K):
        t = k / (K - 1)
        path.append((lean * 2.4 * t * t, -1.0 + (H + 1.0) * t, 0.6 * t * t))
    rad = [0.32 - 0.14 * (k / (K - 1)) for k in range(K)]
    rad[1] += 0.07

    def trunk_col(t, a):
        ring = 0.5 + 0.5 * math.sin(t * 60.0)
        return mix((0.1, 0.075, 0.055), (0.17, 0.13, 0.095), ring) + (0.8 + 0.2 * t,)

    m = Mesh()
    m.merge(loft(path, rad, 6 if not lo else 4, trunk_col, cap_bottom=False))
    top = np.array(path[-1])
    nf = 17 if not lo else 8
    seg = 7 if not lo else 3
    for f in range(nf):
        ang = f / nf * TAU + r.random() * 0.3
        L = 5.8 + 2.2 * r.random()
        th0 = math.radians(34 + 30 * r.random() - (10 if f % 2 else 0))
        W = 1.55
        P, N, UV, C, I = [], [], [], [], []
        dirh = np.array([math.cos(ang), 0, math.sin(ang)])
        side = np.array([-dirh[2], 0, dirh[0]])
        centers = []
        for k in range(seg + 1):
            s = k / seg
            y = math.sin(th0) * L * s - 0.85 * L * s * s
            h = math.cos(th0) * L * s
            centers.append(top + dirh * h + np.array([0, y, 0]))
        centers = np.array(centers)
        for k in range(seg + 1):
            s = k / seg
            w = W * math.sin(math.pi * min(1.0, s * 0.92 + 0.08) ** 0.8) * (1.0 if k else 0.15) + 0.04
            tang = unit(centers[min(k + 1, seg)] - centers[max(k - 1, 0)])
            nrm = unit(np.cross(side, tang))
            if nrm[1] < 0:
                nrm = -nrm
            for v, sg in ((0, -1), (1, 1)):
                # leaflets droop sideways: the outer edge sits lower
                P.append(centers[k] + side * sg * w + np.array([0, -abs(w) * 0.45, 0]))
                N.append(unit(nrm * 0.85 + np.array([0, 1, 0]) * 0.4 + side * sg * 0.25))
                UV.append((2 + s, v))
                C.append(mix(frond, frond2, 0.3 + 0.5 * s * r.random()) + (lerp(0.55, 1.0, s),))
        for k in range(seg):
            a, b, c2, d = 2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 3
            I += [(a, b, c2), (b, d, c2)]
        m.add(np.array(P), np.array(N), np.array(UV), np.array(C), np.array(I))
    # coconuts
    if not lo:
        for q in range(3):
            a = q / 3 * TAU
            m.merge(sphere_blob(top + np.array([math.cos(a) * 0.35, -0.35, math.sin(a) * 0.35]), (0.22, 0.26, 0.22), 0, 0.05, 1, q, lambda p, n, d: (0.09, 0.07, 0.04, 0.9), None, None, 0.0, 0.0))
    return m


# ----------------------------------------------------------------------------------------------------------
# shrub


def shrub(seed=21, R=1.1, lo=False, leaf=(0.045, 0.09, 0.03), leaf2=(0.09, 0.14, 0.04)):
    r = np.random.default_rng(seed)
    m = Mesh()
    crown_c = np.array([0, R * 0.55, 0])
    crown_r = np.array([R * 1.3, R * 0.8, R * 1.3])
    for i in range(4 if not lo else 2):
        a = r.random() * TAU
        c = np.array([math.cos(a) * R * 0.5 * (i > 0), R * (0.5 + 0.2 * r.random()), math.sin(a) * R * 0.5 * (i > 0)])
        ra = R * (0.62 + 0.25 * r.random())
        tint = r.random()

        def col(p, n, d, tint=tint):
            up = 0.5 + 0.5 * n[1]
            depth = np.linalg.norm((p - crown_c) / crown_r)
            return mix(mix(leaf, leaf2, tint), leaf2, up * 0.4) + (np.clip(lerp(0.45, 1.0, depth ** 1.3), 0.4, 1.0),)

        m.merge(sphere_blob(c, (ra, ra * 0.8, ra), 1 if not lo else 0, 0.3, 2.2, seed + i, col, crown_c, crown_r, 0.7, 0.55, squash_bottom=0.5))
    return m


# ----------------------------------------------------------------------------------------------------------


def build_trees():
    meshes = {
        'fir_hi': fir(1, layers=11, K=10),
        'fir_lo': fir(2, layers=4, K=6, trunk=True, lo=True, droop=2.3, R0=5.6),
        'fir_far': fir_far(3),
        'pine_hi': pine(4, H=24.0),
        'pine_lo': pine(5, H=24.0, lo=True),
        'pine_far': blob_cone_far(24.0),
        'oak_hi': broadleaf(6, H=16.0, W=10.5, clumps=10),
        'oak_lo': broadleaf(7, H=16.0, W=10.5, lo=True),
        'oak_far': round_far(16.0, 10.5, seed=8),
        'birch_hi': broadleaf(9, H=17.0, W=7.4, clumps=8, white=True, leaf=(0.075, 0.15, 0.04), leaf2=(0.14, 0.22, 0.05)),
        'birch_lo': broadleaf(10, H=17.0, W=7.4, lo=True, white=True, leaf=(0.075, 0.15, 0.04), leaf2=(0.14, 0.22, 0.05)),
        'birch_far': round_far(17.0, 7.4, leaf=(0.075, 0.15, 0.04), leaf2=(0.14, 0.22, 0.05), seed=11),
        'palm_hi': palm(12),
        'palm_lo': palm(13, lo=True),
        'shrub_hi': shrub(14),
        'shrub_lo': shrub(15, lo=True),
    }
    return meshes


def main():
    args = sys.argv[1:]
    prev = None
    if '--preview' in args:
        i = args.index('--preview')
        prev = args[i + 1]
        del args[i:i + 2]
    which = args or ['trees']
    os.makedirs(OUT, exist_ok=True)
    allm = {}
    if 'trees' in which:
        t = build_trees()
        write_glb(os.path.join(OUT, 'world_trees.glb'), t)
        for k, v in t.items():
            print(f'{k:12s} {v.tri_count():5d} tris')
        print('world_trees.glb', os.path.getsize(os.path.join(OUT, 'world_trees.glb')) // 1024, 'KB')
        allm.update(t)
    if 'rocks' in which:
        import build_world_rocks
        t = build_world_rocks.build(OUT)
        allm.update(t)
    if 'ruins' in which:
        import build_world_ruins
        t = build_world_ruins.build(OUT)
        allm.update(t)
    if 'crystals' in which:
        import build_world_crystals
        allm.update(build_world_crystals.build(OUT))
    if prev:
        preview(prev, allm, views=((0.5, 0.12),), cols=6, extent=30.0 if 'trees' in which else None)


if __name__ == '__main__':
    main()
