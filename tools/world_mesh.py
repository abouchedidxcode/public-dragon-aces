"""Small numpy mesh toolkit shared by the world asset builders (trees, rocks, ruins, crystals).

Meshes are plain arrays: positions, normals, uv, colour (linear RGBA) and triangle indices. `write_glb` writes
a binary glTF with one node per named mesh, `preview` draws a quick software-rendered contact sheet so shapes
can be judged without a GPU. No Blender is needed for any of this.
"""
import json
import math
import struct

import numpy as np

# ----------------------------------------------------------------------------------------------------------
# noise


def _h3(i, seed):
    x = np.sin(i[..., 0] * 127.1 + i[..., 1] * 311.7 + i[..., 2] * 74.7 + seed * 17.31) * 43758.5453
    return x - np.floor(x)


def vnoise(p, seed=0):
    """3D value noise in [0, 1] for an (N, 3) array."""
    p = np.asarray(p, dtype=np.float64)
    i = np.floor(p)
    f = p - i
    u = f * f * (3 - 2 * f)
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[:, 0] if dx else 1 - u[:, 0]) * (u[:, 1] if dy else 1 - u[:, 1]) * (u[:, 2] if dz else 1 - u[:, 2])
                out = out + w * _h3(i + np.array([dx, dy, dz]), seed)
    return out


def fbm(p, octaves=4, seed=0):
    s = 0.0
    a = 0.5
    n = 0.0
    for o in range(octaves):
        s = s + a * vnoise(p * (2.0 ** o), seed + o * 7)
        n += a
        a *= 0.5
    return s / n


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


# ----------------------------------------------------------------------------------------------------------
# mesh container


class Mesh:
    def __init__(self):
        self.P, self.N, self.UV, self.C, self.I = [], [], [], [], []
        self.n = 0

    def add(self, P, N, UV, C, I):
        P = np.asarray(P, dtype=np.float64)
        k = len(P)
        N = unit(N)
        UV = np.zeros((k, 2)) if UV is None else np.asarray(UV, dtype=np.float64)
        C = np.asarray(C, dtype=np.float64)
        if C.ndim == 1:
            C = np.tile(C, (k, 1))
        if C.shape[1] == 3:
            C = np.hstack([C, np.ones((k, 1))])
        self.P.append(P)
        self.N.append(N)
        self.UV.append(UV)
        self.C.append(C)
        self.I.append(np.asarray(I, dtype=np.int64).reshape(-1, 3) + self.n)
        self.n += k
        return self

    def merge(self, other):
        base = self.n
        for P, N, UV, C, I in zip(other.P, other.N, other.UV, other.C, other.I):
            self.P.append(P)
            self.N.append(N)
            self.UV.append(UV)
            self.C.append(C)
            self.I.append(I + base)
        self.n += other.n
        return self

    def arrays(self):
        return (np.vstack(self.P), np.vstack(self.N), np.vstack(self.UV), np.vstack(self.C), np.vstack(self.I))

    def tri_count(self):
        return sum(len(i) for i in self.I)

    def transform(self, scale=1.0, offset=(0, 0, 0), yaw=0.0):
        cs, sn = math.cos(yaw), math.sin(yaw)
        R = np.array([[cs, 0, sn], [0, 1, 0], [-sn, 0, cs]])
        out = Mesh()
        for P, N, UV, C, I in zip(self.P, self.N, self.UV, self.C, self.I):
            out.add((P * scale) @ R.T + np.asarray(offset), N @ R.T, UV, C, I)
        return out


def face_normals(P, I):
    a, b, c = P[I[:, 0]], P[I[:, 1]], P[I[:, 2]]
    return np.cross(b - a, c - a)


def vertex_normals(P, I):
    fn = face_normals(P, I)
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, I[:, k], fn)
    return unit(N)


def orient_outward(P, I, center):
    """Flip triangles whose normal points toward `center`."""
    fn = face_normals(P, I)
    cen = P[I].mean(1)
    flip = np.einsum('ij,ij->i', fn, cen - center) < 0
    I = I.copy()
    I[flip] = I[flip][:, ::-1]
    return I


# ----------------------------------------------------------------------------------------------------------
# primitives


def icosphere(detail=1):
    t = (1 + 5 ** 0.5) / 2
    V = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    F = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
         (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    V = [tuple(unit(np.array(v, dtype=float))) for v in V]
    for _ in range(detail):
        cache = {}
        newF = []

        def mid(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                m = unit((np.array(V[a]) + np.array(V[b])) / 2)
                V.append(tuple(m))
                cache[key] = len(V) - 1
            return cache[key]

        for a, b, c in F:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            newF += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        F = newF
    return np.array(V), np.array(F)


def loft(path, radii, sides, color_fn=None, cap_bottom=True, cap_top=False, uv_fn=None, up=(0, 0, 1)):
    """A tube along a polyline. radii may be (K,) or (K, 2) for elliptical cross sections."""
    path = np.asarray(path, dtype=np.float64)
    K = len(path)
    radii = np.asarray(radii, dtype=np.float64)
    if radii.ndim == 1:
        radii = np.stack([radii, radii], 1)
    tang = unit(np.gradient(path, axis=0))
    P, N, C, UV = [], [], [], []
    for k in range(K):
        t = tang[k]
        ref = np.array(up, dtype=float)
        if abs(np.dot(ref, t)) > 0.95:
            ref = np.array([1.0, 0, 0])
        a = unit(np.cross(t, ref))
        b = np.cross(t, a)
        for s in range(sides + 1):
            ang = s / sides * 2 * math.pi
            P.append(path[k] + math.cos(ang) * a * radii[k, 0] + math.sin(ang) * b * radii[k, 1])
            N.append(math.cos(ang) * a / max(radii[k, 0], 1e-4) + math.sin(ang) * b / max(radii[k, 1], 1e-4))
            C.append(color_fn(k / max(K - 1, 1), ang) if color_fn else (0.1, 0.07, 0.05, 1))
            UV.append(uv_fn(k / max(K - 1, 1), s / sides) if uv_fn else (0, 1))
    P, N, C, UV = np.array(P), unit(np.array(N)), np.array(C), np.array(UV)
    row = sides + 1
    I = []
    for k in range(K - 1):
        for s in range(sides):
            a, b = k * row + s, k * row + s + 1
            c, d = a + row, b + row
            I += [(a, b, c), (b, d, c)]
    I = np.array(I)
    fn = face_normals(P, I)
    flip = np.einsum('ij,ij->i', fn, N[I].mean(1)) < 0
    I[flip] = I[flip][:, ::-1]
    m = Mesh()
    m.add(P, N, UV, C, I)
    for end, flag in ((0, cap_bottom), (K - 1, cap_top)):
        if not flag:
            continue
        base = end * row
        Pc = np.vstack([P[base:base + row], path[end]])
        nrm = -tang[end] if end == 0 else tang[end]
        Cc = np.vstack([C[base:base + row], C[base]])
        Ic = [(len(Pc) - 1, s, s + 1) if end == 0 else (len(Pc) - 1, s + 1, s) for s in range(sides)]
        m.add(Pc, np.tile(nrm, (len(Pc), 1)), None, Cc, np.array(Ic))
    return m


def sphere_blob(center, radii, detail, amp, freq, seed, color_fn, crown_c=None, crown_r=None, normal_mix=0.7, edge=0.5, yaw=0.0, squash_bottom=0.0):
    """Noise-displaced ellipsoid with proxy (crown-shaped) normals, for foliage clumps and rocks."""
    V, F = icosphere(detail)
    r = 1 + amp * (fbm(V * freq + seed * 3.7, 3, seed) - 0.5) * 2
    d = V * r[:, None]
    if squash_bottom:
        d[:, 1] = np.where(d[:, 1] < 0, d[:, 1] * (1 - squash_bottom), d[:, 1])
    P = np.asarray(center) + d * np.asarray(radii)
    if yaw:
        cs, sn = math.cos(yaw), math.sin(yaw)
        R = np.array([[cs, 0, sn], [0, 1, 0], [-sn, 0, cs]])
        P = (P - center) @ R.T + center
    gn = unit(d / (np.asarray(radii) ** 2))
    if crown_c is not None:
        pn = unit((P - np.asarray(crown_c)) / (np.asarray(crown_r) ** 2))
        N = unit(gn * (1 - normal_mix) + pn * normal_mix)
    else:
        N = gn
    C = np.array([color_fn(P[i], N[i], d[i]) for i in range(len(P))])
    UV = np.stack([np.full(len(P), edge), np.zeros(len(P))], 1)
    m = Mesh()
    m.add(P, N, UV, C, F)
    return m


# ----------------------------------------------------------------------------------------------------------
# output


def flat_shade(mesh):
    """Unweld a mesh so every triangle has its own vertices and face normal (crystals, cut stone)."""
    P, N, UV, C, I = mesh.arrays()
    fn = unit(face_normals(P, I))
    out = Mesh()
    k = len(I)
    flat = I.reshape(-1)
    out.add(P[flat], np.repeat(fn, 3, axis=0), UV[flat], C[flat], np.arange(k * 3).reshape(k, 3))
    return out


def _pad(b):
    return b + b' ' * (-len(b) % 4)


def write_glb(path, meshes):
    """meshes: {name: Mesh}. Writes positions, normals, uv0, colour0 (float RGBA) and indices."""
    blob = bytearray()
    views, accessors, mesh_json, nodes = [], [], [], []

    def add_view(arr, target):
        data = arr.tobytes()
        while len(blob) % 4:
            blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data), 'target': target})
        blob.extend(data)
        return len(views) - 1

    for name, m in meshes.items():
        P, N, UV, C, I = m.arrays()
        P32 = P.astype(np.float32)
        acc = {}
        for key, arr, typ, comp in (('POSITION', P32, 'VEC3', 5126), ('NORMAL', N.astype(np.float32), 'VEC3', 5126),
                                    ('TEXCOORD_0', UV.astype(np.float32), 'VEC2', 5126), ('COLOR_0', C.astype(np.float32), 'VEC4', 5126)):
            v = add_view(np.ascontiguousarray(arr), 34962)
            a = {'bufferView': v, 'componentType': comp, 'count': len(arr), 'type': typ}
            if key == 'POSITION':
                a['min'] = P32.min(0).tolist()
                a['max'] = P32.max(0).tolist()
            accessors.append(a)
            acc[key] = len(accessors) - 1
        idx_dtype = np.uint16 if len(P) < 65535 else np.uint32
        v = add_view(np.ascontiguousarray(I.reshape(-1).astype(idx_dtype)), 34963)
        accessors.append({'bufferView': v, 'componentType': 5123 if idx_dtype == np.uint16 else 5125, 'count': int(I.size), 'type': 'SCALAR'})
        mesh_json.append({'name': name, 'primitives': [{'attributes': acc, 'indices': len(accessors) - 1, 'mode': 4}]})
        nodes.append({'name': name, 'mesh': len(mesh_json) - 1})
    gltf = {
        'asset': {'version': '2.0', 'generator': 'dragon-aces tools/world_mesh.py'},
        'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': mesh_json,
        'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}],
    }
    js = _pad(json.dumps(gltf, separators=(',', ':')).encode())
    bn = bytes(blob) + b'\0' * (-len(blob) % 4)
    total = 12 + 8 + len(js) + 8 + len(bn)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(bn), 0x004E4942) + bn)


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def preview(path, meshes, sun=(0.55, 0.74, 0.38), cell=(260, 360), views=((0.6, 0.15),), cols=6, bg=(150, 175, 205), ground=0.0, extent=None):
    """Painter's-algorithm render of each mesh (orthographic, Lambert + hemisphere)."""
    from PIL import Image, ImageDraw
    names = list(meshes)
    rows = (len(names) * len(views) + cols - 1) // cols
    W, H = cell
    img = Image.new('RGB', (cols * W, rows * H), bg)
    dr = ImageDraw.Draw(img)
    s = unit(np.array(sun))
    k = 0
    for name in names:
        P, N, UV, C, I = meshes[name].arrays()
        for az, el in views:
            ca, sa = math.cos(az), math.sin(az)
            R = np.array([[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]])
            Pr = P @ R.T
            Nr = N @ R.T
            ce, se = math.cos(el), math.sin(el)
            # tilt about x
            T = np.array([[1, 0, 0], [0, ce, se], [0, -se, ce]])
            Pt = Pr @ T.T
            Nt = Nr @ T.T
            lo = Pt.min(0)
            hi = Pt.max(0)
            ext = extent or max(hi[1] - lo[1], (hi[0] - lo[0]) * 1.2, 1e-3)
            sc = (H - 36) / ext
            ox = (k % cols) * W + W / 2
            oy = (k // cols) * H + H - 14
            tri = I
            z = Pt[tri][:, :, 2].mean(1)
            order = np.argsort(z)
            vis = None
            for t in order:
                a, b, c = tri[t]
                nrm = (Nt[a] + Nt[b] + Nt[c])
                nl = unit(nrm)
                # lighting in the rotated frame
                sl = unit((T @ (R @ s)))
                lam = max(0.0, float(np.dot(nl, sl)))
                hemi = 0.5 + 0.5 * nl[1]
                col = (C[a, :3] + C[b, :3] + C[c, :3]) / 3 * ((C[a, 3] + C[b, 3] + C[c, 3]) / 3 * 0.5 + 0.5)
                lit = col * (lam * 3.0 + hemi * 0.9)
                rgb = tuple(int(v * 255) for v in srgb(np.clip(lit * 0.9, 0, 1)))
                pts = [(ox + (Pt[v][0] - (lo[0] + hi[0]) / 2) * sc, oy - (Pt[v][1] - lo[1]) * sc) for v in (a, b, c)]
                dr.polygon(pts, fill=rgb)
            dr.text(((k % cols) * W + 4, (k // cols) * H + 2), f'{name} {meshes[name].tri_count()}t', fill=(255, 255, 255))
            k += 1
    img.save(path)
