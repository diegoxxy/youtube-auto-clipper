#!/usr/bin/env python3
"""align_cues.py — geser cue subtitle ke ONSET UCAPAN via energi audio.

transcript.json (LLM ASR) timing telat ~0.3-0.6s sistematis: mulut udah buka
sebelum cue start. Orbit: cari kenaikan energi audio (speech onset) dlm
window [-1.2s, +0.4s] sebelum cue start, geser cue ke onset terdekat.

Berdasarkan pola Opus Clip / Clips Kitty: word-level alignment. Di 4-core,
audio-energy onset = pengganti whisper yang feasible (whisper tiny = 2.4x
realtime, terlalu lambat).

Args: video abs_start abs_end cues_json out.json
  cues_json = [[start,end,text], ...] ABSOLUT timing
Output: {"cues":[[start,end,text],...]} aligned
"""
import sys, os, json, subprocess

video = sys.argv[1]
t0 = float(sys.argv[2])
t1 = float(sys.argv[3])
cues = json.loads(sys.argv[4])
outp = sys.argv[5] if len(sys.argv) > 5 else ""
FF = os.environ.get("FFMPEG_BIN") or "ffmpeg"

if not os.path.exists(video):
    print(json.dumps({"error": "no video"})); sys.exit(0)

dur = max(1.0, t1 - t0)

# 1 pass: decode audio window ke raw PCM 16kHz mono (cepat, no model).
raw = os.path.join(os.environ.get("TEMP") or "/tmp", "al_%d.pcm" % int(t0))
subprocess.run([FF, "-y", "-ss", "%.3f" % t0, "-i", video, "-t", "%.3f" % dur,
                "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", raw],
               capture_output=True)
if not os.path.exists(raw):
    print(json.dumps({"error": "decode gagal"})); sys.exit(0)

import numpy as np
pcm = np.fromfile(raw, dtype=np.int16).astype(np.float32) / 32768.0
os.unlink(raw)
sr = 16000

# Energy per 20ms window (800 samples).
WIN = int(0.02 * sr)
n_win = len(pcm) // WIN
if n_win < 2:
    print(json.dumps({"error": "audio pendek"})); sys.exit(0)
e = np.sqrt((pcm[:n_win * WIN].reshape(n_win, WIN) ** 2).mean(axis=1))

# Threshold bicara: 25% dari PUNCAK GLOBAL (podcast keras seragam, ga ada
# jeda total). Threshold relatif-maksimum sebelumnya (0.30 * max lokal
# kanan) = ambil onset paling kuat doang, nyaris semua cue no-op.
thr = 0.25 * float(e.max())
speak = e > thr

def onset_at(abs_t):
    """Cari speech onset (transisi diam→bicara) di [-0.8, +0.2] sekitar abs_t.
    Scan KIRI→KANAN: onset PERTAMA = awal ucapan. (Scan kanan→kiri ambil
    onset terakhir = jeda mikro di tengah kata = telat lagi.)"""
    rel = abs_t - t0
    wi = int(rel * 50)  # index window 20ms
    lo = max(0, wi - int(0.8 * 50))
    hi = min(len(speak) - 1, wi + int(0.2 * 50))
    for i in range(lo, hi + 1):
        if speak[i] and (i == 0 or not speak[i - 1]):
            return t0 + i * 0.02
    return None

out = []
prev_end = None
for c in cues:
    s, e_txt = c[0], c[1]
    txt = c[2] if len(c) > 2 else ""
    st = onset_at(s)
    # JANGAN geser kalau onset nabrak cue SEBELUMNYA (overfit ke ucapan lama):
    # "Heeh." onset-nya malah ketangkep di cue "FK" sebelumnya. Guard:
    # onset baru harus > prev_end - 0.6. Cue YouTube sering tumpang-tindih
    # (cue2 = cue1 + teks baru), jadi -0.15 terlalu ketat = semua cue no-op.
    if (st is not None and abs(st - s) <= 0.8
            and (prev_end is None or st > prev_end - 0.6)):
        de = e_txt - s
        s2 = round(st, 2)
        out.append([s2, round(s2 + de, 2), txt])
        prev_end = s2 + de
    else:
        out.append([round(s, 2), round(e_txt, 2), txt])
        prev_end = e_txt

if outp:
    with open(outp, "w") as f:
        json.dump({"cues": out}, f)
print(json.dumps({"cues": out}))
