#!/usr/bin/env python3
"""align_words.py — timing per-KATA dari energi audio (speech-based).

Estimasi proporsi panjang-kata salah: kata pendek diucap pelan, kata panjang
diucap cepat. Pakai JEDA ENERGI (local minima) di dalam cue = batas kata
asli. Whisper lokal 2.4x realtime → audio-energy satu-satunya feasible.

Dipanggil setelah cue start di-onset-align (align_cues.py). Word boundary =
local minima terdalam N-1 dalam cue.

Args: video t0 t1 cue_json
  cue_json = [start, end, text] (ABSOLUT, text = kalimat/kue)
Output: {"words":[[start,end,word],...]}
"""
import sys, os, json, subprocess

video = sys.argv[1]
t0 = float(sys.argv[2])
t1 = float(sys.argv[3])
cue = json.loads(sys.argv[4])
FF = os.environ.get("FFMPEG_BIN") or "ffmpeg"

cs, ce, ctext = cue[0], cue[1], cue[2]
words = [w for w in str(ctext).replace("{N}", " ").split() if w]
if len(words) < 2:
    print(json.dumps({"words": [[round(cs, 2), round(ce, 2), ctext]]}))
    sys.exit(0)

dur = max(0.5, t1 - t0)
raw = os.path.join(os.environ.get("TEMP") or "/tmp", "aw_%d.pcm" % int(t0))
subprocess.run([FF, "-y", "-ss", "%.3f" % t0, "-i", video, "-t", "%.3f" % dur,
                "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", raw],
               capture_output=True)
if not os.path.exists(raw):
    # fallback: bagi rata (estimasi lama)
    n = len(words)
    step = (ce - cs) / n
    print(json.dumps({"words": [[round(cs + i * step, 2),
                                 round(cs + (i + 1) * step, 2), words[i]]
                      for i in range(n)]}))
    sys.exit(0)

import numpy as np
pcm = np.fromfile(raw, dtype=np.int16).astype(np.float32) / 32768.0
os.unlink(raw)
sr = 16000
WIN = int(0.02 * sr)
n_win = len(pcm) // WIN
if n_win < 3:
    n = len(words)
    step = (ce - cs) / n
    print(json.dumps({"words": [[round(cs + i * step, 2),
                                 round(cs + (i + 1) * step, 2), words[i]]
                      for i in range(n)]}))
    sys.exit(0)
e = np.sqrt((pcm[:n_win * WIN].reshape(n_win, WIN) ** 2).mean(axis=1))
# smoothing 3-window: redam noise mikro
es = np.convolve(e, np.ones(3) / 3, mode="same")

def rel(abs_t):
    return max(0, min(n_win - 1, int((abs_t - t0) * 50)))

i0, i1 = rel(cs), rel(ce)
seg = es[i0:i1 + 1]
if len(seg) < 5:
    n = len(words)
    step = (ce - cs) / n
    print(json.dumps({"words": [[round(cs + i * step, 2),
                                 round(cs + (i + 1) * step, 2), words[i]]
                      for i in range(n)]}))
    sys.exit(0)

# local minima = kandidat batas kata
mins = []
for i in range(1, len(seg) - 1):
    if seg[i] <= seg[i - 1] and seg[i] <= seg[i + 1]:
        mins.append((float(seg[i]), i))  # (energy, idx relatif)
mins.sort()  # energy terdalem dulu
need = len(words) - 1
bounds = sorted(i for _, i in mins[:need])
if len(bounds) < need:
    # minima kurang: isi sisanya bagi rata di ruang kosong
    extra = []
    have = [0, len(seg)] + list(bounds)
    for k in range(len(have) - 1):
        gap = have[k + 1] - have[k]
        if gap > 3:
            extra.append(have[k] + gap // 2)
    bounds = sorted(set(bounds) | set(extra))[:need]
    if len(bounds) < need:
        n = len(words)
        step = (ce - cs) / n
        print(json.dumps({"words": [[round(cs + i * step, 2),
                                     round(cs + (i + 1) * step, 2), words[i]]
                          for i in range(n)]}))
        sys.exit(0)

edges = [cs] + [t0 + (i0 + b) * 0.02 for b in bounds] + [ce]
out = []
for i, w in enumerate(words):
    s = max(cs, edges[i])
    en = min(ce, max(edges[i + 1], s + 0.08))  # min 80ms biar highlight kebaca
    out.append([round(s, 2), round(en, 2), w])
print(json.dumps({"words": out}))
