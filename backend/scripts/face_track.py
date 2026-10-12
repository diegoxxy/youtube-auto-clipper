#!/usr/bin/env python3
"""
Dynamic face tracking → ffmpeg sendcmd file.
Port dari mehbul/chopify render_clips.py (MIT): detect_track + smooth_track + build_sendcmd.

Cara kerja:
1. Extract low-res preview clip (5fps, 320px) dari window source.
2. Deteksi wajah per-frame pakai YuNet ONNX (fallback Haar untuk cv2 lama).
3. Smooth: EMA low-pass + deadzone + jump detection (snap pas cut kamera).
4. Tulis file ffmpeg sendcmd: "t crop x N;" — crop x berubah per timestamp.

Output: file .txt berisi command list untuk filter ffmpeg sendcmd.

Pemakaian:
  python face_track.py <video> <start_sec> <dur_sec> <out_w> <out_h> <out_cmd.txt> [--fps 5] [--det-w 320]
"""

import argparse
import os
import subprocess
import sys

import cv2

DEFAULT_FPS = 8           # ponytail: 3fps bikin snap kasar; 8fps = mulus, detect tetap cepat (240px)
DEFAULT_DET_W = 320       # 240px bikin YuNet miss banyak (9/45 detect); 320px = 62/75 detect
EMA_ALPHA = 0.18          # smoothing strength: kecil = halus, gede = responsif
MARGIN_FRAC = 0.10        # deadzone: wajah boleh gerak 10% crop width sebelum camera follow
JUMP_FRAC = 0.35          # loncatan > 35% width = cut kamera → snap langsung

YUNET_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)


def make_detector(workdir, det_w, det_h):
    model = os.path.join(workdir, "face_detection_yunet_2023mar.onnx")
    if not os.path.exists(model):
        try:
            import urllib.request
            urllib.request.urlretrieve(YUNET_URL, model)
        except Exception as e:
            print(f"[face_track] YuNet download gagal: {e}", file=sys.stderr)
    if os.path.exists(model):
        try:
            # score_threshold 0.75 (default 0.6) — reject false-positive di background musik video
            det = cv2.FaceDetectorYN.create(model, "", (det_w, det_h), 0.75, 0.3, 5000)
            return "yunet", det
        except Exception as e:
            print(f"[face_track] YuNet init gagal: {e}", file=sys.stderr)
    # fallback: Haar (cv2 < 5 atau model gagal)
    try:
        return "haar", cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
    except Exception as e:
        print(f"[face_track] Haar init gagal: {e}", file=sys.stderr)
        return "none", None


def detect_faces(det, kind, frame_bgr):
    """Return list of (cx, cy, w, h, score) di koordinat frame deteksi."""
    if kind == "yunet":
        ok, faces = det.detect(frame_bgr)
        if not ok or faces is None:
            return []
        out = []
        for f in faces:
            x, y, w, h = float(f[0]), float(f[1]), float(f[2]), float(f[3])
            score = float(f[14]) if len(f) > 14 else 1.0
            out.append((x + w / 2.0, y + h / 2.0, w, h, score))
        return out
    if kind == "haar":
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        faces = det.detectMultiScale(gray, 1.1, 5, minSize=(36, 36))
        return [(x + w / 2.0, y + h / 2.0, float(w), float(h), 1.0)
                for (x, y, w, h) in faces]
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="path video source")
    ap.add_argument("start", type=float, help="start detik (source time)")
    ap.add_argument("dur", type=float, help="durasi detik")
    ap.add_argument("out_w", type=int, help="output width px (1080)")
    ap.add_argument("out_h", type=int, help="output height px (1920)")
    ap.add_argument("outcmd", help="path output sendcmd .txt")
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS)
    ap.add_argument("--det-w", type=int, default=DEFAULT_DET_W)
    args = ap.parse_args()

    video = args.video
    if not os.path.exists(video):
        print(json_dump({"ok": False, "error": "video not found"}))
        sys.exit(1)

    workdir = os.path.dirname(os.path.abspath(video)) or "."
    tmp = os.path.join(workdir, f"_track_{os.getpid()}.mp4")

    # 1. extract low-res silent preview
    subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{args.start:.3f}", "-i", video,
         "-t", f"{args.dur:.3f}",
         "-vf", f"fps={args.fps},scale={args.det_w}:-2",
         "-an", tmp],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    cap = cv2.VideoCapture(tmp)
    dw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or args.det_w)
    dh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    src_w = get_video_w(video)

    kind, det = make_detector(workdir, dw, dh)

    # crop window di koordinat SOURCE (bukan deteksi low-res)
    aspect = args.out_w / float(args.out_h)
    if src_w / get_video_h(video) > aspect:
        ch_src = get_video_h(video)
        cw_src = ch_src * aspect
    else:
        cw_src = float(src_w)
        ch_src = cw_src / aspect

    sx = src_w / float(dw)  # scale low-res → source

    track = []  # [(t_rel, cx_source or None)]
    # SPEAKER DETECTION via motion: orang yang bicara bergerak (kepala/bibir),
    # pendengar diam. Track posisi tiap wajah, pilih yang paling banyak bergerak.
    face_history = {}  # id wajah → [posisi terakhir] → hitung motion
    face_motion = {}   # id wajah → total motion (EWM)
    face_last_pos = {} # id wajah → (x, y) frame sebelumnya
    next_id = 0
    speaker_id = None  # id wajah yang dianggap pembicara utama
    i = 0
    # zona diam kamera: kamera hanya snap kalau pembicara pindah >8% crop width.
    # wajah bergerak kecil saat bicara = wajar, kamera harus menahan (fix goyang)
    cam_locked_x = None
    cam_lock_zone = (src_w * 0.5625) * 0.08 if src_w else 50  # 8% crop width

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = i / float(args.fps)
        faces = detect_faces(det, kind, frame)
        cx = None
        if faces:
            if len(faces) > 1:
                # MULTI-SPEAKER: assign id per wajah (matching posisi terdekat),
                # hitung motion masing-masing, kunci wajah paling aktif = pembicara.
                matched = {}  # face idx → history id
                used = set()
                for fidx, f in enumerate(faces):
                    # cari history id dengan posisi terdekat (simple data association)
                    best_id, best_d = None, 1e9
                    for hid, (hx, hy) in face_last_pos.items():
                        if hid in used: continue
                        d = (f[0] - hx) ** 2 + (f[1] - hy) ** 2
                        if d < best_d: best_d, best_id = d, hid
                    # wajah baru kalau jauh semua (>120px low-res = wajah beda)
                    if best_id is None or best_d > 120 ** 2:
                        best_id = next_id; next_id += 1
                    matched[fidx] = best_id
                    used.add(best_id)
                    # update motion
                    if best_id in face_last_pos:
                        m = ((f[0] - face_last_pos[best_id][0]) ** 2 +
                             (f[1] - face_last_pos[best_id][1]) ** 2) ** 0.5
                        face_motion[best_id] = face_motion.get(best_id, 0) * 0.85 + m
                    face_last_pos[best_id] = (f[0], f[1])
                # pilih pembicara: motion tertinggi (tapi stabilkan — butuh beberapa frame)
                if len(face_motion) >= 2:
                    best_sid = max(face_motion, key=lambda k: face_motion[k])
                    if speaker_id is None or face_motion.get(speaker_id, 0) * 1.5 < face_motion[best_sid]:
                        speaker_id = best_sid
                if speaker_id is not None and speaker_id in matched.values():
                    pick = [i for i, hid in matched.items() if hid == speaker_id][0]
                    best = faces[pick]
                else:
                    best = max(faces, key=lambda f: f[2] * f[3] * f[4])
            else:
                best = max(faces, key=lambda f: f[2] * f[3] * f[4])
                speaker_id = None  # single face → reset
            cx = best[0] * sx
        # HYSTERESIS kamera: kamera DIAM selama pembicara di dalam zona aman
        # (fix "gerak-gerak sendiri" — wajah bicara itu bergerak kecil-kecil,
        # kamera harus menahan, bukan goyang)
        if cx is not None:
            if cam_locked_x is None or abs(cx - cam_locked_x) > cam_lock_zone:
                cam_locked_x = cx  # keluar zona → snap ke posisi baru
            cx = cam_locked_x
        track.append((t, cx))
        i += 1
    cap.release()

    # cleanup tmp
    try:
        os.remove(tmp)
    except OSError:
        pass

    # 2. smooth: fill gap → EMA → deadzone → jump snap
    known = [c for _, c in track if c is not None]
    base = sorted(known)[len(known) // 2] if known else src_w / 2.0
    # ponytail: kalau subjek berpindah terlalu jauh (variance tinggi, mis. video musik banyak orang),
    # dynamic tracking ga cocok → fallback ke static center. Threshold: std > 25% src width.
    if known:
        _mean = sum(known) / len(known)
        _var = sum((c - _mean) ** 2 for c in known if c is not None) / len(known)
        _std = _var ** 0.5
        if _std > src_w * 0.25:
            print(json_dump({"ok": False, "fallback_static": True,
                             "reason": f"variance tinggi (std={_std:.0f}px), subjek pindah jauh"}))
            sys.exit(0)
    # YuNet sering false-positive di background; ini bikin jump detection ga salah snap
    _t_list = [t for t, _ in track]
    _c_list = [c for _, c in track]
    _known_med = sorted([c for c in _c_list if c is not None])
    _med = _known_med[len(_known_med) // 2] if _known_med else src_w / 2.0
    cleaned = []
    for t, c in track:
        if c is not None and abs(c - _med) > src_w * 0.6:
            c = None  # kemungkinan false positive
        cleaned.append((t, c))
    track = cleaned

    # fill missed detections dengan median dari window sekitar (bukan last value — anti jump palsu)
    known_times = [t for t, c in track if c is not None]
    known_cx = [c for t, c in track if c is not None]
    filled = []
    for i, (t, c) in enumerate(track):
        if c is None:
            # ambil median dari 3 deteksi terdekat (sebelum & sesudah)
            near = sorted(zip(known_times, known_cx), key=lambda kc: abs(kc[0] - t))[:3]
            c = sorted(near, key=lambda kc: kc[1])[len(near) // 2][1] if near else (src_w / 2.0)
        filled.append((t, c))

    if not filled:
        filled = [(0.0, src_w / 2.0)]

    crop_w = cw_src
    half = crop_w / 2.0
    max_off = half - crop_w * MARGIN_FRAC
    jump = src_w * JUMP_FRAC

    # KAMERA LANGSUNG DI MUKA: snap ke posisi wajah tiap frame (no EMA drift, no deadzone)
    # Jitter suppression: median dari ±4 frame window → buang deteksi noise, tapi tetap responsif
    out = []
    W = 4
    for i, (t, face) in enumerate(filled):
        lo = max(0, i - W); hi = min(len(filled), i + W + 1)
        window = [filled[j][1] for j in range(lo, hi)]
        cx = sorted(window)[len(window) // 2]
        x = min(max(cx, half), src_w - half)
        out.append((t, x))

    # 3. tulis sendcmd file
    lines = []
    last_x = None
    for t, cx in out:
        xi = int(round(cx - crop_w / 2.0))
        if last_x is None or abs(xi - last_x) >= 2:  # skip micro-jitter
            lines.append(f"{t:.2f} crop x {xi};")
            last_x = xi
    if not lines:
        lines.append("0.0 crop x 0;")

    with open(args.outcmd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(json_dump({
        "ok": True,
        "detector": kind,
        "frames": len(out),
        "commands": len(lines),
        "crop_w": round(crop_w, 1),
        "crop_h": round(ch_src, 1),
        "src_w": src_w,
        "src_h": get_video_h(video),
        "face_frames": len(known),
        "cmd_path": args.outcmd,
    }))


_cache = {}


def get_video_w(p):
    if "w" not in _cache:
        _cache["w"], _cache["h"] = probe(p)
    return _cache["w"]


def get_video_h(p):
    if "h" not in _cache:
        _cache["w"], _cache["h"] = probe(p)
    return _cache["h"]


def probe(p):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", p],
        capture_output=True, text=True)
    try:
        w, h = r.stdout.strip().split("x")
        return int(w), int(h)
    except Exception:
        return 1280, 720


def json_dump(obj):
    import json
    return json.dumps(obj)


if __name__ == "__main__":
    main()
