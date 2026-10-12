#!/usr/bin/env python3
"""mouth_motion.py — pilih speaker aktif via buka-tutup MULUT (bukan LLM).

Dipakai speaker_detect.js sbg pengganti vision LLM (flaky + lambat).
YuNet return 15 col: [x,y,w,h, re_x,re_y, le_x,le_y, nose_x,nose_y,
rm_x,rm_y, lm_x,lm_y, score]. Jarak vertikal rm_y↔lm_y = buka mulut.

Sample N frame di window. Untuk tiap wajah (dilacak via IoU),
hitung std/variasi buka-mulut. Yg paling banyak variasi = LAGI NGOMONG.

Berdasarkan pola Clips Kitty: "subject chosen by mouth motion,
falling back to the most prominent face".

Args: video start end out.json [cueT_json] [maxfaces]
  cueT_json = JSON array timestamp cue subtitle (prioritas sample di cue).
Output: {"speakers":[{"t":t,"cx":cx,"cy":cy,"open":ratio}]}
"""
import sys, os, json, subprocess

try:
    import cv2
    import numpy as np
except Exception as e:
    print(json.dumps({"error": "no cv2/numpy: %s" % e})); sys.exit(0)

video = sys.argv[1]
start = float(sys.argv[2])
end = float(sys.argv[3])
outp = sys.argv[4] if len(sys.argv) > 4 else ""
max_faces = 4
cue_t = []
if len(sys.argv) > 5:
    try:
        cue_t = [float(x) for x in json.loads(sys.argv[5])][:24]
    except Exception:
        pass
FF = os.environ.get("FFMPEG_BIN") or "ffmpeg"

if not os.path.exists(video):
    print(json.dumps({"error": "no video"})); sys.exit(0)

dur = max(1.0, end - start)
# Sample: prioritas di cueT subtitle (speaker switch tepat di kata diucap),
# sisanya terisi rata DI WINDOW start..end. Maks 24 frame (4-core: YuNet
# ~0.5s/frame). ponytail: dulu fill pakai 0..dur = frame salah (t=0).
import numpy as np
times = sorted(set([round(x, 2) for x in cue_t]))
# FILL di CELAH cueT (bukan cuma tambah di ujung): cueT padat di awal ucapan
# tapi MISSING pukulan vokal di tengah kata (c2: pria open 0.066 @127.4 ga
# ada di cueT 125.6/128.7 → cluster max 0.008 = senyum wanita menang).
# Sisipkan titik di tengah tiap gap cueT > 2.2s.
insert = []
for i in range(1, len(times)):
    gap = times[i] - times[i - 1]
    if gap > 2.2:
        insert.append(round(times[i - 1] + gap / 2, 2))
times = sorted(set(times + insert))
need = 24 - len(times)
if need > 0:
    for i in range(need):
        times.append(round(start + dur * i / max(1, need - 1), 2))

# SAMPLE di tiap SHOT SEGMENT (insert shot 1-2s terlewat cueT+fill).
# c2: hoodie insert 133.5-134.6 = 1.1s, sample t=134.6 ga ada di window
# → bucket cluster ambil anchor salah. ffmpeg scene>0.15, sample @30%.
try:
    r = subprocess.run([FF, "-y", "-ss", str(start), "-i", video, "-t", str(dur),
                        "-vf", "select='gt(scene,0.15)',showinfo", "-f", "null", "-"],
                       capture_output=True, timeout=180)
    cuts = [start]
    for line in (r.stderr or b"").decode("utf-8", "ignore").split("\n"):
        if "pts_time:" in line:
            try:
                cuts.append(start + float(line.split("pts_time:")[1].split()[0]))
            except Exception:
                pass
    cuts.append(end)
    seg_pts = []
    for i in range(len(cuts) - 1):
        pts = round(cuts[i] + (cuts[i + 1] - cuts[i]) * 0.30, 2)
        if start <= pts <= end:
            seg_pts.append(pts)
    times = sorted(set(times + seg_pts))
except Exception:
    pass
times = sorted(set(t for t in times if start - 0.5 <= t <= end + 0.5))
N = len(times)
model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models",
                     "face_detection_yunet_2023mar.onnx")

# Extract N frame sekaligus (1 pass ffmpeg, scale 480 buat cepat).
tmp = os.environ.get("TEMP") or "/tmp"
frames = []
for i, t in enumerate(times):
    p = os.path.join(tmp, "mm_%d.png" % i)
    subprocess.run([FF, "-y", "-ss", "%.3f" % t, "-i", video,
                    "-frames:v", "1", "-vf", "scale=480:-2", p],
                   capture_output=True)
    if os.path.exists(p):
        frames.append((t, p))

if len(frames) < 3:
    print(json.dumps({"error": "few frames"})); sys.exit(0)

# Deteksi wajah tiap frame. Kelompokkan lintas-frame via IoU (tracklet sederhana).
det = cv2.FaceDetectorYN_create(str(model), "", (480, 480), 0.6, 0.3, 5000)
tracks = []  # [{boxes:[(x,y,w,h)], mouth:[..], t:[..]}]

def iou(a, b):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    return (ix * iy) / max(1.0, aw * ah + bw * bh - ix * iy)

for t, p in frames:
    im = cv2.imread(p)
    if im is None:
        continue
    h, w = im.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(im)
    cur = []
    if faces is not None:
        for f in faces[:max_faces]:
            x, y, fw, fh = int(f[0]), int(f[1]), int(f[2]), int(f[3])
            cy_f = (y + fh / 2) / h
            if cy_f > 0.62:
                continue  # false positive (tangan/meja)
            rm_x, rm_y = f[10], f[11]
            lm_x, lm_y = f[12], f[13]
            # NORMALISASI thd TINGGI WAJAH (BUKAN lebar mulut). YuNet
            # underestimate mouthW (3.7px di wajah 58px) → rasio palsu
            # jenuh. Wanita senyum (mouthW kecil) → open/mw TINGGI konstan
            # → menang vs pria ngomong. fh stabil & terukur jelas.
            open_m = abs(rm_y - lm_y) / max(1.0, fh)
            cur.append(((x, y, fw, fh), open_m, (x + fw / 2) / w, cy_f))
    # Assign ke tracklet (greedy IoU > 0.4)
    used = set()
    for c in cur:
        best, bi = -1, -1
        for ti, tr in enumerate(tracks):
            if ti in used or not tr["boxes"]:
                continue
            v = iou(c[0], tr["boxes"][-1])
            if v > best:
                best, bi = v, ti
        if best > 0.4 and bi >= 0:
            tracks[bi]["boxes"].append(c[0])
            tracks[bi]["mouth"].append(c[1])
            tracks[bi]["t"].append(t)
            tracks[bi]["cx"].append(c[2])
            used.add(bi)
        else:
            tracks.append({"boxes": [c[0]], "mouth": [c[1]], "t": [t],
                           "cx": [c[2]], "cy": [c[3]]})

# Output PER-FRAME: utk tiap sample, wajah dgn rasio buka-mulut TERTINGGI.
# Ini jadi pengganti detectSpeakers (LLM): timeline siapa ngomong kapan.
# Agregat 1 angka utk seluruh window GA CUKUP — buildSpeakerPan butuh per-cue.
# Langkah 1: deteksi SEMUA wajah di SEMUA frame, kelompokkan via IoU tracklet
# (di atas). Hanya tracklet yang muncul di >=50% frame = WAJAH ASLI. False
# positive YuNet muncul 1-2 frame aja. Dari wajah-wajah asli ini, per-frame
# pilih yang buka-mulutnya paling tinggi.
persist = [(i, tr) for i, tr in enumerate(tracks)
           if len(tr["mouth"]) >= max(3, int(len(frames) * 0.5))]
if not persist:
    persist = list(enumerate(tracks))
# SPEAKER = VARIASI buka-mulut, BUKAN nilai absolute. Wanita tersenyum
# konstan = open TINGGI tapi stabil (range 0.034); pria ngomong = open
# berubah-ubah (range 0.071). YuNet landmark senyum dibaca open besar
# absolut → max-open memilih LISTENER (verified c2: wanita menang, padahal
# pria ngomong "gua kangen lagi"). Skor: range(open) / (mean+eps).
spk_score = {}
for ti, tr in persist:
    ms = tr["mouth"]
    if len(ms) < 3:
        spk_score[ti] = 0.0
    else:
        # SPEAKER = max buka-mulut (normalisasi fh). Orang ngomong buka mulut
        # PENUH di vokal (pria max 0.066); senyum konstan tak pernah buka
        # penuh (wanita max 0.047). Skor onset/range GAGAL: pria bukaan dasar
        # tinggi (mulut selalu setengah buka) → sedikit transisi; wanita senyum
        # kadang nutup → transisi palsu. Max fh-normalized = pembeda stabil.
        spk_score[ti] = max(ms)
# speaker dominan = tracklet dgn variasi terbesar (hanya 1 kamera per frame)
dom_track = max(spk_score, key=spk_score.get) if spk_score else -1
res = []
for i, tr in persist:  # urut muncul pertama
    pass
# Output PER-FRAME SEMUA WAJAH ASLI (BUKAN cuma 1 speaker dominan).
# User: "split cuma saat reaction/2 org tabrakan ngomong; 1 org ngomong =
# 1 frame aja". Untuk bedain, butuh open-mulut TIAP orang per frame, bukan
# cuma pemenang global. Ambil tracklet persisten, output semua cx.
res = []
for t, p in frames:
    im = cv2.imread(p)
    if im is None:
        continue
    h, w = im.shape[:2]
    det.setInputSize((w, h))
    _, faces = det.detect(im)
    if faces is None:
        continue
    row = []
    for f in faces[:max_faces]:
        x, y, fw, fh = int(f[0]), int(f[1]), int(f[2]), int(f[3])
        cy_f = (y + fh / 2) / h
        if cy_f > 0.62:
            continue
        rm_x, rm_y = f[10], f[11]
        lm_x, lm_y = f[12], f[13]
        open_m = abs(rm_y - lm_y) / max(1.0, fh)
        box = (x, y, fw, fh)
        keep = False
        for ti, tr in persist:
            for b in tr["boxes"]:
                if iou(box, b) > 0.4:
                    keep = True
                    break
            if keep:
                break
        if keep:
            row.append({"cx": round((x + fw / 2) / w, 4),
                        "cy": round(cy_f, 4),
                        "open": round(float(open_m), 4)})
    if row:
        res.append({"t": round(t, 2), "faces": row})
res.sort(key=lambda r: r["t"])
if outp:
    with open(outp, "w") as f:
        json.dump({"speakers": res}, f)
print(json.dumps({"speakers": res}))
