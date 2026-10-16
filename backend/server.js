const express = require('express');
require('dotenv').config(); // load .env dari backend/ (AI_PROVIDER, AI_API_KEY, dll)
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const multer = require('multer');

// T-02..T-08 helpers — require di atas agar tidak hoisting bug
const validateFs = require('./scripts/validate/youtube');
const { downloadVideo, downloadSubtitles } = require('./scripts/download');
const { transcribe } = require('./scripts/transcribe');
const { segment, rank } = require('./scripts/ai/adapter');
const { scoreTranscript } = require('./scripts/ai/score_clips');
const { processClip, computeFaceCrop } = require('./scripts/ffmpeg/processor');
const { getTemplate, listCaptionStyles } = require('./scripts/subtitles/templates');

// ponytail: global crash guard — 1 render/LLM gagal tidak boleh exit backend (OOM low-spec).
process.on('uncaughtException', (e) => console.error('[guard] uncaughtException:', e.message));
process.on('unhandledRejection', (e) => console.error('[guard] unhandledRejection:', e?.message || e));

// wrapper untuk endpoint edit (sama logic, beda nama biar ga bingung)
function computeFaceCropForEdit(videoPath, outW, outH) {
  return computeFaceCrop(videoPath, outW, outH);
}

const app = express();
const cors = require('cors');
app.use(cors());

function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') findAvailablePort(startPort + 1).then(resolve).catch(reject);
      else reject(err);
    });
    server.listen(startPort, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const SKILLS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'skills');

let ffmpegPath = 'ffmpeg';
let ffmpegOk = false;
try {
  const out = execSync('where ffmpeg', { encoding: 'utf8' }).toString().trim();
  ffmpegPath = out.split('\n')[0].trim();
  ffmpegOk = true;
  console.log(`[boot] FFmpeg OK: ${ffmpegPath}`);
} catch {
  console.warn('[boot] FFmpeg NOT found in PATH, using custom path');
  ffmpegPath = 'C:/Users/diego/AppData/Local/Microsoft/WinGet/Packages/BtbN.FFmpeg.GPL_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-N-125875-g5d4d3bdc61-win64-gpl/bin/ffmpeg.exe';
  ffmpegOk = true;
  console.log(`[boot] FFmpeg set to: ${ffmpegPath}`);
}
if (!process.env.AI_PROVIDER || !process.env.AI_API_KEY) {
  console.warn('[boot] AI_PROVIDER/AI_API_KEY kosong — T-05/T-06 pakai heuristic (tetap jalan). Set di .env, lihat .env.example');
} else {
  console.log(`[boot] AI provider: ${process.env.AI_PROVIDER} model=${process.env.AI_MODEL || '(default)'}`);
}

function runSkill(skillName, scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SKILLS_DIR, skillName, 'scripts', scriptName);
    const envVars = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    if (skillName === 'youtube-clipper') envVars.YT_CLIPPER_JSON_ONLY = '1';
    let childProcess;
    if (skillName === 'baoyu-youtube-transcript') childProcess = spawn('bun', [scriptPath, ...args], { env: envVars });
    else childProcess = spawn('C:\\Users\\diego\\AppData\\Local\\Programs\\Python\\Python311\\python.exe', [scriptPath, ...args], { env: envVars });
    let output = ''; let error = '';
    childProcess.stdout.on('data', (d) => { output += d.toString(); });
    childProcess.stderr.on('data', (d) => { error += d.toString(); });
    childProcess.on('close', (code) => {
      if (code !== 0) reject(new Error(`Skill ${skillName} failed with code ${code}: ${error}`));
      else resolve(output.trim());
    });
  });
}

const JOBS_DIR = path.join(__dirname, 'jobs');
const UPLOAD_TMP = path.join(JOBS_DIR, '_uploads');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });

// Startup scan: re-queue job queued/clipping (process.exit/restart kill in-memory queue)
function scanAndRequeueStuckJobs() {
  try {
    const dirs = fs.readdirSync(JOBS_DIR).filter(d => 
      fs.statSync(path.join(JOBS_DIR, d)).isDirectory()
    );
    let count = 0;
    for (const dir of dirs) {
      const metaPath = path.join(JOBS_DIR, dir, 'metadata.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if ((meta.status === 'queued' || meta.status === 'clipping') && meta.progress < 100) {
          console.log(`[boot] re-queue ${dir} status=${meta.status} progress=${meta.progress}%`);
          enqueueJob(() => processJob(dir), dir);
          count++;
        }
      } catch (e) {
        console.warn(`[boot] skip ${dir}: ${e.message}`);
      }
    }
    console.log(`[boot] re-queued ${count} job(s)`);
  } catch (e) {
    console.warn('[boot] scanAndRequeueStuckJobs error:', e.message);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (r, f, cb) => cb(null, UPLOAD_TMP),
    filename: (r, f, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + (path.extname(f.originalname) || '.mp4')),
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
  fileFilter: (r, f, cb) => {
    const ok = /\.(mp4|webm|mkv|mov|avi|m4v|mpg|mpeg)$/i.test(f.originalname) || (f.mimetype || '').startsWith('video/');
    cb(ok ? null : new Error('File harus video (mp4/webm/mkv/mov/avi)'), ok);
  },
});
function uploadVideo(req, res, next) {
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload gagal: ' + err.message });
    next();
  });
}
function probeDuration(filePath) {
  try {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, { encoding: 'utf8', windowsHide: true }).trim();
    const d = parseFloat(out);
    return isFinite(d) ? d : null;
  } catch { return null; }
}
function writeMetadata(jobDir, data) {
  const tmp = path.join(jobDir, 'metadata.tmp.json');
  const dest = path.join(jobDir, 'metadata.json');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dest);
}
function readMetadata(jobId) {
  const p = path.join(JOBS_DIR, jobId, 'metadata.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[meta] read ${jobId} corrupted: ${e.message}`);
    return null;
  }
}
function updateJob(jobId, patch) {
  const meta = readMetadata(jobId);
  if (!meta) return null;
  // track _lastProgressUpdate buat stuck detection
  const now = new Date().toISOString();
  const updated = { 
    ...meta, 
    ...patch, 
    updatedAt: now,
    _lastProgressUpdate: patch.progress !== undefined ? now : meta._lastProgressUpdate
  };
  writeMetadata(path.join(JOBS_DIR, jobId), updated);
  return updated;
}
function isValidYouTubeUrl(url) { return validateFs.isValidYouTubeUrl(url); }

// Referensi gaya: streamer bisa kasih link TikTok/IG/Reels atau file video.
// Backend ambil metadata best-effort (title/desc/duration) -> diringkas jadi style guide buat prompt AI.
async function buildReferenceStyle({ meta0, jobDir, warnings }) {
  const refs = (meta0.options && Array.isArray(meta0.options.references)) ? meta0.options.references.filter(Boolean).slice(0, 5) : [];
  if (!refs.length) return null;
  const parts = [];
  for (const ref of refs) {
    const r = String(ref).trim();
    if (!r) continue;
    if (r.startsWith('file://') || /\.(mp4|webm|mov|mkv)$/i.test(r) && fs.existsSync(r.replace(/^file:\/\//, ''))) {
      const p = r.replace(/^file:\/\//, '');
      const d = probeDuration(p);
      parts.push(`- File referensi "${path.basename(p)}"${d ? ` (durasi ${Math.round(d)}s)` : ''}: ${d && d <= 35 ? 'pacing sangat cepat, hook <2s, potongan pendek' : d && d <= 70 ? 'pacing cepat, hook <3s' : 'pacing sedang'}. Tiru ritme potongan ini.`);
      continue;
    }
    // Link sosial: extract title+description via yt-dlp (best-effort, jangan bikin job gagal)
    if (/^https?:\/\//i.test(r)) {
      try {
        const yt = resolveYtDlp ? require('./scripts/download').resolveYtDlp() : 'yt-dlp';
        const raw = execSync(`"${yt}" --skip-download --print "%(title)s\\n%(description).400s\\n%(duration)s" --no-warnings "${r.replace(/"/g, '')}"`, { encoding: 'utf8', timeout: 45000, windowsHide: true });
        const [title = '', desc = '', dur = ''] = raw.split('\n');
        const tags = (desc.match(/#\w+/g) || []).slice(0, 8).join(' ');
        parts.push(`- Referensi ${r}\n  Judul: ${String(title).slice(0, 120)}\n  Durasi: ${dur || '?'}s\n  Deskripsi/tag: ${String(desc).replace(/\s+/g, ' ').slice(0, 300)} ${tags}\n  -> Tiru pola hook, pacing, dan gaya caption/hashtag ini.`);
        console.log(`[refs] extracted: ${r}`);
      } catch (e) {
        warnings.push(`Referensi gagal dianalisis (${r}): ${String(e.message).slice(0, 160)}`);
      }
    }
  }
  return parts.length ? parts.join('\n') : null;
}

// Background runner — T-03..T-08 real
// JOB QUEUE: render video = CPU-bound, low-spec machine. Job sebelumnya selesai
// dulu sebelum mulai job baru (user: 3 job paralel bikin semua lemot & "lama").
let jobQueue = Promise.resolve();
let queuedJobs = []; // track antrian, buat position info
function enqueueJob(fn, jobId) {
  if (jobId) queuedJobs.push(jobId);
  const next = jobQueue.then(() => {
    if (jobId) queuedJobs = queuedJobs.filter(j => j !== jobId);
    return fn();
  });
  jobQueue = next.catch(() => {});
  // update queue position untuk semua job di queue
  if (jobId) {
    for (const jid of queuedJobs) {
      const pos = queuedJobs.indexOf(jid) + 1;
      try {
        const meta = readMetadata(jid);
        if (meta && meta.status === 'queued') {
          updateJob(jid, { 
            _queuePos: pos,
            _queueWait: Math.ceil(pos * 15), // ~15 menit per job
            _lastProgressUpdate: new Date().toISOString()
          });
        }
      } catch {}
    }
  }
  return next;
}

async function processJob(jobId) {
  const jobDir = path.join(JOBS_DIR, jobId);
  const meta0 = readMetadata(jobId);
  if (!meta0) return;
  let videoPath = null; let videoInfo = null; let warningsDownload = [];
  let existingSrt = null;
  let tRes = { srtPath: null, jsonPath: null, segments: [], warnings: [] };
  let clips = [];
  try {
    updateJob(jobId, { status: 'downloading', progress: 5 });
        const url = meta0.url;
        // RESUME: raw sudah ada di jobDir (restart di tengah render) → skip download.
        const existingRaw = ['raw.mp4', 'raw.webm', 'raw.mkv', 'raw.mov'].map(f => path.join(jobDir, f)).find(f => fs.existsSync(f) && fs.statSync(f).size > 102400);
        if (existingRaw && meta0.videoPath === existingRaw) {
          videoPath = existingRaw;
          videoInfo = meta0.videoInfo || { id: 'raw', title: 'video', duration: probeDuration(existingRaw) };
          warningsDownload = ['Resume: pakai video yang sudah ada (skip download)'];
          updateJob(jobId, { videoInfo, videoPath, progress: 15 });
          console.log(`[jobs] ${jobId} RESUME pakai raw existing -> ${existingRaw}`);
        } else if (meta0.source === 'upload' && meta0.uploadedPath && fs.existsSync(meta0.uploadedPath)) {
      // Upload: skip download, pindah file ke jobDir lalu hapus tmp
      const ext = path.extname(meta0.uploadedPath) || '.mp4';
      const dest = path.join(jobDir, `raw${ext}`);
      try { fs.renameSync(meta0.uploadedPath, dest); }
      catch { fs.copyFileSync(meta0.uploadedPath, dest); fs.unlinkSync(meta0.uploadedPath); }
      videoPath = dest;
      videoInfo = {
        id: 'upload',
        title: meta0.uploadTitle || meta0.originalName || 'Uploaded video',
        duration: probeDuration(dest),
        ext: ext.slice(1),
        _source: 'upload',
      };
      updateJob(jobId, { videoInfo, videoPath, warnings: [], progress: 15 });
      console.log(`[jobs] ${jobId} upload ok -> ${dest}`);
    } else {
      const _t0 = Date.now();
      const dl = await downloadVideo({ url, jobDir, runSkill });
      videoPath = dl.videoPath; videoInfo = dl.videoInfo; warningsDownload = dl.warnings || [];
      updateJob(jobId, { videoInfo, videoPath, warnings: warningsDownload, progress: 15 });
      console.log(`[perf] ${jobId} download ${((Date.now() - _t0) / 1000).toFixed(1)}s -> ${videoPath} (${videoInfo.title || videoInfo.id})`);

      // Ambil subtitle terpisah (tidak fatal kalau 429) — transcribe pake ini kalau ada
      if (isValidYouTubeUrl(url)) {
        try {
          const sub = await downloadSubtitles(url, jobDir);
          if (sub.srtPath) {
            existingSrt = sub.srtPath;
            console.log(`[jobs] ${jobId} subtitle ok -> ${sub.srtPath}`);
          } else if (sub.warning) {
            warningsDownload.push(sub.warning);
            updateJob(jobId, { warnings: warningsDownload });
          }
        } catch (e) {
          warningsDownload.push(`Ambil subtitle gagal: ${String(e.message).slice(0, 200)}`);
          updateJob(jobId, { warnings: warningsDownload });
        }
      }
    }

    const _t1 = Date.now();
    updateJob(jobId, { status: 'transcribing', progress: 20 });
    tRes = await transcribe({ url, jobDir, videoPath, runSkill, ffmpegPath, source: meta0.source, existingSrt });
    const transcriptWarnings = tRes.warnings || [];
    const srtPath = tRes.srtPath;
    const transcriptJsonPath = tRes.jsonPath;
    const transcriptSegments = tRes.segments || [];
    updateJob(jobId, {
      transcript: { srtPath: srtPath ? path.relative(jobDir, srtPath) : null, jsonPath: transcriptJsonPath ? path.relative(jobDir, transcriptJsonPath) : null, segmentCount: transcriptSegments.length },
      warnings: [...warningsDownload, ...transcriptWarnings],
      progress: 32,
    });
    console.log(`[perf] ${jobId} transcribe ${((Date.now() - _t1) / 1000).toFixed(1)}s ${srtPath ? 'OK' : 'no transcript'} segments=${transcriptSegments.length}`);

    const _t2 = Date.now();
    updateJob(jobId, { status: 'segmenting', progress: 40, srtPath: tRes.srtPath, videoPath, videoInfo });
    let aiWarnings = [];
    const referenceStyle = await buildReferenceStyle({ meta0, jobDir, warnings: aiWarnings });
    // SOURCE INFO buat AI pilih format framing: rasio source + shot-density
    // (kamera gonta-ganti = bahaya buat crop 9:16 → AI harus pilih fill).
    // Probe cepat sekali (cache); gagal = null, prompt pakai fallback teks.
    let sourceInfo = null;
    try {
      const { probeWidth, probeHeight } = require('./scripts/ffmpeg/processor');
      const dim = { w: probeWidth(videoPath), h: probeHeight(videoPath) };
      const dur = videoInfo && videoInfo.duration ? Number(videoInfo.duration) : 0;
      // shot density: sample window 120s di TENGAH video (awal sering
      // intro lambat; clip asli biasanya di pertengahan). job baa0344a:
      // sample awal 0.19 vs clip window 0.32-0.36 = keliru kamera cepat
      // sebagai tenang.
      const sStart = Math.max(0, Math.round(((dur || 120) - 120) / 2));
      let shots = 0;
      try {
        const rs = require('child_process').spawnSync(ffmpegPath,
          ['-ss', String(sStart), '-i', videoPath, '-t', String(Math.min(120, dur || 120)),
           '-vf', "select='gt(scene,0.25)',showinfo", '-f', 'null', '-'],
          { encoding: 'utf8', timeout: 120000, windowsHide: true });
        shots = ((rs.stderr || '').match(/pts_time:/g) || []).length;
      } catch (e) { shots = 0; }
      const sDur = Math.min(120, dur || 120);
      sourceInfo = JSON.stringify({
        videoAspectRatio: Math.round((dim.w / dim.h) * 100) / 100,
        shotDensity: sDur > 0 ? Math.round((shots / sDur) * 100) / 100 : 0,
        shotCount120s: shots,
      });
      console.log(`[jobs] sourceInfo: ${sourceInfo}`);
    } catch (e) { console.warn(`[jobs] sourceInfo gagal: ${e.message}`); }
    const segRes = await segment({
      transcriptSegments,
      brief: meta0.brief || null,
      duration: videoInfo && videoInfo.duration ? Number(videoInfo.duration) : (transcriptSegments.length ? transcriptSegments[transcriptSegments.length - 1].end : null),
      clipCount: meta0.options?.clipCount || 5,
      targetDuration: meta0.options?.targetDuration || 60,
      referenceStyle,
      sourceInfo,
    });
    clips = segRes.clips || [];
    aiWarnings = [...aiWarnings, ...(segRes.warnings || [])];
    // ponytail: JANGAN tulis clips ke metadata di phase segment — judul masih
    // EN heuristic. Tulis di line ~327 setelah rank+translate (judul ID final).
    // User 2026-10-03: "judul judul clip suka berubah ubah sendiri" = frontend
    // polling dapet EN heuristic (progress 55) lalu ID (progress 70).
    updateJob(jobId, { warnings: [...warningsDownload, ...transcriptWarnings, ...aiWarnings], progress: 55 });
    console.log(`[jobs] ${jobId} segment done clips=${clips.length}`);

    updateJob(jobId, { status: 'ranking', progress: 60 });
    const rankRes = await rank({ clips, transcriptSegments, brief: meta0.brief || null });
    clips = rankRes.clips || clips;
    aiWarnings = [...aiWarnings, ...(rankRes.warnings || [])];

    // TRANSLATE title/reason/keywords ke Indonesia (heuristic & viral_moments
    // ambil 8 kata pertama transcript — kalau transcript en, judul jadi en).
    // User: "hasil clipping previewnya masih pake bahasa inggris".
    try {
      const needT = clips.some(c => /[A-Za-z]/.test(c.title || '') || /Fallback|Topic complete|Keyword/.test(c.reason || ''));
      if (needT) {
        const { callOpenAI } = require('./scripts/ai/adapter');
        const list = clips.map((c, i) => `${i + 1}. title="${c.title || ''}" reason="${(c.reason || '').slice(0, 120)}" hook="${(c.hook || '').slice(0, 80)}" keywords=${JSON.stringify(c.keywords || [])}`).join('\n');
        const out = await callOpenAI({
          model: process.env.AI_MODEL_TRANSLATE || 'Gemini',
          prompt: `Ini adalah daftar judul + alasan + hook clip video pendek (TikTok/Reels). Terjemahkan SEMUA ke Bahasa Indonesia yang natural, catchy, gaya Gen Z. Untuk keywords, terjemahkan ke Indonesia. Jangan ubah makna. Jangan tambahkan penjelasan.\n\n${list}\n\nBalas HANYA JSON array, format: [{"title":"...","reason":"...","hook":"...","keywords":["..."]}]`,
        });
        const arr = JSON.parse(out.trim().replace(/^```json\s*|\s*```$/g, ''));
        if (Array.isArray(arr)) {
          clips = clips.map((c, i) => ({
            ...c,
            title: (arr[i] && arr[i].title) || c.title,
            reason: (arr[i] && arr[i].reason) || c.reason,
            hook: (arr[i] && arr[i].hook) || c.hook,
            keywords: (arr[i] && arr[i].keywords) || c.keywords,
          }));
          console.log(`[translate] ${arr.length} judul clip diterjemah ke ID`);
        }
      }
    } catch (e) { console.warn(`[translate] judul gagal: ${String(e.message).slice(0, 150)}`); }

    // Mode interaktif: berhenti di ranked, user pilih clip baru dirender
    if (meta0.options?.interactive) {
      updateJob(jobId, {
        status: 'ranked',
        progress: 70,
        candidates: clips.map((c) => ({
          id: c.id, start: c.start, end: c.end,
          title: c.title || null, hook: c.hook || null,
          score: c.score ?? null, tier: c.tier || null,
          summary: c.summary || c.reason || null, tags: c.tags || [],
        })),
        warnings: [...warningsDownload, ...transcriptWarnings, ...aiWarnings],
      });
      console.log(`[jobs] ${jobId} ranked — interactive pause, ${clips.length} candidates`);
      return;
    }

    updateJob(jobId, { clips, warnings: [...warningsDownload, ...transcriptWarnings, ...aiWarnings], progress: 70 });
    console.log(`[perf] ${jobId} segment+rank ${((Date.now() - _t2) / 1000).toFixed(1)}s top=${clips[0]?.score ?? '-'}`);

    const _t3 = Date.now();
    updateJob(jobId, { status: 'clipping', progress: 78 });
    const formats = meta0.options?.formats || ['9:16'];

    // PRE-TRANSLATE paralel (sebelum render): Gemini ~4s/call × 10 clip serial
    // di tengah render = +40s. Paralel di awal = ~8s total.
    // SKIP TOTAL kalau sub asli bukan EN-dominan — user: "transcrib apapun
    // yang keluar dari mulut, jangan ada yang diterjemahkan sama sekali."
    // Auto-sub 'id' = ucapan asli; translate = LLM rephrase, BUKAN ucapan.
    if (tRes.srtPath && meta0.options?.includeSubtitles !== false) {
      const srcIsEn = (() => {
        try {
          const p = path.isAbsolute(tRes.srtPath) ? tRes.srtPath : path.join(jobDir, tRes.srtPath);
          if (!fs.existsSync(p)) return false;
          const t = fs.readFileSync(p, 'utf-8');
          const blocks = t.trim().split('\n\n').filter(Boolean);
          const EN = /\b(the|and|you|that|this|with|have|was|were|are|been|they|their|what|when|would|could|should|about|which|there|then|them|these|those|because|between|through|during|before|after)\b/i;
          const enBlocks = blocks.filter(b => EN.test(b.split('\n').slice(2).join(' ')));
          return blocks.length > 0 && enBlocks.length > blocks.length * 0.5;
        } catch (e) { return false; }
      })();
      if (!srcIsEn) {
        console.log(`[translate] sub asli bukan-EN → SKIP translate (ucapan asli dipakai)`);
      } else {
      try {
        const { translateSrt } = require('./scripts/subtitles/translate');
        const _tt = Date.now();
        const tJobs = clips.map(c => (async () => {
          const idPath = path.join(jobDir, `translated_id_${Math.round(c.start * 10)}.srt`);
          if (fs.existsSync(idPath)) return;
          try { await translateSrt(tRes.srtPath, idPath, 'id', c.start, c.end - c.start); }
          catch (e) { console.warn(`[translate] clip ${c.id} pre-gagal: ${e.message}`); }
        })());
        await Promise.all(tJobs);
        console.log(`[perf] ${jobId} pre-translate ${clips.length} window ${((Date.now() - _tt) / 1000).toFixed(1)}s`);
      } catch (e) { console.warn(`[translate] pre-translate batch gagal: ${e.message}`); }
      }
    }

    // ponytail: render clip PARALEL (concurrency 2 — jaga RAM low-spec).
    // Sequential 5 clip × (tracking pass + encode) = bottleneck utama sebelumnya.
    const renderOneClip = async (c) => {
      const filesByFormat = {};
      let subtitleBurnPerClip = null;
      // FORMAT PER-CLIP (AI auto-pick): "auto" mode = clip.format menang,
      // job formats cuma fallback kalau AI ga kasih. "custom" mode = paksa
      // format pilihan user buat SEMUA clip (AI format di-ignore).
      const fmtMode = String(meta0.options?.formatMode || 'auto').toLowerCase();
      const clipFormats = (fmtMode === 'custom' || !c.format)
        ? formats
        : [c.format];
      for (const fmt of clipFormats) {
        const safeFmt = fmt.replace(':', '-').replace(':', '_');
        const outName = `c${String(c.id).replace(/^c/, '')}_${safeFmt}.mp4`;
        const outPath = path.join(jobDir, 'clips', outName);
        try {
          const reactionVideoPath = (fmt === '9:16_reaction' && meta0.options?.reactionVideo) ? meta0.options.reactionVideo : null;
          const subtitleTemplate = meta0.options?.subtitleTemplate || 'bold';
          const srtPathFull = meta0.options?.includeSubtitles !== false && tRes.srtPath ? tRes.srtPath : null;
          const result = await processClip({ ffmpegPath, videoPath, output: outPath, start: c.start, end: c.end, format: fmt, srtPath: srtPathFull, reactionVideoPath, subtitleTemplate, refStyle: referenceStyle });
          if (!fs.existsSync(outPath)) { throw new Error(`clip ${c.id} output missing after processClip: ${outPath}`); }
          console.log(`[server] clip ${c.id} fmt ${fmt} result.subtitleBurn=${JSON.stringify(result.subtitleBurn)}`);
          filesByFormat[fmt] = outName;
          if (fmt === formats[0] && result.subtitleBurn) {
            subtitleBurnPerClip = true;
          }
        } catch (e) {
          console.error(`[jobs] ${jobId} clip ${c.id} format ${fmt} gagal: ${e.stack || e.message}`);
          aiWarnings.push(`Clip ${c.id} ${fmt} gagal: ${e.message.slice(0, 200)}`);
        }
      }
      const primaryFmt = formats[0];
      const primaryFile = filesByFormat[primaryFmt] || Object.values(filesByFormat)[0] || null;
      return { ...c, file: primaryFile, files: filesByFormat, subtitleBurn: subtitleBurnPerClip };
    };

    // pool SERIAL: low-spec CPU — 1 clip render = 1 core penuh (user: "cpu 100% ffmpeg gabisa diturunin?").
    // CONC 2 + 3 job bareng = 6 core jebol. Render = CPU-bound, paralel cuma nambah total waktu.
    const CONC = 1;
    const results = new Array(clips.length);
    let nextIdx = 0;
    let doneCount = 0;
    const workers = Array.from({ length: Math.min(CONC, clips.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= clips.length) break;
        results[i] = await renderOneClip(clips[i]);
        doneCount++;
        // tulis files per-clip ke metadata → UI bisa hitung "2/5 klip selesai".
        const partial = results.filter(Boolean);
        updateJob(jobId, {
          progress: 78 + Math.round((doneCount / clips.length) * 17),
          clips: partial,
          warnings: [...warningsDownload, ...transcriptWarnings, ...aiWarnings],
        });
      }
    });
    await Promise.all(workers);
    const clipsWithFiles = results.filter(Boolean);

    updateJob(jobId, { status: 'done', progress: 100, clips: clipsWithFiles, warnings: [...warningsDownload, ...transcriptWarnings, ...aiWarnings] });
    // ponytail: raw.mp4 sudah di-render jadi clips + ada di _cache/{videoId}.mp4.
    // Hapus dari jobDir biar ga makan disk space (1.4GB per job). Output final cuma clips.
    const rawPath = path.join(JOBS_DIR, jobId, 'raw.mp4');
    if (fs.existsSync(rawPath)) {
      try {
        const rawSizeMB = Math.round(fs.statSync(rawPath).size / 1e6);
        fs.unlinkSync(rawPath);
        console.log(`[jobs] ${jobId} cleanup raw.mp4 (${rawSizeMB}MB freed)`);
      } catch (e) { console.warn(`[jobs] ${jobId} cleanup raw.mp4 gagal: ${e.message}`); }
    }
    console.log(`[perf] ${jobId} render ${clipsWithFiles.length} clips ${((Date.now() - _t3) / 1000).toFixed(1)}s (paralel x${Math.min(CONC, clips.length)})`);
    console.log(`[jobs] ${jobId} done — ${clipsWithFiles.length} clips`);
  } catch (err) {
    console.error(`[jobs] ${jobId} failed:`, err);
    updateJob(jobId, { status: 'failed', progress: 100, error: err.message || String(err) });
  }
}

app.use((req, res, next) => {
  console.log(`[debug] ${req.method} ${req.url}`);
  next();
});

app.use(express.json({ limit: '3mb' }));
app.use(cors());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString(), ffmpeg: ffmpegOk ? ffmpegPath : null, ffmpegOk, aiProvider: process.env.AI_PROVIDER || null, hasAiKey: !!process.env.AI_API_KEY });
});

// T-01: async job API
app.post('/api/jobs/upload', uploadVideo, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file terupload' });
    const { brief, clipCount, targetDuration, formats, formatMode, subtitleLang, includeSubtitles, subtitleTemplate, refId } = req.body;
    const formatModeVal = String(formatMode || 'auto').toLowerCase() === 'custom' ? 'custom' : 'auto';
    const originalNameRaw = req.file.originalname || 'uploaded.mp4';

    const clipCountN = Math.min(10, Math.max(1, parseInt(clipCount, 10) || 5));
    const targetDurationN = Math.min(180, Math.max(15, parseInt(targetDuration, 10) || 60));
    let formatList = Array.isArray(formats) ? formats : String(formats || '9:16').split(',').map((s) => s.trim());
    formatList = formatList.filter((f) => ['9:16', '1:1', '16:9', '9:16_reaction', '9:16_fill', '9:16_split', '16:9_fill'].includes(f));
    if (!formatList.length) formatList = ['9:16'];

    const jobId = crypto.randomUUID();
    const jobDir = path.join(JOBS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.mkdirSync(path.join(jobDir, 'clips'), { recursive: true });
    const tmpPath = req.file.path;
    const upExt = /^\.\w+$/.test(path.extname(originalNameRaw)) ? path.extname(originalNameRaw) : '.mp4';
    const moved = path.join(jobDir, 'input' + upExt);
    try { fs.renameSync(tmpPath, moved); } catch { fs.copyFileSync(tmpPath, moved); fs.unlinkSync(tmpPath); }
    const originalName = originalNameRaw;

    const metadata = {
      jobId,
      url: 'upload://' + originalName,
      source: 'upload',
      uploadedPath: moved,
      originalName,
      uploadTitle: path.basename(originalName, path.extname(originalName)),
      brief: brief || null,
      status: 'queued', progress: 0,
      options: { clipCount: clipCountN, targetDuration: targetDurationN, formats: formatList, formatMode: formatModeVal, subtitleLang: subtitleLang || 'id', includeSubtitles: includeSubtitles !== 'false' && includeSubtitles !== false, subtitleTemplate: subtitleTemplate || 'bold', refId: refId || null },
      videoInfo: null, videoPath: null, clips: [], warnings: [], error: null,
      transcript: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    writeMetadata(jobDir, metadata);
    console.log(`[jobs] queued upload ${jobId} file=${originalName} size=${req.file.size}`);
    setImmediate(() => enqueueJob(() => processJob(jobId), jobId).catch((e) => console.error(e)));
    return res.status(201).json({ jobId, status: 'queued', progress: 0 });
  } catch (err) {
    console.error('POST /api/jobs/upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(500).json({ error: 'Gagal buat job upload: ' + (err.message || String(err)) });
  }
});

app.post('/api/jobs', async (req, res) => {
  try {
    const { url, brief, options = {} } = req.body;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });
    if (!validateFs.isValidYouTubeUrl(url)) return res.status(400).json({ error: 'URL tidak valid — harus youtube.com / youtu.be / m.youtube.com' });
    const briefVal = validateFs.validateBriefText(brief);
    if (!briefVal.ok) return res.status(400).json({ error: briefVal.error });
    const clipCount = Math.min(10, Math.max(1, parseInt(options.clipCount, 10) || 5));
    const targetDuration = Math.min(180, Math.max(15, parseInt(options.targetDuration, 10) || 60));
    let formats = Array.isArray(options.formats) && options.formats.length ? options.formats : ['9:16'];
    formats = formats.filter((f) => ['9:16', '1:1', '16:9', '9:16_reaction', '9:16_fill', '9:16_split', '16:9_fill', 'adaptive'].includes(f));
    if (!formats.length) formats = ['9:16'];
    const formatMode = String(options.formatMode || 'auto').toLowerCase() === 'custom' ? 'custom' : 'auto';

    const jobId = crypto.randomUUID();
    const jobDir = path.join(JOBS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.mkdirSync(path.join(jobDir, 'clips'), { recursive: true });

    const references = Array.isArray(options.references) ? options.references.filter(Boolean).slice(0, 5) : [];

    const metadata = {
      jobId, url, brief: briefVal.brief, status: 'queued', progress: 0,
      options: { clipCount, targetDuration, formats, formatMode, subtitleLang: options.subtitleLang || 'id', includeSubtitles: options.includeSubtitles !== false, references, subtitleTemplate: options.subtitleTemplate || 'bold', interactive: options.interactive === true },
      videoInfo: null, videoPath: null, clips: [], warnings: [], error: null,
      transcript: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    writeMetadata(jobDir, metadata);
    console.log(`[jobs] queued ${jobId} brief=${briefVal.brief ? briefVal.brief.slice(0, 40) : '-'} clipCount=${clipCount} formats=${formats.join(',')}`);
        setImmediate(() => enqueueJob(() => processJob(jobId), jobId).catch((e) => console.error(e)));
        return res.status(201).json({ jobId, status: 'queued', progress: 0 });
  } catch (err) {
    console.error('POST /api/jobs error:', err);
    return res.status(500).json({ error: 'Gagal membuat job: ' + (err.message || String(err)) });
  }
});

app.get('/api/jobs', (req, res) => {
  if (!fs.existsSync(JOBS_DIR)) return res.json([]);
  const ids = fs.readdirSync(JOBS_DIR).filter((d) => { try { return fs.statSync(path.join(JOBS_DIR, d)).isDirectory(); } catch { return false; } });
  const items = ids.map((id) => readMetadata(id)).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20);
  return res.json(items);
});

app.get('/api/jobs/:id', (req, res) => {
  const meta = readMetadata(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Job not found' });
  return res.json(meta);
});

app.get('/api/jobs/:id/logs', (req, res) => {
  const jobId = req.params.id;
  const jobDir = path.join(JOBS_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'Job not found' });
  
  // Kumpulkan log dari console.log backend yang mention jobId
  // ponytail: log per-job ga di-split ke file terpisah (overhead I/O low-spec).
  // Scan dinamis semua be*.log (backend ganti nama per restart beD/beE/...beZ).
  const tmpDir = path.join(process.env.LOCALAPPDATA || process.env.TEMP, 'Temp');
  const logFiles = (() => {
    try {
      return fs.readdirSync(tmpDir)
        .filter(f => /^be[A-Z]?\.log$/.test(f) || /^backend.*\.log$/.test(f))
        .map(f => path.join(tmpDir, f))
        .filter(f => fs.existsSync(f) && fs.statSync(f).size > 0)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) // terbaru dulu
        .slice(0, 5);
    } catch { return []; }
  })();
  
  const lines = [];
  const limit = parseInt(req.query.limit) || 200;

  // urut kronologis: file LAMA dulu → BARU terakhir
  // PENTING: baca TAIL 256KB saja (jangan full read — log MB-an block
  // event loop → semua request /health timeout saat render jalan).
  const TAIL = 262144;
  const readTail = (p, max) => {
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - max);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } catch (e) {
      return '';
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  };
  for (const logPath of [...logFiles].reverse()) {
    try {
      const content = readTail(logPath, TAIL);
      // PENTING: grep jobId FULL, jangan slice(0,8) (tabel log beN.log mencatat UUID full).
      const jobLines = content.split('\n').filter(l => l.includes(jobId));
      lines.push(...jobLines.slice(-limit));
    } catch {}
  }
  
  // Dedupe + sort by timestamp heuristic (line order)
  const unique = [...new Set(lines)].slice(-limit);
  return res.json({ jobId, lines: unique, count: unique.length });
});

app.get('/api/subtitle-templates', (req, res) => {
  const { listTemplates } = require('./scripts/subtitles/templates');
  return res.json(listTemplates());
});

// Preview video 4s tiap template subtitle (bg gelap + srt dummy, karaoke jalan).
// Frontend bisa langsung preload semua template lewat endpoint ini.
app.get('/api/subtitle-preview/:template', async (req, res) => {
  try {
    const tpl = String(req.params.template || 'karaoke');
    const priv = ['..', '\\', '/'];
    if (priv.some(c => tpl.includes(c))) return res.status(400).json({ error: 'bad template' });
    const { getTemplate } = require('./scripts/subtitles/templates');
    const t = getTemplate(tpl);
    if (!t) return res.status(404).json({ error: 'template not found' });
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const { srtToAss } = require('./scripts/ffmpeg/processor');
    const prevDir = path.join(os.tmpdir(), 'subprev');
    fs.mkdirSync(prevDir, { recursive: true });
    const outMp4 = path.join(prevDir, `prev_${tpl}.mp4`);
    // Cache 10 menit: template ga berubah dalam sesi ini.
    if (fs.existsSync(outMp4) && Date.now() - fs.statSync(outMp4).mtimeMs < 600000) {
      return res.sendFile(outMp4);
    }
    const srtPath = path.join(prevDir, 'dummy.srt');
    if (!fs.existsSync(srtPath)) {
      const cues = [
        [0.2, 1.6, 'INI CONTOH SUBTITLE'],
        [1.7, 3.1, 'KATA AKTIF NYALA'],
        [3.2, 4.0, 'CAPCUT STYLE'],
      ];
      const srt = cues.map((c, i) => `${i + 1}\n00:00:${(c[0]).toFixed(3).replace('.', ',')} --> 00:00:${(c[1]).toFixed(3).replace('.', ',')}\n${c[2]}\n`).join('\n');
      fs.writeFileSync(srtPath, srt);
    }
    const assPath = path.join(prevDir, `dummy_${tpl}.ass`);
    srtToAss(srtPath, assPath, 0, 4, tpl);
    const { spawn } = require('child_process');
    const ff = 'C:/Users/diego/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';
    const args = ['-y', '-f', 'lavfi', '-i', 'color=c=0x101014:s=1080x1920:d=4:r=30',
      // path RELATIVE + cwd: drive letter `C:` di filter subtitles = option separator (gotcha).
      '-vf', `subtitles=dummy_${tpl}.ass`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', outMp4];
    await new Promise((resolve, reject) => {
      const sp = spawn(ff, args, { cwd: prevDir, windowsHide: true });
      let err = '';
      sp.stderr.on('data', d => { err += d; });
      sp.on('error', reject);
      sp.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ' ' + err.slice(-400))));
    });
    if (!fs.existsSync(outMp4)) return res.status(500).json({ error: 'render gagal' });
    return res.sendFile(outMp4);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
    // ponytail: endpoint aman dipanggil berulang, cache 10 menit.
  }
});

// Reference video upload endpoint
app.post('/api/references/upload', uploadVideo, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file terupload' });
    const refId = crypto.randomUUID();
    const refDir = path.join(__dirname, 'uploads', 'references');
    fs.mkdirSync(refDir, { recursive: true });
    const ext = path.extname(req.file.originalname) || '.mp4';
    const refPath = path.join(refDir, `${refId}${ext}`);
    try { fs.renameSync(req.file.path, refPath); } catch { fs.copyFileSync(req.file.path, refPath); fs.unlinkSync(req.file.path); }
    
    const { analyzeReference } = require('./scripts/style/extractor');
    const analysis = analyzeReference(refPath);
    
    const metadata = {
      refId,
      fileName: req.file.originalname,
      filePath: refPath,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
      analysis,
    };
    const metaPath = path.join(refDir, `${refId}.json`);
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    
    return res.status(201).json({ refId, fileName: metadata.fileName, analysis });
  } catch (err) {
    console.error('[reference] upload error:', err);
    return res.status(500).json({ error: 'Upload gagal: ' + err.message });
  }
});

app.get('/api/references/:refId', (req, res) => {
  const refDir = path.join(__dirname, 'uploads', 'references');
  const metaPath = path.join(refDir, `${req.params.refId}.json`);
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Reference not found' });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  return res.json(meta);
});

// CANCEL job: mark failed, stop worker
app.post('/api/jobs/:id/cancel', (req, res) => {
  const jobId = req.params.id;
  const meta = readMetadata(jobId);
  if (!meta) return res.status(404).json({ error: 'Job not found' });
  if (['done', 'failed'].includes(meta.status)) return res.status(400).json({ error: 'Job sudah selesai/failed' });
  
  // Mark job failed
  meta.status = 'failed';
  meta.error = 'Cancelled by user';
  meta.updatedAt = new Date().toISOString();
  try {
    const metaPath = path.join(JOBS_DIR, jobId, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    // Remove dari queue
    queuedJobs = queuedJobs.filter(j => j !== jobId);
    console.log(`[jobs] ${jobId} CANCELLED by user`);
    return res.json({ status: 'cancelled', jobId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Serve static frontend AFTER API routes
app.use(express.static(path.join(__dirname, '../frontend')));

// Stream / download per clip (baru, untuk T-09/T-10)
app.get('/api/jobs/:id/stream', (req, res) => {
  const meta = readMetadata(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Job not found' });
  const clipId = req.query.clip; const fmt = req.query.format || (meta.options?.formats?.[0] || '9:16');
  if (!clipId) return res.status(400).json({ error: 'clip query required' });
  const clip = (meta.clips || []).find((c) => String(c.id) === String(clipId));
  if (!clip) return res.status(404).json({ error: 'Clip not found' });
  const safeFmt = String(fmt).replace(':', '-').replace(':', '_');
  const fileName = clip.files?.[fmt] || clip.file || `c${String(clipId).replace(/^c/, '')}_${safeFmt}.mp4`;
  const filePath = path.join(JOBS_DIR, req.params.id, 'clips', fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not ready yet', fileName });
  // preview player butuh inline; judul filename di-handle via download attr di frontend.
  // support range via sendFile
  return res.sendFile(path.resolve(filePath));
});

// Thumbnail cover per clip (fix "hasil video abu-abu doang"): extract frame
// tengah clip render → JPEG, cache di job dir. Frontend pasang jadi video poster.
app.get('/api/jobs/:id/thumb', async (req, res) => {
  try {
    const meta = readMetadata(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Job not found' });
    const clipId = req.query.clip;
    if (!clipId) return res.status(400).json({ error: 'clip query required' });
    const clip = (meta.clips || []).find((c) => String(c.id) === String(clipId));
    if (!clip) return res.status(404).json({ error: 'Clip not found' });
    const fmt = String(req.query.format || meta.options?.formats?.[0] || '9:16');
    const safeFmt = fmt.replace(':', '-').replace(':', '_');
    const fileName = clip.files?.[fmt] || clip.file || `c${String(clipId).replace(/^c/, '')}_${safeFmt}.mp4`;
    const jobDir = path.join(JOBS_DIR, req.params.id);
    const filePath = path.join(jobDir, 'clips', fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not ready yet' });
    const thumbName = `thumb_${String(clipId)}_${safeFmt}.jpg`;
    const thumbPath = path.join(jobDir, 'thumbs', thumbName);
    // cache: gambar sama tiap request, regenerate = buang CPU
    if (!fs.existsSync(thumbPath)) {
      fs.mkdirSync(path.join(jobDir, 'thumbs'), { recursive: true });
      const dur = Math.max(1, (clip.end ?? clip.start + 30) - clip.start);
      // CLIP-RELATIVE: video render mulai dari 0 (BUKAN abs clip.start —
      // raw.mp4 segmen udah di-trim). abs = seek lewat EOF = Invalid argument.
      // MULTI-CANDIDATE: 5 frame di 20-70% durasi (skip transisi). Pilih
      // frame dgn wajah MATA TERBUKA + kontras tinggi (kedipan @35% = mata
      // tertutup = thumbnail jelek). Fallback: frame pertama.
      const cands = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70].map(f =>
        path.join(jobDir, 'thumbs', `_tc_${String(clipId)}_${Math.round(f * 100)}.jpg`));
      const midT = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70];
      let picked = null;
      try {
        const { pickBestThumb } = require('./scripts/thumbs.js');
        picked = await pickBestThumb(ffmpegPath, filePath, midT, cands, thumbPath);
      } catch (e) { /* fallback di bawah */ }
      if (!picked) {
        // fallback simple: 1 frame di 40%
        const mid = dur * 0.40;
        const r = spawnSync(ffmpegPath, ['-y', '-ss', String(mid), '-i', filePath,
          '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', thumbPath],
          { windowsHide: true, timeout: 30000 });
        if (r.status !== 0 || !fs.existsSync(thumbPath)) {
          return res.status(500).json({ error: 'thumb gagal' });
        }
      }
      // bersihin kandidat sementara
      for (const c of cands) { try { fs.unlinkSync(c); } catch (e) {} }
    }
    return res.sendFile(path.resolve(thumbPath));
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Media library: sticker pack bawaan + upload media user
// helper: parse SRT → [{start,end,text}] + cari file SRT di job dir
function parseSrtToSegs(srtText) {
  const segs = [];
  const blocks = String(srtText).split(/\r?\n\r?\n/);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const text = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (text) segs.push({ start, end, text });
  }
  return segs;
}
function findSrt(jobDir) {
  try {
    for (const f of fs.readdirSync(jobDir)) {
      if (/\.(srt|vtt)$/i.test(f) && !f.startsWith('raw.')) return path.join(jobDir, f);
    }
  } catch (e) { /* noop */ }
  return null;
}

// convert whisper transcript.json → SRT (untuk burn subtitle)
function transcriptToSrt(jobDir) {
  const tjson = path.join(jobDir, 'transcript.json');
  if (!fs.existsSync(tjson)) return null;
  try {
    const tj = JSON.parse(fs.readFileSync(tjson, 'utf8'));
    const segs = Array.isArray(tj.segments) ? tj.segments : [];
    if (!segs.length) return null;
    const out = path.join(jobDir, 'whisper.srt');
    let srt = '';
    segs.forEach((s, i) => {
      srt += `${i + 1}\n${assClock(s.start)} --> ${assClock(s.end)}\n${String(s.text || '').trim()}\n\n`;
    });
    fs.writeFileSync(out, srt, 'utf8');
    return out;
  } catch (e) { return null; }
}

function assClock(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0').replace('.', ',')}`;
}

// Preview: score transcript → daftar kandidat clip (sebelum render) — user bisa pilih
app.get('/api/jobs/:id/segments', async (req, res) => {
  try {
    const jobDir = path.join(JOBS_DIR, req.params.id);
    const metaPath = path.join(jobDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'job not found' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    // ambil segments: transcript.json (faster-whisper) / segments.json / parse SRT
    let segs = [];
    const tjsonPath = path.join(jobDir, 'transcript.json');
    const segPath = path.join(jobDir, 'segments.json');
    const srtPath = meta.srtPath || findSrt(jobDir) || transcriptToSrt(jobDir);
    if (fs.existsSync(tjsonPath)) {
      const tj = JSON.parse(fs.readFileSync(tjsonPath, 'utf8'));
      segs = Array.isArray(tj.segments) ? tj.segments : [];
    } else if (fs.existsSync(segPath)) {
      segs = JSON.parse(fs.readFileSync(segPath, 'utf8'));
    } else if (srtPath && fs.existsSync(srtPath)) {
      segs = parseSrtToSegs(fs.readFileSync(srtPath, 'utf8'));
    }
    if (!segs.length) return res.json({ candidates: [], note: 'transcript belum tersedia' });

    const opts = {
      maxClips: 12,
      minScore: 4,
      minDur: 5,
      maxDur: 90,
      step: 4,
    };
    const candidates = scoreTranscript(segs, opts);
    res.json({ candidates, totalSegments: segs.length, duration: meta.duration || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Render segmen terpilih (dari SegmentPicker): clip manual start/end
app.post('/api/jobs/:id/render-clip', async (req, res) => {
  try {
    const { start, end, format = '9:16', subtitleTemplate } = req.body || {};
    const s = Number(start), e = Number(end);
    if (!isFinite(s) || !isFinite(e) || e <= s) return res.status(400).json({ error: 'start/end invalid' });
    const jobDir = path.join(JOBS_DIR, req.params.id);
      const metaPath = path.join(jobDir, 'metadata.json');
      if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'job not found' });
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const videoPath = path.join(jobDir, 'raw.mp4');
      if (!fs.existsSync(videoPath)) return res.status(400).json({ error: 'raw.mp4 belum ada' });

      const clipsDir = path.join(jobDir, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });
    const clipId = `m${Date.now().toString(36)}`;
    const outName = `${clipId}_${format.replace(':', '-')}.mp4`;
    const outPath = path.join(clipsDir, outName);
    const srtPathFull = meta.options?.includeSubtitles !== false ? (meta.srtPath || findSrt(jobDir) || transcriptToSrt(jobDir)) : null;

    const result = await processClip({
      ffmpegPath, videoPath, output: outPath, start: s, end: e, format,
      srtPath: srtPathFull,
      subtitleTemplate: subtitleTemplate || meta.options?.subtitleTemplate || 'modern',
    });

    const clip = {
      id: clipId,
      title: `Clip ${fmtT(s)}–${fmtT(e)}`,
      start: s, end: e,
      duration: Math.round((e - s) * 10) / 10,
      files: { [format]: outName },
      subtitleBurn: result.subtitleBurn || null,
      createdAt: new Date().toISOString(),
    };
    (meta.clips = meta.clips || []).push(clip);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    res.json({ success: true, clip });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function fmtT(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Caption styles gaya CapCut (word highlight presets)
app.get('/api/media/caption-styles', (req, res) => {
  res.json({ styles: listCaptionStyles() });
});

// Sticker packs kategori
app.get('/api/media/stickers', (req, res) => {
  const packs = [
    {
      id: 'basic', name: 'Basic', stickers: ['😀','🔥','💯','🤯','👀','💀','✨','👇','🥵','🤡','⚡','❤️','😱','🤣','💀','🫠'],
    },
    {
      id: 'reaction', name: 'Reaction', stickers: ['😂','😍','😮','😤','🤔','😎','🥳','😭','😡','🤯','😴','🫡'],
    },
    {
      id: 'gaming', name: 'Gaming', stickers: ['🎮','👾','🏆','⚡','🔥','💥','🎯','🗡️','🛡️','💰','🎲','🕹️'],
    },
    {
      id: 'meme', name: 'Meme', stickers: ['🗿','🥴','🫠','😌','🤓','😏','🫦','💀','👁️👄👁️','✍️','🧏','🗣️'],
    },
    {
      id: 'arrows', name: 'Arrows & Point', stickers: ['👇','👉','👈','👆','🫵','📍','🎯','💡','⚠️','❗','✅','❌'],
    },
  ];
  res.json({ packs });
});

// Upload media (foto/video/gif) jadi overlay library per job
app.post('/api/jobs/:id/media', (req, res) => {
  // multer-like manual: cek multipart
  const busboy = require('busboy');
  const bb = busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
  const jobDir = path.join(JOBS_DIR, req.params.id);
  const mediaDir = path.join(jobDir, 'media');
  try { fs.mkdirSync(mediaDir, { recursive: true }); } catch {}
  const saved = [];
  bb.on('file', (name, file, info) => {
    const safe = String(info.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(mediaDir, safe);
    const ws = fs.createWriteStream(dest);
    file.pipe(ws);
    ws.on('close', () => saved.push(safe));
    ws.on('error', () => {});
  });
  bb.on('finish', () => {
    const meta = readMetadata(req.params.id);
    if (meta) {
      meta.mediaFiles = [...new Set([...(meta.mediaFiles || []), ...saved])];
      writeMetadata(jobDir, meta);
    }
    res.json({ success: true, files: saved });
  });
  bb.on('error', () => res.status(500).json({ error: 'upload media gagal' }));
  req.pipe(bb);
});

// List media library per job
app.get('/api/jobs/:id/media', (req, res) => {
  const jobDir = path.join(JOBS_DIR, req.params.id);
  const mediaDir = path.join(jobDir, 'media');
  let files = [];
  try { files = fs.readdirSync(mediaDir).filter(f => /\.(png|jpg|jpeg|gif|webp|mp4|mov|webm)$/i.test(f)); } catch {}
  res.json({ files });
});

// Serve file media
app.get('/api/jobs/:id/media/:filename', (req, res) => {
  const base = path.basename(req.params.filename); // anti path traversal
  const p = path.join(JOBS_DIR, req.params.id, 'media', base);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  return res.sendFile(path.resolve(p));
});

// Edit clip: render ulang dengan edits (split, text overlays, volume, speed)
app.post('/api/jobs/:id/clips/:clipId/edit', async (req, res) => {
  try {
    const meta = readMetadata(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Job not found' });
    const clip = (meta.clips || []).find((c) => String(c.id) === String(req.params.clipId));
    if (!clip) return res.status(404).json({ error: 'Clip not found' });

    const { splitAt, texts = [], mediaLayers = [], volume = 100, speed = 1, start, end, subtitleTemplate } = req.body;
    const jobDir = path.join(JOBS_DIR, req.params.id);
    const videoPath = path.join(jobDir, 'raw.mp4');
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Source video missing' });

    const fmt = (meta.options?.formats?.[0] || '9:16');
    const startSec = Number(start ?? clip.start ?? 0);
    const endSec = Number(end ?? clip.end ?? (startSec + 30));
    const clipDur = Math.max(0.5, endSec - startSec);

    // Build ASS from text layers (pakai template subtitle yg dipilih)
    let assPath = null;
    if (Array.isArray(texts) && texts.length > 0) {
      const tplName = ['modern','retro','minimal','boxed','pop','story'].includes(subtitleTemplate) ? subtitleTemplate : 'modern';
      const tpl = getTemplate(tplName);
      const tplLines = tpl.style.split('\n');
      const evIdx = tplLines.findIndex((l) => l.trim() === '[Events]');
      const lines = tplLines.slice(0, evIdx).concat([
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ]);
      for (const t of texts) {
        const s = Math.max(0, Number(t.start) || 0);
        const e = Math.min(clipDur, Number(t.end) || clipDur);
        if (e <= s) continue;
        const esc = String(t.text || '').replace(/[{}]/g, '').replace(/'/g, '');
        lines.push(`Dialogue: 0,${secToAssStr(s)},${secToAssStr(e)},Default,,0,0,0,,${esc}`);
      }
      assPath = path.join(jobDir, `edit_${clip.id}.ass`);
      fs.writeFileSync(assPath, lines.join('\n') + '\n');
    }

    // Media overlays: foto/video di timeline
    const mediaInputs = [];
    const overlayParts = [];
    (Array.isArray(mediaLayers) ? mediaLayers : []).forEach((m, i) => {
      const mp = path.join(jobDir, 'media', String(m.src || ''));
      if (!fs.existsSync(mp)) return;
      const idx = i + 1;
      mediaInputs.push(mp);
      const s = Math.max(0, Number(m.start) || 0);
      const e = Math.min(clipDur, Number(m.end) || clipDur);
      const px = Math.round((Number(m.x) || 0.5) * 1080);
      const py = Math.round((Number(m.y) || 0.35) * 1920);
      const wpx = Math.round((Number(m.scale) || 0.3) * 1080);
      overlayParts.push({ idx, px, py, s, e, label: `mov${idx}`, wpx });
    });

    const vf = [];
    if (fmt === '9:16') {
      // Auto face-framing (sama kaya pipeline utama)
      const faceCrop = computeFaceCropForEdit(videoPath, 1080, 1920);
      if (faceCrop) {
        vf.push(`crop=${faceCrop.w}:${faceCrop.h}:${faceCrop.x}:${faceCrop.y}`);
        vf.push('scale=1080:1920:force_original_aspect_ratio=decrease');
        vf.push('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black');
      } else {
        vf.push('scale=1080:1920:force_original_aspect_ratio=increase');
        vf.push('crop=1080:1920:(iw-1080)/2:(ih-1920)/2');
      }
    } else if (fmt === '1:1') {
      vf.push('scale=1080:1080:force_original_aspect_ratio=increase');
      vf.push('crop=1080:1080:(iw-1080)/2:(ih-1080)/2');
    } else {
      vf.push('scale=1280:720:force_original_aspect_ratio=decrease');
    }
    if (assPath) {
      const esc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      vf.push(`subtitles='${esc}'`);
    }
    vf.push('fade=t=in:st=0:d=0.3');
    vf.push(`fade=t=out:st=${Math.max(0, clipDur - 0.3)}:d=0.3`);

    const args = ['-y', '-ss', String(startSec), '-t', String(clipDur), '-i', videoPath];
    for (const mi of mediaInputs) {
      args.push('-t', String(clipDur), '-i', mi);
    }
    const af = [];
    if (volume !== 100) af.push(`volume=${Number(volume) / 100}`);
    if (speed !== 1) af.push(`atempo=${Number(speed)}`);
    if (overlayParts.length > 0) {
      // filter_complex: base video + media overlays (enable= timing per overlay)
      const chains = [`[0:v]${vf.join(',')}[base]`];
      overlayParts.forEach((o, i) => {
        chains.push(`[${o.idx}:v]scale=${o.wpx}:-1[${o.label}]`);
        const prev = i === 0 ? 'base' : `ov${i}`;
        chains.push(`[${prev}][${o.label}]overlay=${o.px}:${o.py}:enable='between(t\\,${o.s}\\,${o.e})'[ov${i + 1}]`);
      });
      const last = `ov${overlayParts.length}`;
      args.push('-filter_complex', chains.join(';'));
      args.push('-map', `[${last}]`, '-map', '0:a');
    } else {
      args.push('-vf', vf.join(','));
    }
    if (af.length) args.push('-af', af.join(','));
    if (speed !== 1) args.push('-filter:v', `setpts=${(1 / Number(speed)).toFixed(4)}*PTS`);
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28');
    args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-pix_fmt', 'yuv420p');

    const outName = `${clip.id}_${String(fmt).replace(':', '-')}_edit.mp4`;
    const outPath = path.join(jobDir, 'clips', outName);
    args.push(outPath);

    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => res.status(500).json({ error: 'spawn error: ' + e.message }));
    proc.on('close', (code) => {
      if (code !== 0) return res.status(500).json({ error: 'FFmpeg failed', detail: stderr.slice(-600) });
      // update metadata
      clip.files = { ...clip.files, [fmt]: outName };
      clip.editedAt = new Date().toISOString();
      if (splitAt) clip.splitPoint = Number(splitAt);
      writeMetadata(jobDir, meta);
      return res.status(200).json({ success: true, taskId: req.params.id, clipId: clip.id, file: outName });
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

function secToAssStr(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const se = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(se).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Mode interaktif: render clip terpilih setelah user review candidates
app.post('/api/jobs/:id/confirm', async (req, res) => {
  const jobId = req.params.id;
  const jobDir = path.join(JOBS_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'job not found' });
  const meta = readMetadata(jobId);
  if (!meta) return res.status(404).json({ error: 'job metadata missing' });
  if (meta.status !== 'ranked' || !Array.isArray(meta.candidates) || meta.candidates.length === 0) {
    return res.status(409).json({ error: 'job not in ranked state', status: meta.status });
  }
  const selected = req.body?.selected || [];
  if (!Array.isArray(selected) || selected.length === 0) {
    return res.status(400).json({ error: 'selected must be non-empty array of candidate ids' });
  }
  const formats = req.body?.formats && req.body.formats.length ? req.body.formats : (meta.options?.formats || ['9:16']);
  const subtitleTemplate = req.body?.subtitleTemplate || meta.options?.subtitleTemplate || 'modern';
  const includeSubtitles = req.body?.includeSubtitles !== false;
  const srtPath = includeSubtitles && meta.srtPath ? meta.srtPath : null;

  const want = new Set(selected.map(String));
  const picks = meta.candidates.filter((c) => want.has(String(c.id)));
  if (picks.length === 0) return res.status(400).json({ error: 'no matching candidate ids' });

  // Raw video harus ada
  const rawCandidates = ['raw.mp4', 'raw.mkv', 'raw.webm', 'raw.mov'];
  const videoPath = rawCandidates.map((f) => path.join(jobDir, f)).find((p) => fs.existsSync(p));
  if (!videoPath) return res.status(409).json({ error: 'raw video missing', status: meta.status });

  updateJob(jobId, { status: 'clipping', progress: 75, selected });
  const clipsWithFiles = [];
  let aiWarnings = [];
  try {
    for (const c of picks) {
      const filesByFormat = {};
      let subtitleBurnPerClip = null;
      for (const fmt of formats) {
        const safeFmt = fmt.replace(':', '-').replace(':', '_');
        const outName = `c${String(c.id).replace(/^c/, '')}_${safeFmt}.mp4`;
        const outPath = path.join(jobDir, 'clips', outName);
        try {
          const result = await processClip({
            ffmpegPath, videoPath, output: outPath,
            start: c.start, end: c.end, format: fmt,
            srtPath, subtitleTemplate,
          });
          filesByFormat[fmt] = outName;
          if (fmt === formats[0]) subtitleBurnPerClip = !!result.subtitleBurn;
        } catch (e) {
          aiWarnings.push(`Clip ${c.id} ${fmt} gagal: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
        }
      }
      const primaryFmt = formats[0];
      clipsWithFiles.push({
        ...c, file: filesByFormat[primaryFmt] || Object.values(filesByFormat)[0] || null,
        files: filesByFormat, subtitleBurn: subtitleBurnPerClip,
      });
      updateJob(jobId, { progress: 75 + Math.round((clipsWithFiles.length / picks.length) * 22), warnings: [...(meta.warnings || []), ...aiWarnings] });
    }
    updateJob(jobId, {
      status: 'done', progress: 100, clips: clipsWithFiles,
      warnings: [...(meta.warnings || []), ...aiWarnings],
    });
    res.json({ success: true, jobId, clips: clipsWithFiles });
  } catch (err) {
    updateJob(jobId, { status: 'failed', error: String(err && err.message ? err.message : err) });
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.get('/api/jobs/:id/download', (req, res) => {
  const meta = readMetadata(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Job not found' });
  const clipId = req.query.clip; const fmt = req.query.format || (meta.options?.formats?.[0] || '9:16');
  if (!clipId) return res.status(400).json({ error: 'clip query required' });
  const clip = (meta.clips || []).find((c) => String(c.id) === String(clipId));
  if (!clip) return res.status(404).json({ error: 'Clip not found' });
  const safeFmt = String(fmt).replace(':', '-').replace(':', '_');
  const diskFile = clip.files?.[fmt] || clip.file || `c${String(clipId).replace(/^c/, '')}_${safeFmt}.mp4`;
  const filePath = path.join(JOBS_DIR, req.params.id, 'clips', diskFile);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not ready yet' });
  // Download filename: "Title Clip - 13m47s-14m32s.mp4" (user: "gw mau sesuai dengan judul clipnya")
  const fmtSec = (s) => { const m=Math.floor(s/60); const sec=Math.floor(s%60); return `${m}m${sec.toString().padStart(2,'0')}s`; };
  const downloadName = `${(clip.title || 'Clip').replace(/[<>:"/\\|?*]/g, '_')} - ${fmtSec(clip.start)}-${fmtSec(clip.end ?? clip.start + 30)}.mp4`;
  return res.download(filePath, downloadName);
});

// Legacy single-clip — DEPRECATED
app.post('/clip', async (req, res) => {
  res.setHeader('X-Deprecated', 'Use POST /api/jobs instead');
  try {
    const { url, startTime, endTime, options = {} } = req.body;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });
    const jobId = Date.now().toString();
    const jobDir = path.join(__dirname, 'jobs', jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    console.log(`[legacy /clip] job ${jobId} url=${url}`);
    let transcriptResult;
    try { transcriptResult = await runSkill('baoyu-youtube-transcript', 'main.ts', [url, '--output-dir', path.join(jobDir, 'transcript'), '--format', 'srt']); } catch (e) { console.warn('Transcript failed:', e.message); transcriptResult = null; }
    const videoResult = await runSkill('youtube-clipper', 'download_video.py', [url, jobDir]);
    const videoInfo = JSON.parse(videoResult);
    const videoPath = path.join(jobDir, `${videoInfo.id}.mp4`);
    const audioPath = path.join(jobDir, `${videoInfo.id}.mp3`);
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, ['-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', audioPath, '-y']);
      let stderr = ''; ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('close', (code) => { if (code !== 0) reject(new Error('FFmpeg failed: ' + stderr)); else resolve(); });
    });
    let hookAnalysis = {};
    try { hookAnalysis = await runSkill('youtube-clipper', 'analyze_subtitles.py', [transcriptResult ? path.join(jobDir, 'transcript', 'transcript.srt') : videoPath]); } catch (e) { console.warn('Hook failed:', e.message); }
    let clipStart = startTime || 0; let clipEnd = endTime || videoInfo.duration || 60;
    if (options.autoDetect && hookAnalysis.segments?.length) { const best = hookAnalysis.segments.reduce((a, b) => a.score > b.score ? a : b); clipStart = best.start; clipEnd = best.end; }
    const clippedVideoPath = path.join(jobDir, 'clipped.mp4');
    await runSkill('youtube-clipper', 'clip_video.py', [videoPath, String(clipStart), String(clipEnd), clippedVideoPath]);
    let finalVideoPath = clippedVideoPath;
    if (transcriptResult && options.includeSubtitles !== false) {
      const subPath = path.join(jobDir, 'transcript', 'transcript.srt'); const out = path.join(jobDir, 'subtitled.mp4');
      await runSkill('youtube-clipper', 'burn_subtitles.py', [clippedVideoPath, subPath, out]); finalVideoPath = out;
    }
    if (options.addBranding) { const out = path.join(jobDir, 'branded.mp4'); await runSkill('branding', 'add_watermark.py', [finalVideoPath, options.brandingText || 'YouTube Auto-Clipper', options.brandingPosition || 'bottom-right', out]); finalVideoPath = out; }
    if (options.speed && options.speed !== 1.0) { const out = path.join(jobDir, 'speed_adjusted.mp4'); await runSkill('video-speed-adjustment', 'adjust_speed.py', [finalVideoPath, String(options.speed), out]); finalVideoPath = out; }
    const outputPath = path.join(jobDir, 'output.mp4');
    await runSkill('claude-video-export', 'export_video.py', [finalVideoPath, '--preset', 'web-optimized', '--output', outputPath]);
    const metadata = { jobId, originalUrl: url, clipStart, clipEnd, duration: clipEnd - clipStart, createdAt: new Date().toISOString(), fileSize: fs.statSync(outputPath).size, outputFilename: 'output.mp4', transcriptAvailable: !!transcriptResult };
    fs.writeFileSync(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    res.status(200).json({ success: true, jobId, downloadUrl: `/download/${jobId}/output.mp4`, metadata });
  } catch (error) { console.error('legacy /clip error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.get('/download/:jobId/:filename', (req, res) => {
  const { jobId, filename } = req.params;
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '');
  const candidates = [
    path.join(__dirname, 'jobs', jobId, 'clips', safe),
    path.join(__dirname, 'jobs', jobId, safe),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return res.download(p);
  }
  res.status(404).json({ error: 'File not found' });
});

// Catch-all: serve frontend for any other route (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

const PORT = process.env.PORT || 3010;
// Startup: scan & re-queue stuck job
setImmediate(() => scanAndRequeueStuckJobs());
app.listen(PORT, () => console.log(`YouTube Auto-Clipper API running on port ${PORT}`));

module.exports = app;
