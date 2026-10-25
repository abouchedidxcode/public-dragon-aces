#!/usr/bin/env python3
"""Downloads the CC0 source assets from Poly Haven (and three.js's MIT water normals) and writes the
web-ready versions into client/assets/. Run once; the outputs are committed.

  python3 tools/prepare_assets.py <download_cache_dir>

Sky: the 4K Kloofendal 48d Partly Cloudy (Pure Sky) HDRI becomes
  sky.jpg      upper part of the equirect (elevation -12..90 deg), stored as sRGB(hdr * SKY_SCALE)
  env.hdr      the 1K HDRI, used for image-based lighting (PMREM)
  sky.json     sun direction and the scale the sky shader divides back out
Terrain: 1K diffuse + OpenGL normal maps of five aerial/cliff textures, re-encoded smaller.
"""
import json, math, os, sys, urllib.request
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from hdr import read_hdr

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'client', 'assets')
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '.cache')
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

PH = 'https://dl.polyhaven.org/file/ph-assets'
HDRI = 'kloofendal_48d_partly_cloudy_puresky'
SKY_SCALE = 0.22
SKY_MIN_ELEV = -12.0

def fetch(url):
    path = os.path.join(CACHE, url.rsplit('/', 1)[1])
    if not os.path.exists(path):
        print('download', url)
        urllib.request.urlretrieve(url, path)
    return path

def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)

# --- sky
hdr4k = read_hdr(fetch(f'{PH}/HDRIs/hdr/4k/{HDRI}_4k.hdr'))
H, W, _ = hdr4k.shape
lum = hdr4k.mean(2)
# sun = centroid of the brightest pixels
thr = lum.max() * 0.25
ys, xs = np.nonzero(lum > thr)
wts = lum[ys, xs]
sx, sy = (xs * wts).sum() / wts.sum() + 0.5, (ys * wts).sum() / wts.sum() + 0.5
u, v = sx / W, 1 - sy / H
phi = (u - 0.5) * 2 * math.pi           # three.js equirect: u = atan(z, x) / 2pi + 0.5
el = (v - 0.5) * math.pi                # v = asin(y) / pi + 0.5
sun = [math.cos(el) * math.cos(phi), math.sin(el), math.cos(el) * math.sin(phi)]
print('sun dir', sun, 'elevation deg', math.degrees(el))

rows = int(round((90 - SKY_MIN_ELEV) / 180 * H))
sky = hdr4k[:rows].copy()
# remove the sun disc (the shader draws its own); clamp the hot core to the surrounding glow
sky = np.minimum(sky, 6.0)
img = (srgb(sky * SKY_SCALE) * 255 + 0.5).astype(np.uint8)
Image.fromarray(img).save(os.path.join(OUT, 'sky.jpg'), quality=86, optimize=True, progressive=True)

# horizon colour (average of a band just above the horizon), used for fog
band = hdr4k[int(H * 0.5 - H * 0.02):int(H * 0.5)]
horizon = band.reshape(-1, 3).mean(0)
zenith = hdr4k[: int(H * 0.08)].reshape(-1, 3).mean(0)
import shutil
shutil.copy(fetch(f'{PH}/HDRIs/hdr/1k/{HDRI}_1k.hdr'), os.path.join(OUT, 'env.hdr'))
json.dump({
    'source': f'Poly Haven: {HDRI} (CC0)',
    'sun': sun, 'skyScale': SKY_SCALE, 'minElevation': SKY_MIN_ELEV,
    'horizon': [float(c) for c in horizon], 'zenith': [float(c) for c in zenith],
}, open(os.path.join(OUT, 'sky.json'), 'w'), indent=1)

# --- terrain textures
TEX = {
    'grass': ('aerial_grass_rock', 'diff'),
    'rock': ('aerial_rocks_02', 'diff'),
    'sand': ('aerial_beach_01', 'diff'),
    'snow': ('snow_field_aerial', 'col'),
    'cliff': ('cliff_side', 'diff'),
}
for key, (name, diff) in TEX.items():
    for kind, suffix, q in (('albedo', diff, 84), ('normal', 'nor_gl', 88)):
        src = fetch(f'{PH}/Textures/jpg/1k/{name}/{name}_{suffix}_1k.jpg')
        Image.open(src).convert('RGB').save(os.path.join(OUT, f'{key}_{kind}.jpg'), quality=q, optimize=True)

shutil.copy(fetch('https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/waternormals.jpg'),
            os.path.join(OUT, 'waternormals.jpg'))
print('assets written to', os.path.abspath(OUT))
