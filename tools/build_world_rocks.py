"""Boulders, slabs and sea stacks for world_rocks.glb (see build_world_assets.py).

Rock shapes: a noise-displaced icosphere clipped by a few random planes (gives the angular faces real rock has),
flattened on the bottom so it sits in the ground. Albedo comes from the terrain's rock textures in the shader
(triplanar); vertex colour carries a tint multiplier in rgb and baked occlusion in alpha.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from world_mesh import Mesh, icosphere, vertex_normals, write_glb, unit, fbm, vnoise, loft  # noqa: E402

TAU = math.pi * 2


def rock(seed, scale=(1, 0.8, 1), planes=5, plane_d=(0.55, 0.8), detail=2, bump=0.32, flat_bottom=-0.5):
    r = np.random.default_rng(seed)
    V, F = icosphere(detail)
    P = V.copy()
    n = fbm(P * 1.15 + seed * 3.1, 3, seed)
    P *= (1 + bump * (n - 0.5) * 2)[:, None]
    for _ in range(planes):
        nrm = unit(r.normal(size=3) + np.array([0, 0.25, 0]))
        d = plane_d[0] + (plane_d[1] - plane_d[0]) * r.random()
        s = P @ nrm - d
        P -= np.where(s > 0, s, 0)[:, None] * nrm
    P[:, 1] = np.maximum(P[:, 1], flat_bottom)
    # crisp small-scale roughness
    P += unit(V) * ((fbm(V * 5.0 + seed, 2, seed + 4) - 0.5) * 0.06)[:, None]
    P *= np.asarray(scale)
    N = vertex_normals(P, F)
    # tint: slight per-vertex variation; occlusion darker low down and in crevices (where the surface dips)
    cr = fbm(V * 2.3 + seed * 1.7, 3, seed + 9)
    ao = np.clip(0.55 + 0.45 * (P[:, 1] / max(P[:, 1].max(), 1e-3) * 0.5 + 0.5), 0.35, 1.0) * (0.75 + 0.25 * cr)
    tint = 0.85 + 0.3 * fbm(V * 3.1 + seed, 2, seed + 2)
    C = np.stack([tint, tint, tint, ao], 1)
    m = Mesh()
    m.add(P, N, None, C, F)
    return m


def stack(seed, ledges=4, lean=0.0, planes=10):
    """A sea stack, unit height (y 0..1) and unit base radius: a faceted column, flared at the foot, with ledges,
    clipped by near-vertical planes like real stacks, a ragged crown and a slight lean."""
    r = np.random.default_rng(seed)
    V, F = icosphere(3)
    P = V.copy()
    P[:, 1] *= 2.4
    n = fbm(V * 1.7 + seed * 2.3, 3, seed)
    P[:, 0] *= 1 + 0.5 * (n - 0.5) * 2
    P[:, 2] *= 1 + 0.5 * (n - 0.5) * 2
    for _ in range(planes):
        a = r.random() * TAU
        nrm = unit(np.array([math.cos(a), (r.random() - 0.5) * 0.5, math.sin(a)]))
        d = 0.55 + 0.3 * r.random()
        s = P @ nrm - d
        P -= np.where(s > 0, s, 0)[:, None] * nrm
    y01 = np.clip((P[:, 1] / 2.4 + 1) / 2, 0, 1)
    flare = 1 + 0.55 * np.exp(-y01 * 7.0)
    ledge = 1 + 0.08 * np.sin(y01 * ledges * TAU + r.random() * 6) * (1 - y01)
    P[:, 0] = P[:, 0] * flare * ledge + lean * y01 * y01
    P[:, 2] = P[:, 2] * flare * ledge
    # ragged crown: jitter the top
    P[:, 1] = y01 + (fbm(V * 4.0 + seed, 2, seed + 3) - 0.5) * 0.04 * (y01 > 0.85)
    P[:, 1] = np.clip(P[:, 1], 0, 1.0)
    N = vertex_normals(P, F)
    cr = fbm(V * 2.2 + seed, 3, seed + 5)
    ao = np.clip(0.4 + 0.75 * y01, 0.4, 1.0) * (0.8 + 0.2 * cr)
    tint = 0.85 + 0.3 * fbm(V * 3.0 + seed, 2, seed + 7)
    C = np.stack([tint, tint, tint, ao], 1)
    m = Mesh()
    m.add(P, N, None, C, F)
    return m


def build(out_dir):
    meshes = {
        'rock0': rock(1, (1.0, 0.85, 1.0), planes=3, detail=2, bump=0.3),
        'rock1': rock(2, (1.0, 0.9, 0.9), planes=7, plane_d=(0.5, 0.75), detail=2, bump=0.25),
        'rock2': rock(3, (1.7, 0.5, 1.25), planes=4, plane_d=(0.55, 0.85), detail=2, bump=0.22),
        'rock3': rock(4, (0.75, 1.5, 0.85), planes=6, plane_d=(0.5, 0.8), detail=2, bump=0.28),
        'rock4': rock(5, (1.2, 0.8, 1.0), planes=5, plane_d=(0.55, 0.8), detail=2, bump=0.35),
        'stack0': stack(11, lean=0.08),
        'stack1': stack(12, lean=-0.1, ledges=3, planes=8),
        'stack2': stack(13, lean=0.04, ledges=5, planes=12),
    }
    write_glb(os.path.join(out_dir, 'world_rocks.glb'), meshes)
    for k, v in meshes.items():
        print(f'{k:10s} {v.tri_count():5d} tris')
    print('world_rocks.glb', os.path.getsize(os.path.join(out_dir, 'world_rocks.glb')) // 1024, 'KB')
    return meshes
