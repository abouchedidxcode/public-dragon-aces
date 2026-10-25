"""Glowing crystal clusters for the sky islands (world_crystals.glb, see build_world_assets.py).

Hexagonal prisms with pointed tips, faceted. Vertex colour rgb is the glow gradient (dim at the root, bright at
the tip, multiplied by the island's hue in the shader), alpha is baked occlusion.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from world_mesh import Mesh, loft, flat_shade, write_glb, unit  # noqa: E402

TAU = math.pi * 2


def crystal(base, direction, length, radius, seed, tip_len=0.28):
    d = unit(np.asarray(direction, dtype=float))
    L = length
    path = [base, base + d * L * (1 - tip_len), base + d * L]
    radii = [radius, radius * 0.92, 0.0]

    def col(t, a):
        # dim at the root, hot at the tip; a faint stripe per facet gives them depth
        g = 0.18 + 0.82 * t ** 1.5
        facet = 0.85 + 0.15 * math.sin(a * 3 + seed)
        return (g * facet, g * facet, g * facet, 0.35 + 0.65 * min(1.0, t * 1.5))

    return loft(path, radii, 6, col, cap_bottom=True, cap_top=False, up=(0, 0, 1))


def cluster(seed, n=7, spread=0.55, length=(0.6, 1.0), up=(0, 1, 0)):
    r = np.random.default_rng(seed)
    m = Mesh()
    up = unit(np.asarray(up, dtype=float))
    for i in range(n):
        j = r.normal(size=3) * spread
        d = unit(up + j)
        L = length[0] + (length[1] - length[0]) * r.random() ** 0.7
        if i == 0:
            d = up
            L = length[1] * 1.15
        base = np.array([(r.random() - 0.5) * 0.35, 0.0, (r.random() - 0.5) * 0.35]) if i else np.zeros(3)
        m.merge(crystal(base, d, L, 0.1 + 0.07 * r.random(), seed + i))
    return flat_shade(m)


def build(out_dir):
    meshes = {
        'crystal0': cluster(1, 7),
        'crystal1': cluster(2, 5, spread=0.4, length=(0.7, 1.1)),
        'crystal2': cluster(3, 9, spread=0.75, length=(0.45, 0.9)),
    }
    write_glb(os.path.join(out_dir, 'world_crystals.glb'), meshes)
    for k, v in meshes.items():
        print(f'{k:10s} {v.tri_count():5d} tris')
    return meshes
