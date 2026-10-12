# scripts/face_frame.py — auto face-centered framing untuk 9:16
# Deteksi wajah (Haar cascade, ringan) per frame sample, hitung area wajah dominan,
# crop video agar wajah centered + di area "rule of thirds" atas (pas buat reels/shorts).
#
# Input: video_path, output_w, output_h, target_fps (sample)
# Output JSON: { ok, crop: { x, y, w, h }, face_found, confidence }
#
# ponytail: Haar cascade cepat tapi kurang akurat untuk wajah miring/samping.
#           Upgrade path: mediapipe face_detection (lebih akurat, tapi ~40MB dep).

import sys, os, json, subprocess

def ffprobe_duration(path):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip())
    except Exception:
        return None

def sample_frames(video_path, n=12, t_start=None, t_end=None):
    """Sample N frames sepanjang video via ffmpeg → numpy arrays.
    t_start/t_end: batasi sampling ke window clip (fix framing off-center)."""
    import cv2
    dur = ffprobe_duration(video_path)
    if not dur or dur <= 0:
        return []
    lo = t_start if t_start is not None else 0.0
    hi = t_end if t_end is not None else dur
    hi = min(hi, dur)
    if hi <= lo: hi = min(dur, lo + 1.0)
    span = hi - lo
    # bagi window jadi n segmen, ambil 1 frame per segmen
    times = [lo + span * (i + 0.5) / n for i in range(n)]
    frames = []
    for t in times:
        tmp = video_path + f".frame_{int(t*1000)}.png"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", video_path,
                 "-frames:v", "1", "-vf", "scale=1280:-1", tmp],
                capture_output=True, timeout=30)
            if os.path.exists(tmp):
                img = cv2.imread(tmp)
                if img is not None:
                    # rel = t ABSOLUT (bukan t/dur) — compute_crop pakai abs_t
                    # langsung buat deteksi shot segment & window subtitle.
                    frames.append((t, img))
        except Exception:
            pass
        finally:
            try: os.remove(tmp)
            except Exception: pass
    return frames

def detect_faces(frames):
    """Kumpillin box wajah dari semua sample frames (scale-aware).
    cv2 5.0: FaceDetectorYN (DNN, akurat).

    Return: (all_boxes, frame_face_counts)
      all_boxes: [{rel, cx, cy, rw, rh, frame_idx}]
      frame_face_counts: jumlah wajah per frame → deteksi multi-speaker
    """
    import cv2
    model_path = os.path.join(os.path.dirname(__file__), "..", "models", "face_detection_yunet_2023mar.onnx")
    det = None
    try:
        det = cv2.FaceDetectorYN_create(str(model_path), "", (320, 320), 0.6, 0.3, 5000)
    except Exception:
        det = None
    all_boxes = []
    frame_face_counts = []
    for fidx, (rel, img) in enumerate(frames):
        h, w = img.shape[:2]
        if det is not None:
            det.setInputSize((w, h))
            _, faces = det.detect(img)
            n_faces = 0
            if faces is not None:
                for f in faces:
                    x, y, fw, fh = int(f[0]), int(f[1]), int(f[2]), int(f[3])
                    if fw < 8 or fh < 8: continue
                    all_boxes.append({
                        "rel": rel,
                        "cx": (x + fw / 2) / w,
                        "cy": (y + fh / 2) / h,
                        "rw": fw / w,
                        "rh": fh / h,
                        "frame_idx": fidx,
                    })
                    n_faces += 1
            frame_face_counts.append(n_faces)
    return all_boxes, frame_face_counts

def compute_crop(boxes, src_w, src_h, out_w, out_h, multi_ratio=0.0):
    """Hitung crop window (di piksel source) agar wajah centered di area aman.

    Area aman: wajah di ~1/3 atas frame (mata sejajar garis rule-of-thirds),
    sesuai standar reels/tiktok/shorts biar ga ketutup UI.

    MULTI-FACE (2 atau 4 orang di 1 frame): center = TENGAH ANTAR SEMUA WAJAH
    (mean), bukan dominant. Zoom auto-fit: window melebar sampai semua wajah
    muat. User: "pas ditengah mereka, terus pas 4 orang pun ditengah mereka".
    """
    if not boxes:
        return None
    # MULTI-FACE: deteksi wajah-wajah di frame multi (bukan semua box sample beda frame).
    # Group cx jadi cluster posisi wajah — 2 atau 4 orang.
    # Orang yang lewat cuma muncul di 1-2 frame sample (12 total).
    # Speaker/tamu tetap muncul di hampir semua frame → filter min 25%.
    # cx adalah RASIO (0-1), jadi tol juga rasio. (bug: src_w*0.05 = 96px
    # selalu menelan semua box jadi 1 cluster.)
    tol = 0.05
    # FALSE POSITIVE filter: poster/foto dinding dikenali YuNet sebagai wajah
    # (video test: poster "ARI PRATAMA" di cx=0.76 deteksi 7/12 frame, bikin
    # n_people salah 2 -> crop kelebaran -> speaker keluar tengah).
    # Sinyal: wajah ASLI selalu bergerak (anggukan), poster diam sempurna.
    # ydev wajah asli 0.19 vs poster 0.012 (15x lebih statis).
    # Implementasi: cluster dulu (lihat bawah), lalu filter ydev per-cluster.
    from statistics import pstdev
    # Sample 24 frame (dari 12) — podcast multi-orang: 2 pembicara non-dominan
    # sering cuma muncul di beberapa frame; 12 sample terlalu jarang buat
    # dapat n_frames >= 50% (filter buang mereka = speaker-pan buntu).
    min_frames = max(2, int(len(set(b["frame_idx"] for b in boxes)) * 0.35))
    clusters = []  # [{cx_sum, cy_sum, rw_sum, n, n_frames, _fset}]
    # TIGHT tol: podcast 2 org berdampingan cx beda ~0.06-0.12. tol 0.06
    # = mereka nyatu jadi 1 cluster → split panel 1 wajah ga keliatan
    # (punggung kepala). 0.03 = minimal 2 orang duduk nempel.
    clusterTol = 0.03
    for b in boxes:
        placed = False
        for c in clusters:
            if abs(c["cx_sum"] / c["n"] - b["cx"]) <= clusterTol:
                c["cx_sum"] += b["cx"]; c["cy_sum"] += b["cy"]; c["n"] += 1
                c["rw_sum"] += b["rw"]; c["ys"].append(b["cy"])
                if b["frame_idx"] not in c["_fset"]:
                    c["_fset"].add(b["frame_idx"]); c["n_frames"] += 1
                placed = True; break
        if not placed:
            clusters.append({"cx_sum": b["cx"], "cy_sum": b["cy"], "n": 1, "rw_sum": b["rw"],
                             "n_frames": 1, "_fset": {b["frame_idx"]}, "ys": [b["cy"]]})
    # Buang cluster yang muncul < min_frames (orang lewat background).
    # c["n"] = jumlah BOX, c["n_frames"] = frame UNIK (1 box/orang/frame).
    # Orang lewat muncul 2-3 frame → n besar tapi n_frames kecil → dibuang.
    clusters = [c for c in clusters if c["n_frames"] >= min_frames] or clusters

    # COFRAME (user 2026-09-27 "orang yg sama di 2 panel"): split panel HARUS
    # ambil wajah yg SIMULTAN di 1 frame multi-org. Cluster global by cx bisa
    # nyatuin org beda (kamera cut ke shot lain, cx 0.36 lagi = org lain) atau
    # pecah org yg sama (kamera gerak). Cluster 0.50 = gabungan 2 org cx 0.36
    # & 0.63 → panel ORANG YANG SAMA.
    # FIX LANGSUNG: ambil cx wajah dari FRAME MULTI terbanyak, tanpa cluster.
    # cx di frame multi = org yg beneran bareng di shot itu.
    _multi_cx = None
    _multi_cy = None
    try:
        from collections import Counter, defaultdict
        multi_frames = defaultdict(list)
        for b in boxes:
            multi_frames[b["frame_idx"]].append((b["cx"], b["cy"]))
        sigs = []
        sigcycy = {}
        for fidx, cxs in multi_frames.items():
            if len(cxs) >= 2:
                s = tuple(sorted(round(c, 2) for c, _ in cxs[:4]))
                sigs.append(s)
                sigcycy[s] = [cy for _, cy in sorted(cxs[:4], key=lambda x: x[0])]
        if sigs:
            top_sig, top_n = Counter(sigs).most_common(1)[0]
            if top_n >= max(2, int(len(sigs) * 0.30)):
                _multi_cx = list(top_sig)
                _multi_cy = sigcycy.get(top_sig) or [0.4] * len(top_sig)
    except Exception:
        pass
    _split_pair = None
    # POSTER FALSE-POSITIVE: wajah asli selalu bergerak (ydev besar), poster
    # diam (ydev ~0.012). Hanya filter jika >1 cluster (jangan buang wajah
    # satu-satunya di video single-speaker).
    if len(clusters) > 1:
        ydevs = [pstdev(c["ys"]) for c in clusters if len(c["ys"]) >= 2]
        if ydevs and max(ydevs) > 0.03:
            # Wajah asli bergerak (ydev besar), poster diam (ydev ~0.012).
            # Cluster dengan ydev kecil DAN cukup sample = false-positive.
            # Cluster <2 sample (window pendek) ga bisa diukur -> keep.
            keep = [c for c in clusters
                    if len(c["ys"]) < 2 or pstdev(c["ys"]) > 0.03]
            clusters = keep or clusters
        # WINDOW SEMPIT (3-4 sample): cluster n_frames kecil = orang lewat/
        # poster di frame intro. Keep hanya yang paling sering muncul.
        if len(clusters) > 1 and min(len(set(b["frame_idx"] for b in boxes)) for _ in [0]) <= 4:
            mx = max(c["n_frames"] for c in clusters)
            clusters = [c for c in clusters if c["n_frames"] >= mx]
    # FALSE POSITIVE di area bawah (cy > 0.6): meja, mug, logo baju dikenali
    # YuNet sebagai wajah. Wajah asli podcast cy ~0.3-0.5. Video af5addb5:
    # cx=0.183 cy=0.825 (mug/meja) bikin n=3 -> window kelebaran -> speaker
    # keluar tengah. Filter cy pakai median cluster yang paling banyak n-nya.
    if len(clusters) > 1:
        ref_cy = max(clusters, key=lambda c: c["n_frames"])
        ref_cy = ref_cy["cy_sum"] / ref_cy["n"]
        keep = [c for c in clusters if abs((c["cy_sum"] / c["n"]) - ref_cy) <= 0.25]
        clusters = keep or clusters

    # MERGE cluster yang berdekatan: podcast 2-orang sering nemu 3-4 cluster
    # untuk orang yang sama (cx 0.759 vs 0.687 selisih 0.072) karena tol 0.05.
    # Merge pakai midpoint, bukan rerata bobot box.
    if len(clusters) >= 2:
        merged = []
        for c in sorted(clusters, key=lambda c: c["cx_sum"] / c["n"]):
            cs = [c]
            for m in merged:
                mcs = [x["cx_sum"] / x["n"] for x in cs]
                if abs((sum(mcs) / len(mcs)) - m["cx_sum"] / m["n"]) <= tol:
                    for x in cs:
                        m["cx_sum"] += x["cx_sum"]; m["cy_sum"] += x["cy_sum"]
                        m["rw_sum"] += x["rw_sum"]; m["n"] += x["n"]
                    cs = []
                    break
            if cs:
                merged.extend(cs)
        clusters = merged or clusters
    n_people = len(clusters)
    import os as _os
    if _os.environ.get("FFC_DEBUG"):
        for c in clusters:
            print("CLUSTER cx=%.3f cy=%.3f n=%d nfr=%d ydev=%.4f rw=%.4f" % (
                c["cx_sum"] / c["n"], c["cy_sum"] / c["n"], c["n"], c["n_frames"],
                pstdev(c["ys"]) if len(c["ys"]) >= 2 else -1,
                c["rw_sum"] / c["n"]), flush=True)

    # Center = mean semua cluster (TENGAH antar wajah).
    fcx = sum(c["cx_sum"] for c in clusters) / sum(c["n"] for c in clusters)
    fcy = sum(c["cy_sum"] for c in clusters) / sum(c["n"] for c in clusters)
    avg_w = sum(c["rw_sum"] for c in clusters) / sum(c["n"] for c in clusters)

    # --- WINDOW: rasio aspek output WAJIB dijaga (9:16 = 0.5625).
    # Bug lama: ch_zoom di-clamp ke src_h tapi cw_zoom tidak -> crop 1215x1080
    # (rasio salah) -> ffmpeg scale decrease -> BAR HITAM TEBAL (user complaint).
    aspect_out = out_w / out_h  # 0.5625 untuk 9:16
    if src_w / src_h > aspect_out:
        ch = src_h
        cw = ch * aspect_out
    else:
        cw = src_w
        ch = cw / aspect_out

    # MULTI-FACE: window harus muat SEMUA wajah + margin aman biar ga kepotong.
    # User: "yang satu keliatan pundaknya doang itu jangan, yang penting mukanya
    # keliatan dua-duanya".
    if n_people >= 2:
        xs = [c["cx_sum"] / c["n"] for c in clusters]
        left, right = min(xs), max(xs)
        # midpoint TENGAH-nya (bukan mean — mean miring kalau satu orang
        # punya lebih banyak box deteksi).
        fcx = (left + right) / 2
        span = (right - left) * src_w
        # margin: lebar wajah + 60% padding tiap sisi biar muka ga di pinggir
        avg_rw_px = avg_w * src_w
        need_w = span + 2 * (avg_rw_px * 0.6)
        need_w = max(need_w, cw)
        # tinggi mengikuti lebar dengan rasio TEPAT
        need_h = need_w / aspect_out
        if need_h > src_h:
            need_h = src_h
            need_w = need_h * aspect_out  # rasio jaga, lebar ikut tinggi
        # CLAMP GAGAL: max lebar 9:16 fisik = src_h * aspect_out (1080*0.5625
        # = 607.5px). Kalau span 2 wajah + margin > itu = DUA WAJAH GA MUAT
        # (video af5addb5: span 609px > 607.5). Daripada salah satu kepotong
        # -> single speaker (paling sering muncul = pembicara dominan window).
        # ALL speakers disimpan dulu (buat speaker-pan di processor.js) —
        # jangan di overwrite sama fallback.
        all_speakers = [
            {"cx": round(c["cx_sum"] / c["n"], 4), "cy": round(c["cy_sum"] / c["n"], 4),
             "n_frames": c["n_frames"]}
            for c in sorted(clusters, key=lambda c: c["cx_sum"] / c["n"])]
        max_w = src_h * aspect_out
        min_need = span + 2 * (avg_rw_px * 0.6)
        if min_need > max_w:
            # 2 wajah ga muat fisik 9:16 (span 609px+margin > 607.5px max).
            # JANGAN reset n_people (split layout butuh) & TANDAI
            # faces_fit=False -> processor.js WAJIB auto-layout lock per wajah,
            # bukan pan ke 1 pembicara (yg bikin org lain setengah badan).
            spk = max(clusters, key=lambda c: c["n_frames"])
            fcx = spk["cx_sum"] / spk["n"]
            n_people = max(2, len(clusters))
            faces_fit = False
            zoom = max(1.0, min(1.8, 0.28 / (avg_w * src_w / cw))) if avg_w > 0.02 else 1.0
            cw_zoom, ch_zoom = cw, ch
        else:
            cw_zoom, ch_zoom = need_w, need_h
            zoom = cw / cw_zoom
            faces_fit = True
    else:
        # single: zoom in kalau wajah kecil di window dasar
        face_in_window = avg_w * src_w / cw
        target_face_ratio = 0.28
        zoom = 1.0
        if avg_w > 0.02 and face_in_window > target_face_ratio:
            zoom = target_face_ratio / face_in_window
        zoom = min(zoom, 1.8)
        # zoom < 1 (zoom OUT) melebihi window dasar -> ch_zoom bisa > src_h
        # -> ffmpeg "Invalid too big size for height" (8/10 clip render gagal).
        # Clamp: window maksimal = window dasar (zoom out maksimal 1.0).
        zoom = max(zoom, 1.0)
        cw_zoom, ch_zoom = cw, ch

    # posisi: wajah center-X, vertical ~38-42% dari atas (rule of thirds)
    target_face_y = 0.42 if n_people >= 2 else 0.38
    # SAFE MARGIN: wajah ga boleh terlalu pinggir — kalau orang lain (off-frame
    # YuNet) masuk separuh, atau backdrop kosong, crop ke tengah-area aman.
    # Clamp fcx ke [0.12, 0.88] biar ada ruang di kedua sisi (user: frame
    # "kurang centered" saat speaker duduk di pinggir source).
    fcx = max(0.12, min(0.88, fcx))
    x = fcx * src_w - cw_zoom / 2
    y = fcy * src_h - ch_zoom * target_face_y
    x = max(0, min(x, src_w - cw_zoom))
    y = max(0, min(y, src_h - ch_zoom))

    dom = max(clusters, key=lambda c: c["n"])
    dom_cx, dom_cy, dom_rw = dom["cx_sum"]/dom["n"], dom["cy_sum"]/dom["n"], dom["rw_sum"]/dom["n"]

    # all_speakers = semua cluster (sebelum fallback single-speaker), buat
    # speaker-pan di processor.js. n_people>=2 set all_speakers di bawah;
    # single-speaker murni = 1 cluster doang.
    # COFRAME FILTER: cluster global by cx bisa org sama/gabung org beda.
    # _multi_cx = cx wajah dari FRAME MULTI tersering = org beneran bareng.
    if _multi_cx is not None and len(_multi_cx) >= 2:
        cys = _multi_cy or [0.4] * len(_multi_cx)
        all_speakers = [
            {"cx": round(_multi_cx[i], 4), "cy": round(cys[i], 4), "n_frames": 5}
            for i in range(min(4, len(_multi_cx)))
        ]
    elif "all_speakers" not in locals():
        all_speakers = [
            {"cx": round(c["cx_sum"] / c["n"], 4), "cy": round(c["cy_sum"] / c["n"], 4),
             "n_frames": c["n_frames"]}
            for c in sorted(clusters, key=lambda c: c["cx_sum"] / c["n"])]
    # SHOT SEGMENTS: clip multi-shot (cut kamera) butuh layout PER SHOT —
    # shot solo = static crop 1 wajah, shot multi = split panel. Tanpa ini,
    # split diterapkan ke shot solo = ORANG YANG SAMA 2 panel (user 2026-09-27).
    shots_out = []
    try:
        # t absolut tiap sample: rel * (t_end - t_start) + t_start
        # (compute_crop tau t_start/t_end? tidak — dihitung di caller & di-
        # pass via boxes["abs_t"] di main().)
        fts = sorted(set(b.get("abs_t", 0) for b in boxes))
        if len(fts) >= 2:
            # status multi per sample timestamp
            ts_sorted = sorted(fts)
            step = (ts_sorted[-1] - ts_sorted[0]) / max(1, len(ts_sorted) - 1)
            multi_by_t = {}
            for t in ts_sorted:
                nb = [b for b in boxes if abs(b.get("abs_t", 0) - t) < 0.01]
                multi_by_t[t] = len(set(b["frame_idx"] for b in nb)) and \
                    all(sum(1 for b in nb if b["frame_idx"] == f) >= 2
                        for f in set(b["frame_idx"] for b in nb))
            # gabung sample berurutan dgn status SAMA jadi segmen (extend
            # tiap sample sampai tengah ke sample berikutnya).
            segs, s0 = [], ts_sorted[0] - step / 2
            cur = multi_by_t[ts_sorted[0]]
            for i in range(1, len(ts_sorted)):
                if multi_by_t[ts_sorted[i]] != cur:
                    segs.append([s0, ts_sorted[i] - step / 2, cur])
                    s0 = ts_sorted[i] - step / 2
                    cur = multi_by_t[ts_sorted[i]]
            segs.append([s0, ts_sorted[-1] + step / 2, cur])
            for lo, hi, is_multi in segs:
                nf = [b for b in boxes if lo <= b.get("abs_t", 0) <= hi]
                nmulti = sum(1 for fidx in set(b["frame_idx"] for b in nf)
                             if sum(1 for b in nf if b["frame_idx"] == fidx) >= 2)
                ntot = len(set(b["frame_idx"] for b in nf))
                shots_out.append({
                    "start": round(lo, 2), "end": round(hi, 2),
                    "multi": bool(is_multi),
                    "multi_ratio": round(nmulti / max(1, ntot), 2),
                })
    except Exception:
        pass

    return {
        "x": round(x, 1), "y": round(y, 1),
        "w": round(cw_zoom, 1), "h": round(ch_zoom, 1),
        "face_cx": round(fcx, 4), "face_cy": round(fcy, 4),
        "face_w_ratio": round(dom_rw, 4),
        "faces_fit": faces_fit if "faces_fit" in locals() else True,
        "multi_ratio": round(multi_ratio, 3) if "multi_ratio" in locals() else 0.0,
        "zoom": round(zoom, 2),
        "n_people": n_people,
        "speakers": all_speakers,
        "shots": shots_out,
    }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: face_frame.py <video> [out_w] [out_h] [t_start] [t_end]"}))
        sys.exit(1)
    video = sys.argv[1]
    out_w = int(sys.argv[2]) if len(sys.argv) > 2 else 1080
    out_h = int(sys.argv[3]) if len(sys.argv) > 3 else 1920
    t_start = float(sys.argv[4]) if len(sys.argv) > 4 else None
    t_end = float(sys.argv[5]) if len(sys.argv) > 5 else None
    if not os.path.exists(video):
        print(json.dumps({"ok": False, "error": "video not found: " + video}))
        sys.exit(1)

    import cv2
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "cannot open video"}))
        sys.exit(1)
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    frames = sample_frames(video, n=12, t_start=t_start, t_end=t_end)
    if not frames:
        print(json.dumps({"ok": False, "error": "cannot sample frames"}))
        sys.exit(1)

    boxes, face_counts = detect_faces(frames)
    if not boxes:
        print(json.dumps({
            "ok": True, "face_found": False,
            "src": {"w": src_w, "h": src_h},
            "crop": None,
            "note": "no face detected — fallback ke center-crop default",
        }))
        sys.exit(0)

    # abs_t tiap sample: sample_frames skrg return t ABSOLUT langsung.
    for b in boxes:
        b["abs_t"] = b["rel"]

    # MULTI-SPEAKER / REACTION detection: ada 2+ wajah di sebagian frame.
    # >=60% = podcast/interview (dua-duanya di-frame sepanjang waktu).
    # >=40% = REACTION: tamu/wajah kedua muncul dominan (tertawa/kaget/expresif).
    # <40% = orang lewat di background / cutaway sebentar — bukan speaker, abaikan.
    # User: "split hanya ketika video ada objek orang banyak atau banyak reaction ekspresi"
    multi = sum(1 for n in face_counts if n >= 2)
    multi_ratio = multi / max(1, len(face_counts))

    # SHOT-SEGMENTED split (user 2026-09-27: "split dipake ketika menampilkan
    # orang banyak yang ga cukup kelihatin; 1 orang fokus ngomong = tampilin
    # dia aja"). Clip multi-SHOT (cut kamera 8x di 50s): shot-1 solo 0-7s,
    # shot-2+ 2 org. multi_ratio global = 0.78 → split SEMUA clip = shot solo
    # ikut di-split = ORANG YANG SAMA 2 panel (BUG).
    # FIX: deteksi SHOT BOUNDARY via frame-diff (MSE antar sample frame;
    # frames udah di memori, murah). Hitung multi_ratio PER SHOT, split cuma
    # kalau mayoritas DURASI beneran multi-org.
    import math
    shot_multi_ratio = multi_ratio
    try:
        # MSE antar frame berurutan; cut kamera = lompatan besar.
        difs = []
        for i in range(1, len(frames)):
            a = frames[i - 1][1]; b = frames[i][1]
            if a.shape != b.shape:
                b2 = cv2.resize(b, (a.shape[1], a.shape[0]))
            else:
                b2 = b
            difs.append(float(np.mean((a.astype(np.float32)
                                       - b2.astype(np.float32)) ** 2)))
        if difs:
            # Cut = MSE > 3x median (cut kamera = lompatan seluruh frame).
            med = sorted(difs)[len(difs) // 2]
            cut_thr = max(200.0, 3.0 * med)
            # Bagi sample jadi shot: frame setelah cut mulai shot baru.
            shots, cur = [0], 0
            for i, d in enumerate(difs):
                if d > cut_thr:
                    cur = i + 1
                    shots.append(cur)
            shots.append(len(frames))
            # multi_ratio per shot, jumlahkan frame di shot yg multi-org.
            n_multi_frames = 0
            for si in range(len(shots) - 1):
                lo, hi = shots[si], shots[si + 1]
                n_in = hi - lo
                if n_in <= 0:
                    continue
                m = sum(1 for j in range(lo, hi) if face_counts[j] >= 2)
                if m / n_in >= 0.5:
                    n_multi_frames += n_in
            shot_multi_ratio = n_multi_frames / max(1, len(frames))
    except Exception:
        pass
    multi_ratio = shot_multi_ratio
    if multi_ratio >= 0.40:
        crop = compute_crop(boxes, src_w, src_h, out_w, out_h, multi_ratio)
        if crop:
            crop["multi_speaker"] = True
            crop["zoom"] = 1.0
        # GUEST box: wajah KEDUA (paling jauh dari wajah utama) di frame multi.
        # Untuk split-screen kanan: crop ke tamu, BUKAN full-frame (yang ternyata
        # tetap menampilkan pembicara utama doang).
        guest_box = None
        dom_cx = crop.get("face_cx", 0.5) if crop else 0.5
        far = [b for b in boxes if b.get("frame_idx") is not None
               and face_counts[b["frame_idx"]] >= 2]
        if far:
            guest_box = max(far, key=lambda b: abs(b["cx"] - dom_cx))
        print(json.dumps({
            "ok": True, "face_found": True,
            "face_count": len(boxes),
            "multi_speaker": True,
            "src": {"w": src_w, "h": src_h},
            "crop": crop,
            # FIX user: "harus bisa split screen kalo kamera nampilkan keseluruhan,
            # fokus utama tetep si orang yang menghasilkan suara"
            "split_screen": True,
            "guest": ({
                "cx": round(guest_box["cx"], 4), "cy": round(guest_box["cy"], 4),
                "rw": round(guest_box["rw"], 4), "rh": round(guest_box["rh"], 4),
            } if guest_box else None),
        }))
        sys.exit(0)

    crop = compute_crop(boxes, src_w, src_h, out_w, out_h, multi_ratio)
    print(json.dumps({
        "ok": True, "face_found": True,
        "face_count": len(boxes),
        "src": {"w": src_w, "h": src_h},
        "crop": crop,
    }))

if __name__ == "__main__":
    main()
