"""Small numpy synthesis kit for the sounds that have no recorded source (alerts, ability layers, chimes).

Everything here is original work (CC0), seeded so the build is repeatable. Signals are mono float arrays at SR.
"""
import numpy as np

SR = 44100


def rng(seed):
    return np.random.default_rng(seed)


def t_of(dur):
    return np.arange(int(dur * SR)) / SR


def white(dur, seed=1):
    return rng(seed).standard_normal(int(dur * SR))


def exp_env(n, attack=0.004, tau=0.1, hold=0.0):
    """Fast linear-ish attack, optional hold, exponential decay."""
    t = np.arange(n) / SR
    a = np.minimum(1, t / max(attack, 1e-4)) ** 1.5
    d = np.where(t < attack + hold, 1.0, np.exp(-(t - attack - hold) / tau))
    return a * d


def tone(freq, dur, partials=((1, 1.0),), attack=0.005, tau=0.15, hold=0.0, phase=0.0):
    """Sum of partials; freq is a number or an array of Hz per sample (glide)."""
    n = int(dur * SR)
    f = np.full(n, float(freq)) if np.isscalar(freq) else np.asarray(freq, dtype=float)[:n]
    ph = 2 * np.pi * np.cumsum(f) / SR + phase
    y = sum(a * np.sin(ph * k) for k, a in partials)
    return y * exp_env(n, attack, tau, hold)


def glide(f0, f1, dur, log=True):
    n = int(dur * SR)
    if log:
        return f0 * (f1 / f0) ** (np.arange(n) / max(n - 1, 1))
    return np.linspace(f0, f1, n)


def stft_shape(x, fn, n=2048, hop=512):
    """Shapes x with a gain matrix fn(t[s], f[Hz]) -> frames x bins (time varying filter)."""
    win = np.hanning(n)
    pad = np.concatenate([np.zeros(n), x, np.zeros(n)])
    starts = np.arange(0, len(pad) - n, hop)
    F = np.stack([np.fft.rfft(pad[s:s + n] * win) for s in starts])
    t = (starts + n / 2 - n) / SR
    f = np.fft.rfftfreq(n, 1 / SR)
    F = F * fn(t[:, None], f[None, :])
    out = np.zeros(len(pad))
    norm = np.zeros(len(pad))
    for i, s in enumerate(starts):
        out[s:s + n] += np.fft.irfft(F[i], n) * win
        norm[s:s + n] += win * win
    out = out / np.maximum(norm, 1e-6)
    return out[n:n + len(x)]


def bump(f, fc, bw_oct):
    return np.exp(-0.5 * (np.log2(np.maximum(f, 1.0) / fc) / bw_oct) ** 2)


def sweep_noise(dur, fc0, fc1, bw=0.9, seed=1, amp=None):
    """Noise through a band that glides from fc0 to fc1 Hz (log) with bw octaves of spread."""
    x = white(dur, seed)
    d = max(dur, 1e-3)

    def fn(t, f):
        fc = fc0 * (fc1 / fc0) ** np.clip(t / d, 0, 1)
        return bump(f, fc, bw)

    y = stft_shape(x, fn)
    y /= np.abs(y).max() + 1e-9
    return y if amp is None else y * amp(np.arange(len(y)) / SR)


def lowpass(x, fc):
    """Zero-phase brickwall-ish lowpass via the FFT (soft edge), good enough for sound design."""
    n = len(x)
    F = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    return np.fft.irfft(F / (1 + (f / fc) ** 6), n)


def highpass(x, fc):
    n = len(x)
    F = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    r = (f / fc) ** 4
    return np.fft.irfft(F * r / (1 + r), n)


def crackle(dur, d0, d1, tau=None, seed=3, f0=3200.0, bw=1500.0):
    """Electrical / fire crackle: random clicks whose rate glides from d0 to d1 per second, ringing at f0."""
    r = rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    dens = np.interp(t, [0, dur], [d0, d1])
    hits = r.random(n) < dens / SR
    amp = r.exponential(1.0, n) ** 1.3
    x = np.zeros(n)
    x[hits] = amp[hits] * np.where(r.random(hits.sum()) < 0.5, -1, 1)
    k = np.arange(int(0.006 * SR)) / SR
    kern = np.sin(2 * np.pi * (f0 + bw * r.random()) * k) * np.exp(-k / 0.0012)
    y = np.convolve(x, kern)[:n]
    if tau:
        y *= np.exp(-t / tau)
    return y / (np.abs(y).max() + 1e-9)


def delayed(x, secs, total=None):
    pad = np.zeros(int(secs * SR))
    y = np.concatenate([pad, x])
    if total:
        y = np.pad(y, (0, max(0, int(total * SR) - len(y))))[: int(total * SR)]
    return y


def mixd(*parts):
    """parts: (signal, gain_db, offset_s)"""
    n = max(len(s) + int(o * SR) for s, _, o in parts)
    out = np.zeros(n)
    for s, g, o in parts:
        i = int(o * SR)
        out[i:i + len(s)] += s * 10 ** (g / 20)
    return out


def norm(x, peak=0.9):
    return x * (peak / (np.abs(x).max() + 1e-9))


def smooth_fade(x, fin=0.004, fout=0.03):
    x = x.copy()
    n = min(len(x), int(fin * SR))
    if n: x[:n] *= np.linspace(0, 1, n) ** 1.5
    n = min(len(x), int(fout * SR))
    if n: x[-n:] *= np.linspace(1, 0, n) ** 1.5
    return x


def reverb_tail(x, rt60=1.2, wet=0.25, seed=7, lp=4500.0):
    """Cheap exponential-noise convolution reverb for chimes."""
    r = rng(seed)
    n = int(rt60 * SR)
    t = np.arange(n) / SR
    ir = r.standard_normal(n) * np.exp(-6.9 * t / rt60)
    ir = lowpass(ir, lp)
    ir[0] = 0
    ir /= np.sqrt((ir ** 2).sum())
    y = np.convolve(x, ir)[: len(x) + n // 2]
    return np.pad(x, (0, len(y) - len(x))) * (1 - wet * 0.3) + y * wet


# ------------------------------------------------------------------ the sounds
def warn_seeker():
    """Incoming missile: two warm pulses, urgent but no square-wave bite."""
    p = lambda f: tone(f, 0.13, ((1, 1.0), (2, 0.28), (3, 0.1)), attack=0.008, tau=0.12, hold=0.05)
    y = mixd((p(660), 0, 0), (p(880), 0, 0.15))
    return smooth_fade(lowpass(y, 2600), 0.004, 0.04)


def warn_lock():
    """A lock-on warning: a low double ping."""
    p = lambda f: tone(f, 0.22, ((1, 1.0), (2, 0.2), (2.76, 0.08)), attack=0.006, tau=0.07)
    y = mixd((p(740), 0, 0), (p(740), -5, 0.16))
    return smooth_fade(lowpass(y, 3200), 0.004, 0.05)


def heartbeat():
    """Lub-dub, felt more than heard: two soft sub thumps."""
    lub = tone(glide(64, 40, 0.22), 0.22, attack=0.006, tau=0.07) + 0.25 * lowpass(white(0.22, 5), 220) * exp_env(int(0.22 * SR), 0.003, 0.03)
    dub = tone(glide(56, 36, 0.24), 0.24, attack=0.006, tau=0.08)
    return smooth_fade(mixd((lub, 0, 0), (dub, -3, 0.2)), 0.003, 0.05)


def overheat():
    """Pressure release: a soft hiss that sags into a low thud."""
    n = int(0.7 * SR)
    hiss = stft_shape(white(0.7, 11), lambda t, f: bump(f, 2600, 1.0) * np.exp(-t / 0.22))
    hiss = norm(hiss, 0.5) * exp_env(n, 0.01, 0.2)
    thud = tone(glide(110, 48, 0.3), 0.3, attack=0.004, tau=0.09)
    return smooth_fade(lowpass(mixd((hiss, 0, 0), (thud, -2, 0.0)), 5000), 0.003, 0.08)


def chime_arp(base=523.25, ratios=(1, 1.26, 1.5, 2.0), gap=0.075, dur=1.5):
    """Shrine / heal: a soft bell arpeggio with a shimmer, warm and unhurried."""
    parts = []
    for i, r in enumerate(ratios):
        f = base * r
        y = tone(f, dur - gap * i, ((1, 1.0), (2, 0.35), (3, 0.12), (4.2, 0.05)), attack=0.01, tau=0.38)
        parts.append((y, -2.5 * i if i < 3 else -1.5, gap * i))
    sh = tone(base * 3, dur, ((1, 1.0), (1.003, 0.8)), attack=0.25, tau=0.45) * 0.12
    y = mixd(*parts, (sh, 0, 0.05))
    return smooth_fade(reverb_tail(lowpass(y, 7000), 1.1, 0.35), 0.005, 0.25)


def chill():
    """Frost status: two glassy notes falling."""
    a = tone(glide(2349, 2093, 0.4), 0.4, ((1, 1.0), (2.01, 0.2), (3.97, 0.06)), attack=0.004, tau=0.12)
    b = tone(glide(1568, 1397, 0.5), 0.5, ((1, 1.0), (2.01, 0.2)), attack=0.004, tau=0.16)
    return smooth_fade(reverb_tail(lowpass(mixd((a, 0, 0), (b, -3, 0.07)), 7500), 0.8, 0.3), 0.003, 0.15)


def nova_charge(w=0.45):
    """Frost Nova wind-up: the air gathers (rising band of noise) with an icy shimmer, peaking right at release."""
    dur = w + 0.12
    n = int(dur * SR)
    t = np.arange(n) / SR
    rise = np.clip(t / w, 0, 1) ** 2.2
    body = sweep_noise(dur, 500, 3800, 0.9, seed=21)
    body = body * rise * np.where(t < w, 1, np.exp(-(t - w) / 0.03))
    sh = sum(tone(f * (1 + 0.5 * np.clip(t / w, 0, 1)), dur, attack=0.02, tau=10) * (0.5 + 0.5 * np.sin(2 * np.pi * (7 + i) * t)) for i, f in enumerate((1318.5, 1976, 2637))) / 3
    sh = sh * rise * np.where(t < w, 1, np.exp(-(t - w) / 0.05))
    sub = tone(glide(70, 150, dur), dur, attack=0.02, tau=10) * rise * 0.5
    return smooth_fade(lowpass(body * 0.8 + sh * 0.35 + sub * 0.4, 6500), 0.01, 0.05)


def chain_charge(w=0.3):
    """Chain Lightning wind-up: a building electric hum with crackle."""
    dur = w + 0.1
    n = int(dur * SR)
    t = np.arange(n) / SR
    rise = np.clip(t / w, 0, 1) ** 1.6 * np.where(t < w, 1, np.exp(-(t - w) / 0.03))
    hum = tone(glide(95, 300, dur), dur, ((1, 1.0), (2, 0.5), (3, 0.3), (5, 0.12)), attack=0.01, tau=10)
    crk = crackle(dur, 40, 700, seed=31, f0=2600, bw=900)
    zing = tone(glide(900, 2800, dur), dur, attack=0.02, tau=10) * 0.25
    return smooth_fade(lowpass(hum * 0.45 * rise + crk * 0.5 * rise + zing * rise, 6500), 0.006, 0.04)


def chain_zap(strong=True):
    """A bolt: sharp crack, a falling zip, a crackling tail and a body-shaking thump."""
    dur = 1.5 if strong else 0.8
    n = int(dur * SR)
    t = np.arange(n) / SR
    crack = white(0.05, 41) * exp_env(int(0.05 * SR), 0.0005, 0.008)
    crack = lowpass(crack, 9000)
    zip_ = tone(glide(3200, 220, 0.22), 0.22, ((1, 1.0), (2, 0.4), (3, 0.2)), attack=0.001, tau=0.06)
    fm = sweep_noise(0.3, 6000, 600, 1.0, seed=43) * exp_env(int(0.3 * SR), 0.002, 0.07)
    tail = crackle(dur, 900, 60, tau=0.35 if strong else 0.18, seed=44, f0=3000, bw=1800)
    thump = tone(glide(95, 38, 0.35), 0.35, attack=0.003, tau=0.1)
    parts = [(crack, 0, 0), (zip_, -5, 0.0), (fm, -8, 0.0), (tail, -9, 0.02), (thump, -2 if strong else -8, 0.0)]
    if strong:
        rum = lowpass(white(1.0, 45), 320) * exp_env(int(1.0 * SR), 0.01, 0.3)
        parts.append((norm(rum, 0.6), -7, 0.02))
    return smooth_fade(lowpass(mixd(*parts), 9500), 0.001, 0.12)


def acid_cloud_hiss(dur=1.4):
    """Sizzle that rides the splat: dense soft crackle, filtered so it stays bubbling, not hissing."""
    c = crackle(dur, 700, 120, tau=0.6, seed=51, f0=2200, bw=900)
    c = highpass(lowpass(c, 4800), 600)
    n = len(c)
    return c * exp_env(n, 0.02, 0.55)
