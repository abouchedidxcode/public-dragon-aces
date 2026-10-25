#!/usr/bin/env python3
"""Builds the DRAGON ACES wordmark: Fraunces (roman, the weight below) outlined to SVG paths and set by hand, so it
renders the same on every device and needs no font load. Prints the <svg> element; client/index.html carries the
result inline (twice: the title screen and the loading card).

    pip install fonttools brotli
    python3 tools/build_wordmark.py > /tmp/wordmark.svg

The lockup: "Dragon" over "Aces", one colour (currentColor). "Aces" is tucked in under "ra" so the descender of
the g hangs into the open space above "ce" rather than over a gap; the spacing is hand-fitted pair by pair (Fraunces'
own kerning is made for text sizes, not a 100 px title)."""
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONT = Path(__file__).resolve().parent.parent / 'client/fonts/fraunces-latin.woff2'
WEIGHT = 540
# extra space after each letter, in font units (2000 / em); negative tightens
LINES = [
    # text, x offset, baseline (y down), per-letter adjustments
    ('Dragon', 0, 0, {'D': -64, 'r': -34, 'a': -34, 'g': -42, 'o': -26}),
    ('Aces', 1590, 1530, {'A': -114, 'c': -26, 'e': -34}),
]


def build(weight=WEIGHT, lines=LINES):
    font = instancer.instantiateVariableFont(TTFont(FONT), {'wght': weight})
    cmap, glyphs, hmtx = font.getBestCmap(), font.getGlyphSet(), font['hmtx']
    paths, x_max = [], 0
    for text, x0, base, adj in lines:
        x = x0
        for ch in text:
            name = cmap[ord(ch)]
            pen = SVGPathPen(glyphs, lambda v: f'{v:.0f}')
            # font units are y up; flip into SVG's y down at this line's baseline
            glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, base)))
            paths.append(pen.getCommands())
            x += hmtx[name][0] + adj.get(ch, 0)
        x_max = max(x_max, x)
    top, bottom = -1460, lines[-1][2] + 40  # cap height + overshoot; "Aces" has no descenders
    return ' '.join(paths), (0, top, x_max, bottom - top)


if __name__ == '__main__':
    d, (vx, vy, vw, vh) = build()
    sys.stdout.write(
        f'<svg class="mark" viewBox="{vx} {vy} {vw:.0f} {vh:.0f}" aria-hidden="true" focusable="false">'
        f'<path d="{d}"/></svg>\n'
    )
