// Terjemah SRT ke Bahasa Indonesia pakai LLM (gpt-4o-mini, ~0.3s).
// User: "subtitle disini malah pake bahasa inggris" — YouTube sering cuma
// punya auto-sub en; subtitle harus ikut bahasa video (id).
// ponytail: batch per-blok, skip kalau srt sudah ID. Tambah model audio/whisper
// kalau perlu transkrip video tanpa sub sama sekali.
const fs = require('fs');
const path = require('path');
const { callOpenAI } = require('../ai/adapter');

const ID_HINT = /\b(saya|kamu|kita|mereka|yang|dan|untuk|tidak|ini|itu|adalah|dengan|pada|akan|sudah|bisa|harus|ada)\b/i;

function parseSrt(content) {
  const blocks = content.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n\n');
  const raw = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;
    // timestamp bisa di line 0 (no-index) atau line 1 (ada index) — cari, jangan asumsi
    const ti = lines.findIndex(l => /\d+:\d+:\d+[,.]\d+\s*-->/.test(l));
    if (ti === -1) continue;
    const text = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) raw.push({ tm: lines[ti], text });
  }
  // YouTube auto-sub sering punya 2 cue nyaris identik berurutan (re-flow),
  // ex: 00:05.00-05.49 "TEMAN BLOGGER" lalu 00:05.49-05.98 "TEMAN BLOGGER".
  // Keduanya dibakar → subtitle tumpuk & kliatan "telat". Dedupe teks identik
  // berurutan: simpan yang pertama, perpanjang end-nya.
  const cues = [];
  const toSec = (tm) => {
    const m = tm.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return null;
    return [ (+m[1])*3600+(+m[2])*60+(+m[3])+(+m[4])/1000, (+m[5])*3600+(+m[6])*60+(+m[7])+(+m[8])/1000 ];
  };
  for (const c of raw) {
    const last = cues[cues.length - 1];
    if (last && (last.text === c.text || c.text.startsWith(last.text))) {
      // ROLLING CAPTION (YouTube auto-sub): cue berikut = teks SAMA +
      // kata tambahan ("Kenapa?" lalu "Kenapa? Apa visinya?"). Bukan cue
      // baru — perpanjang end, jangan bikin subtitle dobel menumpuk.
      const a = toSec(last.tm), b2 = toSec(c.tm);
      if (a && b2) { last.tm = last.tm.replace(/-->\s*[\d:,.]+/, '--> ' + fmtT(b2[1])); continue; }
    }
    cues.push(c);
  }
  return cues;
}

function fmtT(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

async function translateSrt(srtPath, outPath, lang = 'id', windowStart = null, windowDur = null) {
  const content = fs.readFileSync(srtPath, 'utf-8');
  const allCues = parseSrt(content);
  if (!allCues.length) return null;

  // Batasi ke window clip saja (kalau dikasih) — hemat token, timing tetap akurat
  let cues = allCues;
  if (windowStart != null && windowDur != null) {
    const ws = Number(windowStart), we = ws + Number(windowDur);
    cues = allCues.filter(c => {
      const m = c.tm.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!m) return true;
      const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
      const e = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
      return e > ws && s < we;
    });
    if (!cues.length) {
      // JANGAN return null: processor.js lanjut srtFinal=null → srtToAss crash
      // "path argument null" → subtitle diam-diam skip. Kasi srtPath asli,
      // srtToAss bakal tulis 0 cue (aman, subtitle emang kosong di window).
      console.log(`[translate] window ${ws}-${we}s: 0 cue, fallback srt asli`);
      return srtPath;
    }
    console.log(`[translate] window ${ws}-${we}s: ${cues.length} cue`);
  }

  // Kalau sudah ID, skip (hemat LLM call)
  const sample = cues.slice(0, 20).map(c => c.text).join(' ');
  if (lang === 'id' && ID_HINT.test(sample)) {
    console.log('[translate] srt sudah Indonesia, skip translate');
    return srtPath;
  }

  const MAX = 80;
  const use = cues.slice(0, MAX);
  const numbered = use.map((c, i) => `${i + 1}. ${c.text}`).join('\n');

  const prompt = `Terjemahkan teks subtitle berikut ke Bahasa Indonesia yang natural dan pas untuk dibaca di video pendek (TikTok/Reels/Shorts). Pertahankan makna dan nada asli. Untuk kata ganti orang pertama, jika konteksnya mendadak/journalistic, gunakan "saya". Jangan tambahkan penjelasan apa pun.\n\n${numbered}\n\nBalas HANYA dengan daftar terjemahan, satu per baris, tanpa nomor:`;

  try {
    // FIX: Claude sering ngeresain prompt translate sebagai "instructions" lalu
    // balas refusal dalam Inggris (prompt injection-ish). Gemini lebih patuh &
    // murah untuk translate bulk. Retry 2x untuk router flaky.
    const TR_MODEL = process.env.AI_MODEL_TRANSLATE || 'Gemini';
    let out = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        out = await callOpenAI({ prompt, model: TR_MODEL });
        if (out && out.trim()) break;
      } catch (e2) {
        console.warn(`[translate] attempt ${attempt} error: ${e2.message}`);
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }
    let lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    // Sanitasi: buang baris refusal/markdown yang jelas bukan terjemahan.
    const BAD = /^(#{1,6}\s*\*?\**|core identity|system prompt|instructions conflict|i cannot|i can't|as an ai|saya tidak|terjemahan|catatan|note:)/i;
    const clean = lines.filter(l => !BAD.test(l) && !/^[-*]\s/.test(l) && !/^\d+[\.)]/.test(l));
    if (clean.length < lines.length) console.warn(`[translate] buang ${lines.length - clean.length} baris refusal/markdown`);
    lines = clean;
    console.log(`[translate] LLM(${TR_MODEL}) balas ${lines.length} baris (butuh ${use.length})`);
    if (lines.length < use.length * 0.4) {
      console.log(`[translate] hasil kurang (${lines.length}/${use.length}), skip`);
      return srtPath;
    }
    let li = 0;
    // Bangun srt output: cue di window diganti terjemahan, sisanya tetap asli.
    // YouTube auto-sub sering duplikat cue (timestamp identik di-offset 0.1s)
    // → dedupe: key = tm+text, ambil yang pertama. Tanpa ini cue dobel muncul
    // di timestamp hampir sama → subtitle saling tumpuk & terlihat "telat".
    const seen = new Set();
    const translatedSet = new Set(use.map(c => c.tm));
    const newCues = [];
    for (const c of allCues) {
      const key = c.tm + '|' + c.text;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!translatedSet.has(c.tm)) { newCues.push(`${c.tm}\n${c.text}`); continue; }
      const t = lines[li] || c.text;
      li++;
      newCues.push(`${c.tm}\n${t}`);
    }
    fs.writeFileSync(outPath, newCues.join('\n\n') + '\n', 'utf-8');
    console.log(`[translate] ${use.length}/${cues.length} cue diterjemah ke ${lang} -> ${path.basename(outPath)}`);
    return outPath;
  } catch (e) {
    console.warn(`[translate] gagal: ${e.message}, pakai srt asli`);
    return srtPath;
  }
}

module.exports = { translateSrt, parseSrt };
