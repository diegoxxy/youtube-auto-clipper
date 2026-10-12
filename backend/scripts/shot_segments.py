#!/usr/bin/env python3
"""shot_segments.py — pecah window clip jadi segmen shot, hitung wajah per segmen.

Problem: multi_ratio dihitung di SELURUH window → split diterapkan ke semua
clip, termasuk segmen solo close-up (user: "dari awal udah split padahal 1
orang lagi fokus ngomong"). Podcast sering cut: solo close-up ↔ wide 2-shot.
Solusi: deteksi shot boundary (ffmpeg scene detect), hitung wajah per segmen,
output multi status per segmen. processor.js pilih split cuma kalau SEGMENT
multi-orang (bukan clip global).

Args: video start end out.json [scene_thr] [maxfaces]
Output: {"segments":[{"start":t,"end":t,"faces":n,"cx":[...]}]}
"""
import sys, os, json, subprocess

try:
    import cv2
except Exception as e:
    print(json.dumps({"error": "no cv2: %s" % e})); sys.exit(0)

video = sys.argv[1]
start = float(sys.argv[2])
end = float(sys.argv[3])
outp = sys.argv[4] if len(sys.argv) > 4 else ""
scene_thr = sys.argv[5] if len(sys.argv) > 5 else "0.25"
FF = os.environ.get("FFMPEG_BIN") or "ffmpeg"

if not os.path.exists(video):
    print(json.dumps({"error": "no video"})); sys.exit(0)

dur = max(1.0, end - start)
model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models",
                     "face_detection_yunet_2023mar.onnx")

# 1. Shot boundaries via ffmpeg scene detect (windowed — full video terlalu lambat).
tmp = os.environ.get("TEMP") or "/tmp"
cuts = [start]
try:
    r = subprocess.run([FF, "-y", "-ss", "%.3f" % start, "-i", video,
                        "-t", "%.3f" % dur,
                        "-vf", "select='gt(scene,%s)',showinfo" % scene_thr,
                        "-f", "null", "-"],
                       capture_output=True, timeout=180)
    for line in (r.stderr or b"").decode("utf-8", "ignore").split("\n"):
        if "pts_time:" in line:
            try:
                cuts.append(start + float(line.split("pts_time:")[1].split()[0]))
            except Exception:
                pass
except Exception:
    pass
cuts.append(end)
# merge cut < 0.6s (sub-0.6 = flicker/transisi). Cut 0.6s+ SUNGGUH.
# YuNet detek cx~0.50 di frame ini = sampah. (sub-1s = flicker). DULU 2.5s terlalu agresif: cut kamera 1-2s itu SUNGGUH (c2 279b5746: 133.5->134.6 = 1.1s wide->hoodie close-up) -> merge -> close-up hoodie detek 2 wajah = false positive.
merged = [cuts[0]]
for c in cuts[1:]:
    if c - merged[-1] >= 0.6:
        merged.append(c)
merged[-1] = end
if len(merged) < 2:
    merged = [start, end]

# 2. Hitung wajah di tengah tiap segmen. MULTI-SAMPLE (3 titik: 25/50/75%)
# — 1 sample @30% bikin cx meleset saat orang bergerak dalem segmen panjang
# (job 4cea54e3 c3 pv0: cx 0.527 @30% tapi wajah drift 0.477 → crop kanan,
# output x=0.25 "orang ga tengah"). Median 3 sample = posisi stabil.
det = cv2.FaceDetectorYN_create(str(model), "", (480, 480), 0.6, 0.3, 5000)
segs = []
for i in range(len(merged) - 1):
    s0, s1 = merged[i], merged[i + 1]
    faces_n = 0
    cxs = []
    # sample 3 titik (segmen pendek) atau 5 titik (segmen >= 6s, wajah drift)
    nfr = 5 if (s1 - s0) >= 6.0 else 3
    for k in range(nfr):
        frac = (k + 1) / (nfr + 1)
        t = s0 + (s1 - s0) * frac
        p = os.path.join(tmp, "ss_%d.png" % int(t * 100))
        subprocess.run([FF, "-y", "-ss", "%.3f" % t, "-i", video,
                        "-frames:v", "1", "-vf", "scale=480:-2", p],
                       capture_output=True)
        im = cv2.imread(p)
        if im is not None:
            h, w = im.shape[:2]
            det.setInputSize((w, h))
            _, f = det.detect(im)
            if f is not None:
                for r in f[:4]:
                    x, y, fw, fh = r[:4]
                    if (y + fh / 2) / h > 0.62:
                        continue
                    faces_n = max(faces_n, len([rr for rr in f[:4]
                                if (rr[1] + rr[3] / 2) / h <= 0.62]))
                    cxs.append(round(float((x + fw / 2) / w), 3))
        try:
            os.unlink(p)
        except Exception:
            pass
    # median cx = posisi stabil (bukan rata-rata: outlier YuNet tarik).
    # SOLO: median 1 titik. MULTI: simpen SEMUA cx unik (split panel butuh
    # posisi tiap orang — median tunggal buang orang lain!).
    # TRACK: simpen cx per sample (URUT WAKTU 25/50/75%, bukan sorted-by-cx)
    # buat tracking kamera dalam segmen (wajah drift di segmen panjang).
    track_cx = [round(c, 3) for c in cxs] if len(cxs) >= 4 else None
    cxs_all = sorted(set(cxs))
    if not cxs_all:
        cxs = []
        faces_n = 0
    elif faces_n >= 2:
        # cluster cx deket (tol 0.10) = org sama sample beda titik → 1 nilai
        groups = []
        for c in cxs_all:
            if groups and c - groups[-1][-1] <= 0.10:
                groups[-1].append(c)
            else:
                groups.append([c])
        cxs = [sorted(g)[len(g) // 2] for g in groups]
        faces_n = len(cxs)
    else:
        cxs = [cxs_all[len(cxs_all) // 2]]
    faces_n = min(faces_n, 4)
    # 3. SPEAKER COUNT: buka-mulut per wajah (YuNet landmark). Segment multi
    # tapi cuma 1 org ngomong (listener diem) = single crop ke pembicara,
    # BUKAN split (user: "1 org fokus ngomong ya tampilin dianya aja").
    # Split cuma kalau 2+ org aktif bicara/reaksi (bergantian atau rebutan).
    speaker_count = 1
    spk_cx = [cxs[0]] if cxs else []
    if faces_n >= 2 and im is not None:
        open_by_cx = {}
        for k, frac in enumerate((0.33, 0.67)):
            tk = s0 + (s1 - s0) * frac
            pk = os.path.join(tmp, "sm_%d.png" % int(tk * 100))
            subprocess.run([FF, "-y", "-ss", "%.3f" % tk, "-i", video,
                            "-frames:v", "1", "-vf", "scale=480:-2", pk],
                           capture_output=True)
            ik = cv2.imread(pk)
            try:
                os.unlink(pk)
            except Exception:
                pass
            if ik is None:
                continue
            hk, wk = ik.shape[:2]
            det.setInputSize((wk, hk))
            _, fk = det.detect(ik)
            if fk is None:
                continue
            for rk in fk[:4]:
                lm = rk[4:14] if len(rk) >= 14 else None
                if lm is None:
                    continue
                # landmark YuNet 15-col: rm=10-11, lm=12-13 (x,y pairs)
                rmy = float(lm[5]); lmy = float(lm[7])
                fhk = float(rk[3])
                cxk = round(float((rk[0] + rk[2] / 2) / wk), 3)
                op = abs(rmy - lmy) / max(1.0, fhk)
                open_by_cx.setdefault(cxk, []).append(op)
        if open_by_cx:
            # CLUSTER cx dulu (tol 0.08): kamera/wajah gerak sedikit = cx
            # beda 0.01-0.04 = ORANG YANG SAMA. Tanpa ini n_speaker=4 padahal
            # cuma 2 org (pria cx 0.336/0.356/0.369 dibilang 3 org).
            cxs_sorted = sorted(open_by_cx)
            groups = []
            for c in cxs_sorted:
                if groups and c - groups[-1][-1] < 0.08:
                    groups[-1].append(c)
                else:
                    groups.append([c])
            cl_avg = {}
            cl_rep = {}
            for g in groups:
                vals = [v for c in g for v in open_by_cx[c]]
                m = sum(vals) / len(vals)
                rep = min(g, key=lambda c: abs(sum(open_by_cx[c]) / len(open_by_cx[c]) - m))
                cl_avg[rep] = m
                cl_rep[rep] = rep
            # rata buka-mulut per wajah (clustered), > 0.015 = aktif bicara
            act = [c for c, v in cl_avg.items() if v > 0.015]
            if len(act) >= 2:
                speaker_count = len(act)
                spk_cx = sorted(act)
            else:
                # 1 pembicara dominan → cx pembicara
                best = max(cl_avg, key=cl_avg.get)
                speaker_count = 1
                spk_cx = [best]
    segs.append({"start": round(s0, 2), "end": round(s1, 2),
                 "faces": faces_n, "cx": cxs,
                 "n_speaker": speaker_count, "spk_cx": spk_cx,
                 "track_cx": track_cx})

if outp:
    with open(outp, "w") as f:
        json.dump({"segments": segs}, f)
print(json.dumps({"segments": segs}))
