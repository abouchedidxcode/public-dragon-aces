#!/usr/bin/env python3
"""Builds client/assets/audio/*.mp3 for DRAGON ACES from CC0 / CC-BY recordings.

Downloads the source packs (OpenGameArt and Kenney.nl, direct links, no login) into a cache folder, then
slices, pitch-shifts, layers, loops and encodes them. Needs ffmpeg (libmp3lame) and numpy. The outputs are
committed, so this is only for changing the mix.

    python3 tools/build_audio.py [--cache /tmp/da-audio-src] [--out client/assets/audio]

Every sample is loudness-normalised here, offline: tools/audio_spec.json gives each sample a category and each
category a target (active LUFS, see tools/loudness.py); encode() scales to it and applies a -1.5 dBFS look-ahead
limiter, then re-measures the encoded file. Music is normalised to an integrated target. The measured numbers
are written to client/assets/audio/loudness.json. Sounds that have no recordings (alerts, ability layers, chimes)
are synthesised in tools/audio_synth.py.

Sources, authors and licences are listed in README.md (Credits) and in SOURCES below.
"""
import argparse, io, json, os, subprocess, sys, urllib.request, zipfile
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import loudness as LD
import audio_synth as SY

SPEC = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'audio_spec.json')))
MANIFEST = {}

SR = 44100
OGA = 'https://opengameart.org/sites/default/files/'
KEN = 'https://kenney.nl/media/pages/assets/'

# name -> (url, [zip]) ; zips are extracted to <cache>/<name>/
SOURCES = {
    'troll':     OGA + 'troll-roars_0.ogg',                                   # Darsycho, CC0
    'monster':   OGA + 'monster_roar.wav',                                    # trazzz123, CC0
    'creature':  OGA + '80-CC0-creature-SFX_0.zip',                           # rubberduck, CC0
    'wingsbig':  OGA + 'wings_flap_large.zip',                                # AntumDeluge, CC0
    'dragonflap': OGA + 'dragonflap.wav',                                     # VishwaJai, CC0
    'fireball':  OGA + '105016__julien-matthey__jm-fx-fireball-01.wav',       # Julien Matthey, CC0
    'fireloop':  OGA + 'fire.wav',                                            # PagDev, CC0
    'bang':      OGA + '25-CC0-bang-sfx.zip',                                 # rubberduck, CC0
    'splash':    OGA + 'water-splash-slime-sfx.zip',                          # rubberduck, CC0
    'swishes':   OGA + 'swishes.zip',                                         # artisticdude, CC0
    'synthexp':  OGA + 'synthetic_explosion_1.flac',                          # qubodup, CC0
    'scifi':     KEN + 'sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip',        # Kenney, CC0
    'interface': KEN + 'interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip',  # Kenney, CC0
    'impacts':   KEN + 'impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip',        # Kenney, CC0
    # music, CC-BY 3.0 by Matthew Pablo (matthewpablo.com)
    'arcana':    OGA + 'The%20Fall%20of%20Arcana_0.mp3',
    'dreamraid': OGA + 'Dream%20Raid%20Pack.zip',
}


def fetch(cache):
    os.makedirs(cache, exist_ok=True)
    paths = {}
    for key, url in SOURCES.items():
        fn = os.path.join(cache, key + os.path.splitext(url.split('?')[0])[1].lower())
        if not os.path.exists(fn):
            print('download', url)
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=180) as r, open(fn, 'wb') as f:
                f.write(r.read())
        if fn.endswith('.zip'):
            d = os.path.join(cache, key)
            if not os.path.isdir(d):
                zipfile.ZipFile(fn).extractall(d)
            paths[key] = d
        else:
            paths[key] = fn
    return paths


def find(root, name):
    for r, _, fs in os.walk(root):
        if name in fs:
            return os.path.join(r, name)
    raise FileNotFoundError(name)


# ---------------------------------------------------------------- dsp helpers
def load(path, sr=SR):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def ffilter(x, af, sr=SR):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-i', '-', '-af', af, '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-'],
                         input=x.astype(np.float32).tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def pitch(x, r):
    """Resample so the sound plays r times faster (r < 1 = lower and longer)."""
    return ffilter(x, f'asetrate={SR * r:.2f},aresample={SR}')


def sl(x, a, b=None):
    return x[int(a * SR): None if b is None else int(b * SR)].copy()


def fade(x, fin=0.005, fout=0.05):
    x = x.copy()
    n = min(len(x), int(fin * SR))
    if n: x[:n] *= np.linspace(0, 1, n) ** 1.5
    n = min(len(x), int(fout * SR))
    if n: x[-n:] *= np.linspace(1, 0, n) ** 1.5
    return x


def gain(x, db):
    return x * (10 ** (db / 20))


def peak_norm(x, db=-1.0):
    p = np.abs(x).max() + 1e-9
    return x * (10 ** (db / 20) / p)


def squash(x, k=3.0):
    """Soft clip to tame the crest of a peaky source (a clipped splash, a firework crack) before it is layered."""
    x = x / (np.abs(x).max() + 1e-9)
    return np.tanh(x * k) / np.tanh(k)


def mix(*parts):
    """parts: (signal, gain_db, offset_seconds)"""
    n = max(len(s) + int(o * SR) for s, _, o in parts)
    out = np.zeros(n, dtype=np.float32)
    for s, g, o in parts:
        i = int(o * SR)
        out[i:i + len(s)] += gain(s, g)
    return out


def segments(x, gap=0.25, thresh_db=-38):
    """Splits at silences: returns [(start_s, end_s)]."""
    w = int(0.01 * SR)
    env = np.sqrt(np.convolve(x * x, np.ones(w) / w, 'same'))
    on = env > env.max() * 10 ** (thresh_db / 20)
    segs, i, n = [], 0, len(x)
    while i < n:
        if on[i]:
            j = i
            last = i
            while j < n and j - last < gap * SR:
                if on[j]: last = j
                j += 1
            segs.append((max(0, i - int(0.03 * SR)) / SR, min(n, last + int(0.05 * SR)) / SR))
            i = j
        else:
            i += 1
    return segs


def loopify(x, xf=0.6):
    n = int(xf * SR)
    y = x[:-n].copy()
    w = np.linspace(0, 1, n)
    y[:n] = x[:n] * np.sin(w * np.pi / 2) + x[-n:] * np.cos(w * np.pi / 2)
    return y


def limit(x, ceil_db=-1.5, look=0.0015, release=0.06):
    """Look-ahead peak limiter: the gain dips smoothly before a peak and recovers over `release` seconds."""
    c = 10 ** (ceil_db / 20)
    need = np.minimum(1.0, c / np.maximum(np.abs(x), 1e-9))
    if need.min() >= 1.0:
        return x
    w = max(1, int(look * SR))
    g = need.copy()
    for k in range(1, w + 1):
        g[:-k] = np.minimum(g[:-k], need[k:])  # look ahead
        g[k:] = np.minimum(g[k:], need[:-k])   # and hold behind
    hann = np.hanning(2 * w + 1)
    g = np.minimum(g, np.convolve(np.pad(g, (w, w), mode='edge'), hann / hann.sum(), 'valid'))
    a = np.exp(-1 / (release * SR))
    out = np.empty_like(g)
    prev = 1.0
    for i in range(len(g)):  # release: gain may fall at once but only creeps back up
        prev = min(g[i], prev * a + (1 - a))
        out[i] = prev
    return x * out


def target_of(name):
    cat = SPEC['samples'][name]
    return cat, SPEC['targets'][cat] + SPEC['offsets'].get(name, 0.0)


def encode(x, path, kbps=96, stereo=False):
    """Normalises to the sample's loudness target, limits, encodes and records what the encoded file measures."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    name = os.path.splitext(os.path.basename(path))[0]
    cat, target = target_of(name)
    x = np.clip(x.astype(np.float64), -4, 4)
    g = 10 ** ((target - LD.active_lufs(x)) / 20)
    for _ in range(5):  # closed loop on what ships: limiter + mp3 encode/decode move the loudness a little
        y = limit(x * g)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'libmp3lame', '-b:a', f'{kbps}k', '-ar', str(SR), path],
                       input=np.clip(y, -1, 1).astype(np.float32).tobytes(), check=True)
        d = LD.load(path)
        err = target - LD.active_lufs(d)
        if abs(err) < 0.1:
            break
        g *= 10 ** (err / 20)
    gr = 20 * np.log10(np.abs(x * g).max() / max(np.abs(y).max(), 1e-9) + 1e-12)
    MANIFEST[name] = dict(cat=cat, target=round(target, 2), active=round(LD.active_lufs(d), 2), integrated=round(LD.integrated_lufs(d), 2), peak=round(LD.peak_db(d), 2), crest=round(LD.crest_db(d), 1), dur=round(len(d) / SR, 3))
    print(f'  {name:16s} {os.path.getsize(path) / 1024:6.1f} KB {len(d) / SR:5.2f}s  {cat:9s} target {target:6.1f}  got {MANIFEST[name]["active"]:6.1f}  peak {MANIFEST[name]["peak"]:5.1f}  limiter {max(0, gr):4.1f} dB')


def music(src, path, kbps=112, start=0, end=None, fade_out=2.0):
    """Cuts, fades and encodes a music track at the integrated loudness in the spec (peak kept under its ceiling)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cut = ['-ss', str(start)] + (['-to', str(end)] if end else [])
    pcm = subprocess.run(['ffmpeg', '-v', 'error'] + cut + ['-i', src, '-vn', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = np.frombuffer(pcm, dtype=np.float32).astype(np.float64).reshape(-1, 2)
    m = SPEC['music']
    gdb = m['integrated'] - LD.integrated_lufs(x)
    gdb = min(gdb, m['ceiling'] - LD.peak_db(x))
    for _ in range(3):  # closed loop on the encoded file, as for the samples
        af = [f'volume={gdb:.2f}dB']
        if end:
            af.append(f'afade=t=out:st={(end - start) - fade_out}:d={fade_out}')
        subprocess.run(['ffmpeg', '-v', 'error', '-y'] + cut + ['-i', src, '-vn', '-af', ','.join(af), '-c:a', 'libmp3lame', '-b:a', f'{kbps}k', '-ar', str(SR), '-ac', '2', path], check=True)
        d = LD.load(path, ch=2)
        err = m['integrated'] - LD.integrated_lufs(d)
        if abs(err) < 0.1 or LD.peak_db(d) + err > m['ceiling']:
            break
        gdb += err
    name = os.path.splitext(os.path.basename(path))[0]
    MANIFEST[name] = dict(cat='music', target=m['integrated'], active=round(LD.integrated_lufs(d), 2), integrated=round(LD.integrated_lufs(d), 2), peak=round(LD.peak_db(d), 2), crest=round(LD.crest_db(d), 1), dur=round(len(d) / SR, 3))
    print(f'  {name:16s} {os.path.getsize(path) / 1024:7.1f} KB  (music) gain {gdb:+.1f} dB  integrated {MANIFEST[name]["integrated"]:.1f}  peak {MANIFEST[name]["peak"]:.1f}')


# ---------------------------------------------------------------- the mix
def build(P, out):
    o = lambda n: os.path.join(out, n + '.mp3')
    cre, scifi, ui, imp = P['creature'], P['scifi'], P['interface'], P['impacts']
    S = lambda n: load(find(scifi, n))
    I = lambda n: load(find(ui, n))
    M = lambda n: load(find(imp, n))
    B = lambda n: load(find(P['bang'], n))
    W = lambda n: load(find(P['splash'], n))
    SW = lambda n: load(find(P['swishes'], n))

    print('roars')
    troll = load(P['troll'])
    segs = segments(troll, gap=0.35)
    print('  troll segments', [(round(a, 2), round(b, 2)) for a, b in segs])
    for i, (a, b) in enumerate(segs[:5]):
        r = fade(sl(troll, a, b), 0.01, 0.25)
        d = pitch(r, 0.8)  # a dragon is bigger than a troll
        rumble = lowpass = ffilter(pitch(r, 0.5), 'lowpass=f=260')
        encode(peak_norm(mix((d, 0, 0), (rumble, -3, 0.02))), o(f'roar_{i + 1}'), 112)
    mon = fade(sl(load(P['monster']), 0.05, 3.6), 0.02, 1.2)
    encode(peak_norm(ffilter(mon, 'lowpass=f=2400')), o('roar_deep'), 96)

    print('dragon pain')
    for i, n in enumerate(['hurt_01.ogg', 'hurt_03.ogg', 'grunt_03.ogg']):
        x = load(find(cre, n))
        encode(peak_norm(ffilter(pitch(fade(x, 0.005, 0.1), 0.78), 'lowpass=f=4200')), o(f'hurt_{i + 1}'), 96)

    print('wings')
    wb = load(find(P['wingsbig'], 'wings_flap_large.ogg'))
    fl = segments(wb, gap=0.3, thresh_db=-30)
    print('  flap segments', [(round(a, 2), round(b, 2)) for a, b in fl])
    for i, (a, b) in enumerate(fl[:3]):
        x = pitch(fade(sl(wb, a, b), 0.01, 0.12), 0.8)
        encode(peak_norm(x), o(f'flap_{i + 1}'), 80)
    df = fade(sl(load(P['dragonflap']), 0.0, 1.5), 0.005, 0.5)
    encode(peak_norm(df), o('flap_4'), 80)

    print('fire')
    fb = load(P['fireball'])
    core = fade(sl(fb, 0.12, 1.55), 0.02, 0.45)
    sw = pitch(SW('swish-3.wav'), 0.6)
    encode(peak_norm(mix((core, 0, 0), (sw, -4, 0.0))), o('fireball_1'), 96)
    encode(peak_norm(pitch(core, 1.18)), o('fireball_2'), 96)
    encode(peak_norm(mix((pitch(core, 0.85), 0, 0), (pitch(SW('swish-7.wav'), 0.5), -4, 0.0))), o('fireball_3'), 96)
    th = S('thrusterFire_001.ogg')
    seek = mix((fade(sl(th, 0, 1.8), 0.12, 0.6), -2, 0), (pitch(core, 0.7), -5, 0.05))
    encode(peak_norm(ffilter(seek, 'highpass=f=90')), o('seeker'), 96)
    # flame breath: a steady roar (rocket thruster, band-limited) with embers crackling through it
    th3 = S('thrusterFire_003.ogg')
    crack = load(P['fireloop'])
    crack = peak_norm(ffilter(crack[: 6 * SR], 'highpass=f=700'), -6)
    body = ffilter(th3, 'lowpass=f=4200,highpass=f=70,bass=g=5:f=180')
    br = mix((body, 0, 0), (crack[: len(body)], -9, 0))
    encode(peak_norm(loopify(br, 0.5), -3), o('breath_loop'), 80)
    ign = fade(sl(core, 0, 0.7), 0.01, 0.3)
    encode(peak_norm(ign), o('breath_start'), 80)

    print('explosions')
    low0, low1 = S('lowFrequency_explosion_000.ogg'), S('lowFrequency_explosion_001.ogg')
    c1, c3, c4, c0 = S('explosionCrunch_001.ogg'), S('explosionCrunch_003.ogg'), S('explosionCrunch_004.ogg'), S('explosionCrunch_000.ogg')
    encode(peak_norm(mix((c3, 0, 0), (low0, -2, 0))), o('explode_1'), 112)
    encode(peak_norm(mix((c4, 0, 0), (low1, -2, 0), (B('bang_03.ogg'), -8, 0.02))), o('explode_2'), 112)
    encode(peak_norm(mix((pitch(c1, 0.85), 0, 0), (pitch(low0, 1.1), -3, 0))), o('explode_3'), 112)
    syn = load(P['synthexp'])
    encode(squash(mix((pitch(c4, 0.7), 0, 0), (low0, 0, 0), (pitch(syn, 0.8), -4, 0.02), (pitch(low1, 0.7), -2, 0.1)), 1.8), o('explode_big'), 128)
    for i, (a, b) in enumerate([('impactPunch_heavy_000.ogg', 'bang_07.ogg'), ('impactPunch_heavy_002.ogg', 'bang_09.ogg'), ('impactSoft_heavy_001.ogg', 'bang_01.ogg')]):
        x = mix((fade(M(a), 0.002, 0.1), 0, 0), (fade(sl(B(b), 0, 0.55), 0.002, 0.3), -6, 0))
        encode(peak_norm(x), o(f'impact_{i + 1}'), 96)
    encode(peak_norm(mix((fade(sl(c0, 0, 0.6), 0.002, 0.2), 0, 0), (pitch(M('impactMetal_heavy_001.ogg'), 0.9), -4, 0))), o('impact_seeker'), 96)

    print('water')
    sp = [('splash_04.ogg', 'splash_01.ogg'), ('splash_07.ogg', None), ('splash_08.ogg', None)]
    for i, (a, b) in enumerate(sp):
        x = mix((W(a), 0, 0), (pitch(low1, 1.3)[: int(0.9 * SR)], -9, 0.02))
        encode(peak_norm(ffilter(fade(x, 0.003, 0.2), 'lowpass=f=4200,treble=g=-6:f=2200')), o(f'splash_{i + 1}'), 96)

    print('air')
    # the wind is no longer a recording: client/js/audio.js synthesises it (filtered noise layers) so it can follow
    # speed, dives and turns smoothly without loop seams or a fixed hiss
    sea = load(find(P['splash'], 'loop_water_02.ogg'))
    encode(peak_norm(ffilter(sea, 'lowpass=f=2800,bass=g=4:f=200'), -3), o('sea_loop'), 64)  # menu ambience
    sw1, sw2, sw3 = SW('swish-9.wav'), SW('swish-4.wav'), SW('swish-7.wav')
    encode(peak_norm(mix((pitch(sw1, 0.5), 0, 0), (pitch(sw2, 0.42), -2, 0.04), (fade(sl(core, 0.4, 0.9), 0.05, 0.3), -9, 0.0))), o('dodge'), 96)

    print('abilities, alerts and chimes')
    glass = lambda n: M(n)
    boom = ffilter(pitch(low0, 0.9), 'lowpass=f=240')
    whoosh_out = SY.sweep_noise(0.9, 3400, 320, 0.9, seed=61) * SY.exp_env(int(0.9 * SR), 0.01, 0.28)
    shimmer = sum(SY.tone(f, 1.8, ((1, 1.0), (2.01, 0.15)), attack=0.01, tau=0.55) for f in (2093.0, 3136.0, 4186.0)) / 3
    nova = SY.mixd((boom, 0, 0), (whoosh_out, -7, 0.0), (pitch(glass('impactGlass_heavy_001.ogg'), 0.8), -5, 0.01),
                   (pitch(glass('impactGlass_heavy_003.ogg'), 1.1), -8, 0.06), (shimmer, -17, 0.04), (SY.tone(SY.glide(72, 33, 1.0), 1.0, attack=0.004, tau=0.3), -3, 0.0))
    encode(fade(ffilter(SY.reverb_tail(nova, 1.0, 0.25), 'lowpass=f=9000'), 0.002, 0.3), o('nova_burst'), 96)
    encode(SY.nova_charge(0.45), o('nova_charge'), 80)
    encode(SY.chain_charge(0.3), o('chain_charge'), 80)
    encode(SY.chain_zap(True), o('chain_zap'), 96)
    encode(SY.chain_zap(False), o('chain_miss'), 80)
    slime = load(find(P['splash'], 'slime_05.ogg'))
    spit = SY.mixd((fade(sl(slime, 0, 0.5), 0.003, 0.15), 0, 0), (SY.sweep_noise(0.45, 2600, 500, 0.9, seed=71) * SY.exp_env(int(0.45 * SR), 0.005, 0.12), -9, 0.0),
                   (SY.tone(SY.glide(420, 130, 0.2), 0.2, attack=0.004, tau=0.07), -8, 0.0))
    encode(ffilter(spit, 'lowpass=f=3800'), o('acid_spit'), 80)
    splat = squash(pitch(W('splash_10.ogg'), 0.85), 3.5)
    acid = SY.mixd((fade(ffilter(splat[: int(1.0 * SR)], 'lowpass=f=4800'), 0.002, 0.3), 0, 0), (SY.acid_cloud_hiss(1.4), -9, 0.05), (W('bubble_02.ogg'), -10, 0.35))
    encode(squash(acid, 2.2), o('acid_burst'), 96)
    inferno = SY.mixd((fade(pitch(core, 0.62)[: int(1.8 * SR)], 0.01, 0.6), 0, 0), (fade(ffilter(mon[: int(2.2 * SR)], 'lowpass=f=700'), 0.02, 0.8), -4, 0.05),
                      (fade(pitch(SW('swish-9.wav'), 0.45), 0.02, 0.4), -5, 0.0))
    encode(inferno, o('inferno'), 96)
    encode(SY.chill(), o('chill'), 64)
    encode(SY.chime_arp(), o('heal'), 80)
    encode(SY.warn_seeker(), o('warn_seeker'), 64)
    encode(SY.warn_lock(), o('warn_lock'), 64)
    encode(SY.overheat(), o('overheat'), 64)
    encode(SY.heartbeat(), o('heartbeat'), 64)

    print('ui')
    ui_map = {
        'ui_hover': 'tick_001.ogg', 'ui_click': 'click_001.ogg', 'ui_confirm': 'confirmation_004.ogg', 'ui_back': 'back_002.ogg',
        'ui_open': 'open_002.ogg', 'ui_close': 'close_002.ogg', 'ui_error': 'error_004.ogg', 'ui_toggle': 'toggle_002.ogg',
        'ui_pick': 'maximize_002.ogg', 'ui_tab': 'select_007.ogg',
    }
    for k, v in ui_map.items():
        encode(peak_norm(ffilter(fade(I(v), 0.001, 0.02), 'lowpass=f=7000,treble=g=-4:f=3000')), o(k), 64)  # the UI set is brighter than anything else: tame it
    encode(peak_norm(ffilter(mix((I('tick_004.ogg'), 0, 0), (I('click_005.ogg'), -6, 0), (SY.tone(SY.glide(640, 420, 0.07), 0.07, attack=0.002, tau=0.025), -3, 0)), 'lowpass=f=3600')), o('hit'), 64)
    encode(peak_norm(ffilter(mix((I('confirmation_003.ogg'), 0, 0), (M('impactPunch_heavy_004.ogg'), -6, 0)), 'lowpass=f=4800,treble=g=-4:f=2800')), o('kill'), 80)
    # streak stings: a struck bell, deeper for bigger streaks
    for i, (n, r) in enumerate([('impactBell_heavy_000.ogg', 1.0), ('impactBell_heavy_002.ogg', 0.8), ('impactBell_heavy_004.ogg', 0.62)]):
        bell = pitch(M(n), r)
        encode(peak_norm(mix((bell, 0, 0), (ffilter(pitch(mon, 0.9)[: int(1.5 * SR)], 'lowpass=f=500'), -8, 0.0))), o(f'streak_{i + 1}'), 96)

    print('music')
    arc = os.path.join(P['arcana'])
    music(arc, os.path.join(out, 'music_menu.mp3'), 112)
    dr = find(P['dreamraid'], 'Dream Raid Part I.mp3')
    music(dr, os.path.join(out, 'music_battle.mp3'), 104)
    music(find(P['dreamraid'], 'Dream Raid Part III.mp3'), os.path.join(out, 'music_results.mp3'), 112)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--cache', default='/tmp/da-audio-src')
    ap.add_argument('--out', default=os.path.join(here, '..', 'client', 'assets', 'audio'))
    a = ap.parse_args()
    paths = fetch(a.cache)
    build(paths, os.path.abspath(a.out))
    tot = sum(os.path.getsize(os.path.join(a.out, f)) for f in os.listdir(a.out))
    with open(os.path.join(a.out, 'loudness.json'), 'w') as f:
        json.dump(dict(sorted(MANIFEST.items())), f, indent=1)
    print(f'total {tot / 1024 / 1024:.2f} MB')
