"""The bleached skeleton of a colossal dragon: skull, spine segments, ribs, tail (pieces of world_ruins.glb).

Bone is ivory vertex colour (rgb tint, alpha baked occlusion) over the rock texture in the shader. Pieces are built
along +x: the spine runs along x, the skull's snout points +x, a rib arcs out in +z and over in +y.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from world_mesh import Mesh, loft, vertex_normals, unit, fbm, vnoise  # noqa: E402

TAU = math.pi * 2
IVORY = np.array([0.78, 0.72, 0.6])


def bone_col(seed, grime=0.0):
    def f(t, a):
        n = vnoise(np.array([[math.cos(a) * 2, t * 5.0, math.sin(a) * 2]]), seed)[0]
        g = 0.82 + 0.3 * n - grime * (1 - t)
        return (IVORY[0] * g, IVORY[1] * g, IVORY[2] * g, 0.55 + 0.45 * min(1.0, t * 2.0 + 0.2))

    return f


def rib(seed, R=9.0, thick=0.9, sweep=2.45):
    """One rib: leaves the spine going out (+z), rises and curls back in over the top."""
    pts, rad = [], []
    n = 18
    for k in range(n + 1):
        t = k / n
        phi = t * sweep
        pts.append((math.sin(phi * 0.5) * 1.2 * t, 1.0 + R * (1 - math.cos(phi)) * 1.12, R * math.sin(phi) * 0.95))
        rad.append(max(0.08, thick * (1 - t) ** 0.8 * (1 + 0.5 * math.exp(-t * 14)) + 0.1))
    m = loft(np.array(pts), np.array(rad), 8, bone_col(seed), cap_bottom=True, cap_top=True, up=(1, 0, 0))
    P, N, UV, C, I = m.arrays()
    P = P.copy()
    P += (np.stack([fbm(P * 0.9 + seed, 2, seed), fbm(P * 0.9 + seed + 3, 2, seed + 1), fbm(P * 0.9 + seed + 7, 2, seed + 2)], 1) - 0.5) * 0.25
    out = Mesh()
    out.add(P, vertex_normals(P, I), UV, C, I)
    return out


def vertebra(x, seed, s=1.0):
    m = Mesh()
    # centrum: a squat cylinder along x with flared ends
    path = [(x - 1.7 * s, 2.2, 0), (x - 1.3 * s, 2.2, 0), (x + 1.3 * s, 2.2, 0), (x + 1.7 * s, 2.2, 0)]
    m.merge(loft(np.array(path), np.array([1.1 * s, 1.5 * s, 1.5 * s, 1.1 * s]), 8, bone_col(seed), cap_bottom=True, cap_top=True, up=(0, 1, 0)))
    # neural spine, up and slightly back
    m.merge(loft(np.array([(x, 3.0 * s, 0), (x - 0.5 * s, 4.8 * s, 0), (x - 1.2 * s, 7.0 * s, 0)]), np.array([0.7 * s, 0.5 * s, 0.1 * s]), 6, bone_col(seed + 1), True, False, up=(0, 0, 1)))
    # transverse processes
    for sg in (-1, 1):
        m.merge(loft(np.array([(x, 2.4 * s, sg * 1.2 * s), (x, 2.0 * s, sg * 3.0 * s), (x - 0.3 * s, 1.5 * s, sg * 4.4 * s)]), np.array([0.5 * s, 0.38 * s, 0.1 * s]), 6, bone_col(seed + 2), True, False, up=(1, 0, 0)))
    return m


def spine(seed, n=8, length=26.0):
    m = Mesh()
    for i in range(n):
        s = 1.0
        m.merge(vertebra(i * length / n + 1.6, seed + i * 3, s))
    return m


def tail(seed, n=9):
    m = Mesh()
    for i in range(n):
        s = 1.0 - i * 0.09
        m.merge(vertebra(i * 3.6 * (1 - i * 0.03) + 1.6, seed + i * 3, max(0.25, s * 0.8)))
    return m


def skull(seed):
    """~22 m long dragon skull, snout toward +x. Upper skull, open lower jaw, teeth, horns and dark eye sockets."""
    m = Mesh()
    L = 22.0
    # upper skull: elliptical sections from the back of the head (x = 0) to the snout tip
    xs = [0.0, 3.5, 7.5, 11.0, 14.5, 17.5, 20.0, 22.0]
    rw = [4.4, 4.6, 3.5, 2.7, 2.2, 1.7, 1.2, 0.5]
    rh = [3.7, 4.3, 3.4, 2.5, 1.7, 1.25, 0.9, 0.4]
    path = [(x, 6.5 + 0.0 * x, 0) for x in xs]
    # vertical centre line rises over the brow
    cy = [6.2, 7.2, 7.4, 6.8, 6.1, 5.6, 5.3, 5.1]
    path = np.array([(x, y, 0) for x, y in zip(xs, cy)])
    radii = np.stack([rh, rw], 1)  # loft radii pair = (along first frame axis, second)
    m.merge(loft(path, radii, 14, bone_col(seed, 0.1), cap_bottom=True, cap_top=True, up=(0, 1, 0)))
    # lower jaw: slimmer, swung open about the back of the head
    jx = [1.0, 4.0, 8.0, 12.0, 16.0, 19.0, 21.0]
    jw = [3.0, 2.7, 2.1, 1.7, 1.3, 0.95, 0.5]
    jh = [1.6, 1.5, 1.2, 0.9, 0.7, 0.5, 0.3]
    jy = [3.6, 3.0, 2.0, 1.1, 0.5, 0.15, 0.0]
    jpath = np.array([(x, y, 0) for x, y in zip(jx, jy)])
    m.merge(loft(jpath, np.stack([jh, jw], 1), 10, bone_col(seed + 5, 0.15), True, True, up=(0, 1, 0)))
    # teeth along both jaws
    for i in range(11):
        x = 9.0 + i * 1.15
        for sg in (-1, 1):
            w = np.interp(x, xs, rw) * 0.78
            y0 = np.interp(x, xs, cy) - np.interp(x, xs, rh) * 0.8
            m.merge(loft(np.array([(x, y0, sg * w), (x + 0.1, y0 - 0.9, sg * w), (x + 0.2, y0 - 1.9, sg * w * 0.98)]), np.array([0.28, 0.2, 0.02]), 5, bone_col(seed + 9), True, False, up=(1, 0, 0)))
    for i in range(9):
        x = 10.0 + i * 1.1
        for sg in (-1, 1):
            w = np.interp(x, jx, jw) * 0.78
            y0 = np.interp(x, jx, jy) + np.interp(x, jx, jh) * 0.6
            m.merge(loft(np.array([(x, y0, sg * w), (x - 0.1, y0 + 0.8, sg * w), (x - 0.2, y0 + 1.6, sg * w * 0.97)]), np.array([0.25, 0.18, 0.02]), 5, bone_col(seed + 11), True, False, up=(1, 0, 0)))
    # horns sweeping back and up
    for sg in (-1, 1):
        hp = np.array([(4.0, 9.0, sg * 3.0), (0.5, 11.5, sg * 4.2), (-3.5, 14.5, sg * 4.6), (-7.0, 16.8, sg * 4.2)])
        m.merge(loft(hp, np.array([0.95, 0.75, 0.45, 0.06]), 7, bone_col(seed + 13), True, False, up=(0, 0, 1)))
    # eye sockets and nostril: dark recessed quads on the sides of the skull
    for sg in (-1, 1):
        for cx, cyy, cz, wd, hh in ((10.5, 7.2, sg * 2.62, 2.4, 1.9), (20.8, 5.2, sg * 0.6, 0.6, 0.5)):
            P = np.array([(cx - wd / 2, cyy - hh / 2, cz), (cx + wd / 2, cyy - hh / 2, cz), (cx + wd / 2, cyy + hh / 2, cz), (cx - wd / 2, cyy + hh / 2, cz)])
            q = Mesh()
            q.add(P, np.tile([0, 0, sg], (4, 1)), None, np.tile([0.015, 0.012, 0.01, 0.2], (4, 1)), np.array([(0, 1, 2), (0, 2, 3)] if sg > 0 else [(0, 2, 1), (0, 3, 2)]))
            m.merge(q)
    return m
