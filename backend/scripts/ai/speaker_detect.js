// speaker_detect.js — deteksi SIAPA lagi ngomong per cue, via vision LLM.
// 1 frame per cue → "wajah mana yang bibirnya ketukup?" + POSISI wajah
// (cx 0..100 viewer perspective). image_url WAJIB: input_audio di-abaikan
// router (balas "unknown" tanpa lihat gambar).
// Output: [{ t: <sec clip-relative>, speaker: 'left'|'right'|'center'|'unknown',
//            cx: <0..1 posisi wajah pembicara di frame SOURCE> }]
// processor.js pakai cx LANGSUNG buat pan — akurat walaupun shot ganti
// (fc0.speakers dari sample YuNet seluruh window bisa miss shot pendek).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

async function detectSpeakers({ videoPath, startSec, cueTimes, ffmpegPath, jobId, onLog }) {
  // ponytail: max 16 sample — pembicara bergerak cepat (wajah 0.486→0.566
  // dalam 1.6s), 12 sample di clip 49s = jarak 4s → wajah kepotong.
  const step = Math.max(1, Math.ceil(cueTimes.length / 16));
  const picks = cueTimes.filter((_, i) => i % step === 0).slice(0, 16);
  const results = [];
  const tmp = require('os').tmpdir();
  const FF = ffmpegPath || process.env.FFMPEG_BIN || 'ffmpeg';
  const base = (process.env.AI_BASE_URL || 'http://localhost:20128/v1').replace(/\/+$/, '');
  for (const t of picks) {
    const img = path.join(tmp, `sd_${jobId || 'x'}_${t}.png`);
    try {
      // FIX DOUBLE OFFSET: cueT (dari clean_*.srt) = timing ABSOLUT video.
      // Dulu -ss startSec+t = 763s bukan 386s → frame salah → cx wajah
      // orang lain → pan/crop ke wajah salah (user: "wajah kepotong").
      spawnSync(FF, ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', img],
        { stdio: 'ignore', windowsHide: true, timeout: 30000 });
      if (!fs.existsSync(img)) continue;
      const b64 = fs.readFileSync(img).toString('base64');
      // ROUTER FLAKY: kadang return '' (finish_reason max_tokens, output
      // kosong) terutama image besar → speaker 'unknown' → pan mati.
      // Retry sampai 3x, jawaban valid atau give up.
      let txt = '';
      for (let attempt = 0; attempt < 3 && !txt.trim(); attempt++) {
        const r = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.AI_API_KEY },
          body: JSON.stringify({
            model: 'Gemini', stream: false, max_tokens: 60,
            messages: [{ role: 'user', content: [
              { type: 'text', text: 'Look at this video frame. Which person is SPEAKING (mouth open)? Reply with ONLY a JSON object like {"speaker":"left","cx":35} where speaker is left/right/center/unknown and cx is that speaking person face horizontal position 0-100 (0=left edge, 50=center, 100=right edge). No other text.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            ]}],
          }),
        });
        const j = await r.json();
        txt = (j.choices?.[0]?.message?.content || '').trim();
      }
      // LLM kadang bungkus ```json ... ``` — strip
      const jm = txt.match(/\{[^{}]*\}/);
      let spk = 'unknown', cx = 0.5;
      if (jm) {
        try {
          const o = JSON.parse(jm[0]);
          spk = ['left', 'right', 'center', 'unknown'].includes(o.speaker) ? o.speaker : 'unknown';
          const v = Number(o.cx);
          if (!isNaN(v)) cx = Math.max(0, Math.min(1, v / 100));
        } catch {}
      } else {
        const m = txt.toLowerCase().match(/(left|right|center|unknown)/);
        spk = m ? m[1] : 'unknown';
      }
      results.push({ t, speaker: spk, cx });
      if (onLog) onLog(`[speaker] t=${t}s -> ${spk} cx=${cx.toFixed(2)} (${txt.slice(0, 24)})`);
    } catch (e) {
      if (onLog) onLog(`[speaker] t=${t}s err ${String(e.message).slice(0, 60)}`);
    } finally { try { fs.unlinkSync(img); } catch {} }
  }
  return results;
}

// Posisi wajah pembicara di frame source, deteksi YuNet langsung di frame cue.
// LLM cx sering meleset (wanita cx LLM 0.50 vs asli 0.68 → wajah kepotong).
// side LLM cuma buat PILIH wajah mana yang ngomong; posisi dari YuNet.
function faceAtTimeSync({ videoPath, absTime, side, pythonPath, scriptPath }) {
  try {
    const img = require('os').tmpdir() + `/fat_${Date.now()}.png`;
    const FF = process.env.FFMPEG_BIN || 'ffmpeg';
    const r1 = spawnSync(FF, ['-y', '-ss', String(absTime), '-i', videoPath, '-frames:v', '1', img],
      { stdio: 'ignore', windowsHide: true, timeout: 90000 });
    if (r1.status !== 0 || !require('fs').existsSync(img)) return null;
    const out = spawnSync(pythonPath, [scriptPath, img],
      { captureOutput: true, timeout: 60000, windowsHide: true });
    try { require('fs').unlinkSync(img); } catch {}
    const lines = (out.stdout || '').toString().split('\n');
    const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));
    if (!jsonLine) return null;
    const faces = JSON.parse(jsonLine).faces || [];
    if (!faces.length) return null;
    // Buang false-positive rendah (cy > 0.6 = tangan di meja, wajah asli 0.3-0.45).
    const real = faces.filter(f => f.cy < 0.6);
    const pool = real.length ? real : faces;
    pool.sort((a, b) => a.cx - b.cx);  // cx naik: kiri→kanan
    const pick = side === 'left' ? pool[0]
      : side === 'right' ? pool[pool.length - 1]
      : pool[Math.floor(pool.length / 2)];
    return pick ? pick.cx : null;
  } catch { return null; }
}

module.exports = { detectSpeakers, faceAtTimeSync, detectSpeakersMouth };

// DETERMINISTIC speaker detect via MOUTH MOTION (bukan LLM). Return shape
// sama kaya detectSpeakers: [{t, speaker, cx}]. Pola dari Clips Kitty:
// "subject chosen by mouth motion, falling back to most prominent face".
// LLM flaky (router return '' 2-3x) + lambat; YuNet mouth landmark akurat.
async function detectSpeakersMouth({ videoPath, startSec, endSec, cueTimes, ffmpegPath, pythonPath, scriptPath, onLog }) {
  const FF = ffmpegPath || process.env.FFMPEG_BIN || 'ffmpeg';
  const tmp = require('os').tmpdir();
  const outp = path.join(tmp, `mm_${Date.now()}.json`);
  // window = [startSec, endSec] ABSOLUT. clean srt: kirim window clip ASLI
  // (125.6-166.8), BUKAN 0..lastCue — sample tersebar di 0-166.8 = cuma
  // beberapa jatuh di window clip → cue mapping meleset (c2: speaker salah).
  // asr srt: startSec=0, endSec=dur clip (clip-relative).
  const winEnd = (endSec != null) ? endSec
    : (startSec + (cueTimes.length ? cueTimes[cueTimes.length - 1] - startSec : 45));
  const args = [scriptPath, videoPath, String(startSec),
    String(winEnd), outp, JSON.stringify(cueTimes)];
  try {
    const r = spawnSync(pythonPath, args,
      { captureOutput: true, timeout: 240000, windowsHide: true,
        env: { ...process.env, FFMPEG_BIN: FF } });
    const lines = (r.stdout || '').toString().split('\n');
    const jl = lines.reverse().find(l => l.trim().startsWith('{'));
    if (!jl) return [];
    const frames = JSON.parse(jl).speakers || [];

    // frames: [{t, faces:[{cx,cy,open}]}] (SEMUA wajah asli per frame).
    // Filter wajah false-positive (cy>0.6 = tangan/meja).
    const SPEAK_THR = 0.025;  // open fh-normalized di atas ini = aktif bicara
    // Map cueT → sample mouth terdekat. Keyframe timing = cueT (sinkron subs).
    const perCue = cueTimes.map(t => {
      let best = null, bd = 1e9;
      for (const f of frames) {
        const d = Math.abs(f.t - t);
        if (d < bd) { bd = d; best = f; }
      }
      if (!best || !best.faces || !best.faces.length)
        return { t, speaker: 'unknown', cx: 0.5, open: 0, nActive: 0, faces: [] };
      const fs_ = best.faces.filter(f => f.cy <= 0.6);
      const act = fs_.filter(f => f.open > SPEAK_THR);
      // SPEAKER: cluster wajah by cx (lebar 0.15), skor = max open di cluster
      // LINTAS SAMPLE terdekat (3-frame). Max per-frame SALAH: senyum konstan
      // (0.019) menang vs orang lagi jeda sebelum ngomong (0.008). Orang
      // ngomong punya peak vokal (0.06) — cluster max 3-frame tangkap itu.
      const near = frames.filter(f => Math.abs(f.t - best.t) <= 3.0);
      const cl = {};  // cx0.3 -> {cxs:[], maxOpen}
      for (const nf of near) {
        for (const ff of (nf.faces || [])) {
          if (ff.cy > 0.6) continue;
          const k = Math.round(ff.cx / 0.15) * 0.15;
          if (!cl[k]) cl[k] = { maxOpen: 0, cxSum: 0, n: 0 };
          cl[k].maxOpen = Math.max(cl[k].maxOpen, ff.open);
          cl[k].cxSum += ff.cx; cl[k].n++;
        }
      }
      const keys = Object.keys(cl);
      let spk = null, bestScore = -1;
      for (const k of keys) {
        if (cl[k].maxOpen > bestScore) { bestScore = cl[k].maxOpen; spk = { cx: cl[k].cxSum / cl[k].n }; }
      }
      if (!spk) spk = fs_.slice().sort((a, b) => b.open - a.open)[0];
      const speaker = spk.cx < 0.42 ? 'left'
        : spk.cx > 0.58 ? 'right' : 'center';
      if (onLog) onLog(`[mouth] t=${t.toFixed(0)} -> ${speaker} cx=${spk.cx.toFixed(3)} active=${act.length}`);
      return { t, speaker, cx: spk.cx, open: bestScore,
        nActive: act.length,
        faces: fs_.map(f => ({ cx: f.cx, cy: f.cy, open: f.open,
          active: f.open > SPEAK_THR })) };
    });
    // RAW FRAMES: semua sample mouth_motion (merata+gap-fill), BUKAN cuma
    // cueT mapping. v12 gate per-segmen butuh peak vokal 0.066@127.4 —
    // per-cue ambil sample terdekat cue → ketinggalan → salah "jeda".
    try { fs.unlinkSync(outp); } catch (e) {}
    Object.defineProperty(perCue, 'rawFrames', { value: frames, enumerable: false });
    return perCue;
  } catch (e) {
    if (onLog) onLog(`[mouth] err ${String(e.message).slice(0, 80)}`);
    return [];
  } finally { try { fs.unlinkSync(outp); } catch {} }
}
