#!/usr/bin/env python3
"""Downloads the CC0 Poly Haven photoscans the castle is built from and writes web-ready JPEGs to client/assets/.

  python3 tools/build_castle_textures.py [download_cache_dir]

Every material becomes two files:
  castle_<key>_albedo.jpg   scan albedo with the scan's baked ambient occlusion folded in (crevices stay dark)
  castle_<key>_nr.jpg       R, G = tangent-space normal x, y (OpenGL, z is rebuilt in the shader), B = roughness
                            (4:4:4 JPEG so the three channels do not bleed into each other)
  castle_<key>_h.jpg        the scan's displacement map as 8-bit grey, contrast-stretched (2nd..98th percentile):
                            drives the shader's parallax, mortar cavity darkening and chipped edges
Albedo and normal files that already exist are kept (set FORCE=1 to rebuild them); the height maps are always written.

  key      Poly Haven asset            used for                              size
  ashlar   medieval_blocks_03          big cut blocks: keep, curtain walls   768
  rubble   castle_wall_varriation      towers, bastions, buttresses          768
  slate    grey_roof_01                spire and roof shingles               512
  wood     medieval_wood               bridge decks, hoardings, doors        512
  iron     metal_plate_02              chains, bands, portcullis, braziers   512
  dark     stone_brick_wall_001        plinths and the dark base courses     512
"""
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'client', 'assets')
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '.cache')
os.makedirs(CACHE, exist_ok=True)
PH = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k'

TEX = {
    'ashlar': ('medieval_blocks_03', 768),
    'rubble': ('castle_wall_varriation', 768),
    'slate': ('grey_roof_01', 512),
    'wood': ('medieval_wood', 512),
    'iron': ('metal_plate_02', 512),
    'dark': ('stone_brick_wall_001', 512),
}


def fetch(name, suffix):
    path = os.path.join(CACHE, f'{name}_{suffix}_1k.jpg')
    if not os.path.exists(path):
        url = f'{PH}/{name}/{name}_{suffix}_1k.jpg'
        print('download', url)
        urllib.request.urlretrieve(url, path)
    return path


def load(name, suffix, size, mode='RGB'):
    im = Image.open(fetch(name, suffix)).convert(mode)
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0




def highpass(a, sigma):
    H, W = a.shape
    fx, fy = np.fft.fftfreq(W)[None, :], np.fft.fftfreq(H)[:, None]
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (fx * fx + fy * fy))
    return a - np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def lowpass(a, sigma):
    return a - highpass(a, sigma)


def integrate_normals(nor):
    # Frankot-Chellappa: the height whose gradient best matches the normal map. Periodic, so the result tiles.
    nx, ny = nor[..., 0] * 2 - 1, nor[..., 1] * 2 - 1
    nz = np.sqrt(np.clip(1 - nx * nx - ny * ny, 0.05, 1))
    gx, gy = -nx / nz, ny / nz  # image rows run down, so +v (up) is -row
    H, W = gx.shape
    fx, fy = np.fft.fftfreq(W)[None, :] * 2 * np.pi, np.fft.fftfreq(H)[:, None] * 2 * np.pi
    den = fx * fx + fy * fy
    den[0, 0] = 1
    F = (-1j * fx * np.fft.fft2(gx) - 1j * fy * np.fft.fft2(gy)) / den
    F[0, 0] = 0
    return np.real(np.fft.ifft2(F))


FORCE = bool(os.environ.get('FORCE'))
for key, (name, size) in TEX.items():
    hp = os.path.join(OUT, f'castle_{key}_h.jpg')
    h = load(name, 'disp', size, 'L')
    if h.std() < 0.03:  # a flat placeholder (medieval_blocks_03 ships one): rebuild the relief from the normals
        h = highpass(integrate_normals(load(name, 'nor_gl', size)), 6)  # integration drifts at low frequency
        lum = load(name, 'diff', size, 'L')
        if np.corrcoef(h.ravel(), lum.ravel())[0, 1] < 0:  # blocks stand proud of the mortar
            h = -h
        # the dark joints of the albedo carry the mortar the normals only hint at: mostly joints, a little face grain
        joints = highpass(lowpass(lum, 1.6), 14)
        joints = np.minimum(joints, 0) / max(-np.percentile(joints, 3), 1e-4)  # 0 on the face, -1 in a joint
        grain = h / max(h.std(), 1e-4)
        h = np.clip(joints, -1.2, 0) * 1.0 + 0.08 * np.clip(grain, -2.5, 2.5)
    lo, hi = np.percentile(h, 1), np.percentile(h, 99)
    h = np.clip((h - lo) / max(hi - lo, 1e-4), 0, 1)
    Image.fromarray((h * 255).astype(np.uint8), 'L').save(hp, quality=82, optimize=True)
    if os.path.exists(os.path.join(OUT, f'castle_{key}_albedo.jpg')) and not FORCE:
        continue
    alb = load(name, 'diff', size)
    try:
        ao = load(name, 'ao', size, 'L')[..., None]
        alb = alb * (0.45 + 0.55 * ao)
    except Exception as e:  # not every scan ships an AO map
        print('no ao for', name, e)
    nor = load(name, 'nor_gl', size)
    rough = load(name, 'rough', size, 'L')
    Image.fromarray((np.clip(alb, 0, 1) * 255).astype(np.uint8)).save(os.path.join(OUT, f'castle_{key}_albedo.jpg'), quality=84, optimize=True)
    nr = np.stack([nor[..., 0], nor[..., 1], rough], axis=-1)
    Image.fromarray((np.clip(nr, 0, 1) * 255).astype(np.uint8)).save(os.path.join(OUT, f'castle_{key}_nr.jpg'), quality=90, subsampling=0, optimize=True)
print('written to', os.path.abspath(OUT))
