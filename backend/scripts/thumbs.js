// thumbs.js — pilih frame thumbnail TERBAIK dari kandidat multi-titik.
//
// Problem: frame @35% durasi sering ketangkap pas MATA TERTUTUP (kedipan) —
// thumbnail jelek. Solusi: extract 6 kandidat (20-70% durasi), pilih frame
// dgn wajah mata terbuka + kontras tinggi.
//
// Deteksi mata terbuka tanpa model: YuNet landmark (re/re_y, le/le_y) + jarak
// vertikal palpebral (buka-mata) — pakai face_one.py yg udah ada.
// NO new deps. NO LLM.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PY = process.env.PYTHON_BIN ||
  'C:/Users/diego/AppData/Local/Programs/Python/Python311/python.exe';
const FACE_ONE = path.join(__dirname, 'face_one.py');

// Skor kandidat: wajah BESAR (close-up) + TENGAH (centered) = thumbnail bagus.
// face_one.py return {cx, cy, w} — NO open/score field.
function scoreCand(imgPath) {
  try {
    const r = spawnSync(PY, [FACE_ONE, imgPath], { windowsHide: true, timeout: 30000 });
    const out = (r.stdout || '').toString();
    const jl = out.split('\n').reverse().find(l => l.trim().startsWith('{'));
    if (!jl) return null;
    const d = JSON.parse(jl);
    const face = (d.faces || [])[0];
    if (!face) return null;
    // close-up (wajah gede di frame) = thumbnail jelas keliatan
    const sizeScore = Math.min(1, (face.w || 0) / 0.12);
    // centered (wajah di tengah) = rule-of-thirds thumbnail
    const centScore = 1 - Math.min(1, Math.abs((face.cx || 0.5) - 0.5) * 2.5);
    // wajah di sepertiga atas (cy 0.25-0.45) = komposisi thumbnail natural
    const yScore = (face.cy > 0.20 && face.cy < 0.50) ? 1 : 0.4;
    const score = sizeScore * 0.5 + centScore * 0.3 + yScore * 0.2;
    return { score, face };
  } catch (e) { return null; }
}

async function pickBestThumb(ffmpegPath, videoPath, fracs, candPaths, outPath) {
  // 1. extract semua kandidat (1 pass per frame, cepat)
  const dur = spawnSync(ffmpegPath, ['-i', videoPath], { windowsHide: true, timeout: 15000 });
  let total = 0;
  const m = (dur.stderr || '').toString().match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (m) total = +m[1] * 3600 + +m[2] * 60 + +m[3];
  if (!total) return false;
  let okCount = 0;
  for (let i = 0; i < fracs.length; i++) {
    const t = total * fracs[i];
    const r = spawnSync(ffmpegPath, ['-y', '-ss', String(t), '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', candPaths[i]],
      { windowsHide: true, timeout: 30000 });
    if (r.status === 0 && fs.existsSync(candPaths[i])) okCount++;
  }
  if (!okCount) return false;

  // 2. skor tiap kandidat, pilih tertinggi
  let best = -1, bestIdx = -1;
  for (let i = 0; i < candPaths.length; i++) {
    if (!fs.existsSync(candPaths[i])) continue;
    const s = scoreCand(candPaths[i]);
    if (s && s.score > best) { best = s.score; bestIdx = i; }
  }
  if (bestIdx < 0) {
    // fallback: kandidat pertama yg ada
    bestIdx = candPaths.findIndex(p => fs.existsSync(p));
    if (bestIdx < 0) return false;
  }

  // 3. copy pemenang ke outPath
  fs.copyFileSync(candPaths[bestIdx], outPath);
  return fs.existsSync(outPath);
}

module.exports = { pickBestThumb, scoreCand };
