#!/usr/bin/env python3
"""Loudness and spectrum measurements for the audio pipeline (numpy only).

K-weighting and gating follow ITU-R BS.1770-4. Two numbers are used:

  integrated_lufs(x)  gated programme loudness (400 ms blocks), for loops, music and renders
  active_lufs(x)      K-weighted mean power over the *audible* part of a short one-shot (50 ms blocks within
                      25 dB of the loudest block). BS.1770 gating needs 400 ms of signal, which UI ticks and
                      impacts never reach; this is the same idea ("how loud is it while it is sounding").

tests/audio.test.mjs re-implements active_lufs / integrated_lufs in JS and checks the shipped files against
tools/audio_spec.json, so keep the two in step.

    python3 tools/loudness.py client/assets/audio          # table of every file
"""
import json, os, subprocess, sys
import numpy as np

SR = 44100


def load(path, sr=SR, ch=1):
    """Decodes any file ffmpeg reads; ch=1 gives a 1-D array, ch=2 an (n, 2) array."""
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', str(ch), '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(out, dtype=np.float32).astype(np.float64)
    return x if ch == 1 else x.reshape(-1, ch)


def _k_response(n, sr):
    """Frequency response of the BS.1770 K-weighting filter on an rfft grid of an n point transform."""
    w = 2 * np.pi * np.arange(n // 2 + 1) / n
    z1, z2 = np.exp(-1j * w), np.exp(-2j * w)

    def biquad(b, a):
        return (b[0] + b[1] * z1 + b[2] * z2) / (a[0] + a[1] * z1 + a[2] * z2)

    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / sr)
    Vh = 10 ** (G / 20)
    Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    shelf = biquad([(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / sr)
    a0 = 1 + K / Q + K * K
    hp = biquad([1, -2, 1], [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0])
    return shelf * hp


def k_weight(x, sr=SR):
    if x.ndim == 2:
        return np.stack([k_weight(x[:, c], sr) for c in range(x.shape[1])], axis=1)
    n = 1 << int(np.ceil(np.log2(len(x) + int(sr * 0.5))))
    y = np.fft.irfft(np.fft.rfft(x, n) * _k_response(n, sr), n)
    return y[: len(x)]


def _blocks(y, sr, win, hop):
    """Mean square per block of the K-weighted signal; channels (n, ch) are summed as BS.1770 does."""
    if y.ndim == 2:
        return sum(_blocks(y[:, c], sr, win, hop) for c in range(y.shape[1]))
    w, h = int(win * sr), int(hop * sr)
    if len(y) < w:
        y = np.pad(y, (0, w - len(y)))
    c = np.concatenate([[0], np.cumsum(y * y)])
    idx = np.arange(0, len(y) - w + 1, h)
    return (c[idx + w] - c[idx]) / w


def _lufs(ms):
    return -0.691 + 10 * np.log10(np.maximum(ms, 1e-12))


def integrated_lufs(x, sr=SR):
    ms = _blocks(k_weight(x, sr), sr, 0.4, 0.1)
    keep = ms[_lufs(ms) > -70]
    if not len(keep):
        return -70.0
    rel = _lufs(keep.mean()) - 10
    keep = keep[_lufs(keep) > rel]
    return float(_lufs(keep.mean())) if len(keep) else -70.0


def short_term(x, sr=SR):
    """3 s windows every 0.5 s (LUFS array)."""
    return _lufs(_blocks(k_weight(x, sr), sr, 3.0, 0.5))


def active_lufs(x, sr=SR):
    ms = _blocks(k_weight(x, sr), sr, 0.05, 0.025)
    keep = ms[ms > ms.max() * 10 ** (-25 / 10)]
    return float(_lufs(keep.mean()))


def peak_db(x):
    return float(20 * np.log10(np.abs(x).max() + 1e-12))


def true_peak_db(x):
    up = np.fft.irfft(np.fft.rfft(x), len(x) * 4) * 4
    return float(20 * np.log10(np.abs(up).max() + 1e-12))


def crest_db(x):
    return float(20 * np.log10((np.abs(x).max() + 1e-12) / (np.sqrt(np.mean(x * x)) + 1e-12)))


BANDS = [(20, 60), (60, 120), (120, 250), (250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000), (8000, 16000)]


def band_db(x, sr=SR, bands=BANDS):
    """Power per band in dB from a Welch-style averaged spectrum (full scale sine = about -3 dB)."""
    seg = 8192
    if len(x) < seg:
        x = np.pad(x, (0, seg - len(x)))
    win = np.hanning(seg)
    acc = np.zeros(seg // 2 + 1)
    cnt = 0
    for i in range(0, len(x) - seg + 1, seg // 2):
        acc += np.abs(np.fft.rfft(x[i:i + seg] * win)) ** 2
        cnt += 1
    psd = acc / cnt / (win ** 2).sum() / seg
    fr = np.fft.rfftfreq(seg, 1 / sr)
    return [float(10 * np.log10(2 * psd[(fr >= a) & (fr < b)].sum() + 1e-20)) for a, b in bands]


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    sp = os.path.join(here, 'audio_spec.json')
    cats = json.load(open(sp))['samples'] if os.path.exists(sp) else {}
    for p in sys.argv[1:]:
        for f in sorted(os.listdir(p)) if os.path.isdir(p) else [p]:
            fp = os.path.join(p, f) if os.path.isdir(p) else f
            if not fp.endswith('.mp3'):
                continue
            x = load(fp)
            n = os.path.basename(fp)[:-4]
            print(f'{n:16s} {cats.get(n, "?"):10s} dur {len(x) / SR:6.2f}  act {active_lufs(x):6.1f}  int {integrated_lufs(x):6.1f}  peak {peak_db(x):6.1f}  crest {crest_db(x):5.1f}')
