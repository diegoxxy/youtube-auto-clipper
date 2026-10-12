// Audio transcription via Gemini multimodal (router lokal).
// Whisper local unusable di low-spec (300s+/60s); Gemini 3.5-flash ~5s/20s.
// User: video upload TikTok ga punya subtitle → subtitle Indonesia harusnya ada.
// ponytail: model audio Gemini; chunk 25s supaya ga overload context window;
//           kalo router ga support audio, fallback null (subtitle skip jujur).

const fs = require('fs');
const { spawnSync } = require('child_process');

function secToSrt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

// Transkrip audio penuh, output SRT.
// Gemini ga kasih timestamp per kata → bagi cue rata per ~4 detik (TikTok pace).
// Parse YouTube SRT (timing GLOBAL video) → cue timing CLIP-RELATIVE (0-based).
// Dipakai buat align timing ASR: YouTube timing presisi, teks ASR Indonesia.
function parseSrtGlobal(srtPath, clipStart, clipDur) {
  try {
    const content = fs.readFileSync(srtPath, 'utf-8').replace(/^\uFEFF/, '');
    const blocks = content.replace(/\r/g, '').split('\n\n');
    const out = [];
    for (const b of blocks) {
      const lines = b.split('\n').filter(l => l.trim());
      const ti = lines.findIndex(l => /\d+:\d+:\d+[,.]\d+\s*-->/.test(l));
      if (ti === -1) continue;
      const m = lines[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!m) continue;
      const s = (+m[1])*3600 + (+m[2])*60 + (+m[3]) + (+m[4])/1000;
      const e = (+m[5])*3600 + (+m[6])*60 + (+m[7]) + (+m[8])/1000;
      const ce = Math.min(clipStart + clipDur, e);
      const cs = Math.max(clipStart, s);
      const text = lines.slice(ti + 1).join(' ');
      if (ce > cs) out.push({ start: cs - clipStart, end: ce - clipStart, text });
    }
    // YouTube auto-sub sering blok DOBEL: teks sama diulang di blok
    // berurutan ("I'm sorry" 12.25-12.26 lalu 12.26-14.61 + teks lanjutan).
    // Sort + buang duplikat teks IDENTIK, simpan timing terpanjang.
    // (Jangan merge overlap sembarangan: blok auto-sub saling overlap jadi
    // 1 cue raksasa = 0 anchor timing untuk align.)
    out.sort((a, b) => a.start - b.start);
    const ded = [];
    for (const c of out) {
      const prev = ded[ded.length - 1];
      const a = (prev && prev.text || '').replace(/\s+/g, ' ').trim();
      const b = c.text.replace(/\s+/g, ' ').trim();
      if (prev && a && (a === b || b.startsWith(a) || a.startsWith(b))) {
        prev.end = Math.max(prev.end, c.end);
        prev.text = a.length >= b.length ? prev.text : c.text;
      } else {
        ded.push({ start: c.start, end: c.end, text: c.text });
      }
    }
    return ded.map(d => ({ start: d.start, end: d.end }));
  } catch (e) { return []; }
}

async function transcribeAudio(audioPath, outSrtPath, lang = 'id', totalDur = null, opts = null) {
  if (!fs.existsSync(audioPath)) return null;
  const dur = totalDur || 60;

  // VAD pakai energy audio: deteksi segmen ucapan (bukan jeda). LLM transcribe
  // tiap segmen -> timing dari segmen nyata, bukan dibagi rata.
  const { spawnSync } = require('child_process');
  const ff = process.env.FFMPEG_BIN || 'ffmpeg';
  // ponytail: silencedetect tanpa LibAVfilter pakai astats? silencedetect
  // standar cukup. noise=-30dB, min durasi 0.35s.
  // Kalau ambang kebanyakan jeda (speech panjang 1 utuh tanpa jeda terdeteksi),
  // turunkan nanti. Awalnya pakai -28dB/0.25s (lebih sensitif = jeda pendek
  // juga dianggap batas kata).
  const sd = spawnSync(ff, ['-i', audioPath, '-af', 'silencedetect=noise=-28dB:d=0.25',
    '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const log = sd.stderr || '';
  const sils = [];
  const re = /silence_start: ([\d.]+)(?:[\s\S]*?silence_end: ([\d.]+))?/g;
  let mm;
  while ((mm = re.exec(log))) {
    const s = +mm[1];
    const e = mm[2] != null ? +mm[2] : Math.min(dur, s + 0.5);
    sils.push([s, e]);
  }
  // segmen ucapan = gap antar jeda
  const segs = [];
  let prev = 0;
  for (const [s, e] of sils) {
    if (s - prev > 0.2) segs.push([prev, s]);
    prev = Math.max(prev, e);
  }
  if (dur - prev > 0.2) segs.push([prev, dur]);
  // merge segmen sangat pendek (<1.2s) ke tetangga: terlalu pendek buat LLM
  const merged = [];
  for (const sg of segs) {
    const last = merged[merged.length - 1];
    if (last && sg[1] - sg[0] < 1.2 && last[1] - last[0] < 3) {
      last[1] = sg[1];
    } else merged.push(sg);
  }
  // chunk tetap max 25s, tapi batas di jeda kalau bisa
  const CHUNK = 25;
  const chunks = [];
  const finalSegs = merged.length > 1 ? merged : [[0, dur]];
  for (const [s, e] of finalSegs) {
    let t = s;
    while (t < e - 0.1) {
      chunks.push({ start: t, dur: Math.min(CHUNK, e - t) });
      t += CHUNK;
    }
  }

  const cues = [];
  const tmpDir = require('path').dirname(outSrtPath);
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
  for (const ch of chunks) {
    // Extract chunk audio via ffmpeg (16kHz mono mp3 — kecil untuk LLM).
    const chunkPath = require('path').join(tmpDir, `_achunk_${ch.start}.mp3`);
    const ff = process.env.FFMPEG_BIN || 'ffmpeg';
    spawnSync(ff, ['-y', '-i', audioPath, '-ss', String(ch.start), '-t', String(ch.dur),
      '-vn', '-acodec', 'libmp3lame', '-b:a', '32k', '-ar', '16000', '-ac', '1', chunkPath],
      { stdio: 'ignore' });
    if (!fs.existsSync(chunkPath)) { console.warn(`[audio-transcribe] chunk ${ch.start}s: ffmpeg gagal`); continue; }

    const b64 = fs.readFileSync(chunkPath).toString('base64');
    const prompt = lang === 'id'
      ? 'Transkripsi audio percakapan ini ke teks apa adanya, dalam bahasa aslinya (Indonesia/gaul). ' +
        'Bagi jadi frasa SANGAT PENDEK 2-4 kata per baris (gaya subtitle TikTok/Shorts). ' +
        'Awal SETIAP baris dengan timestamp detik format [ss.d] saat kata itu diucapkan. ' +
        'Contoh: [0.0] jadi kalau lihat nih\\n[2.3] ibu-ibu parenting milenial. ' +
        'Balas HANYA baris timestamp, tanpa nomor tanpa penjelasan.'
      : 'Transcribe this audio. Split into VERY SHORT phrases 2-4 words per line (TikTok subtitle style). ' +
        'Prefix EACH line with timestamp seconds as [ss.d] when spoken. ' +
        'Reply ONLY timestamped lines.';
    try {
      const r = await fetch(process.env.AI_BASE_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.AI_API_KEY },
        body: JSON.stringify({
          model: process.env.AI_MODEL_AUDIO || 'Gemini', stream: false,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'input_audio', input_audio: { data: b64, format: 'mp3' } },
          ]}],
          max_tokens: 900,
        }),
      });
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content;
      if (!text || !text.trim()) { console.warn(`[audio-transcribe] chunk ${ch.start}s: kosong`); continue; }

      // Pakai timestamp LLM kalau ada ([ss.d] teks); fallback: bagi rata.
      const sents = text.split('\n').map(l => l.trim()).filter(Boolean).filter(l => l.length > 1);
      const tsRe = /^\[(\d+(?:\.\d+)?)\]\s*(.+)$/;
      const haveTs = sents.some(s => tsRe.test(s));
      const before = cues.length;
      if (haveTs) {
        // Deteksi timestamp PALSU: LLM sering cuma naik 0.1s per baris
        // tanpa sinkron audio asli. Kalau gap median < 0.3s, timestamp
        // ngawur -> fallback bagi rata.
        const tsRaw = [];
        for (const s of sents) {
          const m = s.match(tsRe);
          if (m) tsRaw.push(parseFloat(m[1]));
        }
        const gaps = tsRaw.slice(1).map((t, i) => t - tsRaw[i]).filter(g => g >= 0);
        gaps.sort((a, b) => a - b);
        const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1;
        if (med >= 0.3) {
          let prev = null;
          for (const s of sents) {
            const m = s.match(tsRe);
            if (!m) continue;
            const t = ch.start + parseFloat(m[1]);
            if (prev !== null) cues.push({ start: prev, end: t, text: m[2] });
            prev = t;
          }
          if (prev !== null && cues.length > before) {
            cues[cues.length - 1].end = Math.min(dur, ch.start + ch.dur);
          }
          console.log(`[audio-transcribe] chunk ${ch.start}s: ${cues.length - before} ts cue`);
        } else {
          // TS palsu: buang prefix timestamp, bagi rata sepanjang chunk.
          const clean = sents.map(s => s.replace(tsRe, '$2').trim()).filter(Boolean);
          const per = (ch.dur) / Math.max(1, clean.length);
          clean.forEach((s, i) => {
            const st = ch.start + i * per;
            cues.push({ start: st, end: Math.min(dur, st + per), text: s });
          });
          console.log(`[audio-transcribe] chunk ${ch.start}s: ${clean.length} kalimat (ts-fake med=${med.toFixed(2)}s)`);
        }
      } else {
        const per = (ch.dur) / Math.max(1, sents.length);
        sents.forEach((s, i) => {
          const st = ch.start + i * per;
          cues.push({ start: st, end: Math.min(dur, st + per), text: s });
        });
        console.log(`[audio-transcribe] chunk ${ch.start}s: ${sents.length} kalimat (no-ts)`);
      }
    } catch (e) {
      console.warn(`[audio-transcribe] chunk ${ch.start}s error: ${e.message}`);
    }
    try { fs.unlinkSync(chunkPath); } catch {}
  }

  if (!cues.length) return null;

  // TIMING = VAD SEGMENT + DISTRIBUSI KARAKTER. JANGAN pakai YouTube
  // auto-sub anchor: auto-sub LAGGING (teks tampil SETELAH ucapan selesai —
  // "being a child's boarder" 6.21-6.77 padahal speech VAD 0-6.89). ASR yang
  // di-align ke anchor YouTube jadi ikut telat ~1-2s (user: "subtitle telat").
  // VAD silencedetect akurat ±0.1s; distribusi karakter di dalam segmen
  // ngikutin kecepatan bicara (kata pendek cepat, panjang lama).
  for (let i = 0; i + 1 < cues.length; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3;
  }
  if (cues.length) cues[cues.length - 1].end = Math.min(dur, Math.max(cues[cues.length - 1].end, cues[cues.length - 1].start + 0.3));
  const srt = cues.map((c, i) =>
    `${i + 1}\n${secToSrt(c.start)} --> ${secToSrt(c.end)}\n${c.text}\n`
  ).join('\n');
  fs.writeFileSync(outSrtPath, srt);
  console.log(`[audio-transcribe] ${cues.length} cue -> ${outSrtPath}`);
  return outSrtPath;
}

module.exports = { transcribeAudio };
