"""Builds the rigged dragon in Blender and exports client/assets/dragon.glb.

  python -m pip install bpy==5.2.2      (Blender as a Python module; or run inside Blender)
  python tools/build_dragon.py [--preview out.png]

Every part is lofted from elliptical cross-sections along a skeleton (body, neck, head, jaw, tail, limbs,
wing arms, horns, spikes), smoothed with a Subdivision Surface modifier, then joined into two skinned meshes
on one armature:
  Body   vertex colour masks: R = belly, G = horn/claw/teeth/spikes, B = eyes (emissive), A = mouth interior
  Wings  membranes; vertex colour R = distance from the bones (thin membrane glows when backlit)
The rest pose is the flight pose (wings spread, legs tucked). The game animates the bones in code.
Axes: Blender +Y is the dragon's forward and +Z up, which the glTF exporter turns into three.js -Z / +Y.
"""
import math
import os
import random
import sys
import time

import numpy as np

import bpy
from mathutils import Vector, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '..', 'client', 'assets')
OUT = os.path.join(ASSETS, 'dragon.glb')

def V(*a):
    return Vector(a[0] if len(a) == 1 else a)


def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def lerpv(a, b, t):
    return a.lerp(b, t)


# --------------------------------------------------------------------------------------------------
# skeleton (Blender coordinates)

SPINE = [
    # name, y, z, rx (half width), rz (half height)
    ('tip', 8.34, 0.30, 0.15, 0.13),
    ('snout', 7.98, 0.38, 0.27, 0.2),
    ('nose', 7.55, 0.50, 0.34, 0.27),
    ('brow', 7.0, 0.70, 0.50, 0.43),
    ('skull', 6.4, 0.74, 0.62, 0.53),
    ('nape', 5.85, 0.55, 0.46, 0.46),
    ('n2', 5.0, 0.32, 0.46, 0.52),
    ('n3', 4.1, 0.12, 0.58, 0.64),
    ('n4', 3.2, -0.04, 0.85, 0.88),
    ('chest', 2.1, -0.15, 1.34, 1.24),
    ('mid', 0.8, -0.08, 1.36, 1.2),
    ('belly', -0.5, -0.05, 1.12, 1.04),
    ('hips', -1.8, 0.0, 0.88, 0.84),
    ('t1', -3.0, 0.05, 0.64, 0.6),
    ('t2', -4.3, 0.10, 0.48, 0.45),
    ('t3', -5.6, 0.10, 0.37, 0.34),
    ('t4', -6.9, 0.08, 0.28, 0.25),
    ('t5', -8.1, 0.05, 0.2, 0.18),
    ('t6', -9.2, 0.02, 0.14, 0.12),
    ('t7', -10.0, 0.0, 0.1, 0.08),
]

# bones along the spine, tail tip to head (head, tail points); body verts blend between neighbours
SPINE_BONES = [
    ('tail7', (-10.0, 0.0), (-12.5, 0.0)),
    ('tail6', (-9.2, 0.02), (-10.0, 0.0)),
    ('tail5', (-8.1, 0.05), (-9.2, 0.02)),
    ('tail4', (-6.9, 0.08), (-8.1, 0.05)),
    ('tail3', (-5.6, 0.1), (-6.9, 0.08)),
    ('tail2', (-4.3, 0.1), (-5.6, 0.1)),
    ('tail1', (-3.0, 0.05), (-4.3, 0.1)),
    ('hips', (-1.8, 0.0), (-3.0, 0.05)),
    ('belly', (-0.5, -0.05), (-1.8, 0.0)),
    ('chest', (0.8, -0.08), (-0.5, -0.05)),
    ('neck1', (2.1, -0.15), (3.2, -0.05)),
    ('neck2', (3.2, -0.05), (4.1, 0.1)),
    ('neck3', (4.1, 0.1), (5.0, 0.3)),
    ('neck4', (5.0, 0.3), (5.8, 0.5)),
    ('head', (5.8, 0.5), (8.4, 0.3)),
]

SIDES = {'R': 1, 'L': -1}  # Blender +X is the dragon's right; glTF keeps X, so 'R' is +X in the game too
WING = {
    'shoulder': V((0.85, 1.6, 0.55)),
    'elbow': V((3.4, 0.5, 0.85)),
    'wrist': V((6.0, 1.75, 0.95)),
    'tips': [V((11.6, 0.4, 0.45)), V((10.4, -2.4, 0.3)), V((8.0, -4.3, 0.35)), V((4.8, -4.6, 0.45))],
    'hip': V((0.75, -2.3, 0.2)),
}
HIND = [V((0.7, -1.7, -0.35)), V((1.02, -0.85, -1.0)), V((0.95, -2.55, -1.22)), V((0.85, -3.55, -1.05))]
FORE = [V((0.75, 2.4, -0.55)), V((0.88, 1.55, -1.15)), V((0.62, 2.45, -1.32)), V((0.5, 2.95, -1.28))]


def mirror(v, s):
    return V((v.x * s, v.y, v.z))


# --------------------------------------------------------------------------------------------------
# mesh building


class Part:
    """Collects verts/faces with per-vertex masks and bone weights."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.fuv = []  # per-face corner UVs (metres; packed into the atlas later) or None
        self.ftag = []  # per-face tag: 0 = base body, 1.. = breed extras (see EXTRA_TAGS)
        self.tag = 0  # tag given to the faces added from now on
        self.nouv = False  # True: faces carry no UVs (the mesh is smart-unwrapped instead)
        self.nosub = False  # True: faces added now skip the subdivision modifier (thin spikes, teeth, crystals)
        self.fnosub = []
        self.col = []  # RGBA masks
        self.w = []  # list of dict bone->weight

    def add(self, p, col, w):
        self.verts.append(V(p))
        self.col.append(col)
        self.w.append(w)
        return len(self.verts) - 1

    def face(self, f, uv=None):
        self.faces.append(tuple(f))
        self.fuv.append(None if self.nouv else uv)
        self.ftag.append(self.tag)
        self.fnosub.append(self.nosub)


def frames(points):
    out = []
    n = len(points)
    for i in range(n):
        a = points[max(0, i - 1)]
        b = points[min(n - 1, i + 1)]
        t = (b - a).normalized()
        side = t.cross(V((0, 0, 1)))
        if side.length < 1e-4:
            side = V((1, 0, 0))
        side.normalize()
        up = side.cross(t).normalized()
        out.append((t, side, up))
    return out


def loft(part, centers, radii, seg=16, profile=None, colfn=None, wfn=None, cap0=True, cap1=True, fr=None):
    """Loft rings along centers. radii: list of (rx, rz). profile(i, theta) -> (scale_x, scale_z, dz offset)."""
    fr = fr or frames(centers)
    rings = []
    for i, (c, (rx, rz)) in enumerate(zip(centers, radii)):
        t, side, up = fr[i]
        ring = []
        for k in range(seg):
            th = k / seg * math.tau
            sx, sz, off = profile(i, th) if profile else (1, 1, 0)
            p = c + side * (math.sin(th) * rx * sx) + up * (math.cos(th) * rz * sz + off)
            col = colfn(i, th, p) if colfn else (0, 0, 0, 0)
            w = wfn(i, th, p) if wfn else {}
            ring.append(part.add(p, col, w))
        rings.append(ring)
    # unrolled-cylinder UVs: u around the ring (seam on top, under the crest), v along the arc length
    arc = [0.0]
    for i in range(1, len(centers)):
        arc.append(arc[-1] + (centers[i] - centers[i - 1]).length)
    circ = [math.pi * (rx + rz) for rx, rz in radii]
    uv = lambda i, k: ((k / seg - 0.5) * circ[i], arc[i])
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(seg):
            k2 = (k + 1) % seg
            part.face((a[k], a[k2], b[k2], b[k]), (uv(i, k), uv(i, k + 1), uv(i + 1, k + 1), uv(i + 1, k)))
    for cap, ring, c in ((cap0, rings[0], centers[0]), (cap1, rings[-1], centers[-1])):
        if not cap:
            continue
        i = 0 if ring is rings[0] else len(rings) - 1
        col = part.col[ring[0]]
        w = part.w[ring[0]]
        ci = part.add(c, col, w)
        out = -1 if i == 0 else 1
        mid = (0.0, arc[i] + out * circ[i] * 0.12)
        for k in range(seg):
            k2 = (k + 1) % seg
            if ring is rings[0]:
                part.face((ring[k2], ring[k], ci), (uv(i, k + 1), uv(i, k), mid))
            else:
                part.face((ring[k], ring[k2], ci), (uv(i, k), uv(i, k + 1), mid))
    return rings


def chain_weights(p, chain):
    """chain: list of (name, head, tail) Vectors. Blend between neighbouring bones by projection."""
    best = None
    for idx, (name, h, t) in enumerate(chain):
        d = t - h
        L2 = d.length_squared
        u = max(0.0, min(1.0, (p - h).dot(d) / L2)) if L2 > 0 else 0
        q = h + d * u
        dist = (p - q).length
        if best is None or dist < best[0]:
            best = (dist, idx, u)
    _, idx, u = best
    w = {}
    name = chain[idx][0]
    # blend across joints: near u=0 share with previous, near u=1 with next
    if u < 0.5 and idx > 0:
        k = 0.5 - u
        w[chain[idx - 1][0]] = k
        w[name] = 1 - k
    elif u >= 0.5 and idx < len(chain) - 1:
        k = u - 0.5
        w[chain[idx + 1][0]] = k
        w[name] = 1 - k
    else:
        w[name] = 1.0
    return w


SPINE_CHAIN = [(n, V((0, h[0], h[1])), V((0, t[0], t[1]))) for n, h, t in SPINE_BONES]


def body_weights(p):
    # head verts (ahead of the nape) are rigid on the head so the jaw seam stays tight
    if p.y > 5.9:
        return {'head': 1.0}
    q = V((0, p.y, p.z))
    return chain_weights(q, SPINE_CHAIN)


def gauss(x, c, w):
    return math.exp(-(((x - c) / w) ** 2))


def path_frames(pts, ref=None):
    """Parallel-transport frames along a path (no flipping when the path points straight up)."""
    n = len(pts)
    ts = [(pts[min(n - 1, i + 1)] - pts[max(0, i - 1)]).normalized() for i in range(n)]
    if ref is None:
        ref = V((0, 0, 1)) if abs(ts[0].z) < 0.85 else V((0, 1, 0))
    s0 = ts[0].cross(ref).normalized()
    u0 = s0.cross(ts[0]).normalized()
    out = [(ts[0], s0, u0)]
    for i in range(1, n):
        t = ts[i]
        pt, ps, pu = out[-1]
        ax = pt.cross(t)
        if ax.length > 1e-7:
            q = Quaternion(ax.normalized(), math.acos(max(-1.0, min(1.0, pt.dot(t)))))
            ps = q @ ps
            pu = q @ pu
        out.append((t, ps, pu))
    return out


def bezier(c, t):
    a = 1 - t
    return c[0] * (a * a * a) + c[1] * (3 * a * a * t) + c[2] * (3 * a * t * t) + c[3] * (t * t * t)


HORN_Q = (0.55, 0.75)  # ring/segment multipliers: the subdivision modifier quadruples every quad
BONE = (0, 1, 0, 0)
TOOTH = (0, 0.92, 0, 0)  # constant G: teeth are cream from root to tip
HEAD_W = lambda p: {'head': 1.0}
JAW_W = lambda p: {'jaw': 1.0}
SPINE_W = lambda p: chain_weights(V((0, p.y, 0)), SPINE_CHAIN)


def horn(part, ctrl, r0, w, rings=30, seg=10, ridges=0, ratio=1.0, taper=1.15, tipr=0.006, grooves=0, ref=None,
         tip_col=1.0, cap0=True, ridge_amp=0.14, collar=0.0):
    """A curved horn/spike along a cubic Bezier: ridged growth rings, optional grooves, tapering to a point.
    G mask runs 0.5 at the root to 1.0 at the tip (the shader pales the tip)."""
    if not part.nosub:
        rings = max(8, int(rings * HORN_Q[0]))
        seg = max(6, int(seg * HORN_Q[1]))
    pw = 1.7 if collar else 1.0
    ts = [(k / (rings - 1)) ** pw for k in range(rings)]
    pts = [bezier(ctrl, t) for t in ts]
    rad = []
    for k in range(rings):
        t = ts[k]
        rr = r0 * (1 - t) ** taper + tipr
        if collar:
            rr += r0 * collar * math.exp(-t * 11)  # the base flares out into a boss that merges with the skin
        if ridges:
            rr *= 1 + ridge_amp * max(0.0, math.cos(t * ridges * math.tau)) ** 3 * (1 - t * 0.6)
        rad.append((rr * ratio, rr))
    n = rings - 1
    prof = (lambda i, th: (1 + 0.08 * math.cos(grooves * th), 1 + 0.08 * math.cos(grooves * th), 0)) if grooves else None
    loft(part, pts, rad, seg=seg, profile=prof, colfn=lambda i, th, p: (0, 0.5 + (tip_col - 0.5) * ts[i], 0, 0),
         wfn=lambda i, th, p: dict(w(p)), cap0=cap0, cap1=False, fr=path_frames(pts, ref))
    return pts


def tube(part, pts, radii, w, seg=8, col=(0, 0, 0, 0), ref=None, cap=True):
    loft(part, pts, [(r, r) if not isinstance(r, tuple) else r for r in radii], seg=seg, colfn=lambda i, th, p: col,
         wfn=lambda i, th, p: dict(w(p)), cap0=cap, cap1=cap, fr=path_frames(pts, ref))


# --------------------------------------------------------------------------------------------------
# the head


BROW_Y = [6.4, 6.75, 7.0, 7.25, 7.6, 8.0]
BROW_A = [0.8, 0.95, 1.0, 0.85, 0.5, 0.22]
EYE_Y, EYE_A, EYE_R = 7.07, 1.22, 0.112


def brow_a(y):
    return float(np.interp(y, BROW_Y, BROW_A))


def body_profile(y, th):
    """Scale factors (sx, sz) of the body loft's ring at height y: the dorsal ridge, muscles, and all the
    head features (brow, nasal bridge, nostrils, cheeks, eye sockets, lips, jaw muscle)."""
    c = math.cos(th)
    a = abs(math.atan2(math.sin(th), c))
    head = smooth(5.6, 6.2, y)
    # dorsal ridge: a sharper crest along the top of body and tail
    ridge = 1 + 0.16 * gauss(a, 0, 0.32) * (1 - head)
    sx, sz = ridge, ridge
    # flatter belly
    if c < 0:
        sz *= 0.86 + 0.14 * head
    # musculature: wing shoulders, chest, haunches, neck cords, ribs
    shoulder = gauss(y, 1.5, 0.75) * gauss(a, 0.95, 0.42)
    pec = gauss(y, 2.2, 0.6) * gauss(a, 2.25, 0.45)
    haunch = gauss(y, -1.7, 0.6) * gauss(a, 1.7, 0.5)
    cords = gauss(a, 1.15, 0.16) * smooth(3.0, 3.6, y) * (1 - smooth(5.2, 5.7, y))
    throat = gauss(a, 2.6, 0.22) * smooth(3.2, 3.8, y) * (1 - smooth(5.0, 5.6, y))
    ribs = (0.5 + 0.5 * math.cos(y * 2 * math.pi / 0.42)) * gauss(a, 1.85, 0.35) * smooth(-1.2, -0.5, y) * (1 - smooth(1.6, 2.2, y))
    bump = 1 + 0.14 * shoulder + 0.12 * pec + 0.13 * haunch + 0.07 * cords - 0.04 * throat + 0.03 * ribs
    # head: heavy brow arch sweeping from the nose bridge over the eye, raised nasal bridge, nostril bulbs and
    # pits, cheek and jaw muscle, deep eye sockets, a scalloped upper lip
    if head > 0:
        brow = 0.2 * gauss(a, brow_a(y), 0.2) * gauss(y, 7.1, 0.7)
        bridge = 0.1 * gauss(a, 0, 0.3) * smooth(7.0, 7.5, y) * (1 - smooth(8.05, 8.3, y))
        nbulb = 0.2 * gauss(y, 8.1, 0.15) * gauss(a, 0.85, 0.3)
        npit = -0.2 * gauss(y, 8.2, 0.055) * gauss(a, 0.95, 0.12)
        cheek = 0.18 * gauss(y, 6.3, 0.42) * gauss(a, 1.95, 0.55)
        socket = -0.15 * gauss(y, EYE_Y, 0.2) * gauss(a, EYE_A, 0.23)
        temple = -0.07 * gauss(y, 6.7, 0.3) * gauss(a, 1.25, 0.3)
        lip = 0.06 * (1 + 0.3 * math.sin(y * 26)) * gauss(a, 2.35, 0.13) * smooth(6.2, 6.6, y) * (1 - smooth(8.1, 8.3, y))
        jawmus = 0.1 * gauss(y, 6.1, 0.3) * gauss(a, 2.4, 0.4)
        bump += head * (brow + bridge + nbulb + npit + cheek + socket + temple + lip + jawmus)
    sx *= bump
    sz *= bump
    if head > 0:
        # boxier skull (superellipse), wider along the lip line than on top
        s, cc = abs(math.sin(th)), abs(c)
        n = 2.5
        se = (s ** n + cc ** n) ** (-1 / n)
        sx = lerp(sx, se * (1 + 0.07 * gauss(a, 2.2, 0.5)), head * 0.7)
        sz = lerp(sz, se, head * 0.7)
        # the head bottom is the upper jaw edge: flat
        if c < 0:
            sz *= lerp(1, 0.7, head)
    return sx, sz, 0


def build_body(part):
    centers = [V((0, y, z)) for _, y, z, _, _ in SPINE]
    radii = [(rx, rz) for *_, rx, rz in SPINE]
    names = [n for n, *_ in SPINE]
    # densify: two extra rings between skeleton points for smoother subdivision and room for muscles
    c2, r2, n2 = [], [], []
    for i in range(len(centers)):
        c2.append(centers[i]); r2.append(radii[i]); n2.append(names[i])
        if i < len(centers) - 1:
            for t in (1 / 3, 2 / 3):
                c2.append(lerpv(centers[i], centers[i + 1], t))
                r2.append((lerp(radii[i][0], radii[i + 1][0], t), lerp(radii[i][1], radii[i + 1][1], t)))
                n2.append(names[i] + '+')

    def colfn(i, th, p):
        c = math.cos(th)
        belly = smooth(-0.25, -0.75, c) * (1 - smooth(5.9, 6.3, p.y))
        return (belly, 0, 0, 0)

    loft(part, c2, r2, seg=28, profile=lambda i, th: body_profile(c2[i].y, th), colfn=colfn, wfn=lambda i, th, p: body_weights(p))


def spine_at(y):
    for i in range(len(SPINE) - 1):
        a, b = SPINE[i], SPINE[i + 1]
        if a[1] >= y >= b[1]:
            t = (a[1] - y) / (a[1] - b[1])
            return lerp(a[2], b[2], t), lerp(a[3], b[3], t), lerp(a[4], b[4], t)
    return SPINE[-1][2], SPINE[-1][3], SPINE[-1][4]


def ring_point(y, th):
    """Point on the body loft surface at y and ring angle th (0 top, +pi/2 the +X side)."""
    z0, rx, rz = spine_at(y)
    sx, sz, _ = body_profile(y, th)
    return V((math.sin(th) * rx * sx, y, z0 + math.cos(th) * rz * sz))


def head_pt(y, a, s, out=0.0):
    """Surface point on side s (+1/-1) at angle a from the top, pushed out along the ring normal."""
    p = ring_point(y, s * a)
    z0 = spine_at(y)[0]
    n = V((p.x, 0, p.z - z0))
    if n.length > 1e-6:
        n.normalize()
    return p + n * out


JAW_YS = [5.75, 6.1, 6.5, 6.95, 7.4, 7.8, 8.1, 8.26]
JAW_RX = [0.40, 0.5, 0.5, 0.43, 0.34, 0.26, 0.17, 0.09]
JAW_RZ = [0.34, 0.34, 0.28, 0.22, 0.17, 0.13, 0.1, 0.07]


def jaw_center(y):
    z, _, hr = spine_at(y)
    rz = float(np.interp(y, JAW_YS, JAW_RZ))
    return z - hr * 0.7 - rz * 0.3 + 0.045


def jaw_top(y):
    """(half width, z) of the lower jaw's upper edge."""
    return float(np.interp(y, JAW_YS, JAW_RX)), jaw_center(y) + float(np.interp(y, JAW_YS, JAW_RZ)) * 0.3


def build_jaw(part):
    pts = [V((0, y, jaw_center(y))) for y in JAW_YS]

    def profile(i, th):
        c = math.cos(th)
        # U-shaped: the top (inside of the mouth) is flat; a heavy chin and jaw muscle
        chin = 1 + 0.2 * gauss(JAW_YS[i], 8.0, 0.2) * (1 if c < 0 else 0)
        muscle = 1 + 0.22 * gauss(JAW_YS[i], 6.05, 0.3) * (1 if c < 0 else 0)
        return muscle, (0.3 if c > 0 else chin * muscle), 0

    def colfn(i, th, p):
        c = math.cos(th)
        return (smooth(-0.1, -0.6, c), 0, 0, 1.0 if c > 0.55 else 0)

    loft(part, pts, list(zip(JAW_RX, JAW_RZ)), seg=18, profile=profile, colfn=colfn, wfn=lambda i, th, p: {'jaw': 1.0})
    return pts


def build_mouth(part):
    # palate: a dark plate just inside the upper head so an open mouth shows a dark interior
    rows = []
    for y in (5.9, 6.5, 7.1, 7.7, 8.1, 8.28):
        z, hx, hr = spine_at(y)
        zb = z - hr * 0.62
        rows.append([part.add(V((x * hx * 0.8, y, zb)), (0, 0, 0, 1), {'head': 1.0}) for x in (-1, -0.5, 0, 0.5, 1)])
    for r in range(len(rows) - 1):
        for c in range(4):
            f = (rows[r][c], rows[r + 1][c], rows[r + 1][c + 1], rows[r][c + 1])
            part.face(f, tuple((part.verts[i].x, part.verts[i].y) for i in f))
    # tongue lying on the jaw floor
    ys = [6.0, 6.4, 6.85, 7.3, 7.7, 7.95]
    wid = [0.13, 0.15, 0.13, 0.1, 0.07, 0.025]
    pts = [V((0, y, jaw_top(y)[1] + 0.02)) for y in ys]
    loft(part, pts, [(w, 0.028) for w in wid], seg=10, colfn=lambda i, th, p: (0, 0, 0, 0.75),
         wfn=lambda i, th, p: {'jaw': 1.0}, fr=path_frames(pts, V((0, 0, 1))))


def cone(part, base, tip, r0, colfn, w, seg=8, bend=None, rings=5, ridges=0, flat=1.0):
    nosub, part.nosub = part.nosub, True
    pts = []
    rad = []
    for k in range(rings):
        t = k / (rings - 1)
        p = lerpv(base, tip, t)
        if bend is not None:
            p = p + bend * math.sin(t * math.pi) * 0.5 + bend * t * 0.5
        pts.append(p)
        rr = r0 * (1 - t) ** 1.15 + 0.008
        if ridges:
            rr *= 1 + 0.16 * max(0.0, math.cos(t * ridges * math.tau)) ** 3 * (1 - t * 0.7)
        rad.append((rr, rr * flat))
    n = len(pts) - 1
    tint = (lambda i, th, p: (colfn[0], 0.5 + 0.5 * i / n, colfn[2], colfn[3])) if colfn[1] >= 1 else (lambda i, th, p: colfn)
    loft(part, pts, rad, seg=max(seg, 7), colfn=tint, wfn=lambda i, th, p: dict(w(p)), cap1=False)
    part.nosub = nosub


def eye_axes(s):
    g = V((0.5 * s, 0.86, -0.1)).normalized()
    e1 = V((-g.y, g.x, 0)).normalized()
    return g, e1, V((0, 0, 1))


def eye_center(s):
    return head_pt(EYE_Y, EYE_A, s, -0.04)


def build_eyes(part):
    """Eyeballs (their own skinned mesh): UVs are the gaze-axis planar projection so the shader can paint the
    iris, slit pupil and limbal ring."""
    for s in (1, -1):
        c = eye_center(s)
        g, e1, e2 = eye_axes(s)
        NU, NV = 20, 12
        rows = []
        uv = {}
        for j in range(NV + 1):
            lat = math.pi * j / NV
            ring = []
            for i in range(NU):
                lon = math.tau * i / NU
                d = g * math.cos(lat) + (e1 * math.cos(lon) + e2 * math.sin(lon)) * math.sin(lat)
                p = c + d * EYE_R
                ring.append(part.add(p, (0, 0, 1, 0), {'head': 1.0}))
                uv[ring[-1]] = (0.5 + 0.5 * d.dot(e1), 0.5 + 0.5 * d.dot(e2))
            rows.append(ring)
        for j in range(NV):
            for i in range(NU):
                i2 = (i + 1) % NU
                a, b, c2_, d_ = rows[j][i], rows[j][i2], rows[j + 1][i2], rows[j + 1][i]
                f = (a, d_, c2_, b)
                # wind outward whatever the side's axes handedness
                p0, p1, p2 = (part.verts[k] for k in f[:3])
                if (p1 - p0).cross(p2 - p1).dot(p0 + p1 + p2 - c * 3) < 0:
                    f = (a, b, c2_, d_)
                part.face(f, tuple(uv[k] for k in f))


def build_head_base(part):
    """Features every breed shares: eyelids, brow ridge, scutes, teeth."""
    for s in (1, -1):
        # heavy brow ridge from the nose bridge, over the eye, back toward the horn root
        by = [7.72, 7.5, 7.28, 7.05, 6.82, 6.6, 6.4]
        pts = [head_pt(y, brow_a(y), s, 0.018) for y in by]
        tube(part, pts, [0.03, 0.05, 0.07, 0.085, 0.08, 0.066, 0.05], HEAD_W, seg=10, ref=V((0, 0, 1)))
        # swept scutes growing out of the brow ridge: flared bases, flattened, bending back
        for k, y in enumerate((7.42, 7.08, 6.74)):
            b = head_pt(y, brow_a(y), s, 0.025)
            n = (head_pt(y, brow_a(y), s, 0.2) - b).normalized()
            back = V((0.05 * s, -1.0, 0.0)).normalized()
            ln = 0.2 + 0.05 * k
            horn(part, [b - n * 0.05, b + n * 0.06, b + n * 0.1 + back * ln * 0.5, b + n * 0.1 + back * ln + V(0, 0, 0.03)], 0.07 + 0.01 * k, HEAD_W,
                 rings=7, seg=8, ratio=0.62, collar=1.2, taper=1.0)
        # eyelids: an almond ring of thick skin around the eyeball
        c = eye_center(s)
        g, e1, e2 = eye_axes(s)
        ring = []
        rad = []
        N = 22
        for k in range(N + 1):
            ph = k / N * math.tau
            ring.append(c + g * 0.055 + e1 * (math.cos(ph) * 0.128) + e2 * (math.sin(ph) * 0.082))
            rad.append(0.03 + 0.03 * max(0.0, math.sin(ph)) + 0.01 * max(0.0, -math.sin(ph)))
        tube(part, ring, rad, HEAD_W, seg=8, ref=g, cap=False)
        # nostril rims
        for dy in (0.0,):
            p0 = head_pt(8.2, 0.95, s, 0.02)
            tube(part, [p0 + V((0.0, 0.07, 0.0)), p0 + V((0.0, 0.0, 0.04)), p0 + V((0.0, -0.07, 0.0))], [0.02, 0.028, 0.02], HEAD_W, seg=6)
        # teeth: two rows along the lip and the jaw edge, plus long fangs that show with the mouth shut
        upper = [(8.2, 0.045, 0.07), (8.08, 0.05, 0.1), (7.95, 0.055, 0.14), (7.78, 0.08, 0.34), (7.62, 0.045, 0.1), (7.48, 0.05, 0.11),
                 (7.34, 0.05, 0.1), (7.2, 0.05, 0.12), (7.06, 0.05, 0.1), (6.92, 0.048, 0.11), (6.78, 0.046, 0.09), (6.64, 0.044, 0.09),
                 (6.5, 0.04, 0.07)]
        for y, r, ln in upper:
            p0 = head_pt(y, 2.46, s, -0.01)
            cone(part, p0, p0 + V((0.01 * s, 0, -ln)), r, TOOTH, HEAD_W, seg=6, rings=4, bend=V((0, -ln * 0.25, 0)))
        lower = [(8.08, 0.04, 0.07), (7.95, 0.05, 0.22), (7.78, 0.038, 0.07), (7.6, 0.04, 0.09), (7.44, 0.04, 0.08), (7.28, 0.04, 0.09),
                 (7.1, 0.04, 0.08), (6.92, 0.038, 0.08), (6.74, 0.036, 0.07)]
        for y, r, ln in lower:
            hx, zt = jaw_top(y)
            p0 = V((hx * 0.8 * s, y, zt - 0.01))
            cone(part, p0, p0 + V((0.0, 0, ln)), r, TOOTH, JAW_W, seg=6, rings=4, bend=V((0, -ln * 0.2, 0)))


# --------------------------------------------------------------------------------------------------
# breed extras: horns, crests, hoods and tail ornaments. They are built into the same meshes (so they are
# sculpted and baked with everything else) and split into per-breed objects before export; DragonView shows
# the set that matches the breed.

EXTRA_TAGS = {'ember': 1, 'frost': 2, 'storm': 3, 'venom': 4}


def spine_top(y, k=1.1):
    z0, rx, rz = spine_at(y)
    return z0 + rz * k


def dir_ctrl(root, d, ln, curl=V((0, 0, 0))):
    """Bezier control points for a horn leaving root along d (a unit-ish vector), length ln, curling by curl."""
    d = d.normalized()
    return [root, root + d * ln * 0.33, root + d * ln * 0.68 + curl * 0.35, root + d * ln + curl]


def dorsal_spikes(part, ys, hfn, rfn, lean=0.9, ratio=0.7, rings=10, seg=8, ridges=0, tip=0.006):
    part.nosub = True
    rings = max(6, rings // 2 + 1)
    for y in ys:
        zt = spine_top(y)
        h, r = hfn(y), rfn(y)
        P = [V((0, y + 0.1, zt - 0.1)), V((0, y + 0.03, zt + h * 0.35)), V((0, y - h * 0.22 * lean, zt + h * 0.75)),
             V((0, y - h * 0.6 * lean, zt + h))]
        horn(part, P, r, SPINE_W, rings=rings, seg=seg, ratio=ratio, ref=V((0, 1, 0)), ridges=ridges, tipr=tip)
    part.nosub = False


def crest_web(part, y0=5.6, y1=-9.4, col=0.3):
    # a webbed crest along the neck and back, scalloped between the spikes
    ys = [y / 10 for y in range(int(y0 * 10), int(y1 * 10), -2)]
    pts, rad = [], []
    for y in ys:
        z, hx, hr = spine_at(y)
        h = (0.06 + hr * 0.32) * (0.45 + 0.55 * abs(math.cos(math.pi * (y - 5.3) / 1.0)))
        h *= smooth(5.6, 4.8, y) * (1 - smooth(-8.4, -9.6, y)) + 0.001
        pts.append(V((0, y, z + hr * 1.08 + h * 0.5)))
        rad.append((0.022 + hr * 0.02, h * 0.55 + 0.02))
    loft(part, pts, rad, seg=6, colfn=lambda i, th, p: (0, col, 0, 0), wfn=lambda i, th, p: SPINE_W(p))


def crystal(part, base, d, r, ln, w, seg=6, ref=None):
    """A faceted hexagonal ice crystal; the A mask marks it (flat shaded, creased edges, glassy shader)."""
    d = d.normalized()
    pts = [base - d * 0.05, base + d * ln * 0.12, base + d * ln * 0.78, base + d * ln]
    rad = [r * 0.9, r, r * 0.9, 0.012]
    loft(part, pts, [(x, x) for x in rad], seg=seg, colfn=lambda i, th, p: (0, 0, 0, 0.25), wfn=lambda i, th, p: dict(w(p)),
         cap0=True, cap1=True, fr=path_frames(pts, ref))


def sheet(part, pts, wts, thin, flag=1.0, flip=False):
    grid = [[part.add(p, (t, flag, 0, 0), w) for p, t, w in zip(rp, rt, rw)] for rp, rt, rw in zip(pts, thin, wts)]
    quads(part, grid, flip)


def tail_spade(part, w=lambda p: {'tail7': 1.0}, scale=1.0, col=0.3):
    for s in (1, -1):
        horn(part, [V(0.5 * s, -10.5, 0), V(0.85 * s, -10.75, 0.02), V(1.1 * s, -11.0, 0.05), V(1.3 * s, -11.35, 0.05)], 0.07 * scale, w,
             rings=8, seg=6, ratio=0.6)
        horn(part, [V(0.28 * s, -9.9, 0.05), V(0.5 * s, -10.0, 0.1), V(0.7 * s, -10.15, 0.14), V(0.85 * s, -10.4, 0.15)], 0.05 * scale, w,
             rings=7, seg=6)
    ys = [-9.9, -10.3, -10.8, -11.4, -12.0, -12.6, -13.0, -13.3]
    rx = [0.09, 0.5, 0.92, 0.88, 0.58, 0.3, 0.1, 0.02]
    pts = [V((0, y, 0)) for y in ys]
    loft(part, pts, [(r * scale, 0.045 + r * 0.04) for r in rx], seg=14, colfn=lambda i, th, p: (0, col, 0, 0), wfn=lambda i, th, p: w(p))
    # a bony keel down the middle and barbs along both edges
    horn(part, [V(0, -9.9, 0.05), V(0, -11.0, 0.09), V(0, -12.2, 0.09), V(0, -13.35, 0.05)], 0.06 * scale, w, rings=14, seg=7, ridges=8, taper=0.9)
    for s in (1, -1):
        for y in (-10.7, -11.1, -11.5, -11.9, -12.3):
            hw = float(np.interp(-y, [-v for v in ys], rx)) * scale
            horn(part, [V(hw * 0.85 * s, y, 0.0), V((hw + 0.12) * s, y - 0.12, 0.02), V((hw + 0.22) * s, y - 0.3, 0.03), V((hw + 0.2) * s, y - 0.55, 0.03)],
                 0.05 * scale, w, rings=6, seg=6, ratio=0.7)


def extras_ember(part):
    part.tag = EXTRA_TAGS['ember']
    for s in (1, -1):
        # big horns sweeping back from the skull, with a slight hook at the tip
        horn(part, [head_pt(6.38, 0.62, s, -0.08), V(0.68 * s, 5.7, 1.62), V(1.04 * s, 4.7, 1.98), V(1.25 * s, 3.9, 1.72)], 0.165, HEAD_W,
             rings=44, seg=14, ridges=14, grooves=3, taper=1.2)
        # second, lower pair swept out and back
        horn(part, [head_pt(6.2, 1.5, s, -0.07), V(0.98 * s, 5.55, 0.98), V(1.45 * s, 4.9, 0.9), V(1.82 * s, 4.4, 1.12)], 0.1, HEAD_W,
             rings=30, seg=10, ridges=9, taper=1.2)
        # cheek spines
        for y, a, ln in ((6.5, 1.8, 0.8), (6.25, 2.1, 0.62), (6.05, 2.4, 0.5)):
            horn(part, dir_ctrl(head_pt(y, a, s, -0.04), V((0.5 * s, -0.85, -0.12)), ln, V((0, 0, 0.13 * ln))), 0.07, HEAD_W, rings=10, seg=8,
                 collar=1.3, ratio=0.8)
        # chin spikes
        for y, ln in ((7.6, 0.2), (7.1, 0.3), (6.6, 0.38)):
            hx, zt = jaw_top(y)
            horn(part, dir_ctrl(V((hx * 0.55 * s, y, jaw_center(y) - 0.12)), V((0.3 * s, -0.4, -0.85)), ln), 0.045, JAW_W, rings=8, seg=7, collar=1.2)
        # frill of spikes on the back of the head
        for y, z, ln in ((5.95, 0.2, 0.62), (5.8, 0.42, 0.5), (6.15, 0.02, 0.46)):
            horn(part, dir_ctrl(V((0.44 * s, y, z)), V((0.55 * s, -0.8, -0.2)), ln), 0.075, HEAD_W, rings=9, seg=8, collar=1.2, ratio=0.8)
    for s in (1, -1):
        O, tips = ember_ear(s)
        for tp in tips:
            rib(part, O, tp, 0.05, HEAD_W)
    # nose horn
    horn(part, dir_ctrl(head_pt(7.82, 0, 1, -0.03), V((0, -0.3, 1.0)), 0.3, V((0, -0.1, 0))), 0.07, HEAD_W, rings=10, seg=8, ridges=3)
    # dorsal spikes: tallest over the shoulders and hips
    ys = [5.3, 4.5, 3.7, 2.8, 1.8, 0.7, -0.4, -1.5, -2.6, -3.7, -4.8, -5.9, -7.0, -8.0, -9.0]
    dorsal_spikes(part, ys, lambda y: 0.28 + spine_at(y)[2] * 0.75 * (1.0 + 0.2 * math.cos(y * 3.1)), lambda y: 0.065 + spine_at(y)[2] * 0.15,
                  rings=12, ridges=3)
    # small secondary spikes in the gaps
    dorsal_spikes(part, [y - 0.45 for y in ys[:-1]], lambda y: 0.12 + spine_at(y)[2] * 0.25, lambda y: 0.04 + spine_at(y)[2] * 0.06, rings=7, seg=6)
    crest_web(part)
    tail_spade(part)


def frost_horn_tines(part, ctrl, r0, w, tines):
    for t, d, ln in tines:
        root = bezier(ctrl, t)
        horn(part, dir_ctrl(root, d, ln, V((0, 0, 0.18 * ln))), r0 * (1 - t) * 0.7, w, rings=14, seg=8, ridges=4, taper=1.0)


def extras_frost(part):
    part.tag = EXTRA_TAGS['frost']
    for s in (1, -1):
        # broad antlers that sweep up and back, with tines
        c = [head_pt(6.4, 0.6, s, -0.08), V(0.75 * s, 5.8, 1.55), V(1.2 * s, 4.95, 2.1), V(1.35 * s, 4.1, 2.2)]
        horn(part, c, 0.21, HEAD_W, rings=40, seg=14, ridges=8, grooves=4, taper=0.9)
        frost_horn_tines(part, c, 0.21, HEAD_W, [(0.45, V((0.35 * s, 0.1, 1.0)), 0.8), (0.65, V((0.5 * s, 0.0, 1.0)), 0.7), (0.82, V((0.4 * s, -0.4, 0.9)), 0.45)])
        c2 = [head_pt(6.2, 1.5, s, -0.07), V(1.0 * s, 5.6, 0.9), V(1.5 * s, 5.0, 0.75), V(1.85 * s, 4.5, 0.95)]
        horn(part, c2, 0.11, HEAD_W, rings=26, seg=10, ridges=6)
        # ice crowns on the brow and cheek
        for y, a, ln, out in ((7.5, 0.45, 0.4, 0.0), (7.2, 0.8, 0.55, 0.05), (6.9, 1.0, 0.5, 0.05), (6.6, 0.9, 0.42, 0.0)):
            b = head_pt(y, brow_a(y) if a is None else a, s, -0.02)
            crystal(part, b, V((0.35 * s, -0.55, 1.0)), 0.05 + 0.01 * ln, ln, HEAD_W)
        for y, a, ln in ((6.45, 1.9, 0.7), (6.2, 2.2, 0.55), (6.0, 2.5, 0.42)):
            crystal(part, head_pt(y, a, s, -0.03), V((0.6 * s, -0.8, -0.1)), 0.05, ln, HEAD_W)
        # icicle beard
        for y, ln in ((7.7, 0.22), (7.25, 0.36), (6.8, 0.44)):
            hx, zt = jaw_top(y)
            crystal(part, V((hx * 0.5 * s, y, jaw_center(y) - 0.11)), V((0.15 * s, -0.25, -1.0)), 0.04, ln, JAW_W)
    # crystal clusters along the spine
    rnd = random.Random(11)
    ys = [5.0, 3.8, 2.6, 1.4, 0.2, -1.0, -2.3, -3.7, -5.1, -6.6, -8.0]
    for k, y in enumerate(ys):
        zt = spine_top(y, 1.05)
        rz = spine_at(y)[2]
        h = (0.4 + rz * 1.3) * rnd.uniform(0.55, 1.25)
        crystal(part, V((0, y, zt)), V((rnd.uniform(-0.12, 0.12), -0.5, 1.0)), 0.07 + rz * 0.12, h, SPINE_W, ref=V((0, 1, 0)))
        for s in (1, -1):
            crystal(part, V((0.12 * s, y + 0.2, zt - 0.05)), V((0.8 * s, rnd.uniform(-0.5, -0.1), 0.8)), 0.05 + rz * 0.07, h * rnd.uniform(0.5, 0.7), SPINE_W)
            crystal(part, V((0.1 * s, y - 0.25, zt - 0.05)), V((0.55 * s, -0.9, 0.9)), 0.04 + rz * 0.05, h * rnd.uniform(0.3, 0.5), SPINE_W)
    # shoulder crystals
    for s in (1, -1):
        for k in range(3):
            y = 1.8 - k * 0.5
            crystal(part, V((0.9 * s, y, spine_at(y)[0] + spine_at(y)[2] * 0.85)), V((0.9 * s, -0.3, 0.7)), 0.07, 0.5 - k * 0.1, SPINE_W)
    # ice-mace tail: a cluster of crystals on the tail tip
    w7 = lambda p: {'tail7': 1.0}
    crystal(part, V((0, -10.0, 0)), V((0, -1, 0.0)), 0.16, 1.2, w7, ref=V((0, 0, 1)))
    for k in range(6):
        ph = k / 6 * math.tau
        crystal(part, V((0, -10.4, 0)), V((0.9 * math.cos(ph), -0.9, 0.9 * math.sin(ph))), 0.07, 0.6, w7)
    crest_web(part, 5.4, -9.0, 0.3)


def extras_storm(part):
    part.tag = EXTRA_TAGS['storm']
    for s in (1, -1):
        # long rapier horns swept straight back
        horn(part, [head_pt(6.38, 0.6, s, -0.08), V(0.62 * s, 5.2, 1.3), V(0.8 * s, 3.6, 1.55), V(0.9 * s, 1.9, 1.35)], 0.13, HEAD_W,
             rings=60, seg=10, ridges=18, ridge_amp=0.08, taper=0.8)
        horn(part, [head_pt(6.25, 1.35, s, -0.07), V(1.0 * s, 5.4, 0.95), V(1.5 * s, 4.2, 0.8), V(1.75 * s, 2.9, 0.95)], 0.08, HEAD_W,
             rings=40, seg=8, ridges=10, ridge_amp=0.08, taper=0.8)
        # whisker spines on the snout
        horn(part, [head_pt(7.75, 1.9, s, -0.03), V(0.55 * s, 7.3, 0.35), V(0.9 * s, 6.5, 0.5), V(1.2 * s, 5.6, 0.35)], 0.03, HEAD_W,
             rings=24, seg=6, taper=0.7)
        for y, a, ln in ((6.45, 1.85, 0.7), (6.2, 2.15, 0.55)):
            horn(part, dir_ctrl(head_pt(y, a, s, -0.04), V((0.5 * s, -0.85, 0.05)), ln, V((0, 0, 0.1 * ln))), 0.06, HEAD_W, rings=10, seg=8, collar=1.3, ratio=0.8)
    for s in (1, -1):
        O, tips = storm_ear(s)
        for tp in tips:
            rib(part, O, tp, 0.05, HEAD_W)
    horn(part, dir_ctrl(head_pt(7.82, 0, 1, -0.03), V((0, -0.2, 1.0)), 0.36, V((0, -0.12, 0))), 0.06, HEAD_W, rings=10, seg=8, ridges=3)
    # tall slender spines carrying the sail
    ys = [5.0, 4.0, 3.0, 2.0, 1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0, -6.0, -7.0, -8.0]
    dorsal_spikes(part, ys, lambda y: 0.5 + spine_at(y)[2] * 1.3, lambda y: 0.04 + spine_at(y)[2] * 0.07, lean=1.1, ratio=0.6, rings=16, seg=6, tip=0.004)
    # tail: two long rapiers and a central blade
    w7 = lambda p: {'tail7': 1.0}
    for s in (1, -1):
        horn(part, [V(0.1 * s, -9.9, 0.0), V(0.5 * s, -10.6, 0.1), V(1.2 * s, -11.3, 0.25), V(1.9 * s, -12.4, 0.2)], 0.06, w7, rings=22, seg=6, ratio=0.6)
    horn(part, [V(0, -9.9, 0), V(0, -11.2, 0.0), V(0, -12.6, 0.0), V(0, -14.2, 0.0)], 0.07, w7, rings=24, seg=6, ratio=0.6)


def extras_venom(part):
    part.tag = EXTRA_TAGS['venom']
    for s in (1, -1):
        # thick brow horns curving forward and down like a rhino's
        horn(part, [head_pt(6.9, 0.95, s, -0.08), V(0.75 * s, 6.8, 1.35), V(1.0 * s, 6.5, 1.5), V(1.1 * s, 6.0, 1.3)], 0.15, HEAD_W,
             rings=34, seg=12, ridges=7, grooves=3, taper=1.0)
        # tusks rising from the lower jaw
        hx, zt = jaw_top(7.2)
        horn(part, [V(hx * 0.95 * s, 7.15, zt - 0.05), V(hx * 1.1 * s, 7.18, zt + 0.1), V(hx * 1.14 * s, 7.28, zt + 0.26), V(hx * 1.0 * s, 7.5, zt + 0.38)], 0.06, JAW_W,
             rings=14, seg=8, ridges=3)
        # long venom fangs, visible even with the mouth shut
        horn(part, [head_pt(7.7, 2.42, s, -0.02), V(0.25 * s, 7.72, 0.0), V(0.26 * s, 7.7, -0.3), V(0.24 * s, 7.62, -0.55)], 0.06, HEAD_W,
             rings=14, seg=8, taper=0.9)
        # jaw barbs
        for y, a, ln in ((6.4, 2.0, 0.55), (6.15, 2.35, 0.45)):
            horn(part, dir_ctrl(head_pt(y, a, s, -0.04), V((0.7 * s, -0.7, -0.25)), ln, V((0, 0, -0.12 * ln))), 0.065, HEAD_W, rings=9, seg=8, collar=1.3, ratio=0.8)
    O, tips = hood_tips()
    for tp in tips:
        rib(part, O, tp, 0.055, lambda p: {'neck4': 1.0}, bow=V((0, 0, 0.0)))
    # a row of thick thorns hooking backward
    ys = [5.1, 4.3, 3.5, 2.7, 1.8, 0.9, 0.0, -0.9, -1.9, -2.9, -3.9, -4.9, -5.9, -6.9, -7.9, -8.9]
    dorsal_spikes(part, ys, lambda y: 0.2 + spine_at(y)[2] * 0.45, lambda y: 0.07 + spine_at(y)[2] * 0.11, lean=1.7, ratio=0.85, rings=10, seg=8, ridges=2)
    for s in (1, -1):
        for y in ys[1::2]:
            z0, rx, rz = spine_at(y)
            r0 = V((0.55 * rx * s, y, z0 + rz * 0.8))
            horn(part, dir_ctrl(r0, V((0.9 * s, -0.55, 0.6)), 0.2 + rz * 0.3, V((0, -0.05, 0.0))), 0.05 + rz * 0.05, SPINE_W, rings=7, seg=6)
    # barbed stinger on the tail
    w7 = lambda p: {'tail7': 1.0}
    ys = [-9.9, -10.3, -10.9, -11.5, -12.1, -12.6, -13.0]
    rx = [0.09, 0.22, 0.4, 0.36, 0.2, 0.09, 0.015]
    pts = [V((0, y, 0)) for y in ys]
    loft(part, pts, [(r, r * 0.45) for r in rx], seg=10, colfn=lambda i, th, p: (0, 0.5 + 0.5 * i / 6, 0, 0), wfn=lambda i, th, p: w7(p))
    for s in (1, -1):
        horn(part, [V(0.2 * s, -10.9, 0), V(0.55 * s, -11.1, 0.0), V(0.8 * s, -11.0, 0.0), V(0.85 * s, -10.6, 0.0)], 0.07, w7, rings=10, seg=6)
    crest_web(part, 5.0, -8.8, 0.3)


def rib(part, O, tip, r, w, bow=None):
    """A thin curved bone from O to tip (fin and hood supports)."""
    d = tip - O
    b = bow or V((0, 0, 0))
    nosub, part.nosub = part.nosub, True
    horn(part, [O, O + d * 0.33 + b, O + d * 0.68 + b, tip], r, w, rings=8, seg=7, taper=1.0)
    part.nosub = nosub


def sheet(part, pts, wts, thin, phase=None, flag=1.0, flip=False):
    """A grid of membrane quads. Vertex colour: R thin (distance from bones, lets light through), G = 1 marks a
    fin/sail/hood (ribbed relief instead of wing veins), B = rib phase across the panel (0 and 1 are ribs)."""
    grid = []
    for i, (rp, rt, rw) in enumerate(zip(pts, thin, wts)):
        grid.append([part.add(p, (t, flag, phase[i][j] if phase else 0.0, 0), w) for j, (p, t, w) in enumerate(zip(rp, rt, rw))])
    quads(part, grid, flip)


def fan_panels(part, O, tips, wfn, nu=8, nv=5, scallop=0.25, thin0=0.2, flip=False):
    """Membrane stretched between ribs radiating from O to each tip, with scalloped free edges."""
    for A, B in zip(tips[:-1], tips[1:]):
        pts, wts, thin, ph = [], [], [], []
        for iu in range(nu + 1):
            u = iu / nu
            rp, rw, rt, rph = [], [], [], []
            for iv in range(nv + 1):
                v = iv / nv
                p = O + (A.lerp(B, v) - O) * u * (1 - scallop * math.sin(math.pi * v) * u * u)
                p.z += 0.04 * math.sin(math.pi * v) * u
                rp.append(p)
                rw.append(wfn(p))
                rt.append(thin0 + (1 - thin0) * u)
                rph.append(v)
            pts.append(rp); wts.append(rw); thin.append(rt); ph.append(rph)
        sheet(part, pts, wts, thin, ph, flip=flip)


def hood_tips(s=1.0):
    O = V((0, 5.45, 0.55))
    tips = []
    for deg in range(-128, 129, 32):
        f = math.radians(deg)
        R = 0.95 + 1.2 * abs(math.sin(f))
        tips.append(O + V((math.sin(f) * R * 1.2, -0.95 - 0.7 * abs(math.sin(f)), math.cos(f) * R * 0.85)))
    return O, tips


def ember_ear(s):
    return head_pt(6.25, 1.6, s, -0.03), [V(1.55 * s, 5.3, 1.05), V(1.5 * s, 5.45, 0.55), V(1.38 * s, 5.62, 0.1)]


def storm_ear(s):
    return head_pt(6.3, 1.7, s, -0.03), [V(2.0 * s, 4.75, 1.15), V(2.15 * s, 4.65, 0.55), V(1.85 * s, 5.0, 0.0), V(1.4 * s, 5.45, -0.45)]


def wextras_ember(part):
    part.tag = EXTRA_TAGS['ember']
    for s in (1, -1):
        O, tips = ember_ear(s)
        fan_panels(part, O, tips, HEAD_W, nu=6, nv=4, flip=s < 0)


def wextras_storm(part):
    part.tag = EXTRA_TAGS['storm']
    # sail between the tall spines
    ys = [5.0, 4.0, 3.0, 2.0, 1.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0, -6.0, -7.0, -8.0]
    tipp = []
    for y in ys:
        h = 0.5 + spine_at(y)[2] * 1.3
        tipp.append((y - h * 0.66 * 1.1, spine_top(y) + h, h))
    NS = 60
    pts, wts, thin, ph = [], [], [], []
    for n in range(NS + 1):
        f = n / NS * (len(tipp) - 1)
        i = min(int(f), len(tipp) - 2)
        u = f - i
        (y0, z0, h0), (y1, z1, h1) = tipp[i], tipp[i + 1]
        dip = 1 - 0.5 * math.sin(math.pi * u) ** 1.5
        y = lerp(y0, y1, u)
        zt = spine_top(y)
        top = V((0, y, zt + (lerp(z0, z1, u) - zt) * dip))
        row, rw, rt, rph = [], [], [], []
        for j in range(4):
            k = j / 3
            p = V((0, top.y + (1 - k) * 0.25, zt + (top.z - zt) * k))
            row.append(p); rw.append(SPINE_W(p)); rt.append(0.25 + 0.75 * k); rph.append(u)
        pts.append(row); wts.append(rw); thin.append(rt); ph.append(rph)
    sheet(part, pts, wts, thin, ph)
    for s in (1, -1):
        # big swept ear fins
        O, tips = storm_ear(s)
        fan_panels(part, O, tips, HEAD_W, nu=8, nv=5, scallop=0.3, flip=s < 0)
    # swallow-tail fin: membrane between the three tail rapiers
    w7 = lambda p: {'tail7': 1.0}
    O = V((0, -9.95, 0))
    tips = [V(1.9, -12.4, 0.2), V(0.0, -14.2, 0.0), V(-1.9, -12.4, 0.2)]
    fan_panels(part, O, tips, w7, nu=10, nv=6, scallop=0.35, thin0=0.4)


def wextras_venom(part):
    part.tag = EXTRA_TAGS['venom']
    O, tips = hood_tips()
    fan_panels(part, O, tips, lambda p: {'neck4': 1.0}, nu=8, nv=4, scallop=0.28, thin0=0.35)


def limb(part, pts, radii, names, side_tag, claws=3, claw_dir=None):
    chain = [(f'{n}.{side_tag}', pts[i], pts[i + 1]) for i, n in enumerate(names)]
    # densify
    c2, r2 = [], []
    for i in range(len(pts)):
        c2.append(pts[i]); r2.append(radii[i])
        if i < len(pts) - 1:
            c2.append(lerpv(pts[i], pts[i + 1], 0.5))
            r2.append(((radii[i][0] + radii[i + 1][0]) / 2, (radii[i][1] + radii[i + 1][1]) / 2))
    loft(part, c2, r2, seg=10, colfn=lambda i, th, p: (smooth(-0.2, -0.7, math.cos(th)) * 0.6, 0, 0, 0),
         wfn=lambda i, th, p: chain_weights(p, chain))
    end = pts[-1]
    last = chain[-1][0]
    d = (pts[-1] - pts[-2]).normalized() if claw_dir is None else claw_dir
    side = d.cross(V((0, 0, 1))).normalized()
    down = side.cross(d).normalized()
    rigid = lambda i, th, p, last=last: {last: 1.0}
    skin = lambda i, th, p: (smooth(-0.2, -0.7, math.cos(th)) * 0.5, 0, 0, 0)
    r0 = radii[-1][0] * 0.5
    for k in range(claws):
        ang = (k - (claws - 1) / 2) * 0.42
        dd = (d * math.cos(ang) + side * math.sin(ang)).normalized()
        b = end + side * ((k - (claws - 1) / 2) * r0 * 1.3) - d * r0
        knuckle = b + dd * 0.2 + down * 0.03
        tip = knuckle + dd * 0.17 + down * 0.06
        loft(part, [b, lerpv(b, knuckle, 0.5), knuckle, lerpv(knuckle, tip, 0.5), tip],
             [(r0, r0), (r0 * 0.8, r0 * 0.8), (r0 * 0.88, r0 * 0.82), (r0 * 0.7, r0 * 0.68), (r0 * 0.62, r0 * 0.6)],
             seg=8, colfn=skin, wfn=rigid)
        cone(part, tip, tip + dd * 0.22 + down * 0.1, r0 * 0.6, BONE, lambda p, last=last: {last: 1.0}, seg=8, rings=6,
             bend=down * 0.06)
    # dewclaw
    b = end - d * r0 * 2.2 - side * r0
    cone(part, b, b - side * 0.08 + d * 0.1 + down * 0.16, r0 * 0.5, BONE, lambda p, last=last: {last: 1.0}, seg=6, rings=5)


def toe(part, base, dirv, side, lens, radii, curl, w, claw=0.24, claw_r=0.045, down=V((0, 0, -1))):
    """A clawed toe: knuckled phalanges that curl down and back, ending in a hooked claw."""
    d = dirv.normalized()
    pts = [V(base)]
    rad = [(radii[0], radii[0] * 0.9)]
    ang = 0.0
    p = V(base)
    for k, ln in enumerate(lens):
        ang += curl[k]
        dd = (d * math.cos(ang) + down * math.sin(ang)).normalized()
        p = p + dd * ln
        pts.append(V(p))
        rad.append((radii[k + 1], radii[k + 1] * 0.9))
    # knuckle swellings: densify with a bulge at every joint
    dense, drad = [pts[0]], [rad[0]]
    for i in range(1, len(pts)):
        mid = lerpv(pts[i - 1], pts[i], 0.5)
        dense += [mid, pts[i]]
        drad += [(rad[i - 1][0] * 0.85, rad[i - 1][1] * 0.8), (rad[i][0] * 1.22, rad[i][1] * 1.15)]
    nosub, part.nosub = part.nosub, True
    loft(part, dense, drad, seg=8, colfn=lambda i, th, p: (0.0, 0, 0, 0), wfn=lambda i, th, p: dict(w(p)), fr=path_frames(dense, side))
    tip = pts[-1]
    last = (pts[-1] - pts[-2]).normalized()
    horn(part, [tip - last * 0.03, tip + last * claw * 0.35 + down * 0.03, tip + last * claw * 0.75 + down * claw * 0.3, tip + last * claw * 0.9 + down * claw * 0.75],
         claw_r, w, rings=6, seg=7)
    part.nosub = nosub


def leg(part, pts, prof, names, tag):
    """A muscled limb along the joints in pts: radius (rx, rz) follows prof, a list of (u, rx, rz) with u the fraction
    of the path length."""
    chain = [(f'{n}.{tag}', pts[i], pts[i + 1]) for i, n in enumerate(names)]
    lens = [(pts[i + 1] - pts[i]).length for i in range(len(pts) - 1)]
    tot = sum(lens)
    P, U = [], []
    cum = 0.0
    for i, ln in enumerate(lens):
        n = max(4, int(ln / 0.16))
        for k in range(n):
            P.append(lerpv(pts[i], pts[i + 1], k / n))
            U.append((cum + ln * k / n) / tot)
        cum += ln
    P.append(V(pts[-1]))
    U.append(1.0)
    us = [q[0] for q in prof]
    rad = [(float(np.interp(u, us, [q[1] for q in prof])), float(np.interp(u, us, [q[2] for q in prof]))) for u in U]
    fr = path_frames(P, V((1, 0, 0)))

    def colfn(i, th, p):
        below = (P[i].z - p.z) / max(rad[i][1], 0.05)
        return (smooth(0.1, 0.9, below) * 0.55, 0, 0, 0)

    loft(part, P, rad, seg=14, colfn=colfn, wfn=lambda i, th, p: chain_weights(p, chain), fr=fr)


def hind_leg(part, s, tag):
    H, K, A, T = [mirror(p, s) for p in HIND]
    leg(part, [H, K, A], [(0.0, 0.5, 0.55), (0.1, 0.62, 0.66), (0.24, 0.5, 0.52), (0.36, 0.32, 0.34), (0.42, 0.34, 0.34), (0.5, 0.29, 0.26),
                          (0.68, 0.19, 0.18), (0.88, 0.14, 0.13), (1.0, 0.145, 0.13)], ['thigh', 'shin'], tag)
    foot = lambda p: {f'foot.{tag}': 1.0}
    shin = lambda p: {f'shin.{tag}': 1.0}
    thigh = lambda p: {f'thigh.{tag}': 1.0}
    # metatarsus: a slim foot bone with a heel
    d = (T - A).normalized()
    F0 = A + d * 0.5
    pf = [A - d * 0.05, A + d * 0.2, F0]
    loft(part, pf, [(0.145, 0.13), (0.12, 0.1), (0.1, 0.09)], seg=10, colfn=lambda i, th, p: (0.0, 0, 0, 0),
         wfn=lambda i, th, p: foot(p), fr=path_frames(pf, V((1, 0, 0))))
    side = V((s, 0, 0))
    # four toes folded back, curling in toward the belly
    for k in range(4):
        yaw = (k - 1.5) * 0.3
        dd = (d * math.cos(yaw) + side * math.sin(yaw)).normalized()
        toe(part, F0 + side * ((k - 1.5) * 0.07), dd, side, [0.2, 0.17, 0.14], [0.075, 0.065, 0.055, 0.045], [0.1, 0.45, 0.6], foot,
            claw=0.28 if k in (1, 2) else 0.22, down=V((-0.2 * s, 0.0, -1.0)).normalized())
    # a spur on the heel, a knee spike, and scutes down the back of the shin
    nosub, part.nosub = part.nosub, True
    horn(part, [A + V(0, 0.05, 0.05), A + V(0.0, 0.15, 0.2), A + V(0.0, 0.3, 0.3), A + V(0.0, 0.5, 0.28)], 0.06, foot, rings=7, seg=7)
    horn(part, [K + V(0.18 * s, 0.0, 0.05), K + V(0.33 * s, -0.05, 0.1), K + V(0.45 * s, -0.2, 0.12), K + V(0.52 * s, -0.4, 0.08)], 0.07, shin, rings=7, seg=7)
    for u in (0.35, 0.5, 0.65, 0.8):
        p = lerpv(K, A, u) + V(0.0, 0.0, 0.12 * (1 - u))
        horn(part, [p, p + V(0.03 * s, -0.04, 0.1), p + V(0.04 * s, -0.12, 0.15), p + V(0.04 * s, -0.22, 0.14)], 0.045 * (1.1 - u * 0.5), shin, rings=5, seg=6)
    part.nosub = nosub
    # a ridge of muscle laid over the outside of the thigh
    c = [lerpv(H, K, t) + V(0.12 * s, 0.0, 0.1) for t in (0.1, 0.35, 0.6, 0.85)]
    loft(part, c, [(0.22, 0.2), (0.27, 0.24), (0.22, 0.2), (0.1, 0.1)], seg=10, colfn=lambda i, th, p: (0.0, 0, 0, 0), wfn=lambda i, th, p: thigh(p),
         fr=path_frames(c, V((1, 0, 0))))


def fore_leg(part, s, tag):
    S, E, W, T = [mirror(p, s) for p in FORE]
    leg(part, [S, E, W], [(0.0, 0.34, 0.36), (0.14, 0.39, 0.4), (0.34, 0.29, 0.3), (0.5, 0.2, 0.2), (0.56, 0.22, 0.22), (0.72, 0.16, 0.15), (1.0, 0.125, 0.11)],
        ['upperleg', 'foreleg'], tag)
    hand = lambda p: {f'hand.{tag}': 1.0}
    fore = lambda p: {f'foreleg.{tag}': 1.0}
    d = (T - W).normalized()
    side = V((s, 0, 0))
    ph = [W - d * 0.05, W + d * 0.25]
    loft(part, ph, [(0.125, 0.11), (0.1, 0.085)], seg=10, colfn=lambda i, th, p: (0.0, 0, 0, 0), wfn=lambda i, th, p: hand(p), fr=path_frames(ph, V((1, 0, 0))))
    for k in range(3):
        yaw = (k - 1) * 0.34
        dd = (d * math.cos(yaw) + side * math.sin(yaw)).normalized()
        toe(part, W + d * 0.22 + side * ((k - 1) * 0.06), dd, side, [0.15, 0.13, 0.11], [0.06, 0.052, 0.045, 0.038], [0.2, 0.55, 0.7], hand,
            claw=0.22, claw_r=0.04, down=V((-0.15 * s, 0, -1)).normalized())
    nosub, part.nosub = part.nosub, True
    horn(part, [E + V(0.12 * s, 0, 0.05), E + V(0.22 * s, 0.1, 0.1), E + V(0.3 * s, 0.25, 0.1), E + V(0.34 * s, 0.4, 0.05)], 0.055, fore, rings=6, seg=6)
    part.nosub = nosub


def build_limbs(part):
    for tag, s in SIDES.items():
        hind_leg(part, s, tag)
        fore_leg(part, s, tag)
        # wing arm: thick bones on the leading edge
        w = [mirror(WING['shoulder'], s), mirror(WING['elbow'], s), mirror(WING['wrist'], s)]
        chain = [(f'upperarm.{tag}', w[0], w[1]), (f'forearm.{tag}', w[1], w[2])]
        pts = [w[0], lerpv(w[0], w[1], 0.5), w[1], lerpv(w[1], w[2], 0.5), w[2]]
        loft(part, pts, [(0.36, 0.36), (0.26, 0.24), (0.24, 0.22), (0.18, 0.16), (0.17, 0.15)], seg=14,
             colfn=lambda i, th, p: (0.15, 0, 0, 0), wfn=lambda i, th, p, chain=chain: chain_weights(p, chain))
        # knuckles at the elbow and wrist
        for c, r in ((w[1], 0.27), (w[2], 0.21)):
            ring, rad = [], []
            for k in range(9):
                a = -math.pi / 2 + k / 8 * math.pi
                ring.append(c + V((0, math.sin(a) * r, 0)))
                rr = math.cos(a) * r + 0.004
                rad.append((rr, rr * 0.85))
            loft(part, ring, rad, seg=12, colfn=lambda i, th, p: (0.15, 0, 0, 0),
                 wfn=lambda i, th, p, c=c, chain=chain: chain_weights(c, chain))
        # fingers, each with two joints
        ts = [i / 12 for i in range(13)]
        for k, tip in enumerate(WING['tips']):
            name = f'finger{k + 1}.{tag}'
            tp = mirror(tip, s)
            pts = [lerpv(w[2], tp, t) for t in ts]
            r0 = 0.13 - k * 0.012
            joint = lambda t: 1 + 0.28 * (math.exp(-((t - 0.38) / 0.04) ** 2) + math.exp(-((t - 0.7) / 0.035) ** 2))
            loft(part, pts, [(r0 * (1 - t * 0.8) * joint(t), r0 * (1 - t * 0.8) * joint(t)) for t in ts], seg=10,
                 colfn=lambda i, th, p: (0.1, 0, 0, 0), wfn=lambda i, th, p, name=name: {name: 1.0}, cap1=True)
        # thumb claw at the wrist and a spike at the elbow
        cone(part, w[2], w[2] + V((0.25 * s, 0.75, 0.2)), 0.1, BONE, lambda p, tag=tag: {f'forearm.{tag}': 1.0}, seg=8, rings=8,
             bend=V((0, 0.05, -0.12)))
        cone(part, w[1], w[1] + V((0.3 * s, -0.6, 0.25)), 0.09, BONE, lambda p, tag=tag: {f'upperarm.{tag}': 1.0}, seg=6)
        # tips claws
        for k, tip in enumerate(WING['tips']):
            tp = mirror(tip, s)
            d = (tp - w[2]).normalized()
            cone(part, tp, tp + d * 0.45 + V((0, 0, -0.1)), 0.04, BONE, lambda p, k=k, tag=tag: {f'finger{k + 1}.{tag}': 1.0}, seg=6, rings=4)


def build_membranes(part):
    for tag, s in SIDES.items():
        W = mirror(WING['wrist'], s)
        tips = [mirror(t, s) for t in WING['tips']]
        names = [f'finger{k + 1}.{tag}' for k in range(4)]
        # panels between fingers
        NU, NV = 16, 11
        for f in range(3):
            A, B = tips[f], tips[f + 1]
            grid = []
            for iu in range(NU + 1):
                u = iu / NU
                row = []
                for iv in range(NV + 1):
                    v = iv / NV
                    scallop = 1 - 0.3 * math.sin(math.pi * v) * (u ** 2.2)
                    edge = lerpv(A, B, v)
                    p = W + (edge - W) * u * scallop
                    p.z += 0.22 * math.sin(math.pi * v) * math.sin(math.pi * min(1, u * 1.2))
                    wts = {names[f]: (1 - v), names[f + 1]: v}
                    if u < 0.25:
                        k = 1 - u / 0.25
                        wts = {n: x * (1 - k) for n, x in wts.items()}
                        wts[f'forearm.{tag}'] = k
                    thin = math.sin(math.pi * v) * u
                    row.append(part.add(p, (thin, 0, 0, 0), wts))
                grid.append(row)
            quads(part, grid, flip=s < 0)
            hem(part, [grid[NU][iv] for iv in range(NV + 1)])
        # inner panel: from the arm (wrist -> elbow -> shoulder) to the trailing edge (last finger tip -> hip)
        arm = [W, mirror(WING['elbow'], s), mirror(WING['shoulder'], s)]
        hip = mirror(WING['hip'], s)
        NS, NW = 20, 12
        grid = []
        for isg in range(NS + 1):
            t = isg / NS
            if t < 0.5:
                a = lerpv(arm[0], arm[1], t * 2)
                aw = {f'forearm.{tag}': 1 - t * 2, f'upperarm.{tag}': t * 2}
            else:
                a = lerpv(arm[1], arm[2], (t - 0.5) * 2)
                aw = {f'upperarm.{tag}': 1 - (t - 0.5) * 2, 'chest': (t - 0.5) * 2}
            tr = lerpv(tips[3], hip, t)
            row = []
            for iw in range(NW + 1):
                wv = iw / NW
                scallop = 1 - 0.32 * math.sin(math.pi * t) * (wv ** 2)
                p = a + (tr - a) * wv * scallop
                p.z += 0.25 * math.sin(math.pi * t) * math.sin(math.pi * wv)
                wts = {k: x * (1 - wv) for k, x in aw.items()}
                trail = {names[3]: 1 - t, 'belly': t * 0.6, 'hips': t * 0.4}
                for k, x in trail.items():
                    wts[k] = wts.get(k, 0) + x * wv
                thin = math.sin(math.pi * t) * wv
                row.append(part.add(p, (thin, 0, 0, 0), wts))
            grid.append(row)
        quads(part, grid, flip=s > 0)
        hem(part, [grid[isg][NW] for isg in range(NS + 1)])


def hem(part, idx, r=0.024):
    """A rolled edge along a row of membrane vertices: gives the trailing edge real thickness."""
    pts = [V(part.verts[i]) for i in idx]
    ws = [dict(part.w[i]) for i in idx]
    n = len(pts)
    rad = [r * (0.55 + 0.45 * math.sin(math.pi * (k + 0.5) / n)) for k in range(n)]
    loft(part, pts, [(x, x) for x in rad], seg=6, colfn=lambda i, th, p: (0.0, 0.0, 0.0, 0), wfn=lambda i, th, p: dict(ws[i]),
         fr=path_frames(pts, V((0, 0, 1))))


def quads(part, grid, flip=False):
    for i in range(len(grid) - 1):
        for j in range(len(grid[0]) - 1):
            a, b, c, d = grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]
            part.face((a, d, c, b) if flip else (a, b, c, d))


# --------------------------------------------------------------------------------------------------
# Blender objects


def subset(part, keep):
    """A new Part holding only the faces whose index is in `keep` (vertices remapped)."""
    out = Part()
    out.nouv = part.nouv
    remap = {}
    for fi in keep:
        f = part.faces[fi]
        nf = []
        for vi in f:
            if vi not in remap:
                remap[vi] = out.add(part.verts[vi], part.col[vi], part.w[vi])
            nf.append(remap[vi])
        out.faces.append(tuple(nf))
        out.fuv.append(part.fuv[fi])
        out.ftag.append(part.ftag[fi])
        out.fnosub.append(part.fnosub[fi])
    return out


def split_flat(part):
    """Ice crystals (A mask 0.25), spikes and teeth need no subdivision: split them off."""
    flat = [i for i, f in enumerate(part.faces) if part.fnosub[i] or abs(part.col[f[0]][3] - 0.25) < 0.01]
    fs = set(flat)
    return subset(part, [i for i in range(len(part.faces)) if i not in fs]), subset(part, flat)


def make_object(name, part, subdiv):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in part.verts], [], part.faces)
    me.validate()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    # colour masks
    attr = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(part.col):
        attr.data[i].color = (c[0], c[1], c[2], c[3])
    # weights
    groups = {}
    for i, w in enumerate(part.w):
        tot = sum(w.values()) or 1
        for b, x in w.items():
            if x <= 1e-4:
                continue
            g = groups.get(b) or obj.vertex_groups.new(name=b)
            groups[b] = g
            g.add([i], x / tot, 'REPLACE')
    tagattr = me.attributes.new('tag', 'INT', 'FACE')
    crys = []
    for poly, tg in zip(me.polygons, part.ftag):
        tagattr.data[poly.index].value = tg
        # ice crystals (A mask 0.25) are flat shaded with creased edges: the subdivision keeps their facets
        c = abs(part.col[poly.vertices[0]][3] - 0.25) < 0.01
        poly.use_smooth = not c
        if c:
            crys.append(poly)
    if crys:
        crease = me.attributes.new('crease_edge', 'FLOAT', 'EDGE')
        ekey = {tuple(sorted(e.vertices)): e.index for e in me.edges}
        for poly in crys:
            for k in poly.edge_keys:
                crease.data[ekey[tuple(sorted(k))]].value = 1.0
    if any(part.fuv):
        uvl = me.uv_layers.new(name='UVMap')
        for poly, fuv in zip(me.polygons, part.fuv):
            if fuv:
                for li, u in zip(poly.loop_indices, fuv):
                    uvl.data[li].uv = u
        obj['custom_uv'] = True
    if subdiv:
        m = obj.modifiers.new('sub', 'SUBSURF')
        m.levels = subdiv
        m.render_levels = subdiv
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier='sub')
        obj.select_set(False)
    return obj



# --------------------------------------------------------------------------------------------------
# high-poly sculpt + bake: scales, belly plates, horn rings, skin folds and membrane veins are displaced
# on a dense copy and baked into tangent-space normal, AO and height maps for the game mesh.


def select_only(obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def uv_unwrap(obj):
    select_only(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    if obj.get('custom_uv'):
        # every loft already has an unrolled island in metres: just pack them into the 0..1 atlas
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.pack_islands(rotate=True, margin=0.006)
    else:
        bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=0.0035, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def cellular(q, seed=1):
    """3D Worley noise on points q (N,3): returns F1, F2 and the F1 feature point."""
    base = np.floor(q)
    f1 = np.full(len(q), 9.0)
    f2 = np.full(len(q), 9.0)
    fp = np.zeros_like(q)
    rid = np.zeros(len(q))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                c = base + (dx, dy, dz)
                h = (c[:, 0] * 73856093 + c[:, 1] * 19349663 + c[:, 2] * 83492791 + seed * 2654435761).astype(np.int64)
                h = (h ^ (h >> 13)) * 1274126177
                r1 = ((h & 0xFFFF) / 65535.0)
                r2 = (((h >> 16) & 0xFFFF) / 65535.0)
                r3 = (((h >> 32) & 0xFFFF) / 65535.0)
                pnt = c + np.stack([0.15 + 0.7 * r1, 0.15 + 0.7 * r2, 0.15 + 0.7 * r3], 1)
                d = np.linalg.norm(q - pnt, axis=1)
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                fp = np.where(closer[:, None], pnt, fp)
                rid = np.where(closer, r1 * 0.6 + r3 * 0.4, rid)
                f1 = np.where(closer, d, f1)
    return f1, f2, fp, rid


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def hashf(ix, iy, iz, seed):
    h = ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return (h & 0xFFFF) / 65535.0


def vnoise(q, seed=1):
    """Smooth 3D value noise in 0..1."""
    i = np.floor(q).astype(np.int64)
    f = q - i
    f = f * f * (3 - 2 * f)

    def c(dx, dy, dz):
        return hashf(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)

    def mix(a, b, t):
        return a + (b - a) * t

    x00 = mix(c(0, 0, 0), c(1, 0, 0), f[:, 0])
    x10 = mix(c(0, 1, 0), c(1, 1, 0), f[:, 0])
    x01 = mix(c(0, 0, 1), c(1, 0, 1), f[:, 0])
    x11 = mix(c(0, 1, 1), c(1, 1, 1), f[:, 0])
    return mix(mix(x00, x10, f[:, 1]), mix(x01, x11, f[:, 1]), f[:, 2])


def fbm(co, scale, seed=1, octaves=3):
    tot, amp, norm = 0.0, 0.5, 0.0
    for o in range(octaves):
        tot = tot + amp * vnoise(co * (2 ** o / scale), seed + o * 17)
        norm += amp
        amp *= 0.5
    return tot / norm


JOINTS = []  # skin gathers around these points (bind pose, Blender axes): (x, y, z, radius)
for _s in (1, -1):
    JOINTS += [(0.95 * _s, 1.6, 0.55, 0.5), (0.8 * _s, 2.35, -0.55, 0.35), (0.72 * _s, -1.7, -0.35, 0.5), (1.0 * _s, -0.85, -1.0, 0.3),
               (0.88 * _s, 1.55, -1.15, 0.24), (3.4 * _s, 0.5, 0.85, 0.3), (6.0 * _s, 1.75, 0.95, 0.24)]


def body_relief(co, nrm, col):
    """Displacement (m) for each vertex of the dense body, plus two packed 3-channel maps:
    p1 = (sculpt height, per-scale random id, 0)  p2 = (stripe band, blotch, mottle) colour masks for the shader."""
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    belly, eye, mouth = col[:, 0], col[:, 2], col[:, 3]
    horn = sstep(0.4, 0.5, col[:, 1])  # G: 0.5..1 on horns, claws and spikes (root..tip), 0.3 on the crest
    crys = (np.abs(mouth - 0.25) < 0.05).astype(np.float64)  # A = 0.25: ice crystals (smooth facets)
    tongue = (np.abs(mouth - 0.75) < 0.05).astype(np.float64)
    mouth = (mouth > 0.9).astype(np.float64)
    # scale size by region: big on the back, small on head, limbs and toward the tail tip
    cell = np.full(len(co), 0.11)
    cell = np.where(y > 3.4, 0.11 - sstep(3.4, 6.0, y) * 0.072, cell)
    cell = np.where(y < -2.0, 0.11 - np.clip((-y - 2.0) / 9.0, 0, 1) * 0.065, cell)
    limbs = (np.abs(x) > 0.75) & ((z < -0.55) | (np.abs(x) > 1.4))
    cell = np.where(limbs, 0.055, cell)
    q = co / cell[:, None]
    q[:, 1] *= 0.8  # slightly elongated along the body
    f1, f2, fp, rid = cellular(q, 7)
    edge = sstep(0.0, 0.13, f2 - f1)  # narrow grooves between scales
    dome = 1 - np.clip(f1, 0, 1) ** 2 * 0.4
    tilt = np.clip((fp[:, 1] - q[:, 1]) * 0.55, -0.4, 0.5)  # free edge toward the tail stands proud
    keel = 1 - sstep(0.0, 0.32, np.abs(q[:, 0] - fp[:, 0]))  # a ridge down the middle of each scale
    scales = edge * (dome * 0.65 + tilt + keel * 0.3) * (0.8 + 0.4 * rid)
    # fine pebbling inside the big scales
    g1, g2, _, _ = cellular(co / 0.028, 3)
    pebble = sstep(0.0, 0.3, g2 - g1)
    scales = scales * 0.85 + pebble * 0.15
    # belly: transverse plates with a central seam
    ph = (y / 0.3) % 1.0
    plates = sstep(0.0, 0.14, ph) * (1 - 0.35 * ph) * sstep(0.0, 0.06, np.abs(x))
    skin = scales * (1 - sstep(0.35, 0.75, belly)) + plates * sstep(0.35, 0.75, belly)
    # a keeled row of scutes down the spine, and plates along the brow ridge and snout
    spine = sstep(0.06, 0.0, np.abs(x)) * (0.5 + 0.5 * np.sin(y * 2 * np.pi / 0.22)) * sstep(0.3, 0.8, nrm[:, 2]) * (y < 5.6)
    skin = np.maximum(skin, spine * 0.9)
    # folds where skin gathers at the joints
    fold = np.zeros(len(co))
    for jx, jy, jz, jr in JOINTS:
        d = np.sqrt((x - jx) ** 2 + (y - jy) ** 2 + (z - jz) ** 2)
        fold = np.maximum(fold, np.exp(-(d / jr) ** 2) * (0.5 + 0.5 * np.sin(d * 58 + vnoise(co * 6, 2) * 2.0)))
    skin = skin * (1 - 0.55 * fold) + 0.0
    # horns, claws and spikes: growth rings and grain
    rings = 0.5 + 0.5 * np.sin((y * 0.9 + z * 0.7 + np.abs(x) * 0.5) * 34 + np.sin(x * 11) * 1.5)
    grain = 0.5 + 0.5 * np.sin((x * 3 + z * 2) * 60 + np.sin(y * 25) * 2)
    bone = rings * 0.7 + grain * 0.3
    hgt = skin * (1 - horn) + bone * horn
    # folds in the throat and mouth corners
    wrinkle = 0.5 + 0.5 * np.sin(y * 38 + np.sin(z * 9) * 2)
    throat = sstep(3.0, 3.6, y) * (1 - sstep(5.4, 5.9, y)) * sstep(-0.1, -0.5, nrm[:, 2])
    hgt = hgt * (1 - throat * 0.6) + wrinkle * throat * 0.6
    # tongue: fine papillae; crystals: perfectly smooth facets with faint internal flaws
    pap = sstep(0.0, 0.3, cellular(co / 0.012, 5)[1] - cellular(co / 0.012, 5)[0]) if tongue.any() else 0
    hgt = hgt * (1 - tongue) + (0.5 + 0.25 * pap) * tongue
    hgt = hgt * (1 - crys) + 0.5 * crys
    amp = np.where(horn > 0.5, 0.008, np.clip(cell / 0.11, 0.8, 1) * 0.022)
    amp = amp * (1 - eye) * (1 - mouth * 0.7) * (1 - crys) * (1 - tongue * 0.5)
    # colour masks (the shader tints them per breed)
    wob = fbm(co, 0.9, 31, 2) - 0.5
    band = 0.5 + 0.5 * np.sin(y * 12.5 + wob * 5.0 + np.sin(x * 3.0) * 0.6)
    stripe = sstep(0.5, 0.82, band) * sstep(0.22, 0.55, fbm(co, 0.5, 41, 2))
    c1, _, _, id1 = cellular(co / 0.4, 11)
    blotch = (1 - sstep(0.12, 0.5, c1)) * sstep(0.5, 0.75, id1)
    mott = fbm(co, 0.7, 5, 4)
    p1 = np.stack([np.clip(hgt, 0, 1) * (1 - eye), rid, np.zeros_like(rid)], 1)
    p2 = np.stack([stripe, blotch, mott], 1)
    return (hgt - 0.5) * amp, p1, p2


def wing_relief(co, nrm, col):
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    thin = col[:, 0]
    fin = (col[:, 1] > 0.5).astype(np.float64)
    phase = col[:, 2]
    ax = np.abs(x)
    # veins: branching ridges that run out from the wrist, plus fine stretch wrinkles
    ang = np.arctan2(y - 1.75, ax - 6.0)
    r = np.hypot(ax - 6.0, y - 1.75)
    warp = np.sin(r * 1.7 + ax * 0.6) * 0.18 + np.sin(r * 4.3) * 0.05
    v1 = 1 - sstep(0.0, 0.05, np.abs(np.sin((ang + warp) * 9.0)))
    v2 = 1 - sstep(0.0, 0.035, np.abs(np.sin((ang - warp * 1.7) * 23.0 + r * 1.1)))
    branch = sstep(1.5, 3.0, r)
    veins = np.maximum(v1, v2 * branch * 0.7)
    wrinkle = 0.5 + 0.5 * np.sin(r * 26 + np.sin(ang * 14) * 2.5)
    hgt = veins * 0.8 + wrinkle * 0.2 * thin
    # fins, sails and hoods: straight ribs where the phase is 0 or 1, thinner ribs between, fine ripples
    rib = 1 - sstep(0.0, 0.08, np.minimum(phase, 1 - phase))
    mid = 1 - sstep(0.0, 0.05, np.abs(phase - 0.5))
    ripple = 0.5 + 0.5 * np.sin((x * 31 + y * 17 + z * 23) + vnoise(co * 5, 4) * 3)
    fh = np.maximum(rib, mid * 0.5) * 0.85 + 0.15 * ripple * thin
    hgt = hgt * (1 - fin) + fh * fin
    mott = fbm(co, 0.55, 9, 4)
    # speckle: small darker flecks like freckles on the membrane
    fl, _, _, fid = cellular(co / 0.12, 13)
    fleck = (1 - sstep(0.1, 0.25, fl)) * (fid > 0.5)
    p1 = np.stack([np.clip(hgt, 0, 1), np.zeros_like(hgt), np.zeros_like(hgt)], 1)
    p2 = np.stack([mott, fleck, np.zeros_like(hgt)], 1)
    return (hgt - 0.3) * 0.016, p1, p2


def make_high(obj, levels, relief):
    hi = obj.copy()
    hi.data = obj.data.copy()
    hi.name = obj.name + 'High'
    hi.modifiers.clear()
    bpy.context.collection.objects.link(hi)
    m = hi.modifiers.new('sub', 'SUBSURF')
    m.levels = levels
    m.render_levels = levels
    select_only(hi)
    bpy.ops.object.modifier_apply(modifier='sub')
    me = hi.data
    n = len(me.vertices)
    co = np.zeros(n * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    nrm = np.zeros(n * 3)
    me.vertex_normals.foreach_get('vector', nrm)
    nrm = nrm.reshape(-1, 3)
    col = np.zeros(n * 4)
    me.color_attributes['Color'].data.foreach_get('color', col)
    col = col.reshape(-1, 4)
    disp = np.zeros(n)
    p1 = np.zeros((n, 3))
    p2 = np.zeros((n, 3))
    has2 = False
    t0 = time.time()
    for a in range(0, n, 100000):
        d, h1, h2 = relief(co[a:a + 100000], nrm[a:a + 100000], col[a:a + 100000])
        disp[a:a + 100000] = d
        p1[a:a + 100000] = h1
        if h2 is not None:
            p2[a:a + 100000] = h2
            has2 = True
    print(f'  relief computed in {time.time() - t0:.0f}s')
    co += nrm * disp[:, None]
    me.vertices.foreach_set('co', co.ravel())
    for name, data in (('H', p1), ('C', p2)):
        attr = me.color_attributes.new(name, 'FLOAT_COLOR', 'POINT')
        rgba = np.ones((n, 4))
        rgba[:, :3] = data
        attr.data.foreach_set('color', rgba.ravel())
    me.update()
    # emission material so the packed maps can be baked as colours
    mat = bpy.data.materials.new(hi.name + 'Emit')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    attr = nt.nodes.new('ShaderNodeAttribute')
    attr.attribute_name = 'H'
    em = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(attr.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    hi.data.materials.clear()
    hi.data.materials.append(mat)
    hi['has_c'] = has2
    print(f'  {hi.name}: {len(me.polygons)} faces')
    return hi


def bake_maps(lo, hi, size, prefix, col_size=1024):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    mat = lo.data.materials[0]
    nt = mat.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    nt.nodes.active = tex
    attr = hi.data.materials[0].node_tree.nodes['Attribute']
    results = {}
    jobs = [('NORMAL', None), ('AO', None), ('EMIT', 'H')] + ([('EMIT', 'C')] if hi.get('has_c') else [])
    for kind, an in jobs:
        key = kind if an is None else an
        img = bpy.data.images.new(f'{prefix}_{key}', size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = 'Non-Color'
        tex.image = img
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        hi.select_set(True)
        lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        if an:
            attr.attribute_name = an
        t0 = time.time()
        kw = {'normal_space': 'TANGENT'} if kind == 'NORMAL' else {}
        scene.cycles.samples = 40 if kind == 'AO' else 16
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.035, max_ray_distance=0.07, margin=10, **kw)
        print(f'  baked {prefix} {key} in {time.time() - t0:.0f}s')
        px = np.zeros(size * size * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        results[key] = px.reshape(size, size, 4)
    nt.nodes.remove(tex)
    # normal map as is; AO (R) + sculpt height (G) + a per-prefix extra (B) packed into one map
    save_jpeg(results['NORMAL'][..., :3], os.path.join(ASSETS, f'{prefix}_normal.jpg'), 94)
    ao = np.clip(results['AO'][..., 0], 0, 1)
    h = np.clip(results['H'][..., :3], 0, 1)
    save_jpeg(np.stack([ao, h[..., 0], h[..., 1]], -1), os.path.join(ASSETS, f'{prefix}_ao.jpg'), 90)
    if 'C' in results:
        c = np.clip(results['C'][..., :3], 0, 1)
        k = size // col_size
        c = c.reshape(col_size, k, col_size, k, 3).mean(axis=(1, 3))
        save_jpeg(c, os.path.join(ASSETS, f'{prefix}_col.jpg'), 90)


def save_jpeg(rgb, path, quality):
    h, w, _ = rgb.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = rgb
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = 'JPEG'
    scene = bpy.context.scene
    scene.render.image_settings.quality = quality
    img.save(filepath=path, quality=quality)
    print('  wrote', os.path.basename(path), os.path.getsize(path) // 1024, 'KB')


def make_lod(obj, ratio, name):
    lod = obj.copy()
    lod.data = obj.data.copy()
    lod.name = name
    lod.modifiers.clear()
    bpy.context.collection.objects.link(lod)
    m = lod.modifiers.new('dec', 'DECIMATE')
    m.ratio = ratio
    m.use_collapse_triangulate = True
    select_only(lod)
    bpy.ops.object.modifier_apply(modifier='dec')
    return lod


def build_armature():
    arm = bpy.data.armatures.new('DragonRig')
    rig = bpy.data.objects.new('Dragon', arm)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones

    def bone(name, head, tail, parent=None, roll=0):
        b = eb.new(name)
        b.head = head
        b.tail = tail
        b.roll = roll
        if parent:
            b.parent = eb[parent]
        return b

    bone('root', V((0, 0, 0)), V((0, 0.6, 0)))
    bone('chest', V((0, 0.8, -0.08)), V((0, 2.1, -0.15)), 'root')
    bone('belly', V((0, 0.8, -0.08)), V((0, -0.5, -0.05)), 'chest')
    bone('hips', V((0, -0.5, -0.05)), V((0, -1.8, 0.0)), 'belly')
    prev = 'hips'
    for n, h, t in SPINE_BONES[:7][::-1]:
        bone(n, V((0, h[0], h[1])), V((0, t[0], t[1])), prev)
        prev = n
    prev = 'chest'
    for n, h, t in SPINE_BONES[10:]:
        bone(n, V((0, h[0], h[1])), V((0, t[0], t[1])), prev)
        prev = n
    bone('jaw', V((0, 5.85, 0.3)), V((0, 8.15, 0.12)), 'head')
    for tag, s in SIDES.items():
        w = [mirror(WING['shoulder'], s), mirror(WING['elbow'], s), mirror(WING['wrist'], s)]
        bone(f'upperarm.{tag}', w[0], w[1], 'chest')
        bone(f'forearm.{tag}', w[1], w[2], f'upperarm.{tag}')
        for k, tip in enumerate(WING['tips']):
            bone(f'finger{k + 1}.{tag}', w[2], mirror(tip, s), f'forearm.{tag}')
        h = [mirror(p, s) for p in HIND]
        bone(f'thigh.{tag}', h[0], h[1], 'hips')
        bone(f'shin.{tag}', h[1], h[2], f'thigh.{tag}')
        bone(f'foot.{tag}', h[2], h[3], f'shin.{tag}')
        f = [mirror(p, s) for p in FORE]
        bone(f'upperleg.{tag}', f[0], f[1], 'chest')
        bone(f'foreleg.{tag}', f[1], f[2], f'upperleg.{tag}')
        bone(f'hand.{tag}', f[2], f[3], f'foreleg.{tag}')
    for b in eb:
        b.use_connect = False
        b.use_deform = b.name != 'root'
    bpy.ops.object.mode_set(mode='OBJECT')
    rig.select_set(False)
    return rig


def bind(obj, rig):
    obj.parent = rig
    m = obj.modifiers.new('rig', 'ARMATURE')
    m.object = rig


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = 0.55
    # vertex colours go out as COLOR_0 when referenced by the material
    attr = mat.node_tree.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Color'
    return mat


# --------------------------------------------------------------------------------------------------
# GLB size: Blender writes float RGBA colours, float weights and 16-bit joints; repack those as normalised bytes
# (all core glTF), UVs as normalised 16-bit, indices as 16-bit where possible. Positions and normals stay float.

import json
import struct

_CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def optimize_glb(path):
    raw = open(path, 'rb').read()
    magic, ver, total = struct.unpack('<III', raw[:12])
    jl, jt = struct.unpack('<II', raw[12:20])
    doc = json.loads(raw[20:20 + jl])
    bl, bt = struct.unpack('<II', raw[20 + jl:28 + jl])
    binb = raw[28 + jl:28 + jl + bl]

    def read(acc):
        bv = doc['bufferViews'][acc['bufferView']]
        n, nc = acc['count'], _NC[acc['type']]
        dt = np.dtype(_CT[acc['componentType']])
        off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
        stride = bv.get('byteStride') or dt.itemsize * nc
        if stride == dt.itemsize * nc:
            return np.frombuffer(binb, dt, n * nc, off).reshape(n, nc).copy()
        out = np.empty((n, nc), dt)
        for i in range(n):
            out[i] = np.frombuffer(binb, dt, nc, off + i * stride)
        return out

    role = {}
    for m in doc.get('meshes', []):
        for pr in m['primitives']:
            for k, a in pr['attributes'].items():
                role[a] = k
            if 'indices' in pr:
                role[pr['indices']] = 'INDICES'
    out = bytearray()
    views = []
    for i, acc in enumerate(doc['accessors']):
        data = read(acc)
        r = role.get(i, '')
        ct = acc['componentType']
        if r.startswith('COLOR_') and ct == 5126:
            data = np.clip(np.round(data * 255), 0, 255).astype(np.uint8)
            acc['componentType'], acc['normalized'] = 5121, True
        elif r.startswith('WEIGHTS_') and ct == 5126:
            q = np.clip(np.round(data * 255), 0, 255).astype(np.int32)
            diff = 255 - q.sum(1)
            q[np.arange(len(q)), data.argmax(1)] += diff
            data = np.clip(q, 0, 255).astype(np.uint8)
            acc['componentType'], acc['normalized'] = 5121, True
        elif r.startswith('JOINTS_') and ct == 5123 and data.max() < 256:
            data = data.astype(np.uint8)
            acc['componentType'] = 5121
        elif r.startswith('TEXCOORD_') and ct == 5126 and data.min() >= 0 and data.max() <= 1:
            data = np.clip(np.round(data * 65535), 0, 65535).astype(np.uint16)
            acc['componentType'], acc['normalized'] = 5123, True
        elif r == 'INDICES' and ct == 5125 and data.max() < 65536:
            data = data.astype(np.uint16)
            acc['componentType'] = 5123
        b = np.ascontiguousarray(data).tobytes()
        while len(out) % 4:
            out.append(0)
        views.append({'buffer': 0, 'byteOffset': len(out), 'byteLength': len(b)})
        if r.startswith(('POSITION', 'NORMAL', 'COLOR_', 'WEIGHTS_', 'JOINTS_', 'TEXCOORD_')):
            views[-1]['target'] = 34962
        elif r == 'INDICES':
            views[-1]['target'] = 34963
        out += b
        acc['bufferView'] = len(views) - 1
        acc.pop('byteOffset', None)
    while len(out) % 4:
        out.append(0)
    doc['bufferViews'] = views
    doc['buffers'] = [{'byteLength': len(out)}]
    js = json.dumps(doc, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    blob = struct.pack('<III', magic, ver, 12 + 8 + len(js) + 8 + len(out)) + struct.pack('<II', len(js), jt) + js + struct.pack('<II', len(out), bt) + bytes(out)
    open(path, 'wb').write(blob)
    print(f'  optimised {os.path.basename(path)}: {len(raw) // 1024} KB -> {len(blob) // 1024} KB')



def split_by_tag(obj, prefix):
    """Separate the faces tagged k >= 1 (material slot k) into their own objects named <prefix>_<breed>."""
    out = {}
    me = obj.data
    while len(me.materials) < 5:
        me.materials.append(me.materials[0])
    tags = np.zeros(len(me.polygons), dtype=np.int32)
    me.attributes['tag'].data.foreach_get('value', tags)
    me.polygons.foreach_set('material_index', tags)
    for breed, k in EXTRA_TAGS.items():
        if not (tags == k).any():
            continue
        select_only(obj)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='DESELECT')
        obj.active_material_index = k
        bpy.ops.object.material_slot_select()
        before = set(bpy.data.objects.keys())
        bpy.ops.mesh.separate(type='SELECTED')
        bpy.ops.object.mode_set(mode='OBJECT')
        new = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n not in before]
        assert len(new) == 1, new
        new[0].name = f'{prefix}_{breed}'
        new[0].data.name = new[0].name
        out[breed] = new[0]
    return out


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    preview = arg('--preview')
    view = arg('--view', '14,-16,12,0,-1,0,35')
    only = arg('--only')  # build only one breed's extras (fast previews)
    breeds = [only] if only else list(EXTRA_TAGS)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    body = Part()
    build_body(body)
    build_jaw(body)
    build_mouth(body)
    build_head_base(body)
    for b in breeds:
        {'ember': extras_ember, 'frost': extras_frost, 'storm': extras_storm, 'venom': extras_venom}[b](body)
    body.tag = 0
    build_limbs(body)
    wings = Part()
    wings.nouv = True
    build_membranes(wings)
    for b in breeds:
        {'ember': wextras_ember, 'storm': wextras_storm, 'venom': wextras_venom}.get(b, lambda p: None)(wings)
    wings.tag = 0
    eyes = Part()
    build_eyes(eyes)

    rig = build_armature()
    smat0 = material('Scales', (0.4, 0.1, 0.05, 1))
    body, crys = split_flat(body)
    ob = make_object('Body', body, 1)
    if crys.faces:
        oc = make_object('Crystals', crys, 0)
        for o in (ob, oc):
            for _ in range(5):
                o.data.materials.append(smat0)
        select_only(oc)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active
        ob.name = 'Body'
    ow = make_object('Wings', wings, 1)
    oe = make_object('Eyes', eyes, 0)
    wmat = material('Membrane', (0.5, 0.15, 0.08, 1))
    if not crys.faces:
        for _ in range(5):
            ob.data.materials.append(smat0)
    for _ in range(5):
        ow.data.materials.append(wmat)
    emat = bpy.data.materials.new('Eye')
    emat.use_nodes = True
    oe.data.materials.append(emat)
    uv_unwrap(ob)
    uv_unwrap(ow)
    if '--no-bake' not in sys.argv:
        print('sculpting and baking detail maps...')
        hb = make_high(ob, 2, body_relief)
        bake_maps(ob, hb, 2048, 'dragon_body')
        bpy.data.objects.remove(hb)
        hw = make_high(ow, 2, wing_relief)
        bake_maps(ow, hw, 1024, 'dragon_wing', col_size=512)
        bpy.data.objects.remove(hw)
    extras = split_by_tag(ob, 'Extra')
    wextras = split_by_tag(ow, 'WExtra')
    lb = make_lod(ob, 0.22, 'BodyLOD')
    lw = make_lod(ow, 0.4, 'WingsLOD')
    lx = [make_lod(o, 0.27, o.name.replace('Extra', 'ExtraLOD')) for o in extras.values()]
    for o in [ob, ow, oe, lb, lw] + list(extras.values()) + list(wextras.values()) + lx:
        bind(o, rig)
        print(o.name, 'verts', len(o.data.vertices), 'tris', sum(len(p.vertices) - 2 for p in o.data.polygons))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_skins=True,
        export_animations=False, export_morph=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_normals=True, export_materials='EXPORT', export_image_format='NONE',
    )
    print('wrote', os.path.abspath(OUT), os.path.getsize(OUT) // 1024, 'KB')
    optimize_glb(OUT)

    if preview:
        for o in [lb, lw] + lx:
            o.hide_render = True
        views = view.split(';')
        for k, v in enumerate(views):
            render_preview(preview if len(views) == 1 else preview.replace('.png', f'_{k}.png'), [float(x) for x in v.split(',')])


def render_preview(path, view):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.device = 'CPU'
    scene.render.resolution_x = 960
    scene.render.resolution_y = 600
    if scene.camera is None:
        world = bpy.data.worlds.new('w')
        scene.world = world
        world.use_nodes = True
        world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.5, 0.6, 0.75, 1)
        world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
        sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
        sun.data.energy = 4
        sun.rotation_euler = (math.radians(40), math.radians(20), math.radians(30))
        scene.collection.objects.link(sun)
        cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
        scene.collection.objects.link(cam)
        scene.camera = cam
    cam = scene.camera
    cam.location = view[0:3]
    d = V(view[3:6]) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = view[6]
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('preview', path)


main()
