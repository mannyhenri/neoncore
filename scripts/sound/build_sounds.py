#!/usr/bin/env python3
"""
THE APP'S SOUNDS — synthesized here, nothing sampled or downloaded.

One palette, so every sound belongs to the same place: soft sine-and-bell tones in D minor
pentatonic (D F G A C), a short tail of echo, nothing harsh. Fifteen files:

  ambient                 a 50-second outpost bed: a soft steady drone, moving wind and a few
                          distant pings — nothing that hums, pulses or beats. It fades in and out over OVERLAP seconds;
                          the app overlaps consecutive copies by that much, so no loop point is heard.
  ui-tap, ui-primary,     interface: a soft tap, a brighter one for primary buttons, open / close
  ui-open, ui-close,      for an agent's card, and a rising "sent"
  ui-send
  cue-*                   one per kind of event (dashboard/src/lib/sound/cues.ts)

Out:  dashboard/public/sound/*.mp3  and  dashboard/src/lib/sound/sounds.generated.ts
Run:  python3 scripts/sound/build_sounds.py        (needs numpy and ffmpeg)

Every file is checked before it is written: no clipping, a level inside its band, and no click
at either end (it starts and ends at silence).
"""
import os, subprocess, tempfile, wave
import numpy as np

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'dashboard', 'public', 'sound')
OVERLAP = 3.0
rng = np.random.default_rng(7)

NOTE = {'A1': 55.0, 'D2': 73.42, 'A2': 110.0, 'D3': 146.83, 'F3': 174.61, 'G3': 196.0, 'A3': 220.0, 'C4': 261.63, 'D4': 293.66,
        'F4': 349.23, 'G4': 392.0, 'A4': 440.0, 'C5': 523.25, 'D5': 587.33, 'F5': 698.46, 'G5': 783.99, 'A5': 880.0, 'D6': 1174.66}


def t(seconds):
    return np.arange(int(SR * seconds)) / SR


def bell(freq, seconds, decay=6.0, bright=0.35, attack=0.004):
    """A soft struck tone: a sine, a little of its octave and a detuned shimmer, dying away."""
    x = t(seconds)
    env = np.exp(-decay * x) * np.minimum(1.0, x / attack)
    return env * (np.sin(2 * np.pi * freq * x) + bright * np.sin(2 * np.pi * freq * 2.0 * x) * np.exp(-decay * 1.8 * x)
                  + 0.12 * np.sin(2 * np.pi * freq * 3.01 * x) * np.exp(-decay * 3 * x))


def pad(freq, seconds, attack=0.08, release=0.25):
    x = t(seconds)
    env = np.minimum(1.0, x / attack) * np.minimum(1.0, (seconds - x) / release)
    return env * (np.sin(2 * np.pi * freq * x) + 0.3 * np.sin(2 * np.pi * freq * 1.003 * x))


def sweep(f0, f1, seconds, decay=5.0):
    x = t(seconds)
    f = f0 * (f1 / f0) ** (x / seconds)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase) * np.exp(-decay * x) * np.minimum(1.0, x / 0.006)


def noise(seconds, lo, hi):
    """Band-limited noise, by zeroing the spectrum outside lo..hi Hz."""
    n = int(SR * seconds)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec[(f < lo) | (f > hi)] = 0
    y = np.fft.irfft(spec, n)
    return y / (np.max(np.abs(y)) + 1e-9)


def place(parts, seconds):
    """Mix (start_seconds, samples, gain) into one buffer."""
    out = np.zeros(int(SR * seconds))
    for start, y, gain in parts:
        i = int(SR * start)
        y = y[: len(out) - i]
        out[i:i + len(y)] += gain * y
    return out


def echo(y, delay=0.11, feedback=0.32, mix=0.28, tail=0.5):
    y = np.concatenate([y, np.zeros(int(SR * tail))])
    d = int(SR * delay)
    wet = np.zeros_like(y)
    buf = y.copy()
    for _ in range(5):
        buf = np.concatenate([np.zeros(d), buf[:-d]]) * feedback
        wet += buf
    return y + mix * wet


def ends(y, fade_in=0.003, fade_out=0.03):
    a, b = int(SR * fade_in), int(SR * fade_out)
    y = y.copy()
    y[:a] *= np.linspace(0, 1, a)
    y[-b:] *= np.linspace(1, 0, b)
    return y


def level(y, peak):
    return y * (peak / (np.max(np.abs(y)) + 1e-9))


# ── the sounds ───────────────────────────────────────────────────────────────────────────────

def ambient():
    seconds = 50.0
    x = t(seconds)
    slow = lambda rate, phase=0.0: 0.5 + 0.5 * np.sin(2 * np.pi * rate * x + phase)
    # A steady drone: two pure tones a fifth apart that swell and ebb over tens of seconds. No hum,
    # no pulsing and no detuned pair — anything that beats faster than that reads as a vibration.
    drone = (0.5 + 0.2 * slow(1 / 23)) * np.sin(2 * np.pi * NOTE['D3'] * x) + (0.28 + 0.16 * slow(1 / 31, 1.3)) * np.sin(2 * np.pi * NOTE['A3'] * x)
    wind = noise(seconds, 180, 1400) * (0.12 + 0.5 * slow(1 / 13, 0.7) * slow(1 / 7.3, 2.0)) * 0.16
    air = noise(seconds, 2500, 6000) * 0.012 * slow(1 / 19, 1.1)
    pings = place([(s, echo(bell(NOTE[n], 2.2, decay=2.4, bright=0.2), delay=0.37, feedback=0.5, mix=0.7, tail=2.5), g) for s, n, g in
                   [(6.0, 'A5', 0.05), (15.5, 'D6', 0.035), (24.0, 'F5', 0.045), (33.5, 'A5', 0.04), (41.0, 'G5', 0.04)]], seconds)
    y = drone * 0.2 + wind + air + pings
    n = int(SR * OVERLAP)
    # Equal-power fades: two overlapped copies add up to a steady level.
    y[:n] *= np.sin(np.linspace(0, np.pi / 2, n))
    y[-n:] *= np.cos(np.linspace(0, np.pi / 2, n))
    return level(y, 0.5)


SOUNDS = {
    'ambient': ambient,
    # interface — very short, very quiet
    'ui-tap': lambda: level(ends(bell(NOTE['D5'], 0.07, decay=60, bright=0.15) + 0.25 * noise(0.07, 1500, 5000) * np.exp(-90 * t(0.07))), 0.35),
    'ui-primary': lambda: level(ends(place([(0, bell(NOTE['A4'], 0.16, decay=26), 1), (0.012, bell(NOTE['D5'], 0.15, decay=24), 0.8)], 0.18)), 0.42),
    'ui-open': lambda: level(ends(echo(sweep(NOTE['D4'], NOTE['A4'], 0.14, decay=9) + 0.5 * bell(NOTE['A4'], 0.14, decay=18), tail=0.12)), 0.4),
    'ui-close': lambda: level(ends(echo(sweep(NOTE['A4'], NOTE['D4'], 0.14, decay=9) + 0.5 * bell(NOTE['D4'], 0.14, decay=18), tail=0.12)), 0.4),
    'ui-send': lambda: level(ends(echo(sweep(NOTE['D4'], NOTE['D5'], 0.2, decay=7) + 0.6 * place([(0.1, bell(NOTE['D5'], 0.2, decay=14), 1)], 0.3)[: int(SR * 0.2)], tail=0.2)), 0.45),
    # event cues
    # needs you: two notes rising a fourth — a question
    'cue-needs-you': lambda: level(ends(echo(place([(0, bell(NOTE['A4'], 0.5, decay=5), 1), (0.16, bell(NOTE['D5'], 0.6, decay=4.5), 1)], 0.8))), 0.7),
    # stuck: the same note three times, flat — going nowhere
    'cue-stuck': lambda: level(ends(echo(place([(i * 0.2, bell(NOTE['F4'], 0.3, decay=9, bright=0.5), 1 - i * 0.12) for i in range(3)], 0.8))), 0.68),
    # failed: two notes falling a fourth, the second low and a little sour
    'cue-failed': lambda: level(ends(echo(place([(0, bell(NOTE['D4'], 0.4, decay=6, bright=0.5), 1), (0.2, bell(NOTE['A3'], 0.7, decay=4), 1), (0.2, bell(NOTE['A3'] * 1.03, 0.7, decay=5), 0.35)], 1.0))), 0.72),
    # quota nearly gone: two low thumps and a high warning ping
    'cue-quota': lambda: level(ends(echo(place([(0, bell(NOTE['D3'], 0.35, decay=9, bright=0.6), 1), (0.24, bell(NOTE['D3'], 0.35, decay=9, bright=0.6), 1), (0.48, bell(NOTE['C5'], 0.6, decay=5), 0.7)], 1.1))), 0.74),
    # run finished: three notes up to the octave
    'cue-run-finished': lambda: level(ends(echo(place([(0, bell(NOTE['D4'], 0.4, decay=6), 0.9), (0.13, bell(NOTE['A4'], 0.4, decay=6), 0.9), (0.26, bell(NOTE['D5'], 0.7, decay=4), 1)], 1.0))), 0.62),
    # feature delivered: the same climb with a held chord under it
    'cue-delivered': lambda: level(ends(echo(place([(0, pad(NOTE['D3'], 1.3), 0.35), (0, pad(NOTE['A3'], 1.3), 0.25),
                                                   (0, bell(NOTE['D4'], 0.4, decay=6), 0.8), (0.12, bell(NOTE['G4'], 0.4, decay=6), 0.8), (0.24, bell(NOTE['A4'], 0.4, decay=6), 0.85), (0.38, bell(NOTE['D5'], 1.0, decay=3), 1), (0.38, bell(NOTE['A5'], 1.0, decay=4), 0.35)], 1.5), tail=0.7)), 0.66),
    # cartridge launched: a rising whoosh, then a ping on arrival
    'cue-launched': lambda: level(ends(echo(place([(0, noise(0.5, 300, 3000) * np.linspace(0, 1, int(SR * 0.5)) ** 2 * np.exp(-2 * t(0.5)[::-1] * 0), 0.25), (0, sweep(NOTE['D3'], NOTE['D5'], 0.5, decay=1.5), 0.5), (0.5, bell(NOTE['A4'], 0.6, decay=5), 1)], 1.15))), 0.6),
    # notice: one soft note
    'cue-notice': lambda: level(ends(echo(bell(NOTE['G4'], 0.4, decay=8), tail=0.3)), 0.5),
    # turn finished: one low, short note — the quietest cue
    'cue-turn-finished': lambda: level(ends(echo(bell(NOTE['D4'], 0.3, decay=11), tail=0.25)), 0.42),
}

# Loudness band (RMS over the sounding part) each family must sit in: interface under cues, ambient under all.
BANDS = {'ambient': (0.05, 0.2), 'ui': (0.02, 0.22), 'cue': (0.06, 0.3)}


def check(name, y):
    peak = float(np.max(np.abs(y)))
    assert peak <= 0.95, f'{name} clips: peak {peak:.3f}'
    assert not np.isnan(y).any(), f'{name} has NaN'
    # A click is a jump from silence: the first and last few samples must be next to nothing.
    edge = 6
    assert np.max(np.abs(y[:edge])) < 0.06 * peak + 0.005 and np.max(np.abs(y[-edge:])) < 0.06 * peak + 0.005, f'{name} clicks at an end'
    loud = y[np.abs(y) > 0.01 * peak]
    rms = float(np.sqrt(np.mean(loud ** 2)))
    lo, hi = BANDS[name.split('-')[0]]
    assert lo <= rms <= hi, f'{name} level {rms:.3f} outside {lo}–{hi}'
    return peak, rms


def write(name, y, bitrate):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype('<i2').tobytes())
    dest = os.path.join(OUT, f'{name}.mp3')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, '-codec:a', 'libmp3lame', '-b:a', bitrate, '-ac', '1', dest], check=True)
    os.unlink(tmp)
    return os.path.getsize(dest)


def main():
    os.makedirs(OUT, exist_ok=True)
    rows, total = [], 0
    for name, make in SOUNDS.items():
        y = make()
        peak, rms = check(name, y)
        size = write(name, y, '96k' if name == 'ambient' else '128k')
        total += size
        rows.append((name, len(y) / SR))
        print(f'{name:18s} {len(y) / SR:6.2f}s  peak {peak:.2f}  rms {rms:.3f}  {size / 1024:6.1f} KB')
    print(f'{len(rows)} files, {total / 1024:.0f} KB')
    lines = ['// GENERATED by scripts/sound/build_sounds.py — do not edit.',
             '/** Every sound file the app ships, and how long it is, in seconds. */',
             'export const SOUND_FILES = {']
    lines += [f"  '{n}': {{ src: '/sound/{n}.mp3', seconds: {s:.2f} }}," for n, s in rows]
    lines += ['} as const;', 'export type SoundId = keyof typeof SOUND_FILES;',
              '/** Consecutive copies of the ambient loop overlap by this many seconds (it fades in and out over them). */',
              f'export const AMBIENT_OVERLAP = {OVERLAP};', '']
    os.makedirs(os.path.join(ROOT, 'dashboard', 'src', 'lib', 'sound'), exist_ok=True)
    with open(os.path.join(ROOT, 'dashboard', 'src', 'lib', 'sound', 'sounds.generated.ts'), 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
