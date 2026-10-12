#!/usr/bin/env python3
"""face_one.py — deteksi wajah di 1 frame gambar. Output JSON: {"faces":[{cx,...}]}
Pakai YuNet (cv2.FaceDetectorYN). Untuk speaker_detect.faceAtTimeSync.
Argumen opsional ke-2: side (left|right|center) — pilih wajah di sisi itu.
Filter false-positive: cy > 0.6 = tangan/kartu di meja, bukan wajah."""
import sys, os, json
try:
    import cv2
except Exception as e:
    print(json.dumps({"error": "no cv2: %s" % e})); sys.exit(0)
img_path = sys.argv[1] if len(sys.argv) > 1 else ""
side = sys.argv[2] if len(sys.argv) > 2 else ""
if not os.path.exists(img_path):
    print(json.dumps({"error": "no image"})); sys.exit(0)
im = cv2.imread(img_path)
if im is None:
    print(json.dumps({"error": "cannot read"})); sys.exit(0)
h, w = im.shape[:2]
model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models",
                     "face_detection_yunet_2023mar.onnx")
det = cv2.FaceDetectorYN_create(str(model), "", (w, h), 0.6, 0.3, 5000)
_, faces = det.detect(im)
out = []
if faces is not None:
    for f in faces:
        x, y, fw, fh = f[:4]
        cx = float((x + fw / 2) / w)
        cy = float((y + fh / 2) / h)
        if cy > 0.6:
            continue  # false positive: tangan/kartu di meja
        out.append({"cx": round(cx, 4), "cy": round(cy, 4), "w": round(float(fw / w), 4)})
# SIDE SELECT: LLM bilang left → ambil wajah paling kiri, dst.
# Tanpa ini ambil faces[0] = bisa false positive atau orang salah.
if side and out:
    if side == "left":
        out.sort(key=lambda f: f["cx"])
    elif side == "right":
        out.sort(key=lambda f: -f["cx"])
    elif side == "center":
        out.sort(key=lambda f: abs(f["cx"] - 0.5))
    out = [out[0]]
print(json.dumps({"faces": out}))
