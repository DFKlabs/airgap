"""Synthesise the reel's sound effects and place them on the timeline.

Uses the modem's own tones (build/*.f32 from chirp.mjs) plus a few
synthesised ones: whooshes on cuts, a lock blip, a buzz on rejection.

    python3 sfx.py   -> build/sfx.wav
"""
import numpy as np
import soundfile as sf

R, O, END = 44100, 1.7, 49.0          # rate, voice offset, reel length (seconds)
V = lambda x: x + O                    # voice time -> reel time
out = np.zeros(int(END * R) + R)
rng = np.random.default_rng(7)


def put(sig, t, gain):
    i = int(t * R); n = min(len(sig), len(out) - i)
    out[i:i + n] += gain * sig[:n]


def load(name):
    return np.fromfile(f"build/{name}.f32", dtype=np.float32).astype(float)


def env(n, a=.005, r=.05):
    e = np.ones(n); A, Rr = int(a * R), int(r * R)
    e[:A] = np.linspace(0, 1, A); e[-Rr:] = np.linspace(1, 0, Rr)
    return e


def tone(f, d, a=.005, r=.05):
    t = np.arange(int(d * R)) / R
    return np.sin(2 * np.pi * f * t) * env(len(t), a, r)


def mix(*xs):
    o = np.zeros(max(len(x) for x in xs))
    for x in xs:
        o[:len(x)] += x
    return o


def whoosh(d=.42):
    n = int(d * R); x = rng.standard_normal(n)
    fc = 600 + 5000 * np.sin(np.linspace(0, np.pi, n)) ** 2
    y = np.zeros(n); a = 0.0
    for i in range(n):                 # one-pole low-pass, cutoff swept up and down
        k = 1 - np.exp(-2 * np.pi * fc[i] / R); a += k * (x[i] - a); y[i] = a
    return y * np.sin(np.linspace(0, np.pi, n)) ** 1.5 / np.abs(y).max()


put(load("chirp"), 0.1, .38)                                      # the hook: "hey"
put(load("sweep"), V(14.36) - .1, .16)                            # sixteen pitches
put(load("pre"), V(28.55) - .1, .16)                              # the preamble
put(np.concatenate([tone(1320, .07), tone(1760, .12)]), V(31.0), .22)      # lock
put(mix(tone(220, .12, .002, .1), .5 * tone(330, .12, .002, .1)), V(39.42), .25)  # mismatch
buzz = np.sign(np.sin(2 * np.pi * 110 * np.arange(int(.32 * R)) / R)) * env(int(.32 * R), .003, .12)
put(buzz, V(41.58), .09); put(tone(55, .4, .002, .3), V(41.58), .4)          # rejected
screech = np.concatenate([tone(1000 + 160 * rng.integers(0, 16), .06, .003, .01) for _ in range(12)])
put(screech + .15 * rng.standard_normal(len(screech)) * env(len(screech)), V(43.64), .11)  # dial-up
for t in [V(4.48), V(9.53), V(18.45), V(25.48), V(32.23), V(42.59)]:
    put(whoosh(), t - .21, .13)                                   # chapter cuts
put(mix(tone(880, .3, .004, .25), .6 * tone(1318.5, .3, .004, .25)), V(45.77) + .15, .12)
sf.write("build/sfx.wav", out.astype(np.float32), R)
print("build/sfx.wav, peak", round(float(np.abs(out).max()), 2))
