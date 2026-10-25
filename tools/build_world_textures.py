#!/usr/bin/env python3
"""Downloads the extra CC0 Poly Haven textures the world uses and writes web-ready JPEGs to client/assets/.

  python3 tools/build_world_textures.py [download_cache_dir]

  world_cliffb   marble_cliff_03   warm layered limestone, second cliff layer (breaks up the strata)
  world_forest   forest_leaves_04  pine-forest litter under the canopy
  world_ruin     large_sandstone_blocks   cut stone for the ruins and temple
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
    'world_cliffb': 'marble_cliff_03',
    'world_forest': 'forest_leaves_04',
    'world_ruin': 'large_sandstone_blocks',
}


def fetch(name, suffix):
    path = os.path.join(CACHE, f'{name}_{suffix}_1k.jpg')
    if not os.path.exists(path):
        url = f'{PH}/{name}/{name}_{suffix}_1k.jpg'
        print('download', url)
        urllib.request.urlretrieve(url, path)
    return path


for key, name in TEX.items():
    for kind, suffix, q in (('albedo', 'diff', 84), ('normal', 'nor_gl', 88)):
        Image.open(fetch(name, suffix)).convert('RGB').save(os.path.join(OUT, f'{key}_{kind}.jpg'), quality=q, optimize=True)
print('written to', os.path.abspath(OUT))
