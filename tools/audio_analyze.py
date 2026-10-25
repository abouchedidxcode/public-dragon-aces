#!/usr/bin/env python3
"""Numbers for the renders written by tools/audio_render.mjs: loudness, peak, crest, spectral balance.

    python3 tools/audio_analyze.py <renders dir> before after        # table for each scene, tags side by side
    python3 tools/audio_analyze.py <renders dir> after --bands       # octave band levels of the wind-only renders

For every scene and tag the "mix" render (events + music) and the "wind" render (the continuous air only) are read.
  LUFS-I     gated integrated loudness (BS.1770-4, stereo)
  ST max     loudest 3 s window
  M range    spread of the 400 ms loudness of the wind-only render (10th to 90th percentile): how much the bed pumps
  peak/TP    sample peak and 4x oversampled true peak, dBFS
  crest      peak to RMS of the mix
  2-8k       level of the 2 to 8 kHz band; "wind share" is the wind-only energy in that band relative to the mix
"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import loudness as L

BANDS = [(20, 60), (60, 120), (120, 250), (250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000)]


def read(d, name):
    p = os.path.join(d, name + '.f32')
    if not os.path.exists(p):
        return None, None
    meta = json.load(open(os.path.join(d, name + '.json')))
    x = np.fromfile(p, dtype=np.float32).reshape(-1, 2).astype(np.float64)
    return x, meta['sr']


def ms_blocks(x, sr, win, hop):
    tot = None
    for c in range(x.shape[1]):
        y = L.k_weight(x[:, c], sr)
        b = L._blocks(y, sr, win, hop)
        tot = b if tot is None else tot + b
    return tot


def stats(x, sr, skip=0.0):
    x = x[int(skip * sr):]
    ms = ms_blocks(x, sr, 0.4, 0.1)
    keep = ms[L._lufs(ms) > -70]
    rel = L._lufs(keep.mean()) - 10
    integ = float(L._lufs(keep[L._lufs(keep) > rel].mean())) if len(keep) else -70
    st = L._lufs(ms_blocks(x, sr, 3.0, 0.5))
    mom = L._lufs(ms)
    peak = float(20 * np.log10(np.abs(x).max() + 1e-12))
    tp = max(L.true_peak_db(x[:, 0]), L.true_peak_db(x[:, 1]))
    rms = np.sqrt(np.mean(x ** 2) * 1.0)
    crest = peak - 20 * np.log10(rms + 1e-12)
    mono = x.mean(axis=1)
    return dict(integ=integ, stmax=float(st.max()), p10=float(np.percentile(mom, 10)), p90=float(np.percentile(mom, 90)), peak=peak, tp=tp, crest=crest, bands=L.band_db(mono, sr, BANDS), mono=mono)


def band_sum(b, idx):
    return 10 * np.log10(sum(10 ** (b[i] / 10) for i in idx))


def catalog(d, tag):
    """Per-event loudness at the output (active LUFS of the stereo mix, and peak) from the 'catalog' scene."""
    x, sr = read(d, f'{tag}_catalog_mix')
    meta = json.load(open(os.path.join(d, f'{tag}_catalog_mix.json')))['meta']
    print(f'{"event":22s}{"active LUFS":>12s}{"peak dBFS":>11s}')
    rows = []
    for m in meta:
        seg = x[int(m['t0'] * sr):int(m['t1'] * sr)]
        pk = float(20 * np.log10(np.abs(seg).max() + 1e-12))
        if pk < -80:
            rows.append((m['label'], None, pk))
            continue
        rows.append((m['label'], L.active_lufs(seg, sr), pk))
    for lab, a, pk in rows:
        print(f'{lab:22s}{"(silent)" if a is None else f"{a:12.1f}"}{pk:11.1f}')
    return rows


def ducks(d, tag, scene):
    """Depth and timing of the music / ambience ducks and the wind gate, sampled from the audio graph every frame."""
    pr = json.load(open(os.path.join(d, f'{tag}_{scene}_mix.json')))['probe']
    t = np.array([p[0] for p in pr])
    for i, name in ((1, 'music duck'), (2, 'ambience duck'), (3, 'wind cut (cloud)')):
        v = np.array([p[i] for p in pr])
        k = int(v.argmin())
        below = np.where(v < 0.9)[0]
        if not len(below):
            print(f'{name:18s} never below 0.9')
            continue
        i0 = below[0]
        # first dip: from crossing 0.9 down to crossing it back up
        j = i0
        while j < len(v) and v[j] < 0.9:
            j += 1
        print(f'{name:18s} min {v.min():.2f} ({20 * np.log10(v.min()):.1f} dB) at {t[k]:.1f}s; first dip {t[i0]:.2f}s to {t[min(j, len(t) - 1)]:.2f}s; largest step between frames {np.abs(np.diff(v)).max():.3f}')


def voices(d, tag, scene):
    pr = json.load(open(os.path.join(d, f'{tag}_{scene}_mix.json')))['probe']
    v = np.array([p[5] for p in pr])
    print(f'{scene}: simultaneous voices max {int(v.max())}, mean {v.mean():.1f}')
    if len(pr[0]) > 7:
        g = -np.array([p[6] for p in pr]); l = -np.array([p[7] for p in pr])
        print(f'{scene}: glue compressor gain reduction mean {g.mean():.1f} dB, max {g.max():.1f} dB; peak limiter mean {l.mean():.2f} dB, max {l.max():.1f} dB')


def series(d, tag, scene, step=0.5):
    """Momentary loudness (400 ms) every `step` seconds, for gates and fades."""
    x, sr = read(d, f'{tag}_{scene}_mix')
    y = L.k_weight(x, sr)
    w = int(0.4 * sr)
    out = []
    for t in np.arange(0.4, len(x) / sr - 0.01, step):
        seg = y[int(t * sr) - w:int(t * sr)]
        out.append((t, float(L._lufs((seg ** 2).sum(axis=0).sum() / w))))
    print(' '.join(f'{t:4.1f}s:{v:6.1f}' for t, v in out))


def main():
    if '--series' in sys.argv:
        i = sys.argv.index('--series')
        series(sys.argv[1], sys.argv[i + 1], sys.argv[i + 2])
        return
    if '--voices' in sys.argv:
        i = sys.argv.index('--voices')
        voices(sys.argv[1], sys.argv[i + 1], sys.argv[i + 2])
        return
    if '--ducks' in sys.argv:
        i = sys.argv.index('--ducks')
        ducks(sys.argv[1], sys.argv[i + 1], sys.argv[i + 2])
        return
    if '--catalog' in sys.argv:
        catalog(sys.argv[1], sys.argv[sys.argv.index('--catalog') + 1])
        return
    d, tags = sys.argv[1], [a for a in sys.argv[2:] if not a.startswith('--')]
    show_bands = '--bands' in sys.argv
    scenes = ['cruise', 'dive', 'dogfight', 'boom']
    print('WIND ONLY (the continuous air: wind layers, flame loops, passes; no events, no music)')
    print(f'{"scene":9s}{"tag":8s}{"LUFS-I":>8s}{"ST max":>8s}{"M p10":>7s}{"M p90":>7s}{"peak":>7s}{"2-8k":>8s}{"2-8k re total":>15s}')
    wstats = {}
    for sc in scenes:
        for tag in tags:
            wd, sr = read(d, f'{tag}_{sc}_wind')
            if wd is None:
                continue
            w = stats(wd, sr, 1.0)
            wstats[(sc, tag)] = w
            hi = band_sum(w['bands'], (6, 7))
            tot = band_sum(w['bands'], range(len(w['bands'])))
            print(f'{sc:9s}{tag:8s}{w["integ"]:8.1f}{w["stmax"]:8.1f}{w["p10"]:7.1f}{w["p90"]:7.1f}{w["peak"]:7.1f}{hi:8.1f}{hi - tot:15.1f}')
    print('\nFULL MIX (events + battle music; default slider positions)')
    print(f'{"scene":9s}{"tag":8s}{"LUFS-I":>8s}{"ST max":>8s}{"peak":>7s}{"TP":>7s}{"crest":>7s}{"2-8k":>8s}{"wind share of 2-8k":>20s}')
    for sc in scenes:
        for tag in tags:
            mx, sr = read(d, f'{tag}_{sc}_mix')
            if mx is None:
                continue
            s_ = stats(mx, sr, 1.0)
            hi = band_sum(s_['bands'], (6, 7))
            line = f'{sc:9s}{tag:8s}{s_["integ"]:8.1f}{s_["stmax"]:8.1f}{s_["peak"]:7.1f}{s_["tp"]:7.1f}{s_["crest"]:7.1f}{hi:8.1f}'
            w = wstats.get((sc, tag))
            if w:
                hw = band_sum(w['bands'], (6, 7))
                line += f'{100 * 10 ** ((hw - hi) / 10):19.1f}%'
            print(line)
    if show_bands:
        print('\noctave band levels of the wind-only renders (dB, mono):')
        print(f'{"scene/tag":16s}' + ''.join(f'{a}-{b}'.rjust(11) for a, b in BANDS))
        for (sc, tag), w in wstats.items():
            print(f'{sc + "/" + tag:16s}' + ''.join(f'{v:11.1f}' for v in w['bands']))


if __name__ == '__main__':
    main()
