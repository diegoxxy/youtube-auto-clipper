// backend/scripts/ffmpeg/processor.js — T-07/T-08
// FFmpeg wrapper: clip, crop (9:16/1:1/16:9), burn ASS subtitle.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getTemplate } = require('../subtitles/templates');

function srtTimeToAss(t) {
  // 00:01:23,456 atau 00:01:23.456 -> 0:00:01:23.45
  const m = String(t).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10), s = parseInt(m[3], 10);
  const cs = m[4].padEnd(3, '0').slice(0, 2); // centiseconds
  return `${h}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}.${cs}`;
}

function assTimeToSec(t) {
  const m = String(t).match(/(\d+):(\d+):(\d+)[.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
}

function secToAss(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const mi = Math.floor((s % 3600) / 60);
  const se = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Convert SRT ke ASS untuk burn.
 * offsetSec: geser semua timestamp (clip mulai di 0, srt absolut) + buang cue di luar window.
 * template: 'modern' | 'retro' | 'minimal' (default modern)
 * refStyle: optional { subtitleColor, subtitlePosition } dari reference analysis
 */
// Uppercase yang lewati tag ASS (\c, \N, \an, \b, \i, \fn, \fs, \1c...).
// \c kalau ke-UPPERCASE jadi \C = warna SEKUNDER → highlight ga keliatan.
function upNoTags(t) {
  return String(t).split(/(\\[A-Za-z0-9]+&H[0-9A-Fa-f]+&|\\N|\\[A-Za-z]+[0-9]*)/g)
    .map((part, i) => (i % 2) ? part : part.toUpperCase())
    .join('');
}

function srtToAss(srtPath, assPath, offsetSec = 0, clipDur = null, template = 'bold', refStyle = null, wordTimings = null) {
  const content = fs.readFileSync(srtPath, 'utf8').replace(/^\uFEFF/, '');
  let tpl = getTemplate(template);
  const UPPERCASE = tpl.uppercase === true; // template 'bold': KAPITAL SEMUA biar tegas
  
  // Override dari refStyle jika ada
  if (refStyle) {
    let style = tpl.style;
    if (refStyle.subtitleColor) {
      // Replace PrimaryColour: &H00FFFFFF -> refStyle color (BGR format ASS)
      const hex = refStyle.subtitleColor.replace('#', '');
      const r = parseInt(hex.slice(0,2), 16);
      const g = parseInt(hex.slice(2,4), 16);
      const b = parseInt(hex.slice(4,6), 16);
      const bgr = `&H00${b.toString(16).padStart(2,'0').toUpperCase()}${g.toString(16).padStart(2,'0').toUpperCase()}${r.toString(16).padStart(2,'0').toUpperCase()}`;
      style = style.replace(/PrimaryColour:\s*&H[0-9A-F]+/i, `PrimaryColour: ${bgr}`);
    }
    if (refStyle.subtitlePosition) {
      // Alignment: bottom=2, top=8, center=5 (ASS numpad layout)
      const align = refStyle.subtitlePosition === 'top' ? 8 : refStyle.subtitlePosition === 'center' ? 5 : 2;
      style = style.replace(/Alignment:\s*\d+/, `Alignment: ${align}`);
    }
    tpl = { ...tpl, style };
  }
  
  const assHeader = tpl.style;

  const blocks = content.split(/\r?\n\r?\n/)
  const events = [];
  // Dedupe cue identik berurutan (YouTube auto-sub re-flow) — reuse logic
  // translate.js. Tanpa ini 2 cue nyaris sama saling tumpuk → "caption telat".
  let lastText = null;
  let lastEnd = null;
  let lastEndHi = null; // layer-1 (highlight) ga boleh overlap
  // Semua cue (termasuk hasil split WPC) ga boleh mulai sebelum cue sebelumnya
  // berakhir. YouTube auto-sub sering overlap 0.2-0.5s → 2 cue tumpuk di layar
  // → kliatan "caption telat"/kacau (vision: "ROLL JER,").
  const pushHi = (ws, we, txt) => {
    if (lastEndHi != null && ws < lastEndHi) ws = lastEndHi;
    if (we <= ws) we = ws + 0.15;
    lastEndHi = we;
    events.push(`Dialogue: 1,${secToAss(ws)},${secToAss(we)},Default,,0,0,0,,${txt}`);
  };
  const pushEv = (ws, we, txt) => {
    if (lastEnd != null && ws < lastEnd) ws = lastEnd;
    if (we <= ws) we = ws + 0.3;
    lastEnd = we;
    events.push(`Dialogue: 0,${secToAss(ws)},${secToAss(we)},Default,,0,0,0,,${txt}`);
  };
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const tm = lines[timeIdx].match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!tm) continue;

    let startSec = parseSrtSec(tm[1]);
    let endSec = parseSrtSec(tm[2]);
    const txt = lines.slice(timeIdx + 1).join(' ').replace(/[{}]/g, '').trim();
    if (txt === lastText) continue; // dedupe berurutan
    lastText = txt;
    
    // Buang overlap dengan cue sebelumnya (YouTube auto-sub sering overlap
    // 0.2-0.5s) — clamp start ke end cue sebelumnya. Tanpa ini 2 cue tumpuk
    // di layar → kliatan "caption telat"/kacau (vision: "ROLL JER,").
    // ASR cue timing = CLIP-RELATIVE (0-based, dari transcribeAudio audio clip).
    // YouTube SRT = timing GLOBAL video. ASR path `asr_*.srt` → skip offset.
    const isAsr = /(^|[/\\])asr_/.test(srtPath.replace(/\\/g, '/'));
    const clipStart = isAsr ? 0 : offsetSec;
    const clipEnd = isAsr ? (clipDur || 999999) : offsetSec + (clipDur || 999999);

    if (!isAsr && lastEnd != null && startSec < lastEnd + clipStart) startSec = lastEnd + clipStart;

    
    // Skip only if subtitle entirely outside clip window
    if (endSec < clipStart || startSec >= clipEnd) continue;
    
    // Clamp to clip window, then convert to clip-relative (0-based)
    const clampedStart = Math.max(startSec, clipStart);
    const clampedEnd = Math.min(endSec, clipEnd);
    const relativeStart = Math.max(0, clampedStart - clipStart);
    const relativeEnd = Math.max(relativeStart + 0.4, clampedEnd - clipStart); // min 0.4s biar kebaca
    // NOTE: lastEnd di-set OLEH pushEv sendiri (domain relatif). Jangan set di sini
    // — clamp cue-ke-cue-sama-nya ke relativeEnd-nya sendiri = start selalu lompat ke end.

    const text = lines.slice(timeIdx + 1).join(' ').replace(/[{}]/g, '').trim();
    if (!text) continue;
    // ponytail: wrap manual ~42 char/baris biar subtitle ga overflow layar
    const words = text.split(/\s+/);
    // KARAOKE per-kata (CapCut style): kata dasar PUTIH, KATA AKTIF
    // (sesuai timing bicara) kuning + fade in 150ms. Layer ganda:
    // base cue full teks + cue highlight per kata.
    // SEMUA template = highlight per-kata sesuai ucapan (user: "highlight per
    // kata sesuai yang sedang diucapkan"). warna = tpl.highlightColor.
    const KAR = true;
    // HIGHLIGHT WARNA PER KATA (CapCut style): kata terakhir dapat warna beda.
    const HL = tpl.highlightColor || '&H0000FFFF&'; // ASS BGR hex, default KUNING
    const hlWords = (txt) => {
      if (!HL) return txt;
      const ws2 = txt.split(/\s+/);
      if (ws2.length < 2) return txt;
      // Referensi TikTok (PWK/GADO): kata dasar KUNING, KATA TERAKHIR putih
      // tebal + outline hitam = "punch". Bukan separuh akhir semua.
      // "INTIMATE PARTY KAYAK [GUE]" / "MASIH [28]" / "DUA PROJECT MALAH SAMA [DIA]"
      const head = ws2.slice(0, -1).join(' ');
      const last = ws2[ws2.length - 1];
      // \\c = primary, \\3c = outline colour, \\bord = outline tebal (box-ish).
      return `${head} {\\c${HL}\\3c&H000000&\\bord7}${last}{\\c\\3c\\bord}`;
    };
    // MODE KATA (TikTok style): tiap kata cue sendiri, durasi dibagi rata.
    // Cuma aktif untuk template yang set wordsPerCue. Referensi user: "LU TAHU" / "GUA BANT".
    const WPC = tpl.wordsPerCue || 0;
    if (WPC && words.length > WPC) {
      // Durasi per chunk PROPORSIONAL panjang kata (bicara ga rata — kata
      // panjang makan waktu lebih lama dari "ya"). Fix caption telat.
      const totalChars = words.reduce((a, w) => a + w.length, 0);
      let acc = relativeStart;
      for (let i = 0; i < words.length; i += WPC) {
        const chunk = words.slice(i, i + WPC);
        const chars = chunk.reduce((a, w) => a + w.length, 0);
        // FIX: proporsi murni kasih chunk pendek (sisa 1 kata "ya") durasi 0.05s
        // → kedip ga kebaca. MIN 0.3s per chunk; cue boleh sedikit lewati end
        // (pushEv clamp cue berikutnya, ga overlap).
        const dur = Math.max(0.3, (relativeEnd - relativeStart) * (chars / totalChars));
        const ws = acc;
        const we = acc + dur;
        acc = we;
        let wt = hlWords(chunk.join(' '));
        if (UPPERCASE) wt = upNoTags(wt);
        pushEv(ws, we, wt);
      }
      continue;
    }
    // === KARAOKE MODE: single cue, kata non-aktif REDUP, kata aktif SOLID.
    // Pakai inline \alpha per kata (libass): ga butuh layer-2, posisi
    // kata otomatis sejajar (centered) — bebas bug overlay numpuk tengah.
    if (KAR && words.length >= 2) {
      // Timing kata: AUDIO-ALIGNED (local minima energi) kalau ada,
      // fallback estimasi proporsi panjang kata.
      const row = words.slice(0, 12); // ponytail: max 12 kata/cue biar 1 baris
      let wordTimes = null;
      if (wordTimings && Array.isArray(wordTimings)) {
        // wordTimings = [[absStart, absEnd, word], ...] ABSOLUT video.
        // Ambil kata yg overlap cue window (clip-relative).
        const hits = wordTimings.filter(wt =>
          wt[0] < clampedEnd && wt[1] > clampedStart &&
          text.toLowerCase().includes(String(wt[2] || '').toLowerCase()));
        if (hits.length >= 2) {
          wordTimes = hits.map(wt => [
            Math.max(0, wt[0] - clipStart), Math.max(0.08, wt[1] - clipStart)]);
          // urut + lewati kata double (YouTube tumpang-tindih)
          wordTimes.sort((a, b) => a[0] - b[0]);
        }
      }
      const wordEnds = [];
      if (wordTimes && wordTimes.length >= 2) {
        // Guard timing audio: MIN 0.25s per kata (kata pendek/audio noise
        // bikin highlight kedip tak kebaca). extend ke belakang.
        let prev = relativeStart;
        for (const wt of wordTimes) {
          const s = Math.max(prev, Math.min(wt[0], relativeEnd));
          const e = Math.min(relativeEnd, Math.max(s + 0.25, wt[1]));
          prev = e;
          wordEnds.push(e);
        }
        while (wordEnds.length < row.length) wordEnds.push(relativeEnd);
        wordEnds.length = row.length;
      } else {
        const chars2 = row.reduce((a, w) => a + w.length + 1, 0);
        let acc = relativeStart;
        for (const w of row) {
          acc += (relativeEnd - relativeStart) * ((w.length + 1) / chars2);
          wordEnds.push(acc);
        }
      }
      // Base cue (layer 0): FULL TEXT PUTIH solid (bukan PrimaryColour template
      // — kalau base ikut warna template, highlight kuning di atasnya ga keliatan).
      // POP-UP: fade-in cepat 80ms + scale 90→100 (user: "subtitle dynamic/pop up").
      let baseText = `{\\fad(80,0)\\fscx90\\fscy90\\t(0,120,\\fscx100\\fscy100)\\c&H00FFFFFF&}${words.join(' ')}`;
      if (UPPERCASE) baseText = upNoTags(baseText);
      pushEv(relativeStart, relativeEnd, baseText);
      // Highlight (layer 1): FULL TEXT di posisi SAMA (centered) —
      // kata non-aktif alpha CC (redup), kata aktif solid + kuning + bord7.
      // workaround bug libass: layer-1 1-kata dirender centered sendiri.
      for (let i = 0; i < row.length; i++) {
        const t0 = i === 0 ? relativeStart : Math.max(wordEnds[i - 1], relativeStart);
        const t1 = Math.min(wordEnds[i], relativeEnd);
        if (t1 <= t0) continue;
        // Highlight cue: FULL TEXT posisi sama + kata non-aktif INVISIBLE
        // (alpha FF). Highlight kata aktif KUNING solid di atas base putih.
        // WAJIB full text + alpha: cue 1-kata doang = render sendiri, posisi
        // ga sejajar base (lebar spasi placeholder ga match glyph).
        let txt2 = '';
        for (let j = 0; j < row.length; j++) {
          const w2 = row[j];
          if (j === i) txt2 += `{\\alpha&H00&\\c${HL}\\3c&H000000&\\bord7}${w2} `;
          else txt2 += `{\\alpha&HFF&}${w2} `;
        }
        if (UPPERCASE) txt2 = upNoTags(txt2);
        pushHi(t0, t1, txt2);
      }
      continue;
    }
const lines2 = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 30) { lines2.push(cur.trim()); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines2.push(cur);
    let wrapped = lines2.slice(0, 2).join('\\N');
    wrapped = hlWords(wrapped);
    if (UPPERCASE) wrapped = upNoTags(wrapped); // template 'bold': KAPITAL SEMUA
    pushEv(relativeStart, relativeEnd, wrapped);
  }

  fs.writeFileSync(assPath, assHeader + events.join('\n') + '\n');
  return events.length;
}

function parseSrtSec(t) {
  const m = String(t).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

// Auto face-framing: panggil face_frame.py, cache hasil per videoPath+window
const faceCropCache = {};
function computeFaceCrop(videoPath, outW, outH, startSec = null, endSec = null) {
  try {
    const cacheKey = `${videoPath}|${outW}x${outH}|${startSec}-${endSec}`;
    if (cacheKey in faceCropCache) return faceCropCache[cacheKey];
    // DISK CACHE: render paralel CONC=3 jalan di 1 proses tapi tiap job beda window.
    // Tanpa ini, 10 clip × YuNet 30-60s di video 1.4GB = +8-10 menit.
    const fsx = require('fs');
    const crypto = require('crypto');
    const cacheFile = path.join(require('os').tmpdir(), 'ffc_' +
      crypto.createHash('md5').update(cacheKey).digest('hex') + '.json');
    if (fsx.existsSync(cacheFile)) {
      try { const c = JSON.parse(fsx.readFileSync(cacheFile, 'utf8')); faceCropCache[cacheKey] = c; return c; }
      catch {}
    }
    const scriptPath = path.join(__dirname, '..', 'face_frame.py');
    const py = process.env.PYTHON_BIN || 'C:/Users/diego/AppData/Local/Programs/Python/Python311/python.exe';
    const cliArgs = [scriptPath, toFwd(videoPath), String(outW), String(outH)];
    // FIX user "kurang pas di tengah": sample HANYA di window clip, bukan full video
    if (startSec != null) cliArgs.push(String(startSec));
    if (endSec != null) cliArgs.push(String(endSec));
    if (!fs.existsSync(videoPath)) throw new Error(`Video not found: ${videoPath}`);
    const out = require('child_process').execFileSync(
      py, cliArgs,
      { encoding: 'utf8', timeout: 240000, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    // ambil baris JSON terakhir (cv2 bisa ngeluarin warning di stdout)
    const jsonLine = out.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop();
    if (!jsonLine) { faceCropCache[cacheKey] = null; return null; }
    const res = JSON.parse(jsonLine);
    const crop = (res.ok && res.face_found && res.crop) ? res.crop : null;
    if (crop && res.crop.speakers) crop.speakers = res.crop.speakers;
    faceCropCache[cacheKey] = crop;
    try { fsx.writeFileSync(cacheFile, JSON.stringify(crop)); } catch {}
    return crop;
  } catch (e) {
    console.warn(`[ffmpeg] face-framing gagal: ${String(e.message).slice(0, 150)}`);
    return null;
  }
}

// Cue start times dari SRT (clip-relative).
function srtCueTimes(srtPath) {
  try {
    const raw = fs.readFileSync(srtPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');
    return raw.split('\n\n').map(b => {
      const l = b.split('\n').find(x => x.includes('-->'));
      if (!l) return null;
      const m = l.match(/([\d:,.]+)\s*-->/);
      return m ? parseSrtSec(m[1]) : null;
    }).filter(t => t != null);
  } catch { return []; }
}

// speaker detect → sendcmd crop x per segmen. detectSpeakers kasih cx 0..1
// POSISI wajah pembicara di frame cue (viewer perspective). Pakai cx langsung:
// fc.speakers dari YuNet sample seluruh window bisa miss shot pendek
// (podcast cut kamera: hoodie @153s vs beige @120s — crop ke wajah salah).
function buildSpeakerPan(sp, fc, srcW, srcH) {
  if (!sp || sp.length < 2) return null;
  const vi = { w: srcW || 1920, h: srcH || 1080 };
  const w = fc.w, h = fc.h;
  const xFor = cx => {
    // SAFE ZONE (panel-relative, BUKAN clamp cx source-ratio):
    // cx clamp [0.15,0.85] lama = rasio terhadap WIDTH SOURCE. Speaker
    // cx=0.92 (pinggir kanan ekstrim) dipaksa 0.85 → x=1632, window kanan
    // 2240 > 1920 → clamp ke 1312 → wajah 74% panel = MASIH KEPOCUT KANAN.
    // Hitung x dulu, baru kalau wajah di luar [0.10,0.90] panel, geser x.
    // VERIFIED: cx=0.92 srcW1920 w608 → x=1312 → wajah 74.7% panel (test).
    const fx = cx * vi.w;                       // wajah di pixel source
    let x = fx - w / 2;
    x = Math.max(0, Math.min(x, vi.w - w));     // window valid dulu
    let pos = (fx - x) / w;                     // posisi wajah di panel 0..1
    if (pos < 0.15) x = fx - 0.15 * w;          // terlalu kiri → geser kanan
    else if (pos > 0.85) x = fx - 0.85 * w;     // terlalu kanan → geser kiri
    // re-clamp + recheck (window bisa mentok edge → wajah tetap pinggir,
    // gap terlalu kecil untuk digeser. fallback: wide crop zoom out).
    x = Math.max(0, Math.min(x, vi.w - w));
    pos = (fx - x) / w;
    if (pos > 0.85 || pos < 0.15) {
      // mentok: crop window kekecilan. fallback pakai w fallback = 0.65*vi.w
      // (zoom out) biar wajah muat safe zone. ponytail: kasar, upgrade = 
      // adaptive zoom per keyframe via zpan expr.
      const wideW = Math.min(vi.w, Math.round(w * 1.6));
      x = fx - (pos > 0.90 ? 0.90 : 0.10) * wideW;
      x = Math.max(0, Math.min(x, vi.w - wideW));
      return Math.round(x);
    }
    return Math.round(x);
  };
  // group deteksi jadi run (side sama berurutan)
  const runs = [];
  // singleShot = range<0.20 (org sama gerak halus) → 1 keyframe statis.
  // Hoist ke sini (dulu dideklarasi di dalem branch → ReferenceError).
  let singleShot = false;
  for (const d of sp) {
    if (d.speaker === 'unknown') continue;
    const last = runs[runs.length - 1];
    if (last && last.side === d.speaker) {
      last.t1 = d.t; last.cxs.push(d.cx);
    } else runs.push({ side: d.speaker, t0: d.t, t1: d.t, cxs: [d.cx] });
  }
  if (runs.length < 2) return null;
  // cx per run = MEDIAN dari sample cue di run itu (bukan terakhir — wajah
  // pembicara bergerak/shot ganti antar cue, 1 sample meleset → wajah kepotong).
  for (const r of runs) {
    r.cxs.sort((a, b) => a - b);
    r.cx = r.cxs[Math.floor(r.cxs.length / 2)];
  }
  // INTERUPSI SINGKAT (user: "pas ada yang interupsi sekata dua kata dia tetep
  // fokus ke yang ngomong banyak"): run < 1.2s di TENGAH = orang nyelip 1-2
  // kata. JANGAN pindah kamera kesana — gabung ke run sebelumnya (kamera hold
  // di speaker utama). Run PERTAMA/TERAKHIR ga pernah di-skip (bisa jadi
  // satu2nya speaker = bunuh pan). Video referensi: cut ke pembicara BARU cuma
  // kalau dia ngomong beneran, bukan reaksi sekata.
  const MIN_RUN = 1.2;
  const kept = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const isEdge = (i === 0 || i === runs.length - 1);
    if (!isEdge && (r.t1 - r.t0) < MIN_RUN) continue;  // interupsi tengah: skip
    kept.push(r);
  }
  const finalRuns = kept.length >= 2 ? kept : runs;
  if (finalRuns.length < 2) {
    // 1 speaker valid = SINGLE lock: kamera statis di cx pembicara LLM
    // (BUKAN cx YuNet dominan = bisa beda orang).
    const only = finalRuns[0];
    if (only) return { keyframes: [{ t: 0, x: xFor(only.cx) }], single: true };
    return null;
  }
  // INTERPOLASI linier per-frame via crop expression (bukan sendcmd stepwise):
  // wajah pembicara bergerak cepat (cx 0.63→0.45→0.64 antar cue, shot ganti).
  // Stepwise = wajah kepotong di antara command. Expression: nested if/lerp.
  // SMOOTHING: pan mentah NaikTURUN (830→368→772→374) = kamera "geser-geser"
  // (user complaint). Side LLM bingung di single-speaker shot: pembicara
  // posisi ~0.57 tapi LLM jawab left/center/right交替 → pan bolak-balik.
  // SINGLE-SPEAKER detect: range cx kecil (<0.20) = orang yang sama bergerak
  // halus → kamera STATIS di median cx (video referensi = tripod statis).
  // MULTI-SPEAKER (range >= 0.20): 2 orang beda posisi → pan per segmen,
  // tapi smooth median window 3 biar fluktuasi side LLM salah rata.
  const allCx = sp.map(d => d.cx).filter(c => typeof c === 'number');
  const range = allCx.length ? Math.max(...allCx) - Math.min(...allCx) : 0;
  const keyframes = [];
  if (range < 0.20) {
    const sorted = allCx.slice().sort((a, b) => a - b);
    const medCx = sorted[Math.floor(sorted.length / 2)];
    keyframes.push({ t: 0, x: xFor(medCx) });
    // SINGLE-SPEAKER lock (range<0.20 = org sama gerak halus): consumer
    // butuh crop statis di median cx (bukan interpolasi 1 keyframe).
    singleShot = true;
  } else {
    // side yang sama berurutan = 1 run; cx run = median sample di run itu.
    // (Bukan sample terakhir — shot ganti cepat, 1 sample meleset → wajah kepotong.)
    // INTERUPSI SINGKAT di-skip (finalRuns) — kamera hold di speaker utama.
    for (const r of finalRuns) keyframes.push({ t: r.t0, x: xFor(r.cx) });
  }
  // KEYFRAME PERTAMA WAJIB t=0: tanpa ini crop awal = expr default x=0
  // (pan ke kiri ekstrim) → wajah kepotong 0-20s sampai keyframe pertama.
  if (keyframes.length && keyframes[0].t > 0.001) {
    keyframes.unshift({ t: 0, x: keyframes[0].x });
  }
  // ponytail: batasi pan maksimal 8 keyframe (expression terlalu panjang
  // bikin ffmpeg lambat di low-spec; 8 keyframe = track tiap ~5s).
  // NO median-window smoothing: window 3 rata median ACROSS run = bunuh
  // switch pembicara beneran (side=left cx 0.31 di-timpa tetangga right
  // 0.62/0.64 → median 0.62 → pan ke kanan, wajah kepotong kiri).
  // Per-run median (di atas) udah cukup ratakan fluktuasi sample.
  const kf = keyframes.slice(0, 8);
    // SINGLE-LOCK: 1 keyframe (range<0.20 = org sama) → crop statis di
    // median cx pembicara. Dulu return null = static crop pakai cx YuNet
    // (bisa beda orang) → wajah kepotong/salah orang.
    if (kf.length < 2) {
      if (!kf.length) return null;
      return { keyframes: kf, w, h, y: fc.y, zoom: 1.0, single: true };
    }
    const zoom = Math.max(1.0, Math.min(1.35, fc.zoom || 1.0));
    const zoomedW = Math.max(200, Math.round(w / zoom));
    return { keyframes: kf, w: zoomedW, h, y: fc.y, zoom, interpolate: true,
             single: !!singleShot };
}


// pickSplitPair: dari N wajah (YuNet di 1 frame), pilih 2 yang akan jadi
// panel split. c1 abadca9b shot wide 4-org @184.35: YuNet return
// [0.76,0.69,0.30,0.47]. Ambil sp[0]+sp[1] = 0.69+0.76 = DUA ORANG SEBELAHAN
// → crop x=1209 & x=1075 (overlap 72%) = "double split screen orang sama".
// FIX: pasangan TERJAUH Δcx = 0.30 vs 0.76 = 2 sisi meja = org berbeda.
function pickSplitPanel(faces, maxN) {
  // pilih maxN wajah = ORANG BERBEDA tersebar (max-min dispersion), BUKAN
  // faces[0..N] acak YuNet. c1 @184.35: [0.76,0.69,0.30,0.47] → maxN=3
  // = {0.30,0.76} + 0.47 (jarak-min 0.17 > 0.69 jarak-min 0.07).
  // EDGE GUARD: cx<0.08 / >0.92 = wajah SETENGAH keluar frame source
  // (job baa0344a c5 pv8: cx=0.08 → panel crop x=0, muka kepotong dinding).
  // Buang; kalau ga ada wajah valid sama sekali → return [] (caller ke
  // solo crop, jangan bikin panel sampah).
  const fs2 = (faces || []).filter(f => f && f.cx != null && f.cx >= 0.08 && f.cx <= 0.92);
  if (!fs2.length) return [];
  if (fs2.length <= maxN) return fs2.sort((a, b) => a.cx - b.cx);
  let best = null, bd = -1;
  for (let i = 0; i < fs2.length; i++)
    for (let j = i + 1; j < fs2.length; j++) {
      const d = Math.abs(fs2[i].cx - fs2[j].cx);
      if (d > bd) { bd = d; best = [fs2[i], fs2[j]]; }
    }
  while (best.length < maxN) {
    let cand = null, cd = -1;
    for (const f of fs2) {
      if (best.indexOf(f) >= 0) continue;
      const mn = Math.min.apply(null, best.map(b => Math.abs(b.cx - f.cx)));
      if (mn > cd) { cd = mn; cand = f; }
    }
    if (!cand || cd <= 0) break;
    best.push(cand);
  }
  return best.sort((a, b) => a.cx - b.cx);
}

// buildSplitGraph: auto split-screen 2-3 panel untuk multi-speaker (9:16).
// Reference: ssstik.io_1790038308335-2.mp4 @8s = 3-panel vstack.
// ffmpeg: [0:v]split=N -> crop tiap wajah -> scale 1080x(1920/N) -> vstack.
// deteksi wajah di 1 frame (absolut time). Untuk per-segmen split: ambil
// speakers asli dari SEGMENT MULTI, bukan window global.
function detectFacesAt(videoPath, absT, probeW = 640) {
  const tmp = path.join(require('os').tmpdir(), `dfa_${Date.now()}.png`);
  const fbin = process.env.FFMPEG_BIN || 'ffmpeg';
  const pyBin = process.env.PYTHON_BIN ||
    'C:/Users/diego/AppData/Local/Programs/Python/Python311/python.exe';
  const oneScript = path.join(__dirname, '..', 'face_one.py');
  try {
    require('child_process').spawnSync(fbin, ['-y', '-ss', String(absT),
          '-i', videoPath, '-frames:v', '1', '-vf', `scale=${probeW}:-2`, tmp],
          { windowsHide: true, timeout: 30000 });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) return null;
    const rs = require('child_process').spawnSync(pyBin, [oneScript, tmp],
      { captureOutput: true, windowsHide: true, timeout: 60000 });
    const ls = (rs.stdout || '').toString().split('\n');
    const jl = ls.reverse().find(l => l.trim().startsWith('{'));
    return jl ? JSON.parse(jl) : null;
  } catch (e) { return null; }
  finally { try { fs.unlinkSync(tmp); } catch (e) { /* noop */ } }
}

// v22: sample wajah PER-SHOT. shot_segments.py kasih cx per segmen tapi
// GA ADA cy — padahal wajah naik-turun per angle (c4 job d7fce121: org
// merundung di meja → cy beda 0.20 vs window global). detectFacesAt di
// frame TENGAH tiap segmen → [{t, faces:[{cx,cy}]}] waktu RELATIF clip.
// SIMPAN SEMUA wajah (bukan center-most): close-up cutaway 1 org cx 0.51
// bukan milik panel manapun kalau di-threshold → keyframe DROPPED →
// panel kembali median statis → close-up kepala kepotong (d7fce121 c1).
// Assign per-panel di buildSplitGraph (nearest-cx, no reject).
// return null kalau ga ada wajah / kurang dari 2 sample.
function sampleFacesPerShot(videoPath, startSec, endSec, segs) {
  if (!segs || !segs.length) return null;
  const out = [];
  for (const s of segs) {
    if (s.start >= endSec || s.end <= startSec) continue;
    const mid = (s.start + s.end) / 2;
    const one = detectFacesAt(videoPath, mid);
    if (one && one.faces && one.faces.length) {
      out.push({ t: Math.max(0, mid - startSec),
              faces: one.faces.map(f => ({ cx: f.cx, cy: f.cy, w: f.w || 0 })) });
    }
  }
  return out.length >= 2 ? out : null;
}

// bangun crop expr ffmpeg: instant cut antar keyframe (user: "langsung
// inframe ketengah", BUKAN pan pelan). expr = nested if(lt(t,k),val,rest).
function cropExpr(keyframes) {
  if (!keyframes || keyframes.length < 2) return null;
  let expr = String(keyframes[keyframes.length - 1].v);
  for (let i = keyframes.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${keyframes[i + 1].t.toFixed(2)}),${keyframes[i].v},(${expr}))`;
  }
  return expr;
}

// v22: posisi vertikal wajah di panel. yFace = fraksi tinggi panel tempat
// PUSAT wajah ditaruh (dari atas). Kepala atas ada di yFace - faceH/(2*zH).
// Wajah BESAR (close-up) butuh yFace BESAR biar ubun ga kepotong atas:
//   box YuNet h ≈ 1.15 * w; kepala asli ≈ 1.3 * w.
//   fw = lebar wajah (fraksi srcW), srcW = lebar source px, zH = tinggi crop px.
// Contoh job d7fce121: fw 0.12 → box 230px, zH 432 → perlu yFace ~0.37
// (yFace 0.12 → kepala atas di -18% = KEPOTONG, bug re/rd).
function faceYFace(fw, srcW, zH) {
  const faceHpx = Math.max(0.03, fw || 0.06) * srcW * 1.30;
  // wajah besar (close-up) butuh yFace BESAR → kepala muat atas.
  // wajah kecil (wide) butuh yFace KECIL → kepalanya kecil, tempat di 40-50%.
  // +0.05 shift: box YuNet di output upscale sering lebih luas 12% dari
  // source → headroom aktual kurang (verified c2/c3: top -0.03..-0.12
  // borderline, c1 -0.14 sebelum zW-2.4 fix).
  // v22d: headroom ekstra +0.08 (c1v3: t=3/30/50/67 top -0.04..-0.15
  // setelah +0.05). YuNet box output upscale ~12% lebih luas; kepala asli
  // ≈1.5x wajah tapi ubun2 kadang ~1.7x (pria berambut tebal).
  return Math.min(0.58, Math.max(0.32, faceHpx / (2 * zH) + 0.06 + 0.13));
}

function buildSplitGraph(faceCrop, srcW, srcH, panelFx, shotSamples) {
  // Panel 0 = speaker utama (paling sering muncul) — subs nempel di situ.
  // Panel sisanya diurut cx (kiri→kanan). CAP 3 panel: 4 panel di 9:16 =
  // 480px/panel = muka ~60px, tak terlihat (user: "ga nunjukin badan
  // setengah-setengah" = muka harus keliatan).
  const sorted = (faceCrop.speakers || []).filter(s => s.cx != null);
  if (sorted.length < 2) return null;
  const byFreq = [...sorted].sort((a, b) => (b.n_frames || 0) - (a.n_frames || 0));
  const main = byFreq[0];
  // PANEL PALSU: cluster lain cuma nge-detek ORANG YANG SAMA dari
  // samping/belakang (YuNet tangkap punggung kepala) → cx beda tipis
  // tapi wajahnya sama. Split = mubazir (panel belakang kepala).
  // Hanya terima panel lain kalau cx-nya BENERAN beda (>0.10 = org lain)
  // DAN muncul cukup sering (>= 20% frame utama, bukan orang lewat).
  // v22e: 0.14→0.10, 25%→20% (user: "3 orang ga ke-shoot semua").
  const others = byFreq.slice(1).filter(s =>
    Math.abs((s.cx || 0) - (main.cx || 0)) > 0.10 &&
    (s.n_frames || 0) >= Math.max(2, (main.n_frames || 4) * 0.20)
  ).sort((a, b) => a.cx - b.cx);
  const picked = [main, ...others].slice(0, 3);
  const n = picked.length;
  if (n < 2) return null;  // ga ada org lain beneran → static crop (fallback)
  const panelH = Math.floor(1920 / n);
  // Panel 1080xpanelH. n=2 → 1080x960 (rasio 1.125, LANDSCAPE-ish).
  // Crop source per-wajah harus SAMA rasio (bukan 9:16) supaya ga
  // distorsi: zW = zH * (1080/panelH). Tinggi crop di source = srcH/n.
  // ZOOM IN 1.15x: panel split (n=2 → 1080x960) = wajah muncul KECIL
  // (~70px di 540px crop) karena kamera source wide. Tanpa zoom, muka
  // tak keliatan jelas. wajah besar tapi masih muat badan (zoom 1.8 = kepala
  // kepotong). zW/zH dikecilin = crop lebih dekat.
  // v22e: 1.25→1.15 (user 2026-10-14: "zoom terlalu dekat"). 1.15 = wajah
  // keliatan tapi badan juga, ga terlalu close-up.
  // ADAPTIVE: kalau wajah terbesar (faceW) > 55% zW, zoom out ke 1.0
  // (close-up 2 org deket kamera: wajah 0.48*srcW=922px > zW 486 = kepala
  // kepotong dgn zoom 1.25). Ponytail: shot wajah 1 org + wajah besar =
  // sudah di-guard closeUp di segShots (solo). Ini buat 2-org close.
  const SPLIT_ZOOM_BASE = 1.15;
    const panelRatio = 1080 / panelH;           // rasio panel (W/H)
    let zH = Math.round(Math.floor(srcH / n) / SPLIT_ZOOM_BASE);
    let zW = Math.round(zH * panelRatio);       // lebar crop = rasio sama dgn panel
    // ADAPTIVE: kepala close-up (fw 0.42 → 1050px) > zH 432 → ubun KEPOTONG
    // walau yFace max (job d7fce121 rf t=3/38: headtop -15/-16). Besarkan
    // window sampe muat kepala (faceH*1.15) = wajah lebih kecil tapi utuh.
    const faceMaxWpx = picked.reduce((m, p) =>
      Math.max(m, (p.faceW || (p.w || 0) * srcW || 0)), 0);
    if (faceMaxWpx) {
      const needH = Math.round(faceMaxWpx * 1.30 * 1.15);
      if (needH > zH) {
        zH = Math.min(srcH, needH);
        zW = Math.min(srcW, Math.round(zH * panelRatio));
      }
    }
  // panelFx = array filter per-panel (subtitle/fade). Panel 0 = speaker utama.
  // Setelah vstack, subtitle di-chain [base] = muncul di panel BAWAH (posisi
  // global 58% frame gabungan) = nutup reaction, bukan speaker. Taruh subs
  // di panel 0 SEBELUM vstack → subtitle nempel di speaker utama.
  panelFx = panelFx || [];
  let g = '[0:v]split=' + n;
  for (let i = 0; i < n; i++) g += '[s' + i + ']';
  g += ';';
  const outs = [];
  for (let i = 0; i < n; i++) {
    const sp = picked[i];
    const x = Math.max(0, Math.min(srcW - zW, Math.round(sp.cx * srcW - zW / 2)));
    // Wajah di ~30% dari ATAS panel (YuNet cy = tengah box ~ hidung).
    // Headroom konstan 30% zH di ATAS wajah: cy*srcH - zH*0.30.
    // yFace lama (cy+0.06 / cy*0.70) = makin tinggi wajah makin nggak
    // konstan → wajah posisi makin turun (cy 0.3 → 75% panel = bawah).
    const yFace = faceYFace(sp.w, srcW, zH);
    const y = Math.max(0, Math.min(srcH - zH, Math.round((sp.cy || 0.4) * srcH - zH * yFace)));
    const fx = panelFx[i] || '';
    // v22 PER-SHOT crop: shot close-up (1 wajah) wajah di TEMPAT LAIN dari
    // median global → crop statis kena kepala (job d7fce121 c1-c3: panel
    // muka kepotong saat close-up). shotSamples = wajah per-shot (cx, cy,
    // waktu relatif). Assign sample ke panel TERDEKAT (cx paling dekat dgn
    // cx panel), build crop expr INSTANT-CUT antar keyframe (user: "langsung
    // inframe ketengah", bukan pan pelan).
    let xExpr = String(x), yExpr = String(y);
    if (shotSamples && shotSamples.length >= 2) {
      let sy0 = null;  // anchor slice SOLO (panel0); panel1 = sy0 + zH
      const keys = [];
      for (const smp of shotSamples) {
        const fs = (smp.faces || []).map(f => ({ ...f,
          d: Math.abs(f.cx - (sp.cx ?? 0.5)) }));
        if (!fs.length) continue;
        fs.sort((a, b) => a.d - b.d);
        const nf = fs[0];
        // SOLO segment (1 wajah di shot ini): jangan split 2 panel ke ORANG
        // SAMA — tiap panel cuma dapat potongan tubuh (rahang/leher), wajah
        // ga keliatan (job d7fce121 c1 @14s). Render sebagai SLICE full-frame:
        // panel0 = slice berisi WAJAH, panel1 = slice TEPAT DI BAWAHNYA.
        // Kedua panel = 1 frame utuh distack = wajah guaranteed keliatan.
        if (fs.length < 2) {
          // SOLO segment (1 wajah di shot ini): jangan split 2 panel ke ORANG
          // SAMA — tiap panel cuma dapat potongan tubuh (rahang/leher), wajah
          // ga keliatan (job d7fce121 c1 @14s). Render sebagai SLICE full-frame:
          // panel0..n-1 = n slice vertikal berurutan (adjacent), panel0
          // berisi WAJAH. Kedua panel = 1 frame utuh distack = wajah
          // guaranteed keliatan. Rasio panel = srcW : (srcH/n) = persis rasio
          // crop (zW x zH) → zero distortion.
          const sx0 = Math.max(0, Math.min(srcW - zW, Math.round((nf.cx ?? 0.5) * srcW - zW / 2)));
          let sy;
          if (i === 0) {
            const yf = faceYFace(nf.w, srcW, zH);
            sy0 = Math.max(0, Math.min(srcH - n * zH, Math.round((nf.cy ?? 0.4) * srcH - zH * yf)));
            sy = sy0;
          } else {
            if (sy0 == null) {
              const yf = faceYFace(nf.w, srcW, zH);
              sy0 = Math.max(0, Math.min(srcH - n * zH, Math.round((nf.cy ?? 0.4) * srcH - zH * yf)));
            }
            sy = Math.min(srcH - zH, sy0 + i * zH);
          }
          keys.push({ t: smp.t, v: { x: sx0, y: sy } });
          continue;
        }
        // MULTI segment: 1 wajah per panel, urut cx (kiri→kanan) = panel
        // urut cx. BUKAN median statis: window 486px (25% srcW) sempit,
        // median cx speaker utama (0.19) = Lewat wajah org lain (0.36/0.86)
        // → panel nampilin rahang/meja (job d7fce121 c1 @14s).
        // MULTI segment: assign wajah TERDEKAT per panel (nearest cx), BUKAN
        // sorted-cx index: panel0 = speaker utama (byFreq), panel1 = org lain
        // sorted cx — urutan panel != urutan cx → mf[i] = ORANG SALAH (job
        // d7fce121 c1: main cx 0.77 di panel0, mf[0]=wajah 0.19 kiri → lompat).
        // HOLD: shot close-up 1 org (detected MULTI global tapi visible 1) →
        // pertahankan posisi keyframe sebelumnya (wajah masih di tempat lama,
        // bukan muncul dari kosong).
        let nf2 = null;
        if (smp.faces && smp.faces.length) {
          let bd = 1e9;
          for (const f of smp.faces) {
            const d = Math.abs(f.cx - (sp.cx ?? 0.5));
            if (d < bd) { bd = d; nf2 = f; }
          }
        }
        let sxm, sym;
        if (!nf2) {
          // tidak ada wajah di shot ini → hold keyframe sebelumnya (keys last)
          if (keys.length) { keys.push({ t: smp.t, v: { ...keys[keys.length - 1].v } }); }
          continue;
        }
        sxm = Math.max(0, Math.min(srcW - zW, Math.round(nf2.cx * srcW - zW / 2)));
                const yfm = faceYFace(nf2.w, srcW, zH);
        sym = Math.max(0, Math.min(srcH - zH, Math.round(nf2.cy * srcH - zH * yfm)));
        keys.push({ t: smp.t, v: { x: sxm, y: sym } });
      }
      if (keys.length >= 2) {
        const xK = keys.map(k => ({ t: k.t, v: k.v.x }));
        const yK = keys.map(k => ({ t: k.t, v: k.v.y }));
        const xe = cropExpr(xK), ye = cropExpr(yK);
        if (xe && ye) { xExpr = `'${xe}'`; yExpr = `'${ye}'`;
          console.log(`[ffmpeg] panel${i} TRACK: ${keys.map(k => k.t.toFixed(1) + '@(' + k.v.x + ',' + k.v.y + ')').join(' ')} (static x=${x} y=${y})`); }
      }
    }
    // crop source (zW x zH, ratio panel) -> scale ke panel 1080xpanelH.
    // FIX DISTORSI: scale=1080:panelH stretch kalau crop ratio != 9:16
    // (crop 303x540 -> 1080x960 = muka lebar 3.5x). Pakai
    // force_original_aspect_ratio=decrease + pad ke 1080xpanelH
    // (aspect benar, background hitam).
    g += '[s' + i + ']crop=' + zW + ':' + zH + ':' + xExpr + ':' + yExpr +
         ',scale=1080:' + panelH + ',setsar=1' + (fx ? ',' + fx : '') + '[p' + i + '];';
    outs.push('[p' + i + ']');
  }
  g += outs.join('') + 'vstack=inputs=' + n + '[base]';
  return g;
}

// pickSubtitleSource: subtitle SRT terbaik untuk 1 clip.
// PRIORITAS 0: transcript ucapan ASLI (transcript.json → clean_*.srt).
//   User: "transcrib apapun yang keluar dari mulut, jangan ada yang
//   diterjemahkan sama sekali." Auto-sub YouTube 'id' = ucapan asli.
//   Translate DILARANG dipakai kalau sub asli sudah印尼 / bukan EN.
// PRIORITAS 1: ASR per-clip (kalau sub asli EN-dominan — video Indonesia
//   yang YouTube cuma sediain auto-sub 'en').
// PRIORITAS 2: translate ID (FALLBACK terakhir, hanya kalau 2 di atas
//   bener-bener EN dan ASR gagal — lebih baik ucapan asli walau kasar
//   daripada translate yang bukan ucapan).
// PRIORITAS 3: srtPath mentah (lebih baik ada daripada kosong).
async function pickSubtitleSource({ fs, path, jobDir, srtPathAbs, startSec, clipDur, videoPath, ffmpegPath, spawn, toFwd }) {
  // --- DETEKSI: sub asli EN-dominan? (baru boleh ASR/translate) ---
  // transcript.json = ucapan asli (auto-sub id ATAU en, apapun sumbernya).
  // Kalau BUKAN en-dominan = SUB ASLI → pakai langsung, JANGAN translate.
  const srcLangIsEn = (() => {
    try {
      const t = fs.existsSync(srtPathAbs) ? fs.readFileSync(srtPathAbs, 'utf-8') : '';
      const blocks = t.trim().split('\n\n').filter(Boolean);
      const EN = /\b(the|and|you|that|this|with|have|was|were|are|been|they|their|what|when|would|could|should|about|which|there|then|them|these|those|because|between|through|during|before|after)\b/i;
      const enBlocks = blocks.filter(b => EN.test(b.split('\n').slice(2).join(' ')));
      return blocks.length > 0 && enBlocks.length > blocks.length * 0.5;
    } catch (e) { return false; }
  })();

  // sub asli = bukan EN → PRIORITAS MUTLAK transcript ucapan, lewati
  // translate cache sama sekali (translated_id_*.srt = hasil LLM, bukan
  // ucapan).
  if (!srcLangIsEn) {
    try {
      const idPath = path.join(jobDir, 'translated_id_' + Math.round(startSec * 10) + '.srt');
      if (fs.existsSync(idPath)) {
        console.log('[ffmpeg] sub asli bukan-EN: skip translate cache (bukan ucapan) ' + idPath);
      }
    } catch (e) { /* noop */ }
  }

  let srtFinal = srtPathAbs;

  // --- PRIORITAS 0: ASR ucapan ASLI (audio → teks apa adanya) ---
  // WAJIB di atas transcript.json kalau sub asli EN-dominan: video Indonesia
  // yang YouTube cuma sediain auto-sub 'en' → transcript.json-nya EN = BUKAN
  // ucapan. User: "transcrib apapun yang keluar dari mulut, jangan ada yang
  // diterjemahkan sama sekali." ASR denger audio = ucapan asli.
  // Kalau sub asli bukan EN → skip ASR (transcript.json di bawah = ucapan).
  if (srcLangIsEn) {
    try {
      const { transcribeAudio } = require('../audio_transcribe');
      require('dotenv').config();
      const asrPath = path.join(jobDir, 'asr_' + Math.round(startSec * 10) + '.srt');
      if (!fs.existsSync(asrPath)) {
        const audioClip = path.join(jobDir, '_asrsrc_' + Math.round(startSec * 10) + '.m4a');
        await new Promise((res, rej) => {
          spawn(ffmpegPath, ['-y', '-ss', String(startSec), '-t', String(clipDur),
            '-i', toFwd(videoPath), '-vn', '-c:a', 'aac', '-b:a', '128k', audioClip],
            { cwd: jobDir, windowsHide: true })
            .on('close', c => (c === 0 ? res() : rej(new Error('audio cut rc=' + c))));
        });
        await transcribeAudio(audioClip, asrPath, 'id', clipDur,
          { srtGlobal: srtPathAbs, clipStart: startSec });
        try { fs.unlinkSync(audioClip); } catch (e2) { /* noop */ }
      }
      if (fs.existsSync(asrPath) && fs.readFileSync(asrPath, 'utf-8').trim()) {
        console.log('[ffmpeg] subtitle ASR ucapan asli (sub asli EN): ' + asrPath);
        return asrPath;
      }
    } catch (e) {
      console.warn('[ffmpeg] ASR ucapan gagal: ' + e.message);
    }
  }

  // --- PRIORITAS 1: transcript.json -> SRT per-clip bersih ---
  try {
    const jsonPath = path.join(jobDir, 'transcript.json');
    if (fs.existsSync(jsonPath)) {
      const tj = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      const segs = (tj.segments || []).filter(s =>
        typeof s.start === 'number' && typeof s.end === 'number');
      if (segs.length >= 3) {
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        const secToSrt = v => {
          const s = Math.max(0, v);
          return pad(Math.floor(s / 3600)) + ':' +
                 pad(Math.floor((s % 3600) / 60)) + ':' +
                 pad(Math.floor(s % 60)) + ',' +
                 pad(Math.round((s % 1) * 1000), 3);
        };
        const clipEnd = startSec + clipDur;
        // ALIGN ONSET: transcript.json (LLM ASR) timing telat ~0.3-0.6s
        // sistematis — mulut udah buka sebelum cue start (verified mouth
        // landmark: open peak di dt=-0.5 sebelum cue). Geser cue ke speech
        // onset via energi audio. Whisper lokal terlalu lambat (2.4x
        // realtime 4-core) jadi audio-energy onset = pengganti feasible.
        const cuesArr = [];
        for (const sg of segs) {
          if (sg.end <= startSec || sg.start >= clipEnd) continue;
          const s = Math.max(startSec, sg.start), e = Math.min(clipEnd, sg.end);
          if (e - s < 0.05) continue;
          const txt = String(sg.text || '').trim();
          if (!txt) continue;
          cuesArr.push([s, e, txt]);
        }
        if (cuesArr.length >= 2) {
          let aligned = cuesArr;
          try {
            const { spawnSync: spSync } = require('child_process');
            const pyPath = process.env.PYTHON_BIN ||
              'C:/Users/diego/AppData/Local/Programs/Python/Python311/python.exe';
            const alScript = path.join(__dirname, '..', 'align_cues.py');
            const r = spSync(pyPath, [alScript, videoPath,
              String(startSec), String(clipEnd), JSON.stringify(cuesArr)],
              { captureOutput: true, timeout: 120000, windowsHide: true,
                env: { ...process.env, FFMPEG_BIN: ffmpegPath } });
            const ls = (r.stdout || '').toString().split('\n');
            const jl = ls.reverse().find(l => l.trim().startsWith('{'));
            if (jl) {
              const ac = JSON.parse(jl).cues;
              if (Array.isArray(ac) && ac.length === cuesArr.length) {
                aligned = ac;
                console.log('[ffmpeg] subtitle ALIGN onset: ' +
                  cuesArr.filter((c, i) => Math.abs(ac[i][0] - c[0]) > 0.05).length +
                  '/' + cuesArr.length + ' cue digeser');
              }
            }
          } catch (e) { /* gagal = pakai timing asli */ }
          const out = aligned.map((c, i) =>
            (i + 1) + '\n' + secToSrt(c[0]) + ' --> ' + secToSrt(c[1]) +
            '\n' + c[2] + '\n');
          const cleanPath = path.join(jobDir, 'clean_' + Math.round(startSec * 10) + '.srt');
          fs.writeFileSync(cleanPath, out.join('\n'));
          console.log('[ffmpeg] subtitle CLEAN+ALIGN transcript.json: ' + out.length +
            ' cue (window ' + startSec + '-' + clipEnd.toFixed(1) + 's)');
          return cleanPath;
        }
      }
    }
  } catch (e) {
    console.warn('[ffmpeg] transcript.json clean gagal: ' + e.message);
  }

  // --- PRIORITAS 2: ASR kalau srt mentah beneran EN ---
  try {
    const t = fs.readFileSync(srtPathAbs, 'utf-8');
    const blocks = t.trim().split('\n\n').filter(Boolean);
    // EN function words. "Hari"/"kita" pake huruf latin = BUKAN EN.
    const EN = /\b(the|and|you|that|this|with|have|was|were|are|been|they|their|what|when|would|could|should|about|which|there|then|them|these|those|because|between|through|during|before|after)\b/i;
    const enBlocks = blocks.filter(b => EN.test(b.split('\n').slice(2).join(' ')));
    if (enBlocks.length > blocks.length * 0.5) {
      const { transcribeAudio } = require('../audio_transcribe');
      require('dotenv').config();
      const asrPath = path.join(jobDir, 'asr_' + Math.round(startSec * 10) + '.srt');
      if (!fs.existsSync(asrPath)) {
        const audioClip = path.join(jobDir, '_asrsrc_' + Math.round(startSec * 10) + '.m4a');
        await new Promise((res, rej) => {
          spawn(ffmpegPath, ['-y', '-ss', String(startSec), '-t', String(clipDur),
            '-i', toFwd(videoPath), '-vn', '-c:a', 'aac', '-b:a', '128k', audioClip],
            { cwd: jobDir, windowsHide: true })
            .on('close', c => (c === 0 ? res() : rej(new Error('audio cut rc=' + c))));
        });
        await transcribeAudio(audioClip, asrPath, 'id', clipDur,
          { srtGlobal: srtPathAbs, clipStart: startSec });
        try { fs.unlinkSync(audioClip); } catch (e2) { /* noop */ }
      }
      if (fs.existsSync(asrPath) && fs.readFileSync(asrPath, 'utf-8').trim()) {
        return asrPath;
      }
    }
  } catch (e) {
    console.warn('[ffmpeg] ASR fallback gagal: ' + e.message);
  }

  // --- PRIORITAS 3: srt mentah ---
  return srtFinal;
}

// Timing per-KATA dari energi audio (local minima = batas kata asli).
// Mengganti estimasi proporsi panjang-kata (kata pendek diucap pelan,
// kata panjang cepat). Return [[absStart, absEnd, word],...] atau null.
function alignWordsCues(ffmpegPath, videoPath, startSec, endSec, cues) {
  try {
    const { spawnSync: spSync } = require('child_process');
    const pyPath = process.env.PYTHON_BIN ||
      'C:/Users/diego/AppData/Local/Programs/Python/Python311/python.exe';
    const script = path.join(__dirname, '..', 'align_words.py');
    const all = [];
    for (const c of cues) {
      const r = spSync(pyPath, [script, videoPath,
        String(startSec), String(endSec), JSON.stringify(c)],
        { captureOutput: true, timeout: 240000, windowsHide: true,
          env: { ...process.env, FFMPEG_BIN: ffmpegPath } });
      const ls = (r.stdout || '').toString().split('\n');
      const jl = ls.reverse().find(l => l.trim().startsWith('{'));
      if (jl) {
        try {
          const w = JSON.parse(jl).words;
          if (Array.isArray(w) && w.length) all.push(...w);
        } catch (e) { /* per-cue gagal = skip */ }
      }
    }
    return all.length ? all : null;
  } catch (e) { return null; }
}

// Parse srt → [[absStart, absEnd, text], ...] ABSOLUT (utk align_words).
function parseSrtCues(srtPath, startSec) {
  try {
    const content = fs.readFileSync(srtPath, 'utf8').replace(/^\uFEFF/, '');
    const blocks = content.split(/\r?\n\r?\n/);
    const out = [];
    for (const b of blocks) {
      const lines = b.split(/\r?\n/).filter(l => l.trim() !== '');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti === -1) continue;
      const tm = lines[ti].match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
      if (!tm) continue;
      const s = parseSrtSec(tm[1]), e = parseSrtSec(tm[2]);
      const txt = lines.slice(ti + 1).join(' ').replace(/[{}]/g, '').trim();
      if (!txt) continue;
      if (e < startSec - 0.5) continue;
      out.push([s, e, txt]);
    }
    return out;
  } catch (e) { return []; }
}

async function processClip({ ffmpegPath, videoPath, output, start, end, format, srtPath, reactionVideoPath, subtitleTemplate = 'bold', refStyle = null, enableTransitions = true }) {
  const jobDir = path.dirname(videoPath);
  const startSec = Number(start) || 0;
  const durSec = Math.max(0.5, (Number(end) || startSec + 30) - startSec);
    const endSec = Number(end) || 0;
    const clipDur = Math.max(0, endSec - startSec);
    const hasReaction = reactionVideoPath && fs.existsSync(reactionVideoPath);
    
    let subtitleBurnInfo = null;
    // split-screen multi-speaker: graph terpisah (label [sv]→[out]), filter lain masuk chain terakhir
    let splitGraph = null;
    // hoisted: faceCrop + dimensi source dipakai di branch split-layout di bawah
    // (sebelumnya const di dalam `if(format==='9:16')` → scope luar ReferenceError).
    let faceCrop = null;
    let splitFaces = null;   // faceCrop asli (sebelum di-null saat wantSplit)
    let wantSplit = false;
    // v21: snapshot faceCrop buat branch 9:16_fill. faceCrop di-nuke di
    // `if (wantSplit) faceCrop = null` (line ~995/1197, scope block 9:16),
    // tapi branch 9:16_fill (entertainment auto-pick) TETAP butuh window wajah
    // biar framing ga di tengah frame kosong. Assign di block 9:16 = null buat
    // fill → wajah kepotong (job 49f9ced2 c3 @226.9). Declare di scope atas.
    let fillFaceCrop = null;
    let thisSegs = [];       // shot_segments.py segments (per-shot, akurat)
    let segShots = [];       // v12: [{start,end,multi,spk_cx}] dipakai gate
    let shots = [];          // v12: segShots setelah gate (branch split)
                            // per-segmen + branch faceCrop/split
    const srcDim = probeDim(videoPath);
    const srcW = srcDim.w, srcH = srcDim.h;

    // Subtitle: PRIORITAS YouTube ID track (timing asli, bukan ASR LLM
    // yang timing-nya meleset >1s dari ucapan). Ref: user "youtube kan
    // punya transcribe bahasa indonesia kenapa gak pake itu aja".
    // Fallback: ASR LLM per-clip (VAD timing lebih akurat dari anchor
    // YouTube auto-sub yang inherently telat).
    const srtPathAbs = srtPath && !path.isAbsolute(srtPath) ? path.join(jobDir, srtPath) : srtPath;
    const useSub = srtPathAbs && fs.existsSync(srtPathAbs) && format !== '9:16_reaction';
    console.log(`[ffmpeg] srtPath=${srtPath}, abs=${srtPathAbs}, exists=${useSub}, format=${format}`);
    let srtFinal = srtPathAbs;
    if (useSub) {
      try {
        srtFinal = await pickSubtitleSource({ fs, path, jobDir, srtPathAbs, startSec, clipDur, videoPath, ffmpegPath, spawn, toFwd });
      } catch (e) {
        console.warn(`[ffmpeg] subtitle source gagal: ${e.message}, pakai srt asli`);
      }
    }

    // SPEAKER-AWARE PAN: hitung di async area (detectSpeakers butuh await).
    // n_people=1 = 2 wajah ga muat 9:16 → pan ke pembicara AKTIF per segmen,
    // bukan statis ke 1 titik (user: "pas disebelah perempuan lagi ngomong
    // tapi frame malah ngambil muka si perempuan bukan yang lagi ngomong").
    let speakerPan = null;
    let speakerDominance = 0;  // fraction sample di pembicara terbanyak (0-1)
    let mmSp = [];             // mouth-motion per-cue: [{t,cx,speaker,nActive,faces}]
    if (srtFinal && (format === '9:16' || format === '9:16_fill' || format === '9:16_split' || format === 'adaptive')) {
      try {
        const fc0 = computeFaceCrop(videoPath, 1080, 1920, startSec, endSec);
        if (fc0 && fc0.n_people >= 1) {
          // MULTI-ORANG juga butuh speaker detect: shot wide 2-org dgn 1
          // pembicara (listener diem) = SINGLE CROP ke pembicara, BUKAN
          // split (user: "1 org fokus ngomong ya tampilin dianya aja").
          // Dulu gate (multi_ratio<0.50) skip pan → langsung split = listener
          // dapat panel sendiri padahal cuma diem. Fix: jalanin mouth-motion
          // selalu, simpan speaker distribution buat gate per-segmen.
          const { detectSpeakersMouth } = require('../ai/speaker_detect');
          const cueT = srtCueTimes(srtFinal);
          // TIMING: clean_*.srt (transcript.json) = ABSOLUT. asr_*.srt =
          // CLIP-RELATIVE (0-based). mouth_motion.py seek pakai timestamp
          // langsung, jadi ASR butuh +startSec, clean ga butuh.
          const isAsrSrt = /(^|[/\\])asr_/.test(srtFinal.replace(/\\/g, '/'));
          if (cueT.length >= 3) {
            const off = isAsrSrt ? startSec : 0;
            const pyPath = process.env.PYTHON_BIN ||
              'C:/Users/diego/AppData/Local/Programs/Python/Python311/python.exe';
            const mmScript = path.join(__dirname, '..', 'mouth_motion.py');
            const sp = await detectSpeakersMouth({
              // clean srt: window = [startSec, endSec] ABSOLUT (off=0).
              // asr srt: window = [0, endSec-startSec] CLIP-RELATIVE (off=startSec).
              videoPath, startSec: off || startSec, endSec: off ? endSec - off : endSec,
              cueTimes: cueT,
              ffmpegPath, pythonPath: pyPath, scriptPath: mmScript,
              onLog: (m) => console.log(`[ffmpeg] ${m}`),
            });
            mmSp = sp;
            // mouth_motion return per-cue (timing = cueT). Filter buang
            // sample dgn open rendah (orang lagi tutup mulut di cue itu).
            const clean = sp.filter(d => d.speaker !== 'unknown');
            const vi = probeDim(videoPath);
            speakerPan = buildSpeakerPan(clean.length ? clean : sp, fc0, vi.w, vi.h);
            // DOMINANCE: berapa fraction sample di 1 pembicara. c2: pria
            // menang 13/20 (0.65) = 1 org ngomong, listener diem → bukan
            // split. <0.60 = 2+ org aktif bergantian → split.
            const cxs = (clean.length ? clean : sp).map(d => d.cx);
            if (cxs.length) {
              const counts = {};
              cxs.forEach(c => { const k = Math.round(c * 10) / 10; counts[k] = (counts[k] || 0) + 1; });
              speakerDominance = Math.max(...Object.values(counts)) / cxs.length;
            }
            console.log(`[ffmpeg] speaker-pan: ${speakerPan ? speakerPan.keyframes.length : 0} keyframe, dominance ${speakerDominance.toFixed(2)}`);
          }
        }
      } catch (e) { console.warn(`[ffmpeg] speaker detect: ${String(e.message).slice(0, 100)}`); }
    }

    // ADAPTIVE FORMAT: 1-2 org = talking head/split, 3+ org = band blur.
    // User: "kalo 2 orang masih muat split screen, tapi 3+ orang langsung
    // ganti band blur". Hitung face count max dari mouth-motion samples.
    let maxFaces = 1;
    if (format === 'adaptive') {
      mmSp.forEach(d => {
        if (d.faces && d.faces > maxFaces) maxFaces = d.faces;
      });
      // 1-2 org → 9:16 (talking head, auto-split kalau 2 speaker aktif)
      // 3+ org → 9:16_fill (band blur, auto multi-panel kalau butuh)
      format = maxFaces >= 3 ? '9:16_fill' : '9:16';
      console.log(`[ffmpeg] ADAPTIVE resolve: max ${maxFaces} faces → ${format}`);
    }

    return new Promise((resolve, reject) => {
    // ffmpeg -ss sebelum -i = input seeking: audio+video seek bareng.
    // Timestamp output mulai 0, jadi offset subtitle = startSec.
    const args = ['-y', '-ss', String(startSec), '-t', String(clipDur), '-i', toFwd(videoPath)];
    if (hasReaction) {
      args.push('-ss', '0', '-t', String(clipDur), '-i', toFwd(reactionVideoPath));
    }

    const vf = [];
    if (format === '9:16_reaction') {
      // Split-screen reaction: main video top 60%, reaction cam bottom 40%
      if (hasReaction) {
        args.push('-filter_complex',
          '[0:v]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080[main];' +
          '[1:v]scale=1080:768:force_original_aspect_ratio=increase,crop=1080:768[react];' +
          '[main][react]vstack=inputs=2[outv]',
        );
        args.push('-map', '[outv]', '-map', '0:a');
      } else {
        vf.push('scale=1080:1080:force_original_aspect_ratio=increase');
        vf.push('crop=1080:1080:(iw-1080)/2:(ih-1080)/2');
        vf.push('pad=1080:1920:0:0:black');
      }
    } else if (format === '9:16' || format === '9:16_split') {
      // STATIC face-framing: deteksi wajah, crop 1 titik optimal sepanjang clip.
      // Video referensi user: kamera STATIS (tripod), medium close-up, wajah upper-third.
      // 9:16_split = FORCE split 2 kolom (gate OFF, paksa wantSplit=true).
      // Dynamic tracking = drift/goyang -> hapus, pakai static framing yang pas.
      faceCrop = computeFaceCrop(videoPath, 1080, 1920, startSec, endSec);
      // AUTO-SPLIT gate — PER SHOT SEGMENT, bukan window global.
      // multi_ratio window gabungan = split diterapkan ke SEMUA clip
      // termasuk segmen solo close-up (user: "dari awal udah split padahal 1
      // orang lagi fokus ngomong"). Podcast cut solo↔wide: hitung wajah per
      // shot segment, split cuma kalau MAYORITAS DURASI multi-orang.
      splitFaces = faceCrop;
      let segMultiRatio = 0;
      try {
        const pyPath = process.env.PYTHON_BIN ||
          'C:/Users/diego/AppData/Local/Programs/Python/Python311/python.exe';
        const segScript = path.join(__dirname, '..', 'shot_segments.py');
        const { spawnSync: spSync } = require('child_process');
        const rs = spSync(pyPath, [segScript, videoPath, String(startSec),
          String(endSec), '', '0.25'],
          { captureOutput: true, timeout: 300000, windowsHide: true,
            env: { ...process.env, FFMPEG_BIN: ffmpegPath } });
        if (rs.error) console.warn(`[ffmpeg] shot-segments spawn error: ${rs.error.message}`);
        if (rs.status !== 0 && rs.stderr) console.warn(`[ffmpeg] shot-segments py exit=${rs.status}: ${(rs.stderr||'').toString().slice(-200)}`);
        const ls = (rs.stdout || '').toString().split('\n');
        const jl = ls.reverse().find(l => l.trim().startsWith('{'));
        if (jl) {
          const segs = JSON.parse(jl).segments || [];
          thisSegs = segs;
          const total = segs.reduce((a, s) => a + (s.end - s.start), 0);
          const multiT = segs.filter(s => s.faces >= 2)
            .reduce((a, s) => a + (s.end - s.start), 0);
          segMultiRatio = total > 0 ? multiT / total : 0;
          console.log(`[ffmpeg] shot-segments: ${segs.length} seg, multi ${Math.round(segMultiRatio * 100)}% durasi`);
        }
      } catch (e) { console.warn(`[ffmpeg] shot-segments gagal: ${e.message}`); /* fallback ke multi_ratio window */ }
      // FALLBACK: shot_segments TIMEOUT (raw 663MB scene-detect >300s) →
      // thisSegs kosong → graph NULL → static crop center meleset (job
      // d7fce121: shot-segments exit=null, output @20s 0 wajah). Sample
      // detectFacesAt di 5 titik interval = segmen sintetis kasar.
      if (!thisSegs.length && clipDur >= 8) {
              const nP = Math.min(6, Math.max(3, Math.floor(clipDur / 8)));
              for (let i = 0; i < nP; i++) {
                const absT = startSec + (clipDur * (i + 0.5)) / nP;
                const one = detectFacesAt(videoPath, absT, 1280);
                thisSegs.push({
                  start: startSec + (clipDur * i) / nP,
                  end: startSec + (clipDur * (i + 1)) / nP,
                  faces: one && one.faces ? one.faces.length : 0,
                  // wMax: lebar wajah TERBESAR di sample. Close-up (w>0.22)
                  // = 1 org deket kamera → jangan split panel (wajah > panel
                  // 486px, kepotong). Solo full-height crop.
                  wMax: one && one.faces ? Math.max(...one.faces.map(f => f.w)) : 0,
                  spk_cx: one && one.faces ? one.faces.map(f => f.cx) : null,
                  spk_cy: one && one.faces ? one.faces.map(f => f.cy) : null,
                });
              }
              console.log(`[ffmpeg] shot-segments TIMEOUT → fallback ${thisSegs.length} segmen sample detectFacesAt`);
            }
      // shot_segments lebih akurat (per segmen); fallback computeFaceCrop.
      // GATE PER-SEGMENT (user 2026-09-28): split BUKAN ke seluruh clip.
      // c4: multi hanya 16.9s/127s → splitRatio 0.13 → gate lama (>=0.50)
      // menolak split → wide 3-org jadi 1 panel. Gate baru: pakai shot
      // segments langsung — split cuma di segmen multi, solo tetap 1 panel.
      // speakerPan TIDAK mematikan split: shot wide multi-orang tetap
      // butuh split meski speaker-pan ada (pan cover segmen solo, split
      // cover segmen multi — branch MULTI-SHOT gabung keduanya).
      const segRatio = segMultiRatio || (faceCrop ? faceCrop.multi_ratio : 0) || 0;
      // GATE = CONVERSATION TIMELINE: split BUKAN per jumlah wajah di frame
      // saja. 2 org di frame tapi cuma 1 ngomong = per-SEGMEN gate nentuin
      // solo-vs-split (mouth-motion activity line 1258+). Gate GLOBAL:
      // konfirmasi ada ≥2 org BENERAN (shot_segments) + multi ratio cukup.
      // convRatio/oneSpeaker TIDAK matiin split — per-segmen gate yang handle.
      // User 2026-10-14: \"3 orang tapi cuma 1 panel → badan kepotong setengah,
      // harusnya auto-split 3 panel biar muka semua keliatan\".
      const nAct = mmSp.filter(d => d.nActive >= 2).length;
      const convRatio = mmSp.length ? nAct / mmSp.length : 0;
      const segMaxFaces = thisSegs.reduce((m, s) => Math.max(m, s.faces || 1), 0);
      const segConfirmsMulti = segMaxFaces >= 2;
      // wantSplit = APAKAH PUNYA SEGMEN MULTI yang butuh split layout.
      // Per-segmen gate (mouth-motion) nanti nentuin segmen mana yang split
      // vs solo. Gate ini cuma: "punya orang ≥2 + ada segmen multi?"
      wantSplit = !!(splitFaces && (segConfirmsMulti || splitFaces.n_people >= 2) &&
        segRatio > 0.02);
      // shot_segments bilang 0 segmen multi (thisSegs ada & akurat) = video
      // solo / vlog cut-cepat → OFF classic split, pakai static/solo crop.
      if (thisSegs.length && !segConfirmsMulti) {
        wantSplit = false;
      }
      console.log(`[ffmpeg] CONV: active2=${convRatio.toFixed(2)} segMulti=${segConfirmsMulti} faces=${segMaxFaces} wantSplit=${wantSplit}`);
      // 9:16_split = FORCE split (user pilih manual "2 Kolom"): paksa
      // wantSplit + semua segmen multi=true (gate AI di-bypass).
      if (format === '9:16_split') {
        wantSplit = !!(splitFaces && splitFaces.n_people >= 2);
        console.log(`[ffmpeg] 9:16_split FORCE: wantSplit=${wantSplit} (n=${splitFaces ? splitFaces.n_people : 'null'})`);
      }
      // v21: snapshot ke fillFaceCrop SEBELUM di-nuke. wantSplit=true →
      // faceCrop=null (split pake graph sendiri), tapi 9:16_fill butuh window.
      if (faceCrop) fillFaceCrop = faceCrop;
      if (wantSplit) faceCrop = null;  // jangan push static crop (split pake graph sendiri)
      // ponytail: MERGE segmen dgn STRUKTUR SAMA (v18, job bc297bc4 Idgitaf).
      // Video vlog/musik cut kamera tiap 2-3s → shot_segments pecah jadi
      // 13-21 segmen → MULTI-SHOT render cut tiap segmen = kamera pindah
      // terus = pusing. Cut kamera BUKAN alasan ganti layout. Layout cuma
      // boleh ganti kalau JUMLAH ORANG / pembicara BERUBAH (speaker swap,
      // solo→multi, B-roll tanpa wajah). Segmen berurutan dgn multi-status
      // + posisi wajah serupa = 1 layout sama → gabung.
      const _raw = (thisSegs && thisSegs.length ? thisSegs :
        (splitFaces.shots || []));
      segShots = _raw.map(s => {
          const nspk = (s.n_speaker != null) ? s.n_speaker : null;
          const multi = (s.faces != null ? s.faces : (s.multi ? 2 : 1)) >= 2;
          // 2+ org ngomong aktif di segmen ini = split. 1 atau ga tau =
          // jangan split (single crop).
          const doSplit = multi && nspk != null ? nspk >= 2 : multi;
          // B-ROLL GUARD: segmen tanpa wajah (YuNet 0 di semua sample) =
          // cutaway/B-roll (video musik, panning bangunan,orang dari
          // belakang). Bukan percakapan → SOLO, jangan split (split 2 panel
          // B-roll = 2 panel adegan SAMA = pusing).
          const cxs = (s.cx || s.spk_cx || []);
          const noFace = !multi && cxs.length === 0;
          // CLOSE-UP GUARD: jika 1 wajah terlalu besar (>0.32), itu bukan multi-shot
          // tapi solo dekat kamera. Khusus scene 3+ orang (maxFaces>=3), jangan
          // matikan split gara-gara closeUp, karena 3 orang butuh 3 panel.
          const closeUp = (s.wMax || 0) > 0.32 && (maxFaces < 3);
          return { start: s.start, end: s.end,
                   multi: (noFace || closeUp) ? false : doSplit, rawMulti: multi,
                   wMax: s.wMax || 0,
                   spk_cx: s.spk_cx || [],
                   track_cx: Array.isArray(s.track_cx) ? s.track_cx : null };
        }).filter(s => s.end > s.start + 0.3);
      // MERGE: segmen berurutan dgn status multi SAMA + cx pembicara mirip
      // (Δ<0.12) = layout sama → gabung jadi 1 segmen. cx = median gabungan.
      // DULU merge <0.6s di shot_segments (flicker); ini merge berbasis
      // STRUKTUR, durasi ga dibatasi. c1 bc297bc4 21 seg → ~4 layout.
      {
        const merged = [];
        for (const s of segShots) {
          const prev = merged[merged.length - 1];
          if (prev && prev.multi === s.multi) {
            // SOLO/SOLO atau SPLIT/SPLIT: cek cx pembicara mirip?
            const a = (prev.spk_cx && prev.spk_cx.length) ? prev.spk_cx[0] : null;
            const b = (s.spk_cx && s.spk_cx.length) ? s.spk_cx[0] : null;
            // B-roll (cx null) atau cx deket = org sama masih → gabung
            const sameSpeaker = (a == null || b == null) || Math.abs(a - b) < 0.12;
            if (sameSpeaker) {
              prev.end = s.end;
              // track_cx gabung urut waktu
              if (Array.isArray(prev.track_cx) && Array.isArray(s.track_cx)) {
                prev.track_cx = [...prev.track_cx, ...s.track_cx];
              } else if (Array.isArray(s.track_cx)) {
                prev.track_cx = [...s.track_cx];
              }
              // spk_cx gabung (median-ish: ambil semua, consumer pakai [0])
              prev.spk_cx = [...(prev.spk_cx||[]), ...(s.spk_cx||[])];
              continue;
            }
          }
          merged.push({ ...s });
        }
        if (merged.length < segShots.length) {
          console.log(`[ffmpeg] MERGE v18: ${segShots.length} → ${merged.length} layout segmen`);
        }
        segShots = merged;
      }

      // ============ GATE PER-SEGMEN ACTIVITY (v12) ============
      // DULU: speakerDominance>=0.60 GLOBAL → matiin split SEMUA segmen
      //   → c2: dominance 0.70 → semua segmen multi di-override solo →
      //   "dari awal cuma 1 layout", padahal 133.5+ dua2nya aktif beneran.
      // BARU: per-SEGMEN. 2+ org aktif bicara di segmen itu = split
      //   (reaction/tabrakan). 1 org = solo crop ke pembicara itu.
      //   User: "split hanya ketika ada reaction atau 2 orang sama-sama
      //   bertabrakan bicara, kalo 1 orang aja yang ngomong cukup 1 frame".
      // RAW FRAMES (semua sample mouth_motion, merata+gap-fill) — bukan
      // per-cue mapping. Peak vokal 0.066@127.4 cuma ketangkap di raw.
      const rawFrames = (mmSp && mmSp.rawFrames) || mmSp || [];
      if (rawFrames.length) {
        // cluster wajah horizontal (podcast 2-shot): L cx<0.5, R cx>=0.5.
        // open > SPEAK_THR = mulut buka = bicara/reaksi (bukan diem/senyum).
        // ACT threshold: senyum konstan ~0.019-0.021, reaksi/ketawa
        // 0.025-0.035, bicara penuh 0.040+. c5: wanita ketawa 0.029 butuh
        // split (reaksi = 2 org aktif). DULU 0.030 = ketawa lolos sebagai
        // jeda → c5 0 split (regresi dari v9 multi 69%).
        const ACT = 0.022;
        segShots.forEach(s => {
          const inSeg = rawFrames.filter(d => d.t >= s.start - 0.4 && d.t <= s.end + 0.4);
          if (!inSeg.length) return;
          // CLUSTER via spk_cx shot_segments (posisi wajah asli YuNet per
          // segmen), BUKAN hardcode L<0.5/R>=0.5. Close-up hoodie man cx
          // 0.502 → hardcode baca cluster R padahal dalemnya wajah lain.
          // ANCHOR = cluster wajah dari rawFrames sendiri (0.15 bucket),
          // bukan spk_cx shot_segments (bisa false-positive YuNet di
          // close-up). Group open tertinggi per cluster.
          // BUCKET cx 0.12 + PERSISTENSI: wajah asli muncul di >1 sample,
          // false-positive YuNet (mug/mic/shot-boundary) cuma 1 sample.
          // c5 job 4671a17a: segmen 541.3-546.7 (solo buzzcut cx 0.54)
          // kena sample 547.0 (shot cut wide 2-org, cx 0.348) → bucket 0.34
          // open 0.029 menang → crop kiri → wajah asli kepotong KANAN.
          const buckets = {};
                    for (const d of inSeg) for (const f of (d.faces || [])) {
                      // ponytail v21: threshold 0.82 membuang wajah ORANG BAWAH/DUDUK
                      // (job wanita duduk agak rendah cy 0.85 → wajah kepotong). Naikkan ke 0.90
                      // agar wajah di bagian bawah tetap terdeteksi dengan aman.
                      if (f.cy > 0.90) continue;
                      const k = Math.round(f.cx / 0.12) * 0.12;
                      if (!buckets[k]) buckets[k] = { cxs: [], opens: [], mx: 0, n: 0 };
                      buckets[k].cxs.push(f.cx);
                      buckets[k].opens.push(f.open || 0);
                      buckets[k].mx = Math.max(buckets[k].mx, f.open);
                      buckets[k].n++;
                    }
                    // BICARA PERSISTEN vs REAKSI SEKEJAP: hitung berapa SAMPLE mulut
                    // buka (>= ACT), bukan cuma max. Listener yang sekali ketawa
                    // (1 sample mx 0.03) BUKAN pembicara; pembicara asli buka mulut
                    // berkali-kali (nOpen >= 2). User: "cuma 1 orang ngomong tapi
                    // split 2 layer, ga ada ekspresi apapun".
                    const annotate = b => ({
                      cx: b.cxs.sort((a, c) => a - c)[Math.floor(b.cxs.length / 2)],
                      mx: b.mx, n: b.n,
                      nOpen: b.opens.filter(o => o >= ACT).length,
                    });
                    const anchor = Object.values(buckets)
                      .filter(b => b.n >= 2)          // persist: ≥2 sample = wajah asli
                      .map(annotate)
                      // PEMBICARA = nOpen tertinggi (paling sering buka mulut), tiebreak mx.
                      .sort((a, b) => (b.nOpen - a.nOpen) || (b.mx - a.mx));
                    const opens = anchor.map(a => a.mx);
                    // fallback: semua bucket <2 sample (segmen sangat pendek) →
                    // jangan buang, tetap pakai sample tunggal.
                    let anchorF = anchor;
                    if (!anchorF.length) {
                      anchorF = Object.values(buckets)
                        .map(b => annotate({ ...b, n: 1 }))
                        .sort((a, b) => (b.nOpen - a.nOpen) || (b.mx - a.mx));
                    }
                    // SPLIT hanya kalau 2+ orang BICARA PERSISTEN (nOpen>=2 masing2),
                    // bukan 1 pembicara + 1 listener yang kebetulan bereaksi sekejap.
                    const nAct = anchorF.filter(a => a.nOpen >= 2).length;
                                        const nActLoose = anchorF.filter(a => a.mx >= ACT).length;
                                        s.nAct = nAct;  // untuk gate anti-flicker (v22h)
                                        s.anchorN = anchorF.length;  // wajah persisten = org asli (3 panel)
                    const wasMulti = s.multi;
                    // Multi kalau 2+ pembicara persist; ATAU 1 pembicara + 1 reaksi
                    // kuat (mx tinggi DAN nOpen>=1 = ekspresif/ketawa nyata, bukan noise).
                    const strongReaction = anchorF.filter(a => a.mx >= 0.030 && a.nOpen >= 1).length;
                    s.multi = wasMulti && (nAct >= 2 || (nAct >= 1 && strongReaction >= 2));
          // cx pembicara SOLO = cluster open tertinggi (pan/crop ke dia).
          // SOLO/ JEDA: tetap set spk_cx ke wajah open-tertinggi WALAU
          // < ACT. Speaker bukaan mulut kecil (c5 buzzcut open 0.017 di
          // bawah ACT 0.022) tapi DIA satu2nya orang di segmen — spk_cx
          // global = wajah lain → crop meleset (screenshot user: wajah
          // di kanan terpotong, cuma keliatan samping).
          if (!s.multi && anchorF.length) {
            // FIX centering: spk_cx = MEDIAN SEMUA sample di bucket anchor
            // (anchorF[0].cx cuma cx 1 bucket = bisa meleset pas YuNet
            // lihat wajah miring). Median semua sample = posisi stabil.
            const bucketAll = [];
            const cyAll = [];
            for (const d of inSeg) for (const f of (d.faces || [])) {
              if (f.cy > 0.82) continue;
              if (Math.abs(f.cx - anchorF[0].cx) <= 0.06) {
                bucketAll.push(f.cx); cyAll.push(f.cy);
              }
            }
            const med = arr => arr.length ? arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;
            // v22i: MEDIAN langsung (bukan range center). YuNet noise
            // (mic/mug/false-positive) bikin range lebar → mid-range meleset
            // dari wajah asli. Median = robust ke outlier, wajah asli dominan.
            // User: "wajah ga pas di tengah, sering kepotong kanan/kiri".
            if (bucketAll.length >= 3) {
              s.spk_cx = [med(bucketAll)];
            } else {
              s.spk_cx = [med(bucketAll) || anchorF[0].cx];
            }
            s.spk_cy = [med(cyAll) || 0.42];
            // TRACKING: sample cx pembicara utama di tiap rawFrame segmen
            // (urut waktu). 1 posisi statis → wajah drift di segmen panjang.
            // Step-cut halus pakai expr if(lt(t,T),A,B).
            // GATE keyframe: YuNet noise ±0.05/sample → kamera weaving
            // kiri-kanan (f55.5 0.40 → f57 0.58 → f60 0.28 = "geser-geser").
            // Hanya gerakan ASLI: |Δcx| > 0.05 dari keyframe terakhir, DAN
            // total span <0.08 = orang diem → static median (no tracking).
            // TRACKING: cx sample URUT WAKTU dari shot_segments (3 titik
            // @25/50/75%), BUKAN rawFrames mouth_motion — sample mouth_motion
            // @30%-per-shot-sendiri (scene detect beda merge) = sample dari
            // segmen lain masuk filter inSeg ±0.4s → track_cx salah segmen
            // (pv0 track cx 0.59+ padahal segmen cx 0.49 → wajah x=0.20).
            const cxsRaw = (Array.isArray(s.track_cx) ? s.track_cx : [])
              .map(c => (typeof c === 'number' ? c : null)).filter(c => c != null);
            const span = cxsRaw.length ? Math.max(...cxsRaw) - Math.min(...cxsRaw) : 0;
            // USER (c2_9-16-3/c5_9-16-6): "kamera jangan bergerak-gerak.
            // Ketika ganti orang gw mau langsung nangkep posisinya di tengah
            // dia." Kamera STATIS per pembicara, INSTANT CUT pas ganti.
            // span < 0.05 = diem betul → static. >= 0.05 = TRACKING.
            if (span < 0.15) {
              // USER "kamera jangan bergerak-gerak": goyang ngomong
              // (0.05-0.15) = STATIC di median cx pembicara. Kamera stay.
              s.track_cx = null;
            } else {
              // pembicara PINDAH posisi jauh (>= 0.15): instant cut ke
              // posisi baru. hysteresis 0.15 = 1 keyframe per perpindahan.
              const gated = [cxsRaw[0]];
              for (const c of cxsRaw.slice(1)) {
                if (Math.abs(c - gated[gated.length - 1]) > 0.15) gated.push(c);
              }
              s.track_cx = (gated.length >= 2 && cxsRaw.length >= 4) ? gated : null;
            }
          }
          console.log(`[ffmpeg] SEG ${s.start.toFixed(1)}-${s.end.toFixed(1)} opens=[${anchorF.map(a => a.mx.toFixed(3)).join(',')}] cx=[${anchorF.map(a => a.cx.toFixed(2)).join(',')}] → ${s.multi ? 'SPLIT' : (nAct === 1 ? 'SOLO' : 'jeda')}` + (wasMulti !== s.multi ? ' (override)' : ''));
        });

        // JEDA cx warisan: jeda (nAct=0) tapi ada wajah terdeteksi →
        // kamera STICK ke pembicara terakhir, jangan loncat ke wajah diem.
        // User: "pindah-pindah cepet padahal gak ngomong".
        for (let i = 0; i < segShots.length; i++) {
          const s = segShots[i];
          if (s.multi || !s.spk_cx || s.nAct >= 1) continue;
          // Jeda (nAct=0): cari solo terakhir sebelumnya
          for (let j = i - 1; j >= 0; j--) {
            const prev = segShots[j];
            if (!prev.multi && prev.spk_cx && prev.nAct >= 1) {
              s.spk_cx = [...prev.spk_cx];
              s.spk_cy = [...(prev.spk_cy || [0.42])];
              console.log(`[ffmpeg] JEDA ${s.start.toFixed(1)}-${s.end.toFixed(1)} warisan cx=${s.spk_cx[0].toFixed(2)} dari ${prev.start.toFixed(1)}`);
              break;
            }
          }
        }
      }
      // ============ STABILISASI LAYOUT (anti-pusing) ============
      // User: "ganti-gantinya cepet banget bikin pusing. Priority: orang
      // yang keluar suara aja yang difokusin; ngomong di sela/ekspresif
      // baru multi cam." Dua langkah:
      // (1) DEMOTE: segmen SPLIT < 3.5s diapit SOLO = interupsi sesaat
      //     → layout balik ke SOLO (jangan ganti layout demi 3 detik).
      // (2) RE-MERGE: sisa segmen berurutan multi SAMA + cx serupa
      //     digabung lagi (ACT gate bisa fragmentasi setelah merge awal).
      {
        const st = segShots;
        for (let i = 0; i < st.length; i++) {
          const s = st[i];
          if (!s.multi) continue;
          const dur = s.end - s.start;
          const prevSolo = i > 0 && !st[i - 1].multi;
          const nextSolo = i < st.length - 1 && !st[i + 1].multi;
          if (dur < 3.5 && prevSolo && nextSolo) {
            s.multi = false;
            console.log(`[ffmpeg] DEMOTE ${s.start.toFixed(1)}-${s.end.toFixed(1)} split<3.5s diapit solo → SOLO (anti-flicker)`);
          }
        }
        const merged2 = [];
        for (const s of st) {
          const prev = merged2[merged2.length - 1];
          if (prev && prev.multi === s.multi) {
            const a = (prev.spk_cx && prev.spk_cx.length) ? prev.spk_cx[0] : null;
            const b = (s.spk_cx && s.spk_cx.length) ? s.spk_cx[0] : null;
            const same = (a == null || b == null) || Math.abs(a - b) < 0.12;
            if (same) {
              prev.end = s.end;
              if (Array.isArray(prev.track_cx) && Array.isArray(s.track_cx)) {
                prev.track_cx = [...prev.track_cx, ...s.track_cx];
              } else if (Array.isArray(s.track_cx)) prev.track_cx = [...s.track_cx];
              prev.spk_cx = [...(prev.spk_cx || []), ...(s.spk_cx || [])];
              continue;
            }
          }
          merged2.push({ ...s });
        }
        if (merged2.length < st.length) {
          console.log(`[ffmpeg] RE-MERGE pasca-gate: ${st.length} → ${merged2.length} layout`);
        }
        segShots = merged2;

        // (3) ENFORCE MINIMUM SHOT DURATION: shot < 2s (solo/split apapun)
        //     digabung ke tetangga terpanjang → anti-pusing universal.
        //     User: "pindah-pindahnya cepet banget padahal gak ngomong".
        const MIN_SHOT = 2.0;
        let changed = true;
        while (changed && segShots.length > 1) {
          changed = false;
          for (let i = 0; i < segShots.length; i++) {
            const s = segShots[i];
            const dur = s.end - s.start;
            if (dur >= MIN_SHOT) continue;
            // Pilih tetangga terpanjang (prev vs next)
            const prev = i > 0 ? segShots[i - 1] : null;
            const next = i < segShots.length - 1 ? segShots[i + 1] : null;
            const prevDur = prev ? prev.end - prev.start : 0;
            const nextDur = next ? next.end - next.start : 0;
            if (!prev && !next) break;
            const mergeWith = (prevDur >= nextDur && prev) ? prev : next;
            if (mergeWith === prev) {
              prev.end = s.end;
              prev.track_cx = [...(prev.track_cx || []), ...(s.track_cx || [])];
              prev.spk_cx = [...(prev.spk_cx || []), ...(s.spk_cx || [])];
              segShots.splice(i, 1);
            } else {
              next.start = s.start;
              next.track_cx = [...(s.track_cx || []), ...(next.track_cx || [])];
              next.spk_cx = [...(s.spk_cx || []), ...(next.spk_cx || [])];
              segShots.splice(i, 1);
            }
            console.log(`[ffmpeg] MIN-SHOT ${s.start.toFixed(1)}-${s.end.toFixed(1)} ${dur.toFixed(1)}s < ${MIN_SHOT}s → merge`);
            changed = true;
            break;
          }
        }
      }
      shots = segShots;
      console.log(`[ffmpeg] SPLIT DEBUG n_people=${splitFaces.n_people} multi=${splitFaces.multi_ratio} speakers=${(splitFaces.speakers||[]).length} shots=${shots.length} graph=${splitGraph ? 'OK' : 'NULL'}`);

      if (faceCrop && speakerPan && speakerPan.single) {
        // SINGLE-SPEAKER lock: kamera statis di cx pembicara LLM (YuNet
        // dominan cluster bisa beda orang → crop ke wrong face).
        const vi = probeDim(videoPath);
        const w = Math.min(faceCrop.w, vi.w);
        const h = Math.round(w * 16 / 9);
        const x = Math.max(0, Math.min(speakerPan.keyframes[0].x, vi.w - w));
        const y = Math.max(0, Math.min(faceCrop.y, vi.h - h));
        vf.push(`crop=${w}:${h}:${x}:${y}`);
        vf.push('scale=1080:1920');
        console.log(`[ffmpeg] single-speaker lock: crop ${w}x${h} @(${x},${y}) cx=${speakerPan.keyframes[0].x}`);
      } else if (faceCrop && speakerPan && speakerPan.interpolate && speakerPan.keyframes.length >= 2) {
        // SPEAKER-AWARE PAN dengan INTERPOLASI linier per-frame (crop expr).
        // sendcmd stepwise = wajah kepotong di antara command (shot ganti
        // cepat cx 0.63→0.45→0.64). Crop expr: nested if = lerp antar keyframe.
        const kf = speakerPan.keyframes;
        // KEYFRAME t = ABSOLUT (dari detectSpeakers: startSec + cueT). ffmpeg
        // -ss sebelum -i = output timestamp mulai 0 → filter t = CLIP-RELATIVE.
        // Konversi: t_clip = t_abs - startSec. TANPA ini: lt(t,386) selalu
        // true di clip 45s → keyframe kedua ga pernah aktif = kamera beku di
        // keyframe pertama (wajah kepotong).
        const t0 = startSec || 0;
        const kfRel = kf.map(k => ({ t: Math.max(0, k.t - t0), x: k.x }));
        // bangun expr: clamp(t) → segmen → lerp
        let expr = String(kfRel[kfRel.length - 1].x);
        for (let i = kfRel.length - 2; i >= 0; i--) {
          const a = kfRel[i], b = kfRel[i + 1];
          const dt = Math.max(0.001, b.t - a.t);
          // x = a.x + (b.x - a.x) * clamp((t - a.t) / dt, 0, 1)
          expr = `if(lt(t,${b.t.toFixed(2)}),${a.x},(${expr}))`;  // STEP cut: instant, gak lerp
        }
        const vi = probeDim(videoPath);
        const w = Math.min(speakerPan.w, vi.w);
        // RASIO 9:16 WAJIB: h harus ikut zoom. Kalau w=450 tapi h=1080
        // → crop 450x1080 (rasio 0.417) → scale ke 1080x1920 = SQUEEZE
        // muka gepeng/melebar. h = w * 16/9.
        const h = Math.round(w * 16 / 9);
        const y = Math.max(0, Math.min(speakerPan.y, vi.h - h));
        // simpan keyframe buat debug (mirip pan_*.txt dulu)
        const dbgFile = path.join(jobDir, `pan_${Math.round(startSec * 10)}.txt`);
        fs.writeFileSync(dbgFile, kf.map(k => `${k.t.toFixed(2)} crop x ${k.x};`).join('\n') + '\n');
        // ponytail: KOMA di dalam crop expr (clip(a,b,c)) di-parse ffmpeg
        // sebagai FILTER SEPARATOR → "No such filter: '32.73'". Bungkus expr
        // dengan single-quote di filtergraph.
        vf.push(`crop=${w}:${h}:'${expr}':${y}`);
        vf.push('scale=1080:1920');
        console.log(`[ffmpeg] speaker-pan: ${kf.length} keyframe (interpolated), w=${w}`);
      } else if (faceCrop) {
        // STATIC crop: single speaker ATAU multi-orang tapi wajahnya muat
        // 9:16 (n>=2 tapi multi_ratio < 0.35 = 1 org duduk diam, cluster
        // palsu muka/samping/belakang). auto-split branch di bawah tolak
        // kalau multi_ratio rendah → kesini, crop normal speaker utama.
        // MULTI-FACE auto-fit: 2 orang = tengah antar mereka, 4 orang = tengah
        // kumpulan. compute_crop hitung center + zoom yang muat semua wajah.
        // User: "auto split screen nya gausah, pas 2 orang ditengah mereka,
        // 4 orang pun ditengah mereka".
        // SKIP kalau n_people>=2: split-layout branch yang handle (crop per
        // wajah). Kalau dua-duanya jalan = crop 608x1080 dobel + ffmpeg
        // "Invalid too big size" (verified exit 4294967274).
        vf.push(`crop=${faceCrop.w}:${faceCrop.h}:${faceCrop.x}:${faceCrop.y}`);
        // crop window sudah EXACT 9:16 (compute_crop jaga rasio) → scale langsung
        // ke 1080x1920. force_original_aspect_ratio=decrease + pad = BAR HITAM
        // tebal kalau rasio crop sedikit meleset (user complaint 4 screenshot).
        vf.push('scale=1080:1920');
        console.log(`[ffmpeg] face-framing: crop ${faceCrop.w}x${faceCrop.h} @(${faceCrop.x},${faceCrop.y}) zoom=${faceCrop.zoom} n=${faceCrop.n_people ?? 1}`);
        // GUARD: crop window harus muat di source. compute_crop bisa kasik
        // window > source (bug zoom-out) -> ffmpeg "Invalid too big size" ->
        // seluruh render clip gagal (8/10 clip job test gagal).
        const vi = probeDim(videoPath);
        faceCrop.w = Math.min(faceCrop.w, vi.w);
        faceCrop.h = Math.min(faceCrop.h, vi.h);
        faceCrop.x = Math.max(0, Math.min(faceCrop.x, vi.w - faceCrop.w));
        faceCrop.y = Math.max(0, Math.min(faceCrop.y, vi.h - faceCrop.h));
      } else {
        vf.push('scale=1080:1920:force_original_aspect_ratio=increase');
        vf.push('crop=1080:1920:(iw-1080)/2:(ih-1920)/2');
      }
    } else if (format === '9:16_fill') {
      // BLURRED-BACKGROUND (ref TikTok @langkahhening0 + @adereskiamaldo):
      // canvas 1080x1920, video landscape di-scala SAMPAI TINGGI band 79%
      // (ref: band tajam 75-84% tinggi, blur cuma ~20%). Konsekuensi: sisi
      // kiri/kanan ke-crop ~30%/sisi — ref juga begitu (tanda "kasisolus"
      // kepotong pinggir). Full fit (band 32%) = subjek kecil + space blur
      // banyak → user: "untuk tiktok terlihat kecil dan banyak space kosong".
      // BAND_AUTO: portrait source (9:16, 4:5) → fit penuh, blur ga keliatan.
      const BAND = 0.79;
      const MIN_KEEP = 0.35;  // min fraksi lebar source yg ditampilkan
      let hb = Math.round(1920 * BAND);
      const hbMax = Math.round(1080 * srcH / (srcW * MIN_KEEP));
      if (hbMax < hb) hb = Math.max(hbMax, Math.round(1920 * 0.45));
      hb -= hb % 2;  // ffmpeg scale butuh genap
      const wAtBand = srcW * (hb / srcH);
      // ponytail v21: FG crop WAJIB ikut posisi WAJAH, bukan center frame.
      // Sebelumnya `scale=-2:${hb},crop=1080:${hb}:(iw-1080)/2:0` = scale
      // FULL tinggi source lalu crop hb-tall = yCrop MUTLAK 0. Orang
      // BERDIRI (wajah cy 0.15-0.28, job 49f9ced2 c3 @226.9) numpuk di
      // pinggir ATAS band = "kamera ngarah tengah, ga ada muka" (user
      // 2026-10-02).
      // FIX: faceCrop = compute_crop face_frame.py = window 9:16 yang
      // UDAH muat SEMUA wajah (faces_fit guard). Scale window itu ke
      // tinggi band, zoom biar lebar 1080 (3 org @853px → 1.27x). Crop
      // INSTANT (static window, user: "langsung inframe ketengah", no pan).
      // faceCrop null (no face / B-roll) = fallback behavior lama.
      let fgChain = wAtBand >= 1080
        ? `scale=-2:${hb},crop=1080:${hb}:(iw-1080)/2:0,setsar=1`
        : `scale=1080:1920:force_original_aspect_ratio=decrease,setsar=1`;
      let fillNote = '';
      // v21: computeFaceCrop KHUSUS fill (block 9:16 skip untuk format ini).
      // window 9:16 yang muat semua wajah → fg crop ikut wajah, bukan tengah.
      let fillFC = fillFaceCrop;
      try {
        if (!fillFC) {
          fillFC = computeFaceCrop(videoPath, 1080, 1920, startSec, endSec);
          fillFaceCrop = fillFC;
          if (fillFC) console.log(`[ffmpeg] fill face-crop: ${fillFC.w}x${fillFC.h} @(${fillFC.x},${fillFC.y}) n=${fillFC.n_people ?? 1} cy=${fillFC.face_cy}`);
        }
      } catch (e) { console.warn(`[ffmpeg] fill face-crop gagal: ${e.message}`); }
      if (fillFC && fillFC.w && fillFC.h && wAtBand >= 1080) {
        try {
          // fillFaceCrop = compute_crop face_frame.py = window 9:16 yang
          // UDAH muat SEMUA wajah (faces_fit guard). Band 79% (1080x1516)
          // BUKAN 9:16 (0.712 vs 0.5625) → window ga muat utuh. Scale
          // window biar LEBAR=1080 (tinggi 1920 > band), crop vertikal ke
          // band ambil bagian di sekitar WAJAH. Semua wajah horizontal
          // muat; vertikal di-crop area tanpa wajah (kaki/meja).
          // Crop INSTANT (static), user: "langsung inframe ketengah", no pan.
          // ponytail: YuNet MISS wajah profil/gerak (c1 job 49f9ced2: 2 org
          // dideteksi 1, wajah cx 0.36 keluar window cx 0.62 → kepotong).
          // n<=1 = mungkin ada org lain ga kedetect → window = TENGAH frame
          // lebar 55% source (jamin 2-org shot miss-detect tetep masuk).
          // n>=2 = window asli compute_crop (sudah muat semua wajah).
          const fcw = fillFC;
          if ((fcw.n_people ?? 1) <= 1) {
            const wideW = srcW * 0.55;
            if (fcw.w < wideW) {
              fcw.w = wideW;
              fcw.x = (srcW - wideW) / 2;
            }
          }
          const sx = Math.max(1080 / fcw.w, hb / srcH);  // min zoom: lebar 1080 ATAU tinggi band
          // Ambang split ADAPTIF: split HANYA kalau 2 wajah GA muat 1 panel.
          // Band 1080px dari scaled canvas: pasangan muat kalau
          // spread*srcW*sx + 2*halfFace <= 1080 → sp <= 1080/(srcW*sx) - 0.16.
          // (0.28 statis = bug 2026-10-06: semua clip kesplit; c1 spread 0.24-0.36
          //  masih muat 1 panel lebar 1080.)
          const scaleOutW = srcW * sx;
          const scaleOutH = srcH * sx;
          let xCrop = fcw.x * sx;             // window x di scaled canvas
          xCrop = Math.max(0, Math.min(Math.max(0, scaleOutW - 1080), xCrop));
          // vertikal: BUKAN median — pakai cy TERENDAH (wajah paling atas)
          // biar KEPALA ga kepotong atas band. Band 1516 < window 1920 →
          // ada yang kepotong vertikal; korban area tanpa wajah (kaki/meja).
          // cyMin speakers = wajah paling tinggi. Headroom 12% band di atasnya.
          let cyMin = 0.5, cyMid = 0.5;
          const spc = (fcw.speakers || []).filter(f => typeof f.cy === 'number');
          if (spc.length) {
            const cys = spc.map(f => f.cy).sort((a, b) => a - b);
            cyMin = cys[0]; cyMid = cys[Math.floor(cys.length / 2)];
          } else if (typeof fcw.face_cy === 'number') { cyMin = cyMid = fcw.face_cy; }
          // target: wajah paling atas di ~12% band (headroom), dominan ~38%
          let yCrop = Math.round(cyMin * scaleOutH - hb * 0.12);
          yCrop = Math.max(0, Math.min(Math.max(0, scaleOutH - hb), yCrop));
          fgChain = `scale=${Math.round(scaleOutW)}:${Math.round(scaleOutH)},crop=1080:${hb}:${Math.round(xCrop)}:${yCrop},setsar=1`;
          // AUTO PANEL untuk fill (user 2026-10-04: "yang ukuran formatnya
          // gak full masih ada bug yaitu gaada auto panel layout seperti yang
          // format ukuran fullnya"). Band 79% (1080x1516) cuma muat SATU
          // wajah kalau wajah berjauhan → org kedua keluar window / kepotong.
          // Split band jadi 2 KOLOM (540x1516 masing2), 1 wajah per kolom,
          // hstack balik 1080. Rasio kolom 0.356 (portrait) → crop dari
          // source zW = srcH*0.356 ≈ 385px, cukup buat wajah 230-400px.
          const spkFill = (fcw.speakers || [])
            .filter(f => typeof f.cx === 'number')
            .sort((a, b) => a.cx - b.cx);
          let bandSplit2 = null;
                    let bandKps = null;   // keyframe per-shot: [{t, a:{cx,cy,w}, b:{...}}]
                    // Ambang split ADAPTIF (gate fill): split HANYA kalau 2 wajah GA muat
                    // 1 panel. Panel = 1080px dari scaled canvas (lebar source = srcW*sx).
                    // sp wajah muat kalau sp*srcW*sx + 2*halfW <= 1080; halfW≈0.08 → 0.16.
                    // (0.28 statis = bug 2026-10-06: semua clip jadi split; c1 spread
                    //  0.24-0.36 masih muat 1 panel → jangan split.)
                    const spFit = Math.max(0.30, Math.min(0.50, 1080 / (srcW * sx) - 0.16));
                    // PER-SHOT keyframes: wajah berjauhan beda tiap shot.
                    // Statik 1 sample (0.12/0.70) = wajah shot lain (0.45/0.94) di
                    // luar panel → n=0 wajah terdeteksi (verified t=1,4,10).
                    // Instant cut antar shot (user: "langsung inframe", no pan).
                    const shotsFc = (thisSegs && thisSegs.length ? thisSegs : null);
                    const kps = [];
                    const nShots = shotsFc ? shotsFc.filter(s => (s.end||0)-(s.start||0) >= 0.5).length : 0;
                    if (shotsFc) {
                      for (const s of shotsFc) {
                        const s0 = Math.max(0, s.start || 0), s1 = Math.min(clipDur, s.end || clipDur);
                        if (s1 - s0 < 0.5) continue;
                        const one = detectFacesAt(videoPath, startSec + (s0 + s1) / 2, 1280);
                        if (one && one.faces && one.faces.length) {
                          const fs = one.faces.filter(f => f.cy <= 0.82).sort((a, b) => a.cx - b.cx);
                          // spread WAJIB besar (≥0.28): wajah sebelahan (spread 0.11)
                          // muat 1 panel → bukan layout 2 kolom.
                          const sp = fs.length >= 2 ? fs[fs.length - 1].cx - fs[0].cx : 0;
                          if (fs.length >= 2 && sp >= spFit) kps.push({ t: s0, a: fs[0], b: fs[fs.length - 1] });
                        }
                      }
                    }
                    // GATE: split cuma kalau MAYORITAS shot = 2+ org berjauhan
                    // (speaker tetap di 2 sisi). 1 shot multi di antara solo shot
                    // = cutaway → jangan split seluruh clip.
                    if (kps.length >= 1 && kps.length >= Math.max(1, Math.ceil(nShots * 0.5))) {
                      bandSplit2 = [kps[0].a, kps[0].b];  // buat calc geometry awal
                      bandKps = kps;
                      // biar log/judul + pengecekan jelas
                      console.log(`[ffmpeg] fill band-kf: ${kps.length} shot kf (thisSegs)`);
                    } else {
                                          // FALLBACK: shot_segments kosong (window pendek / timeout)
                                          // → sample titik merata, ambil pasangan berjauhan terbesar.
                                          // fokus 1-2 org, BUKAN wajah sebelahan (t=228.9 cx 0.45/0.56
                                                        // spread 0.11 = 2 org di meja sebelahan, muat 1 panel).
                                                        // CARI wajah TERJAUH antar SEMUA pasangan, bukan fs[0]/fs[last]
                                                        // per-frame (sama aja). Pakai DENSITY sample: wajah yg muncul
                                                        // di banyak sample = orang tetap; jadi pasangan
                                                        // tetap-terjauh = layout 2 kolom.
                                                        const nS = Math.max(2, Math.min(6, Math.floor(clipDur / 3)));
                                                        const kpsAll = [];
                                                        let bestSpread = 0;
                                                        // kumpul semua wajah sample, bucket cx 0.10
                                                        const b2 = [];
                                                        for (let si = 0; si < nS; si++) {
                                                          const absT = startSec + (clipDur * (si + 0.5)) / nS;
                                                          const one = detectFacesAt(videoPath, absT, 1280);
                                                          const fsS = (one && one.faces) ? one.faces.filter(f => f.cy <= 0.82).sort((a,b)=>a.cx-b.cx) : [];
                                                          if (fsS.length) b2.push({ t: absT - startSec, fs: fsS });
                                                          if (!fsS.length) continue;
                                                          for (const f of fsS) {
                                                            if (f.cy > 0.82) continue;
                                                            const k = Math.round(f.cx / 0.10) * 0.10;
                                                            if (!b2[k]) b2[k] = { cxs: [], n: 0 };
                                                            b2[k].cxs.push(f.cx); b2[k].n++;
                                                          }
                                                        }
                                                        const anchors = Object.values(b2.reduce((m, smp) => {
                                                          for (const f of smp.fs) {
                                                            const k = Math.round(f.cx / 0.10) * 0.10;
                                                            (m[k] = m[k] || []).push(f.cx);
                                                          }
                                                          return m;
                                                        }, {})).map(arr => arr.sort((x,y)=>x-y)[Math.floor(arr.length/2)])
                                                          .sort((a, b) => a - b);
                                                        // kiri-kanan anchor: wajah solo di kolom kiri tetap
                                                        // KE-TRACK (kf per sample, b = anchor kanan global)
                                                        const aL = anchors.length ? anchors[0] : 0.5;
                                                        const aR = anchors.length ? anchors[anchors.length - 1] : 0.95;
                                                        const sp = aR - aL;
                                                        // sampai 4 kf per sample (termasuk wajah solo)
                                                        for (const smp of b2.slice(0, 4)) {
                                                          const L = smp.fs.find(f => f.cx < 0.5) || smp.fs[0];
                                                          const R = smp.fs.find(f => f.cx >= 0.5) || smp.fs[smp.fs.length - 1];
                                                          kpsAll.push({ t: smp.t, a: L, b: R });
                                                        }
                                                        if (sp > spFit) {
                                                          bestSpread = sp;
                                                          bandSplit2 = [{ cx: aL, cy: 0.35, w: 0.08 }, { cx: aR, cy: 0.35, w: 0.08 }];
                                                          if (kpsAll.length) bandKps = kpsAll;
                                                          else bandKps = [{ t: 0, a: bandSplit2[0], b: bandSplit2[1] }];
                                                        } else if (!kpsAll.length && !bandSplit2 && spkFill.length >= 2) {
                                                          // speakers GLOBAL berjauhan = 2 cluster org tetap (video
                                                          // table talk, shot cut cepat → detectFacesAt titik n<2).
                                                          const spG = spkFill[spkFill.length - 1].cx - spkFill[0].cx;
                                                          if (spG > spFit) {
                                                            bestSpread = spG;
                                                            bandSplit2 = [spkFill[0], spkFill[spkFill.length - 1]];
                                                            bandKps = [{ t: 0, a: spkFill[0], b: spkFill[spkFill.length - 1] }];
                                                          }
                                                        }
                                                        // panel n=0 (t=7/9/11) = panel crop ke keyframe t=0
                                                        // wajah, padahal wajah shot itu di luar window → SEMUA
                                                        // keyframe dipakai, bukan cuma 1. expr if(lt(t,...))
                                                        // = instant cut antar sample multi.
                                                        if (kpsAll.length >= 2) bandKps = kpsAll;
                                                        else if (bandSplit2) bandKps = [{ t: 0, a: bandSplit2[0], b: bandSplit2[1] }];
                                                        if (!bandSplit2 && spkFill.length >= 2) {
                                                          const sp2 = spkFill[spkFill.length - 1].cx - spkFill[0].cx;
                                                          if (sp2 > spFit) bandSplit2 = [spkFill[0], spkFill[spkFill.length - 1]];
                                                        }
                                                        if (bandSplit2 && bestSpread <= spFit) bandSplit2 = null;
                                                        }
                    if (bandSplit2) {
                                // kolom 540x1516; crop source rasio sama (zW = zH*540/1516)
                                const cH = srcH;                               // full tinggi source
                                const cW = Math.round(cH * 540 / 1516);
                                const xFor = (f) => Math.max(0, Math.min(srcW - cW, Math.round(f.cx * srcW - cW / 2)));
                                const yFor = (f) => {
                                  const yf = faceYFace(f.w || 0.12, srcW, cH);
                                  return Math.max(0, Math.min(srcH - cH, Math.round((f.cy || 0.35) * cH - cH * yf)));
                                };
                                // expr instant-cut antar shot keyframe (eval=frame default crop x/y)
                                const mkExpr = (vals) => {
                                  let e = String(vals[vals.length - 1].v);
                                  for (let i = vals.length - 2; i >= 0; i--) {
                                    e = `if(lt(t,${vals[i + 1].t.toFixed(2)}),${vals[i].v},(${e}))`;
                                  }
                                  return e;
                                };
                                const colChains = [0, 1].map(ci => {
                                  const pick = k => (ci === 0 ? k.a : k.b);
                                  let ex, ey;
                                  if (bandKps && bandKps.length) {
                                    ex = mkExpr(bandKps.map(k => ({ t: k.t, v: xFor(pick(k)) })));
                                    ey = mkExpr(bandKps.map(k => ({ t: k.t, v: yFor(pick(k)) })));
                                  } else {
                                    ex = String(xFor(bandSplit2[ci])); ey = String(yFor(bandSplit2[ci]));
                                  }
                                  return `[f${ci}]crop=${cW}:${cH}:'${ex}':'${ey}',scale=540:1516,setsar=1[p${ci}]`;
                                });
                                fgChain = `[fg]split=2[f0][f1];${colChains.join(';')};[p0][p1]hstack=inputs=2[fgf]`;
                                fillNote += ` BAND-SPLIT 2 kolom, ${bandKps ? bandKps.length + ' shot kf' : 'static'} @cx ${bandSplit2.map(f => f.cx.toFixed(2)).join('/')}`;
                                console.log(`[ffmpeg] fill auto-panel: 2 kolom, ${bandKps ? bandKps.length + ' shot kf' : 'static'} @cx ${bandSplit2.map(f => f.cx.toFixed(2)).join('/')}`);
                              } else {
          fillNote = ` face-win ${fcw.w.toFixed(0)}x${fcw.h.toFixed(0)} @(${fcw.x.toFixed(0)},${fcw.y.toFixed(0)}) cy=${cyMid.toFixed(2)} sx=${sx.toFixed(2)}`;
          // v22 PER-ANGLE TRACK (user 2026-10-03: "untuk setiap angle langsung
          // diarahin ke muka"). v21 cuma 1 window GLOBAL → shot ganti, wajah
          // keluar window (job 49f9ced2 c3 @18s tight close-up di luar window
          // 3-org wide). Sample wajah tiap ~6s, bangun crop expr interpolasi
          // linier. INSTANT cut antar keyframe (user: "langsung inframe"),
          // bukan pan pelan.
          try {
            const vi0 = probeDim(videoPath);
            // SPEAKER RUNS dari mouth-motion (sekarang jalan buat fill juga):
            // group cue per speaker, skip interupsi <1.2s (sama kaya
            // buildSpeakerPan). cx run = median sample. Dipakai buat PILIH
            // wajah mana yang di-track per sample — sebelumnya pake wajah
            // paling TENGAH (cx~0.5) = "kamera ga ngarah ke yg ngomong"
            // (user 2026-10-07).
            const spkRuns = [];
            if (mmSp && mmSp.length) {
              for (const d of mmSp) {
                if (d.speaker === 'unknown' || typeof d.cx !== 'number') continue;
                const last = spkRuns[spkRuns.length - 1];
                if (last && last.side === d.speaker) { last.t1 = d.t; last.cxs.push(d.cx); }
                else spkRuns.push({ side: d.speaker, t0: d.t, t1: d.t, cxs: [d.cx] });
              }
              const keptR = [];
              for (let i = 0; i < spkRuns.length; i++) {
                const r = spkRuns[i];
                const isEdge = (i === 0 || i === spkRuns.length - 1);
                if (!isEdge && (r.t1 - r.t0) < 1.2) continue;  // nyelip sekata: hold
                keptR.push(r);
              }
              const fr = keptR.length >= 2 ? keptR : spkRuns;
              for (const r of fr) {
                const cs = r.cxs.slice().sort((a, b) => a - b);
                r.cx = cs[Math.floor(cs.length / 2)];
              }
              spkRuns.length = 0;
              spkRuns.push(...fr);
            }
            const spkAt = (t) => {
              // speaker cx aktif di waktu t (clip-relative)
              for (const r of spkRuns) {
                if (t >= r.t0 - 0.25 && t <= r.t1 + 0.25) return r.cx;
              }
              return null;
            };
            const nSamp = Math.max(2, Math.min(6, Math.floor(clipDur / 6)));
            const samples = [];
            for (let si = 0; si < nSamp; si++) {
              const absT = startSec + (clipDur * (si + 0.5)) / nSamp;
              const one = detectFacesAt(videoPath, absT, 1280);
              if (one && one.faces && one.faces.length) {
                // PILIH wajah: kalau mouth-motion tau speaker aktif di t ini,
                // ambil wajah TERDEKAT ke cx speaker (bukan tengah frame).
                // Fallback: wajah paling tengah.
                const want = spkAt(absT - startSec);
                let best = one.faces[0], bd = 1e9;
                for (const f of one.faces) {
                  const d = Math.abs(f.cx - (want != null ? want : 0.5));
                  if (d < bd) { bd = d; best = f; }
                }
                samples.push({ t: absT - startSec, cx: best.cx, cy: best.cy });
              }
            }
            if (samples.length >= 2) {
              const maxShift = Math.abs(samples[0].cx - samples[samples.length - 1].cx);
              // HANYA track kalau ada perpindahan bermakna (>0.10 = angle beda).
              // Shot statis = pakai window global v21 (wajah muat semua).
              if (maxShift > 0.10) {
                // window lebar 55% source follow cx sample (sama kaya v21 n<=1)
                const trackW = srcW * 0.55;
                const xFor = (cx) => Math.max(0, Math.min(srcW - trackW, cx * srcW - trackW / 2));
                const yFor = (cy) => Math.max(0, Math.min(scaleOutH - hb, cy * scaleOutH - hb * 0.12));
                const sxFill = Math.max(1080 / trackW, hb / srcH);
                const scW = Math.round(srcW * sxFill), scH = Math.round(srcH * sxFill);
                // expr x: instant cut antar keyframe
                let exprX = String(Math.round(xFor(samples[samples.length - 1].cx) * sxFill));
                for (let i = samples.length - 2; i >= 0; i--) {
                  exprX = `if(lt(t,${samples[i + 1].t.toFixed(2)}),${Math.round(xFor(samples[i].cx) * sxFill)},(${exprX}))`;
                }
                // expr y: follow cy sample (wajah tinggi/rendah per angle)
                let exprY = String(Math.round(yFor(samples[samples.length - 1].cy)));
                for (let i = samples.length - 2; i >= 0; i--) {
                  exprY = `if(lt(t,${samples[i + 1].t.toFixed(2)}),${Math.round(yFor(samples[i].cy))},(${exprY}))`;
                }
                fgChain = `scale=${scW}:${scH},crop=1080:${hb}:'${exprX}':'${exprY}',setsar=1`;
                fillNote += ` TRACK ${samples.length} angle (shift ${maxShift.toFixed(2)})`;
                console.log(`[ffmpeg] fill per-angle: ${samples.map(s => s.t.toFixed(1) + '@' + s.cx.toFixed(2)).join(' ')}`);
              }
            }
          } catch (e) { console.warn(`[ffmpeg] fill per-angle gagal: ${e.message}`); }
          }
        } catch (e) { /* fallback center */ }
      }
      // fgChain bisa berisi filter_complex sendiri (auto-panel: split=2
      // + hstack) → JANGAN dibungkus [fg]...[fgf], atau label bentrok
      // dengan [0:v]split=2[fg][bg] di atas (ffmpeg "Invalid argument").
      // Band-split: fgChain sudah utuh [in]...[out], sambung via ;.
      if (fgChain.startsWith('[fg]')) {
        splitGraph = '[0:v]split=2[fg][bg];' +
          '[bg]scale=1188:2112:force_original_aspect_ratio=increase,' +
          'crop=1188:2112:(iw-1188)/2:(ih-2112)/2,gblur=sigma=28,' +
          'scale=1080:1920[bgb];' +
                    fgChain +  // [fg]split=2...hstack=inputs=2[fgf] — label [fg]
                    ';[bgb][fgf]overlay=(W-w)/2:(H-h)/2[base]';
      } else {
        splitGraph = '[0:v]split=2[fg][bg];' +
          '[bg]scale=1188:2112:force_original_aspect_ratio=increase,' +
          'crop=1188:2112:(iw-1188)/2:(ih-2112)/2,gblur=sigma=28,' +
          'scale=1080:1920[bgb];' +
          `[fg]${fgChain}[fgf];` +
          '[bgb][fgf]overlay=(W-w)/2:(H-h)/2[base]';
      }
      console.log(`[ffmpeg] 9:16_fill: band ${hb}px (${Math.round(hb/1920*100)}%), fg=${fgChain.slice(0,60)}, src ${srcW}x${srcH}${fillNote}`);
    } else if (format === '16:9_fill') {
      // LANDSCAPE-FIT TikTok (user 2026-10-10: "di tiktok landscape, atas
      // bawahnya sisanya video blur"): kanvas 9:16, video 16:9 UTUH fit-width
      // (ga ke-crop, subtitle di area blur bawah ga nutup wajah).
      // FG y agak ke atas → band bawah lega buat subtitle gede.
      const fgW = 1080;
      const fgH = Math.max(1, Math.round(fgW * srcH / srcW));
      fgChain = `scale=${fgW}:${fgH},setsar=1`;
      const yOff = Math.max(0, Math.round((1920 - fgH) / 2) - 80);
      splitGraph = '[0:v]split=2[fg][bg];' +
        '[bg]scale=1188:2112:force_original_aspect_ratio=increase,' +
        'crop=1188:2112:(iw-1188)/2:(ih-2112)/2,gblur=sigma=28,' +
        'scale=1080:1920[bgb];' +
        `[fg]${fgChain}[fgf];` +
        `[bgb][fgf]overlay=(W-w)/2:${yOff}[base]`;
      console.log(`[ffmpeg] 16:9_fill: fg 1080x${fgH} utuh, y=${yOff}, blur atas-bawah, src ${srcW}x${srcH}`);
    } else if (format === '1:1') {
      vf.push('scale=1080:1080:force_original_aspect_ratio=increase');
      vf.push('crop=1080:1080:(iw-1080)/2:(ih-1080)/2');
    } else if (format === '16:9') {
          // Landscape YouTube: full 1920x1080 tanpa bar. Source 16:9 → scale pas;
          // source lain → scale-increase + crop center (no letterbox).
          vf.push('scale=1920:1080:force_original_aspect_ratio=increase');
          vf.push('crop=1920:1080');
        } else {
          vf.push('scale=1280:720:force_original_aspect_ratio=decrease');
        }

    // Subtitle burn (skip untuk split-screen reaction)
    // Make srtPath absolute jika relative
    if (useSub) {
      // FIX: nama file ass PER-CLIP — sebelumnya semua clip share clip.ass,
      // render paralel saling overwrite → subtitle cue tabrakan/cepat pudar.
      const assName = `clip_${Math.round(startSec * 10)}_${(endSec || startSec + 30).toFixed(0)}.ass`;
      const assPath = path.join(jobDir, assName);
      try {
        // Word-level timing dari audio (sekali per clip, cache di scope).
        if (!processClip._wt || processClip._wt.key !== srtFinal + startSec) {
          // ponytail: cues dari clean srt (sudah onset-aligned) → per cue
          // align kata via local minima energi. ~1-3s per cue di 4-core.
          const cuesW = parseSrtCues(srtFinal, startSec);
          const wt = cuesW.length ? alignWordsCues(ffmpegPath, videoPath, startSec, endSec, cuesW) : null;
          processClip._wt = { key: srtFinal + startSec, wt };
          if (wt) console.log('[ffmpeg] word-align: ' + wt.length + ' kata (audio)');
        }
        const n = srtToAss(srtFinal, assPath, startSec, clipDur, subtitleTemplate, refStyle, processClip._wt.wt);
        if (n > 0) {
          // FIX: path absolut Windows (drive letter "C:") merusak filter
          // subtitles= di ffmpeg ini (original_size Invalid argument) →
          // pakai path relatif (cwd spawn = jobDir).
          vf.push(`subtitles=${assName}`);
          console.log(`[ffmpeg] subtitle burn: ${n} cue (offset ${startSec}s) template=${subtitleTemplate}`);
          subtitleBurnInfo = { cueCount: n, offset: startSec, template: subtitleTemplate };
        } else {
          console.warn(`[ffmpeg] no cue dalam window ${startSec}-${endSec}s, skip subtitle`);
        }
      } catch (e) {
        console.warn(`[ffmpeg] srtToAss gagal: ${e.message}`);
      }
    }

    // Transitions: fade in/out
    if (enableTransitions && clipDur > 1) {
      vf.push('fade=t=in:st=0:d=0.3');
      const fadeOutStart = Math.max(0, clipDur - 0.3);
      vf.push(`fade=t=out:st=${fadeOutStart}:d=0.3`);
      console.log(`[ffmpeg] transitions enabled: fade in/out (${clipDur}s clip)`);
    }

    if (format === '9:16_reaction' && hasReaction) {
      // filter_complex sudah handle; jangan push vf biasa
    } else if (splitFaces && wantSplit) {
      // AUTO-SPLIT LAYOUT: 2+ wajah SIMULTAN di >=25% frame (multi_ratio).
      // BUKAN cluster count temporal — 1 org duduk diam menghasilkan 4 cluster
      // (muka/samping/belakang YuNet) → split 3 panel muka org yg sama =
      // false positive. multi_ratio = wajah di 1 frame bareng = org beneran.
      // t=435 verified: 4 org ASLI (podcast panel wide cutaway) = 33% frame.
      // User: "kamera nunjukin semua tapi frame gabisa muat semua orang
      // karena format 9:16 → dibikin auto layout lock ke muka masing2".
      // (referensi ssstik.io @8s = 3-panel split vertikal).
      // vf = [crop?, scale?, subs, fade]. Cuma SUBTITLE yang masuk panel 0
      // (crop+scale bikin panel 1080x1080 → vstack 2880 = salah rasio;
      //  crop per-wajah sudah ada di graph). fade pasca-vstack di [base].
      // SUBTITLE TETEP DI TENGAH FRAME GABUNGAN (user: "tetep ditengah aja"):
      // subs di [base] setelah vstack = posisi global tengah. Panel 0
      // cuma dapat crop per-wajah.
      const tailFx = vf.filter(f => !f.startsWith('crop=') && !f.startsWith('scale='));
      // PER-SHOT LAYOUT (user 2026-09-27: "1 org fokus ngomong = tampilin
      // dia aja; kamera fokus ke banyak org = pecah screen"). Clip multi-shot
      // (cut kamera alternating solo/multi): split statis ke SEMUA frame =
      // orang sama 2 panel di shot solo. Bagi jadi segmen per-shot, layout
      // sendiri (solo=static crop, multi=split), concat.
      // shots = segment dari shot_segments.py (akurat per-shot), fallback
      // face_frame.shots.
      // GATE SPEAKER DOMINANCE: segmen multi tapi cuma 1 org ngomong
      // (listener diem/mendengarkan) = SINGLE crop ke pembicara, BUKAN
      // split. User: "kalo 1 orang lagi fokus ngomong ya tampilin dianya
      // aja". speakerDominance>=0.60 = 1 pembicara jelas. Pakai spk_cx
      // dari shot_segments (mouth landmark per segmen) kalau ada, fallback
      // speakerDominance global.
      console.log(`[ffmpeg] SHOTS SOURCE: ${thisSegs.length ? 'shot_segments.py' : 'FACE_FRAME fallback'} (${shots.length} seg, ${shots.filter(s=>s.multi).length} multi)`);
      splitGraph = buildSplitGraph(splitFaces, srcW, srcH, [],
        sampleFacesPerShot(videoPath, startSec, endSec || startSec + 30, thisSegs));
      // Per-segmen split: speakers/n_people window GLOBAL bisa cuma 1 org
      // (c4: 87% solo → graph NULL, padahal segmen multi punya 4 wajah
      // asli). Ambil speakers dari SEGMENT MULTI pertama: deteksi wajah di
      // 1 frame tengah segmen itu.
      // SPEAKERS PER-SEGMEN (user: "double split screen harusnya dibedain
      // dengan orang lainnya kalo udah ada 1 frame yang sama"). Dulu ambil
      // speakers 1x dari segmen multi PERTAMA → dipakai buat SEMUA segmen
      // multi. Shot beda = orang beda! c1 abadca9b: segmen 191.4-193.3 =
      // 2-shot pria+wanita, 193.3-200.8 = wide 4-org. Speakers 192.35
      // dipakai buat 198.7 → crop org SAMA di 2 panel.
      const segSpeakers = [];
      if (thisSegs.some(s => (s.faces || 1) >= 2)) {
        for (const ms of thisSegs) {
          if ((ms.faces || 1) < 2) { segSpeakers.push(null); continue; }
          const mt = (ms.start + ms.end) / 2;
          const one = detectFacesAt(videoPath, mt);
          // ORDER cx naik biar deterministik + log baca (YuNet acak:
          // c1 @184: [0.76,0.69,0.30,0.47]). CYCLING 3 PANEL: wajah A/B
          // di-panel parallell dg segmen sblmnya biar org ga lompat"
          // posisi panel saat shot alternating (c1 181-188 ↔ 193-201).
          // faces = YuNet segment, ambil 3 paling tersebar (len>3).
          let spk = null;
          if (one && one.faces && one.faces.length >= 2) {
            spk = one.faces.map(f => ({ cx: f.cx, cy: f.cy,
              faceW: Math.round((f.w || 0) * srcW),
              n_frames: ms.end - ms.start }))
              .sort((a, b) => a.cx - b.cx);
            if (spk.length > 3) {
              const keep = pickSplitPanel(spk, 3);
              spk = keep;
            }
          }
          console.log(`[ffmpeg] detectFacesAt @${mt.toFixed(1)}s: ${one ? (one.faces||[]).length + ' wajah' : 'NULL'}`);
          segSpeakers.push(spk);
          // splitGraph global tetap dari segmen multi pertama (panel template).
          if (!splitGraph && spk) {
            splitFaces.speakers = spk;
            splitFaces.n_people = spk.length;
            splitFaces.multi_ratio = 1;
            splitGraph = buildSplitGraph(splitFaces, srcW, srcH, [],
        sampleFacesPerShot(videoPath, startSec, endSec || startSec + 30, thisSegs));
            console.log(`[ffmpeg] split speakers dari segmen multi @${mt.toFixed(1)}s: ${spk.length} wajah`);
          }
        }
      }
      // STATIC-CROP GUARD: graph NULL terjadi kalau speakers global <2
      // (face_frame cluster 1 padahal segmen multi punya 2-3 wajah asli).
      // Fallback: sample wajah tiap segmen → window CENTER ke cluster wajah
      // + FULL-height (wajah merundung cy 0.55 tetap masuk, ga kepotong
      // atas). Job d7fce121 c1: face_frame miss → output @20s 0 wajah.
      let nS = 0, cxMin = Infinity, cxMax = -Infinity;
      for (const ts of thisSegs) {
        const one = detectFacesAt(videoPath, (ts.start + ts.end) / 2);
        if (one && one.faces && one.faces.length) {
          for (const f of one.faces) {
            cxMin = Math.min(cxMin, f.cx);
            cxMax = Math.max(cxMax, f.cx);
            nS++;
          }
        }
      }
      console.log(`[ffmpeg] static-crop fallback scan: ${nS} wajah, cx ${cxMin === Infinity ? '-' : cxMin.toFixed(2)}-${cxMax === -Infinity ? '-' : cxMax.toFixed(2)}`);
      if (nS && cxMax > cxMin) {
        // window 9:16: full-height source, lebar 9/16*H center ke cluster wajah
        const winW = Math.round(srcH * 9 / 16);
        const cxMid = (cxMin + cxMax) / 2;
        const x = Math.max(0, Math.min(srcW - winW, Math.round(cxMid * srcW - winW / 2)));
        splitFaces.w = winW; splitFaces.h = srcH; splitFaces.x = x; splitFaces.y = 0;
        console.log(`[ffmpeg] static-crop fallback window: ${winW}x${srcH} x=${x}`);
      }
    if (!splitGraph) {
        // Panel palsu (org sama dari belakang) → balik STATIC crop speaker
        // utama.
        vf.push(`crop=${splitFaces.w}:${splitFaces.h}:${splitFaces.x}:${splitFaces.y}`);
        console.log(`[ffmpeg] split ditolak (panel palsu) → static crop ${splitFaces.w}x${splitFaces.h}`);
      } else if (shots.length >= 2 && shots.some(s => s.multi) && shots.some(s => !s.multi)) {
        // MULTI-SHOT: segment per-shot, concat. Tiap segmen: trim →
        // (multi: split panel | solo: static crop speaker utama) → scale
        // 1080x1920 → concat. Subtitle dipasang setelah concat (timing global).
        const vi0 = probeDim(videoPath);
        // ffmpeg crop TIDAK terima DESIMAL (607.5 = Invalid argument). Bulatkan.
        const sc = { w: Math.round(splitFaces.w), h: Math.round(splitFaces.h),
                     x: Math.round(splitFaces.x), y: Math.round(splitFaces.y) };
        // SOLO crop per-SEGMEN: pakai spk_cx segmen itu (BUKAN global
        // splitFaces.x = pembicara utama window). Hoodie man cx 0.502
        // di-crop ke 0.35 → wajah kepotong kanan (c2 segmen 164.2+).
        // TRACKING: segmen panjang (>=6s) = 1 posisi statis → orang
        // geser/condong dalem segmen drift dari center (benchmark c5_9-16-5:
        // pv10 34.3s static x=776, wajah meleset di tengah). Sample cx
        // multi-titik, STEP-CUT halus (sama kaya speaker-pan: if(lt(t,T),A,B)).
        const soloCropFor = s => {
          const cxs = (s.spk_cx && s.spk_cx.length) ? s.spk_cx : null;
          if (!cxs) return `crop=${sc.w}:${sc.h}:${sc.x}:${sc.y},scale=1080:1920`;
          // FIX "kurang centered buat orangnya": y hardcode 0.40*vi0.h = asumsi
          // wajah selalu di 40% frame. Orang duduk condong/tinggi beda → wajah
          // ga di tengah panel. Pakai MEDIAN cy wajah segmen (spk_cy).
          const cyM = (s.spk_cy && s.spk_cy.length) ? s.spk_cy.reduce((a, b) => a + b, 0) / s.spk_cy.length : 0.42;
          // ponytail v21: CENTER wajah di panel, bukan hardcode 38%.
          // Scen lama (cy 0.4): y = 0.4*h - 0.38*h = 0.02*h = wajah atas ✓.
          // Scen BERDIRI (cy 0.72, job 49f9ced2 c3): y = 0.72*h - 0.38*h =
          // 0.34*h → crop window harus shift ke atas, tapi lama pakai
          // 0.38 → wajah di 0.34*vi0.h dari atas crop window = KELEBIHAN
          // bawah → kepala kepotong atas. CENTER: y = cy*h - h/2 + headroom
          // sedikit (mata di 45% panel = natural).
          const y = Math.max(0, Math.min(vi0.h - sc.h, Math.round(cyM * vi0.h - sc.h * 0.45)));
          // 1 keyframe = statis. 2+ = step-cut tracking. track_cx = sample
          // cx pembicara utama dalem segmen (urut waktu).
          const cxsT = (s.track_cx && s.track_cx.length >= 2) ? s.track_cx : null;
          // GUARD 2-ORANG BERBEDA: track_cx lompat jauh (dispersion >0.35)
          // = BUKAN 1 wajah gerak, tapi 2 pembicara ALTERNATING
          // (job baa0344a c5 pv11: track 0.26,0.76,0.26,0.76... 2 org
          // bergantian ngomong, speaker_count salah anggap 1 karena cuman
          // 1 mulut terbuka per frame). Bukan tracking → statis ke MEDIAN.
          const dispT = cxsT && cxsT.length >= 2
            ? Math.max(...cxsT) - Math.min(...cxsT) : 0;
          if (dispT > 0.35) {
            console.log(`[ffmpeg] track_cx dispersion ${dispT.toFixed(2)} > 0.35 = 2 org alternating → static median (seg @${s.start.toFixed(1)})`);
            s.track_cx = null;
          }
          // C1: mainCx = s.spk_cx[0] (pembicara utama median dari segmen ini, udah
          // computed di loop di atas). Jangan reference anchorF di sini (scope beda).
          const mainCx = (cxs && cxs.length) ? cxs[0] : 0.5;
          if (!cxsT || s.track_cx === null) {
            const x = Math.max(0, Math.min(vi0.w - sc.w, Math.round(mainCx * vi0.w - sc.w / 2)));
            return `crop=${sc.w}:${sc.h}:${x}:${y},scale=1080:1920`;
          }
          // t CLIP-RELATIVE dalam segmen: 0..(end-start). t dimulai 0 di
          // awal segmen (trim reset PTS).
          const segDur = Math.max(0.1, s.end - s.start);
          const kfX = cxsT.map(cx => Math.max(0, Math.min(vi0.w - sc.w, Math.round(cx * vi0.w - sc.w / 2))));
          // STEP CUT INSTANT (user: "kamera jangan bergerak-gerak", "langsung
          // nangkep posisinya"). NO ease/smoothstep = NO kamera melayang.
          // Antara keyframe: `if(lt(t,T),A,B)` = switch langsung.
          if (cxsT.length > 2) {
            // kompresi: max 6 keyframe (sample rapat = expr panjang)
            const step = Math.ceil(cxsT.length / 6);
            const comp = cxsT.filter((_, i) => i % step === 0 || i === cxsT.length - 1);
            cxsT.length = 0;
            cxsT.push(...comp);
          }
          let expr = String(kfX[kfX.length - 1]);
          for (let i = cxsT.length - 2; i >= 0; i--) {
            const tt = ((i + 1) / cxsT.length) * segDur;
            const a = kfX[i];
            expr = `if(lt(t,${tt.toFixed(2)}),${a},(${expr}))`;
          }
          return `crop=${sc.w}:${sc.h}:'${expr}':${y},scale=1080:1920`;
        };
        let g = '';
        const outs = [];
        shots.forEach((s, i) => {
          const lo = Math.max(0, s.start - startSec);
          const hi = Math.min(endSec - startSec, s.end - startSec);
          if (hi <= lo) return;
          if (g) g += ';';  // chain separator antar segmen
          g += `[0:v]trim=${lo.toFixed(2)}:${hi.toFixed(2)},setpts=PTS-STARTPTS`;
          if (s.multi && splitGraph) {
            // speakers PER-SEGMEN: segSpeakers index sejajar dgn thisSegs.
            // Global splitFaces.speakers = shot pertama aja → org lain di
            // shot berikutnya di-crop ke wajah org sama = "double split".
            // segSpeakers index = thisSegs (pre-filter). Cari matching
            // segmen asli by time (shots = segShots sudah difilter <0.3s).
            let spRaw = null;
            if (segSpeakers && thisSegs.length) {
              const mi = thisSegs.findIndex(ts =>
                ts.start <= s.start + 0.15 && ts.end >= s.end - 0.15);
              if (mi >= 0) spRaw = segSpeakers[mi];
            }
            const spRawAll = spRaw || (splitFaces.speakers || []);
            // PANEL SELECTION: pilih wajah tersebar (max-min dispersion),
            // BUKAN faces[0..N] acak YuNet. c1 @184.35: 4 wajah YuNet
            // [0.76,0.69,0.30,0.47]; faces[0]+faces[1] = 0.69+0.76 = DUA ORANG
            // SEBELAHAN → crop x=1209/1075 overlap 72% = "double split org
            // sama". 0.30 vs 0.76 = 2 sisi meja = org berbeda.
            // N PANEL = jumlah wajah asli segmen (3+ org = 3 panel CAP).
            const nPanel = Math.min(3, Math.max(2, s.anchorN || 2));
            const sp = nPanel >= 3 && spRawAll.length > 2
              ? pickSplitPanel(spRawAll, 3)
              : pickSplitPanel(spRawAll, 2);
            // EDGE GUARD: <2 wajah valid (sisanya setengah keluar frame)
            // → SOLO CROP, jangan split 1 panel (split=1 + crop ganda = error).
            if (sp.length < 2) {
              g += `,${soloCropFor(s)}[pv${i}]`;
              console.log(`[ffmpeg] seg @${s.start.toFixed(1)}: <2 wajah valid (edge) → solo`);
            } else {
            const nP = Math.min(3, sp.length);  // 2 atau 3 panel
            g += `,split=${nP}` + (nP === 3 ? `[sa${i}][sb${i}][sc${i}]` : `[sa${i}][sb${i}]`);
            const pH = nP === 3 ? 640 : 960;      // 1920/3 vs 1920/2
            let zH = Math.round(Math.floor(vi0.h / nP) / 1.25);
            let zW = Math.round(zH * (1080 / pH));
            // v22: wajah besar (close-up) melebihi window → zW tidak muat,
            // kepala kepotong (job d7fce121 rd @t=3/38: headtop -15/-18).
            // Lebarin zW (proportional ke wajah) + yFace kecil.
            const wMax = Math.max(...sp.map(f => f.faceW || (f.w || 0) * vi0.w || 0));
                        // Kepala asli ≈ 1.5×lebar wajah (YuNet box = muka, bukan ubun).
                        // Kepala sebagai fraksi tinggi panel = 1.5*wMax/zH dengan
                        // zH = zW*pH/1080 → = 1.69*wMax/zW. Biar kepala ≤70% panel
                        // (cukup ruang headroom), butuh zW ≥ 2.4*wMax.
                        // c1 d7fce121 t=3: face 255px, zW 486 (52% panel) → kepala 88%
                        // panel → tiap offset cy = kepotong (verified top=-0.14).
                        if (wMax > 0) {
                          const needW = Math.ceil(wMax * 2.4);
                          if (needW > zW) {
                            zW = Math.min(vi0.w, needW);
                            zH = Math.min(Math.floor(vi0.h / nP), Math.round(zW * pH / 1080));
                          }
                          // KEPALA TINGGI: zH harus ≥ kepala (1.5×wMax) + headroom.
                          // c3 d7fce121 t=54: close-up wMax 350 → kepala 525, zH 432 =
                          // KEPOTONG (top -0.12). Naik zH ke kepala+15%, zW ikut rasio
                          // panel (zH ≤ 540 = ≤half frame utk nP=2).
                          const headH = Math.round(wMax * 1.5 * 1.15);
                          const zHcap = nP === 2 ? 540 : 360;
                          if (headH > zH) {
                            zH = Math.min(zHcap, headH);
                            zW = Math.min(vi0.w, Math.max(Math.ceil(zH * 1080 / pH), needW));
                          }
                        }
            const paneLbl = n => String.fromCharCode(97 + n);  // a,b,c
            const paneOuts = [];
            for (let pi = 0; pi < nP; pi++) {
              const fx = sp[pi];
              const x = Math.max(0, Math.min(vi0.w - zW, Math.round(fx.cx * vi0.w - zW / 2)));
              // yFace dari lebar wajah (faceYFace): close-up wajah besar →
                            // yFace besar (kepala muat atas). 0.12/0.38 statis = kepotong.
                            const yFace3 = faceYFace(fx.w || (fx.faceW || 0) / vi0.w, vi0.w, zH);
                            const y = Math.max(0, Math.min(vi0.h - zH, Math.round((fx.cy || 0.4) * vi0.h - zH * yFace3)));
              paneOuts.push('p' + paneLbl(pi) + i);
              g += `;[s${paneLbl(pi)}${i}]crop=${zW}:${zH}:${x}:${y},scale=1080:${pH},setsar=1[p${paneLbl(pi)}${i}]`;
            }
            g += ';' + paneOuts.map(o => `[${o}]`).join('') +
                 `vstack=inputs=${nP}[pv${i}]`;
            if (nP < 2) {
              g += `,${soloCropFor(s)}[pv${i}]`;
            }
            }
          } else {
            g += `,${soloCropFor(s)}[pv${i}]`;
          }
          outs.push(`pv${i}`);
        });
        g += ';' + outs.map(o => `[${o}]`).join('') +
          `concat=n=${outs.length}:v=1:a=0[base]`;
        // SUBTITLE POSISI: 2-panel (seam y=960) → MarginV 880 = nempel
                // seam tapi turun dikit (v22g: 930→880 — 930 bikin text nutup
                // puncak panel bawah, wajah panel bawah sering di 1000-1200).
                // 3-panel (panel tengah 640-1280) → MarginV 640 = bawah panel
                        // tengah, aman dari wajah panel tengah (center ~960±150).
                        // v22e: 770→700, v22g: 700→640 (user: "masih ada yang nutup wajah").
                        // v22h: solo 1-panel → 750 (880 = text y≈960 nutup dagu
                        // close-up; 750 = text y≈1090 = bawah dagu, aman).
                        const maxPanels = shots.reduce((m, s) => Math.max(m, s.multi && s.anchorN ? Math.min(3, s.anchorN) : (s.multi ? 2 : 1)), 1);
                        const marginV = maxPanels >= 3 ? 640 : (maxPanels === 2 ? 880 : 750);
        const subsFx = tailFx.find(f => f.startsWith('subtitles='));
        if (subsFx) {
          const assF = subsFx.replace(/^subtitles=/, '');
          const midFx = `subtitles=${assF}:force_style='MarginV=${marginV}'`;
          const restFx = tailFx.filter(f => !f.startsWith('subtitles=') && !f.startsWith('fade'));
          splitGraph = `${g};[base]${restFx.length ? restFx.join(',') + ',' : ''}${midFx}[out]`;
        } else {
          splitGraph = `${g};[base]${tailFx.length ? tailFx.join(',') + ',' : ''}null[out]`;
        }
        console.log(`[ffmpeg] MULTI-SHOT: ${outs.length} segmen (${shots.filter(s => s.multi).length} multi)`);
        args.push('-filter_complex', splitGraph);
        args.push('-map', '[out]', '-map', '0:a?');
      } else {
      // SPLIT: subtitle TETEP DI TENGAH frame gabungan (user: "tetep ditengah
      // aja"). ASS MarginV default (bottom-anchored) jatuh di panel terakhir
      // → override ke tengah frame: margin_v = (1920/2) - textHeight/2.
      // pakai force_style di filter subs (header ASLI ga diubah permanen).
      // v22h: 930→750 (user: "masih ada yang nutup wajah solo 1 panel";
      // 930 = 48% tinggi, 750 = 39% tinggi = aman di bawah dagu podcast).
      const subsFx = tailFx.find(f => f.startsWith('subtitles='));
      if (subsFx) {
        const assF = subsFx.replace(/^subtitles=/, '');
        const midFx = `subtitles=${assF}:force_style='MarginV=750'`;
        const restFx = tailFx.filter(f => !f.startsWith('subtitles='));
        splitGraph += `;[base]${restFx.length ? restFx.join(',') + ',' : ''}${midFx}[out]`;
      } else {
        splitGraph += `;[base]${tailFx.length ? tailFx.join(',') + ',' : ''}null[out]`;
      }
      args.push('-filter_complex', splitGraph);
      args.push('-map', '[out]', '-map', '0:a?');
      }
    } else if (splitGraph) {
      // SPLIT-SCREEN: filter_complex split → [base], lalu subtitle/fade/transisi di chain [base]→[out]
      const tail = vf.length ? `;[base]${vf.join(',')}[out]` : ';[base]null[out]';
      args.push('-filter_complex', `${splitGraph}${tail}`);
      args.push('-map', '[out]', '-map', '0:a?');
    } else {
      args.push('-vf', vf.join(','));
    }
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-threads', '1');
    // AUDIO NORMALIZE: user "suaranya kok kaya sedikit di kecilin ya, coba di normalin"
    // loudnorm = EBU R128 broadcast standard, loudness target -16 LUFS (TikTok/IG ideal).
    // dynamic detection → no 2-pass needed (1-pass quality cukup buat voice).
    args.push('-c:a', 'aac', '-b:a', '192k', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:linear=true', '-movflags', '+faststart', '-pix_fmt', 'yuv420p');
    args.push(toFwd(output));

    // DEBUG: log args ffmpeg untuk troubleshooting sendcmd
    try { fs.appendFileSync(path.join(jobDir, 'ffmpeg_debug.log'), args.join(' ') + '\n\n'); } catch (e) { /* noop */ }

    // FIX: ffmpeg filter "subtitles=" merusak path absolut Windows
    // (drive letter "C:" di-parse sebagai pemisah option → "Invalid argument"
    // original_size). BURN JALAN tapi subtitle gagal terpasang = subtitle
    // kosong/tidak muncul. Pakai cwd=jobDir + path relatif.
    const proc = spawn(ffmpegPath || 'ffmpeg', args, { cwd: jobDir });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => reject(new Error(`FFmpeg spawn error: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`FFmpeg clip gagal (exit ${code}): ${stderr.slice(-1200)}`));
      else resolve({ output, subtitleBurn: subtitleBurnInfo });
      });
  });
}

// ffprobe wrapper: ambil dimensi source (cache per videoPath — dipanggil banyak kali per job)
const _probeCache = {};
function probeDim(videoPath) {
  if (videoPath in _probeCache) return _probeCache[videoPath];
  let res = { w: 1280, h: 720 };
  try {
    const out = require('child_process').execFileSync(
      'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', videoPath],
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    ).trim();
    const [w, h] = out.split('x').map(Number);
    if (w && h) res = { w, h };
  } catch (e) { /* fallthrough */ }
  _probeCache[videoPath] = res;
  return res;
}
function probeWidth(videoPath) { return probeDim(videoPath).w; }
function probeHeight(videoPath) { return probeDim(videoPath).h; }

// Windows path: backslash dimakan Node spawn arg parser → selalu forward slash
function toFwd(p) { return String(p || '').replace(/\\/g, '/'); }

module.exports = { processClip, srtToAss, secToAss, parseSrtSec, computeFaceCrop, probeWidth, probeHeight, toFwd, buildSplitGraph };
