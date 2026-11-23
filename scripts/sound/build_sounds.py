#!/usr/bin/env python3
"""
THE APP'S SOUNDS — synthesized here, nothing sampled or downloaded.

One set per world theme (dashboard/src/world/theme.ts), the same fourteen sounds in each, in the
same key (D minor pentatonic: D F G A C), so a cue means the same thing in both:

  scifi     soft sine-and-bell tones with a short tail of echo — a quiet console
  fantasy   a medieval village, in D dorian: a lute (paired strings), a hunting horn, a church bell,
            a hand drum, a tambourine and knocks on wood, in a stone hall instead of an echo

Fourteen files each (there is no background loop: the app is silent between sounds):

  ui-tap, ui-primary,     interface: a soft tap, a brighter one for primary buttons, open / close
  ui-open, ui-close,      for an agent's card, and a rising "sent"
  ui-send
  cue-*                   one per kind of event (dashboard/src/lib/sound/cues.ts)

Out:  dashboard/public/sound/*.mp3 (scifi), dashboard/public/sound/fantasy/*.mp3,
      and dashboard/src/lib/sound/sounds.generated.ts
Run:  python3 scripts/sound/build_sounds.py        (needs numpy and ffmpeg)

Every file is checked before it is written: no clipping, a level inside its band, and no click
at either end (it starts and ends at silence).
"""
import os, subprocess, tempfile, wave
import numpy as np

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'dashboard', 'public', 'sound')
rng = np.random.default_rng(7)

NOTE = {'E4': 329.63, 'B4': 493.88, 'A1': 55.0, 'D2': 73.42, 'A2': 110.0, 'D3': 146.83, 'F3': 174.61, 'G3': 196.0, 'A3': 220.0, 'C4': 261.63, 'D4': 293.66,
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

SOUNDS = {
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

# ── the fantasy set: the same fifteen, played on a village's instruments ─────────────────────

def pluck(freq, seconds, damp=0.996, bright=0.5):
    """A plucked string (Karplus–Strong): a burst of noise going round a delay line, losing its edge each lap."""
    n = int(SR * seconds)
    period = max(2, int(round(SR / freq)))
    line = rng.uniform(-1, 1, period)
    # A softer pluck starts from smoother noise.
    line = bright * line + (1 - bright) * (line + np.roll(line, 1) + np.roll(line, 2)) / 3
    out = np.empty(n)
    for i in range(0, n, period):
        m = min(period, n - i)
        out[i:i + m] = line[:m]
        line = damp * 0.5 * (line + np.roll(line, 1))
    return out * np.minimum(1.0, t(seconds) / 0.002)


def knock(seconds=0.12, pitch=180.0):
    """Knuckles on wood: a short thud with a dry click on top."""
    x = t(seconds)
    return np.sin(2 * np.pi * pitch * x) * np.exp(-45 * x) + 0.5 * noise(seconds, 700, 2600) * np.exp(-110 * x)


def drum(seconds=0.4, pitch=95.0):
    """A hand drum: a low note that drops as it dies."""
    x = t(seconds)
    f = pitch * (1 + 0.6 * np.exp(-30 * x))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-11 * x) + 0.15 * noise(seconds, 200, 900) * np.exp(-60 * x)


def pipe(freq, seconds, attack=0.12, release=0.3):
    """A breathy pipe: a pure note with a little air in it, held steady (no vibrato)."""
    x = t(seconds)
    env = np.minimum(1.0, x / attack) * np.minimum(1.0, (seconds - x) / release)
    return env * (np.sin(2 * np.pi * freq * x) + 0.18 * np.sin(2 * np.pi * freq * 2 * x) + 0.05 * noise(seconds, freq * 1.5, freq * 6))


def chirp(seconds=0.09, f0=2600.0, f1=3900.0):
    x = t(seconds)
    f = f0 + (f1 - f0) * (x / seconds) ** 0.6
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * x / seconds) ** 2


def horn(freq, seconds, attack=0.06, release=0.18):
    """A hunting horn: a bright, buzzy note that speaks slowly and holds steady."""
    x = t(seconds)
    env = np.minimum(1.0, x / attack) * np.minimum(1.0, (seconds - x) / release)
    # Odd and even harmonics falling away, a touch brighter as it swells.
    y = sum(np.sin(2 * np.pi * freq * k * x) / k ** 1.4 for k in range(1, 9))
    return env * y / 2.2


def church_bell(freq, seconds):
    """A cast bell: partials that are not in tune with each other, a hard strike, a long ring."""
    x = t(seconds)
    partials = [(0.5, 1.0, 1.2), (1.0, 0.9, 1.6), (1.19, 0.6, 2.2), (1.5, 0.45, 2.6), (2.0, 0.5, 3.0), (2.51, 0.3, 4.0), (3.01, 0.2, 5.0)]
    y = sum(g * np.sin(2 * np.pi * freq * r * x) * np.exp(-d * x) for r, g, d in partials)
    return y * np.minimum(1.0, x / 0.003)


def jingle(seconds=0.25):
    """A tambourine's shake: bright metal noise in a few quick bursts."""
    x = t(seconds)
    bursts = sum(np.exp(-70 * np.maximum(0, x - s)) * (x >= s) for s in (0.0, 0.07, 0.14))
    return noise(seconds, 5500, 12000) * bursts / 2


def lute(notes, seconds, step=0.13, **kw):
    """Notes on a lute: each string is a pair, a hair apart in pitch and in time, as on the real thing."""
    parts = []
    for i, (n, g) in enumerate(notes):
        left = seconds - i * step
        parts += [(i * step, pluck(NOTE[n], left, **kw), g), (i * step + 0.006, pluck(NOTE[n] * 1.004, left - 0.006, **kw), g * 0.7)]
    return place(parts, seconds)


def hall(y, tail=0.6, mix=0.3):
    """A stone hall instead of an echo: a handful of early reflections, each duller and fainter."""
    y = np.concatenate([y, np.zeros(int(SR * tail))])
    wet = np.zeros_like(y)
    for delay, gain in ((0.023, 0.6), (0.041, 0.5), (0.067, 0.4), (0.097, 0.3), (0.139, 0.22), (0.191, 0.15), (0.263, 0.1)):
        d = int(SR * delay)
        wet[d:] += gain * y[:-d]
    # Duller: average neighbouring samples a few times.
    for _ in range(3):
        wet = (wet + np.roll(wet, 1)) / 2
    return y + mix * wet


# D dorian (D E F G A B C) — the raised sixth, B, is what makes it sound like a medieval tune.
FANTASY = {
    # interface: wood and gut
    'ui-tap': lambda: level(ends(knock(0.07, 420)), 0.35),
    'ui-primary': lambda: level(ends(lute([('A4', 1), ('D5', 0.8)], 0.18, step=0.014, damp=0.985)), 0.42),
    'ui-open': lambda: level(ends(place([(0, knock(0.05, 300), 0.5), (0.02, lute([('D4', 0.9), ('A4', 1)], 0.24, step=0.06, damp=0.988), 1)], 0.26)), 0.4),
    'ui-close': lambda: level(ends(place([(0, lute([('A4', 0.9), ('D4', 1)], 0.2, step=0.06, damp=0.988), 1), (0.16, knock(0.08, 220), 0.7)], 0.26)), 0.4),
    'ui-send': lambda: level(ends(lute([('D4', 0.8), ('A4', 0.9), ('D5', 1)], 0.4, step=0.06, damp=0.99)), 0.45),
    # needs you: a horn call, two notes rising a fourth — someone at the gate
    'cue-needs-you': lambda: level(ends(hall(place([(0, horn(NOTE['A3'], 0.3), 0.9), (0.26, horn(NOTE['D4'], 0.6), 1)], 0.9))), 0.5),   # a horn is dense: a lower peak for the same loudness
    # stuck: three knocks on a wooden door — nobody answers
    'cue-stuck': lambda: level(ends(hall(place([(i * 0.2, knock(0.16, 190), 1 - i * 0.1) for i in range(3)], 0.75), mix=0.35)), 0.68),
    # failed: a drum, and the lute falling a fourth onto it
    'cue-failed': lambda: level(ends(hall(place([(0, lute([('D4', 1)], 0.5), 1), (0.2, lute([('A3', 1)], 0.8), 1), (0.2, drum(0.5), 0.8)], 1.0))), 0.72),
    # quota nearly gone: the bell tolls twice
    'cue-quota': lambda: level(ends(hall(place([(0, church_bell(NOTE['D4'], 0.9), 1), (0.45, church_bell(NOTE['D4'], 1.15), 0.9)], 1.6), tail=0.0, mix=0.25)[: int(SR * 1.6)], fade_out=0.25), 0.74),
    # run finished: a lute flourish up the mode, with a shake of the tambourine
    'cue-run-finished': lambda: level(ends(hall(place([(0, lute([('D4', 0.9), ('A4', 0.9), ('B4', 0.9), ('D5', 1)], 1.0, step=0.1), 1), (0.3, jingle(0.25), 0.25)], 1.0), tail=0.5)), 0.62),
    # feature delivered: a fanfare — horns climbing to the octave, lute and tambourine under them
    'cue-delivered': lambda: level(ends(hall(place([(0, horn(NOTE['D4'], 0.22), 0.8), (0.2, horn(NOTE['F4'], 0.22), 0.8), (0.4, horn(NOTE['A4'], 0.22), 0.85), (0.6, horn(NOTE['D5'], 0.9), 1), (0.6, horn(NOTE['A4'], 0.9), 0.5),
                                                   (0.6, lute([('D4', 1), ('A4', 0.9), ('D5', 0.9)], 0.9, step=0.05), 0.6), (0.6, jingle(0.25), 0.25), (0.6, drum(0.4), 0.5)], 1.5), tail=0.7)), 0.55),
    # cartridge launched: a gust under the wings, then the small bell at the landing circle
    'cue-launched': lambda: level(ends(hall(place([(0, noise(0.55, 400, 2600) * np.sin(np.pi * t(0.55) / 0.55) ** 2, 0.4), (0.5, church_bell(NOTE['A5'], 0.65), 0.6)], 1.15), tail=0.5)), 0.6),
    # notice: one lute note with a grace note before it
    'cue-notice': lambda: level(ends(hall(lute([('F4', 0.6), ('G4', 1)], 0.4, step=0.05, bright=0.3), tail=0.3)), 0.5),
    # turn finished: a tap on the drum skin and one low string — the quietest cue
    'cue-turn-finished': lambda: level(ends(hall(place([(0, knock(0.06, 150), 0.5), (0.02, lute([('D4', 1)], 0.28, bright=0.3, damp=0.99), 1)], 0.3), tail=0.25)), 0.5),
}

# theme → (the folder under public/sound, its fourteen sounds)
SETS = {'scifi': ('', SOUNDS), 'fantasy': ('fantasy', FANTASY)}

# Loudness band (RMS over the sounding part) each family must sit in: interface under cues.
BANDS = {'ui': (0.02, 0.22), 'cue': (0.06, 0.3)}


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


def write(folder, name, y, bitrate):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    with wave.open(tmp, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype('<i2').tobytes())
    os.makedirs(os.path.join(OUT, folder), exist_ok=True)
    dest = os.path.join(OUT, folder, f'{name}.mp3')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, '-codec:a', 'libmp3lame', '-b:a', bitrate, '-ac', '1', dest], check=True)
    os.unlink(tmp)
    return os.path.getsize(dest)


def main():
    assert all(set(sounds) == set(SOUNDS) for _, sounds in SETS.values()), 'every theme has the same fourteen sounds'
    lines = ['// GENERATED by scripts/sound/build_sounds.py — do not edit.',
             'export interface SoundFile { src: string; seconds: number }']
    for theme, (folder, sounds) in SETS.items():
        rows, total = [], 0
        for name, make in sounds.items():
            y = make()
            peak, rms = check(f'{name}', y)
            size = write(folder, name, y, '128k')
            total += size
            rows.append((name, len(y) / SR))
            print(f'{theme:8s} {name:18s} {len(y) / SR:6.2f}s  peak {peak:.2f}  rms {rms:.3f}  {size / 1024:6.1f} KB')
        print(f'{theme}: {len(rows)} files, {total / 1024:.0f} KB')
        prefix = f'/sound/{folder}/' if folder else '/sound/'
        if theme == 'scifi':
            lines += ['/** Every sound the app has, and how long it is, in seconds — the base (sci-fi) set. */', 'export const SOUND_FILES = {']
            lines += [f"  '{n}': {{ src: '{prefix}{n}.mp3', seconds: {s:.2f} }}," for n, s in rows]
            lines += ['} as const;', 'export type SoundId = keyof typeof SOUND_FILES;']
            packs = ['  scifi: SOUND_FILES,']
        else:
            packs.append(f'  {theme}: {{ ' + ', '.join(f"'{n}': {{ src: '{prefix}{n}.mp3', seconds: {s:.2f} }}" for n, s in rows) + ' },')
    lines += ['/** The same sounds per world theme (world/theme.ts): each theme plays its own set. */',
              'export const SOUND_PACKS: Record<string, Record<SoundId, SoundFile>> = {', *packs, '};',
              '']
    os.makedirs(os.path.join(ROOT, 'dashboard', 'src', 'lib', 'sound'), exist_ok=True)
    with open(os.path.join(ROOT, 'dashboard', 'src', 'lib', 'sound', 'sounds.generated.ts'), 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main()
