// backend/scripts/transcribe.js — T-04
// Coba YouTube transcript resmi dulu (baoyu skill), gagal -> yt-dlp subs -> ekstrak audio + Whisper fallback.
// Tidak pernah bikin job failed — return warnings + transcript kosong kalau semua gagal (pipeline lanjut heuristic).

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { resolveYtDlp } = require('./download');

function srtTimeToSec(t) {
  // 00:01:23,456 -> sec
  const m = String(t).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1],10)*3600 + parseInt(m[2],10)*60 + parseInt(m[3],10) + parseInt(m[4],10)/1000;
}

function parseSrt(srtText) {
  const blocks = String(srtText).split(/\r?\n\r?\n/).filter(Boolean);
  const segments = [];
  for (const b of blocks) {
    const lines = b.split(/\r?\n/);
    if (lines.length < 2) continue;
    // line 0 = index, line 1 = time, rest = text
    const timeLine = lines[1] || '';
    const tm = timeLine.match(/(.+?)\s*-->\s*(.+)/);
    if (!tm) continue;
    const start = srtTimeToSec(tm[1]);
    const end = srtTimeToSec(tm[2]);
    const text = lines.slice(2).join(' ').trim();
    if (text) segments.push({ start, end, text });
  }
  return segments;
}

// Rolling auto-captions (YouTube aR): tiap cue = akumulasi teks penuh,
// cue berikutnya startsWith cue sebelumnya. Simpan hanya DELTA-nya.
function dedupeSegments(segs) {
  const out = [];
  for (const s of segs) {
    if (s.start >= s.end) continue;
    const prev = out[out.length - 1];
    if (prev && s.text.startsWith(prev.text) && s.start >= prev.start - 0.05) {
      const delta = s.text.slice(prev.text.length).trim();
      if (!delta) continue; // duplikat persis — skip
      out.push({ ...s, text: delta });
    } else {
      out.push(s);
    }
  }
  return out;
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')      // <c>, <00:00:04.479>, <i>, dll
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\N/g, ' ')
    .trim();
}

function vttToSrt(vttPath, srtOut) {
  // VTT (webvtt) -> SRT. Buang header, tag, watermark; baris timestamp -> blok SRT.
  const content = fs.readFileSync(vttPath, 'utf8');
  const lines = String(content).replace(/^\uFEFF/, '').split(/\r?\n/);
  const blocks = [];
  let cue = null;
  for (const line of lines) {
    if (/^WEBVTT|^Kind:|^Language:|^\s*$/.test(line)) { if (cue) { blocks.push(cue); cue = null; } continue; }
    if (line.includes('-->')) {
      if (cue) blocks.push(cue); // cue sebelumnya belum ditutup
      const m = line.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) { cue = null; continue; }
      cue = { start: m[1].replace('.', ','), end: m[2].replace('.', ','), text: [] };
    } else if (cue) {
      const t = stripTags(line);
      if (t) cue.text.push(t);
    }
  }
  if (cue) blocks.push(cue);
  let out = '';
  blocks.forEach((b, i) => {
    if (!b.text.length) return;
    out += `${i + 1}\n${b.start} --> ${b.end}\n${b.text.join(' ')}\n\n`;
  });
  fs.mkdirSync(path.dirname(srtOut), { recursive: true });
  fs.writeFileSync(srtOut, out);
  return out;
}

function findSrt(jobDir) {
  const candidates = [
    path.join(jobDir, 'transcript', 'transcript.srt'),
    path.join(jobDir, 'transcript.srt'),
    path.join(jobDir, 'raw.srt'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  // scan transcript subdir (.srt atau .vtt)
  const td = path.join(jobDir, 'transcript');
  if (fs.existsSync(td)) {
    try {
      for (const f of fs.readdirSync(td)) if (f.endsWith('.srt') || f.endsWith('.vtt')) return path.join(td, f);
    } catch {}
  }
  // fallback: file subtitle di jobDir root (skill download_video tulis {id}.en.vtt)
  try {
    for (const f of fs.readdirSync(jobDir)) {
      if (/\.(srt|vtt)$/i.test(f) && !f.startsWith('raw.')) return path.join(jobDir, f);
    }
  } catch {}
  return null;
}

function extractAudio({ videoPath, audioPath, ffmpegPath }) {
  return new Promise((resolve, reject) => {
    const ff = ffmpegPath || 'ffmpeg';
    const proc = spawn(ff, ['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', audioPath]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => reject(new Error('FFmpeg tidak ditemukan: ' + e.message)));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`FFmpeg extract audio gagal (code ${code}): ${stderr.slice(0, 600)}`));
      else resolve(audioPath);
    });
  });
}

function runWhisper({ audioPath, jobDir }) {
  // DISABLED: whisper too slow on low-spec hardware
  // Transcript will be null; pipeline continues with heuristic.
  return Promise.resolve(null);
}

/**
 * transcribe({ url, jobDir, videoPath, runSkill, ffmpegPath })
 * Returns: { srtPath, jsonPath, segments, warnings }
 * - srtPath null kalau gagal total (pipeline tetap lanjut)
 */
async function transcribe({ url, jobDir, videoPath, runSkill, ffmpegPath, source, existingSrt }) {
  const warnings = [];
  let srtPath = null;
  const isYouTube = String(url || '').includes('youtube.com') || String(url || '').includes('youtu.be');

  // 0) Pakai subtitle yang sudah didownload terpisah (downloadSubtitles di server.js)
  if (existingSrt && fs.existsSync(existingSrt)) {
    srtPath = existingSrt;
    console.log(`[transcribe] pake existingSrt -> ${srtPath}`);
  }

  const SKILL_OUT = srtPath
    ? path.join(jobDir, 'transcript', 'fallback.srt')   // jangan overwrite existingSrt
    : path.join(jobDir, 'transcript', 'transcript.srt');

  // Helper: probe duration dari video
  function probeDuration(vp) {
    try {
      const { execSync } = require('child_process');
      const probe = execSync(`ffmpeg -i "${vp}" 2>&1 | grep Duration`, { encoding: 'utf8' });
      const m = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (m) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    } catch {}
    return null;
  }

  // 1) Coba skill baoyu-youtube-transcript (hanya untuk URL YouTube; upload langsung ke whisper)
  // SKIP kalau existingSrt udah ada (dari downloadSubtitles — timing lebih akurat, ga overwrite)
  if (!srtPath && runSkill && isYouTube) {
    try {
      // -o: tulis langsung ke jalur deterministik (skill punya output alias -o),
      // biar kebaca findSrt — default --output-dir nyimpen di subfolder channel/title/.
      // --languages id,en: banyak video cuma punya sub auto-gend id/en, bukan en manual.
      await runSkill('baoyu-youtube-transcript', 'main.ts', [url, '--output-dir', path.join(jobDir, 'transcript'), '--format', 'srt', '--languages', 'id,id.*,en,en.*', '-o', SKILL_OUT]);
      srtPath = findSrt(jobDir);
      if (srtPath) {
        console.log(`[transcribe] skill OK -> ${srtPath}`);
      } else {
        warnings.push('Transcript skill selesai tapi .srt tidak ditemukan');
      }
    } catch (e) {
      warnings.push(`Transcript skill gagal: ${String(e.message).slice(0, 400)}`);
    }
  }

  // 2) Fallback yt-dlp --write-auto-sub --skip-download (opsional, cepat; hanya YouTube)
  if (!srtPath && isYouTube) {
    try {
      const ytDlpBin = resolveYtDlp();
      await new Promise(res => {
        const proc = spawn(ytDlpBin, ['--skip-download', '--js-runtimes', 'node', '--write-auto-sub', '--sub-lang', 'id,en,id-orig,en-orig', '--convert-subs', 'srt', '-o', path.join(jobDir, 'transcript/auto.%(ext)s'), url], { env: process.env });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', () => res());
        proc.on('close', code => res());
      });
      const found = findSrt(jobDir);
      if (found && found !== srtPath) { srtPath = found; console.log(`[transcribe] yt-dlp auto-sub OK -> ${srtPath}`); }
    } catch {}
  }

  // 3) Fallback Whisper (butuh audio)
  if (!srtPath && videoPath && fs.existsSync(videoPath)) {
    try {
      const audioPath = path.join(jobDir, 'raw.mp3');
      if (!fs.existsSync(audioPath)) {
        await extractAudio({ videoPath, audioPath, ffmpegPath });
      }
      const whisperSrt = await runWhisper({ audioPath, jobDir });
      if (whisperSrt) {
        // pindah ke transcript/transcript.srt biar konsisten
        const destDir = path.join(jobDir, 'transcript');
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, 'transcript.srt');
        try { fs.copyFileSync(whisperSrt, dest); srtPath = dest; } catch { srtPath = whisperSrt; }
        console.log(`[transcribe] whisper OK -> ${srtPath}`);
      } else {
        warnings.push('Whisper tidak tersedia / gagal — lanjut tanpa transcript (heuristic)');
      }
    } catch (e) {
      warnings.push(`Whisper fallback gagal: ${String(e.message).slice(0, 400)}`);
    }
  }

  if (!srtPath) {
    // FIX: sample subtitle placeholder ("Hai semuanya, selamat datang!") bikin subtitle
    // GA SESUAI dengan apa yang diucapkan. Kalo gaada transcript, bilang jujur.
    if (source === 'upload' && videoPath) {
      // Audio transcription via Gemini multimodal (Whisper local unusable di low-spec).
      // User: video TikTok upload ga punya subtitle → subtitle Indonesia harusnya ada.
      try {
        const { transcribeAudio } = require('./audio_transcribe');
        const audioOut = path.join(jobDir, 'transcript', 'audio_id.srt');
        const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
        const durOut = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { encoding: 'utf8' });
        const dur = parseFloat(durOut.stdout?.trim()) || 60;
        console.log(`[transcribe] upload tanpa transcript → audio transcription Gemini (dur ${dur}s)`);
        const r = await transcribeAudio(videoPath, audioOut, 'id', Math.min(dur, 600));
        if (r) {
          srtPath = r;
          console.log('[transcribe] audio transcription OK');
        } else {
          warnings.push('Audio transcription gagal — subtitle butuh transcribe manual');
        }
      } catch (e) {
        warnings.push(`Audio transcription error: ${String(e.message).slice(0, 300)}`);
        console.log('[transcribe] upload tanpa transcript: skip sample subtitle (bikin teks palsu)');
      }
    }
    if (!srtPath) return { srtPath: null, jsonPath: null, segments: [], warnings };
  }

  // Parse SRT -> JSON
  let segments = [];
  let jsonPath = null;
  try {
    let srtText = fs.readFileSync(srtPath, 'utf8');
    // Kalau sumbernya VTT (auto-caption), convert dulu ke SRT bersih
    if (/\.vtt$/i.test(srtPath) || /^\s*WEBVTT/.test(srtText)) {
      const conv = path.join(jobDir, 'transcript', 'transcript.srt');
      vttToSrt(srtPath, conv);
      srtPath = conv;
      srtText = fs.readFileSync(srtPath, 'utf8');
      console.log(`[transcribe] VTT -> SRT: ${srtPath}`);
    }
    segments = dedupeSegments(parseSrt(srtText));
    jsonPath = path.join(path.dirname(srtPath), 'transcript.json');
    // juga tulis di jobDir/transcript.json untuk pipeline yang expect di jobDir
    const altJson = path.join(jobDir, 'transcript.json');
    const payload = { segments, srtPath: path.relative(jobDir, srtPath), generatedAt: new Date().toISOString() };
    try { fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2)); } catch {}
    try { fs.writeFileSync(altJson, JSON.stringify(payload, null, 2)); jsonPath = altJson; } catch { if (!jsonPath) jsonPath = altJson; }
    // normalize srt ke jobDir/transcript/transcript.srt kalau belum
    const normalized = path.join(jobDir, 'transcript', 'transcript.srt');
    if (srtPath !== normalized) {
      try { fs.mkdirSync(path.dirname(normalized), { recursive: true }); fs.copyFileSync(srtPath, normalized); srtPath = normalized; } catch {}
    }
  } catch (e) {
    warnings.push(`Parse SRT gagal: ${e.message}`);
    return { srtPath, jsonPath: null, segments: [], warnings };
  }

  return { srtPath, jsonPath, segments, warnings };
}

module.exports = { transcribe, parseSrt, srtTimeToSec, findSrt, extractAudio, vttToSrt, dedupeSegments };
