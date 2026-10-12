// backend/scripts/download.js — T-03
// Robust download: coba skill youtube-clipper dulu, fallback yt-dlp direct.
// Dipakai di server.js processJob. Tidak bikin job failed kalau retry masih gagal — throw dengan pesan ramah.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function classifyDownloadError(stderr) {
  const s = String(stderr).toLowerCase();
  if (s.includes('private video') || s.includes('this video is private')) return 'Video private — tidak bisa didownload.';
  if (s.includes('video unavailable') || s.includes('has been removed') || s.includes('deleted')) return 'Video tidak tersedia / sudah dihapus.';
  if (s.includes('age-restricted') || s.includes('confirm your age')) return 'Video age-restricted — butuh login. Coba video lain.';
  if (s.includes('copyright') || s.includes('blocked on copyright')) return 'Video diblokir karena hak cipta.';
  if (s.includes('live event') || s.includes('is a live')) return 'Video masih live — tunggu sampai selesai.';
  if (s.includes('members-only')) return 'Video members-only — tidak bisa didownload.';
  if (s.includes('sign in to confirm')) return 'YouTube minta verifikasi — coba lagi atau pakai video lain.';
  return null; // unknown -> pesan generic + stderr snippet
}

function findDownloadedVideo(jobDir, expectedId) {
  // skill lama tulis {id}.mp4 di jobDir, fallback yt-dlp tulis raw.mp4 / raw.webm
  const candidates = [];
  if (expectedId) {
    for (const ext of ['.mp4', '.webm', '.mkv', '.mov']) candidates.push(path.join(jobDir, `${expectedId}${ext}`));
  }
  candidates.push(path.join(jobDir, 'raw.mp4'), path.join(jobDir, 'raw.webm'), path.join(jobDir, 'raw.mkv'));
  // scan jobDir untuk file video terbesar (fallback terakhir)
  try {
    const files = fs.readdirSync(jobDir).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f)).map(f => path.join(jobDir, f));
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    candidates.push(...files);
  } catch {}
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function resolveYtDlp() {
  const candidates = [
    'yt-dlp',
    'C:/Users/diego/AppData/Local/hermes/hermes-agent/venv/Scripts/yt-dlp.exe',
    'C:/Users/diego/AppData/Roaming/Python/Python311/Scripts/yt-dlp.exe',
    'C:/Users/diego/AppData/Local/Programs/Python/Python311/Scripts/yt-dlp.exe',
  ];
  let checked = [];
  for (const p of candidates) {
    if (p === 'yt-dlp') {
      try { if (require('child_process').execSync('yt-dlp --version', { stdio: 'ignore' }) ) return p; } catch { checked.push(p + ' (not on PATH)'); continue; }
    }
    try { if (fs.existsSync(p)) return p; } catch {}
    checked.push(p);
  }
  throw new Error('yt-dlp tidak ditemukan di PATH. Install: pip install yt-dlp atau winget install yt-dlp. Dicoba: ' + checked.join(', '));
}

function spawnYtDlp(url, jobDir) {
  return new Promise((resolve, reject) => {
    const ytDlpBin = resolveYtDlp();
    const outTpl = path.join(jobDir, 'raw.%(ext)s');
    const infoPath = path.join(jobDir, 'yt-info.json');
    // --no-playlist, --merge-output-format mp4, best mp4, tulis info json
    const args = [
      '--no-playlist',
      '--js-runtimes', 'node',
      '--merge-output-format', 'mp4',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--write-info-json', '--no-write-playlist-metafiles',
      // ponytail: subtitle diambil terpisah (downloadSubtitles) supaya 429/rate-limit
      // pada ambil sub tidak membatalkan download video utama.
      '-o', outTpl,
      '--print-json', // untuk parse info
      url,
    ];
    const proc = spawn(ytDlpBin, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      // yt-dlp tidak terinstall
      reject(new Error('yt-dlp tidak ditemukan di PATH. Install: pip install yt-dlp atau winget install yt-dlp'));
    });
    proc.on('close', code => {
      if (code !== 0) {
        const friendly = classifyDownloadError(stderr);
        const msg = friendly || `Download gagal (yt-dlp exit ${code}): ${stderr.slice(0, 600)}`;
        const e = new Error(msg);
        e.rawStderr = stderr;
        e.code = code;
        return reject(e);
      }
      // coba parse videoInfo dari stdout (last json line) atau info file
      let info = null;
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try { info = JSON.parse(lines[i]); if (info && info.id) break; } catch {}
        }
      } catch {}
      if (!info && fs.existsSync(infoPath)) {
        try { info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch {}
      }
      if (!info) info = { id: 'raw', title: 'video', duration: null };
      resolve({ info, stdout, stderr });
    });
  });
}

/**
 * downloadVideo({ url, jobDir, runSkill })
 * - runSkill: function(skill, script, args) dari server.js
 * Returns: { videoPath, videoInfo, warnings[] }
 * Throws: Error dengan pesan ramah (untuk updateJob status=failed)
 */
function extractVideoId(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function cacheDirOf(jobDir) {
  // shared cache se-level dengan jobs (JOBS_DIR/_cache)
  return path.join(path.dirname(path.resolve(jobDir)), '_cache');
}

// ponytail: jaga cache ga gede2an — max 5 video, sisanya buang (LRU by mtime)
function pruneCache(cacheDir) {
  try {
    const files = fs.readdirSync(cacheDir).filter(f => /\.mp4$/i.test(f));
    if (files.length <= 5) return;
    const withT = files.map(f => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }));
    withT.sort((a, b) => a.t - b.t);
    for (const { f } of withT.slice(0, withT.length - 5)) {
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch {}
      const stem = f.replace(/\.mp4$/i, '');
      try { fs.unlinkSync(path.join(cacheDir, stem + '.info.json')); } catch {}
    }
  } catch {}
}

// ponytail: simpan video+info ke shared cache supaya job lain skip download
function storeCache(videoId, videoPath, videoInfo, cacheDir) {
  if (!videoId || !fs.existsSync(videoPath)) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, `${videoId}.mp4`);
    try { fs.linkSync(videoPath, cached); }          // hardlink same-volume = nol copy
    catch { fs.copyFileSync(videoPath, cached); }     // cross-volume / ada
    try { fs.writeFileSync(path.join(cacheDir, `${videoId}.info.json`), JSON.stringify({ title: videoInfo.title, duration: videoInfo.duration }, null, 2)); } catch {}
    console.log(`[download] video cache STORE ${videoId} (${Math.round(fs.statSync(videoPath).size / 1e6)}MB)`);
  } catch (e) { console.warn('[download] cache store gagal:', String(e.message).slice(0, 120)); }
}

async function downloadVideo({ url, jobDir, runSkill }) {
  const warnings = [];
  let videoInfo = null;
  let videoPath = null;
  let lastErr = null;

  // VIDEO CACHE: URL sama = video sama. Hardlink ke jobDir, skip download 1.4GB.
  // pertama kali tetap download (store ke cache), job ke-2+ instan.
  const videoId = extractVideoId(url);
  const cacheDir = cacheDirOf(jobDir);
  if (videoId) {
    pruneCache(cacheDir);
    const cachedRaw = path.join(cacheDir, `${videoId}.mp4`);
    if (fs.existsSync(cachedRaw) && fs.statSync(cachedRaw).size > 102400) {
      const dest = path.join(jobDir, 'raw.mp4');
      try { fs.linkSync(cachedRaw, dest); }       // hardlink NTFS same-volume: no copy
      catch { fs.copyFileSync(cachedRaw, dest); }
      let info = { id: videoId, title: 'video', duration: null, _source: 'cache' };
      const cachedInfo = path.join(cacheDir, `${videoId}.info.json`);
      if (fs.existsSync(cachedInfo)) {
        try { info = { ...info, ...JSON.parse(fs.readFileSync(cachedInfo, 'utf8')) }; } catch {}
      }
      console.log(`[download] video cache HIT ${videoId} -> hardlink, skip download ${Math.round(fs.statSync(dest).size / 1e6)}MB`);
      return { videoPath: dest, videoInfo: info, warnings: ['Video dari cache — sudah pernah didownload, skip download ulang'] };
    }
  }

  // Attempt 1: skill youtube-clipper
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt === 1 && runSkill) {
        const out = await runSkill('youtube-clipper', 'download_video.py', [url, jobDir]);
        try { videoInfo = JSON.parse(out); } catch { videoInfo = { id: path.basename(String(out).trim(), '.mp4') || 'raw' }; }
        videoPath = findDownloadedVideo(jobDir, videoInfo && videoInfo.id);
        if (!videoPath) throw new Error('Skill selesai tapi file video tidak ditemukan di ' + jobDir);
        // normalize ke raw.mp4 biar pipeline konsisten (copy, jangan move biar id tetap)
        const normalized = path.join(jobDir, 'raw.mp4');
        if (videoPath !== normalized) {
          try { fs.copyFileSync(videoPath, normalized); videoPath = normalized; } catch {}
        }
        storeCache(videoId, videoPath, videoInfo, cacheDir);   // skill path juga simpan cache
        return { videoPath, videoInfo, warnings };
      }
    } catch (e) {
      lastErr = e;
      const friendly = classifyDownloadError(e.message + ' ' + (e.rawStderr || ''));
      if (friendly) throw new Error(friendly); // fatal, jangan retry fallback yang sama
      warnings.push(`skill download gagal (attempt ${attempt}): ${e.message.slice(0, 300)}`);
      if (attempt === 1) {
        // fallthrough ke yt-dlp
        break;
      }
    }
  }

  // Fallback: yt-dlp direct (retry 1x untuk transient)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await spawnYtDlp(url, jobDir);
      videoInfo = res.info;
      videoPath = findDownloadedVideo(jobDir, videoInfo && videoInfo.id);
      if (!videoPath) throw new Error('yt-dlp selesai tapi file video tidak ditemukan');
      // info tidak selalu punya durasi/filename yang rapi — enrich
      videoInfo = {
        id: videoInfo.id || 'raw',
        title: videoInfo.title || videoInfo.fulltitle || 'video',
        duration: videoInfo.duration || null,
        ext: path.extname(videoPath).slice(1) || 'mp4',
        _source: 'yt-dlp',
      };
      if (attempt > 1) warnings.push(`yt-dlp retry berhasil di attempt ${attempt}`);
      storeCache(videoId, videoPath, videoInfo, cacheDir);   // yt-dlp path simpan cache juga
      return { videoPath, videoInfo, warnings };
    } catch (e) {
      lastErr = e;
      const friendly = classifyDownloadError(e.message + ' ' + (e.rawStderr || ''));
      if (friendly) throw new Error(friendly);
      if (attempt < 2) {
        warnings.push(`yt-dlp gagal attempt ${attempt}, retry: ${e.message.slice(0, 300)}`);
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
      throw new Error(e.message);
    }
  }
  throw lastErr || new Error('Download gagal tanpa detail');
}

module.exports = { downloadVideo, classifyDownloadError, findDownloadedVideo, spawnYtDlp, downloadSubtitles, resolveYtDlp, extractVideoId, cacheDirOf };

/**
 * Ambil subtitle terpisah dari download video.
 * Tidak pernah throw fatal — kalau gagal, return { srtPath: null, warning }.
 * Retry 2x dengan fallback bahasa (en → id → auto) + delay 2s (YouTube 429 butuh jeda).
 */
async function downloadSubtitles(url, jobDir) {
  const ytDlpBin = resolveYtDlp();
  const subDir = path.join(jobDir, 'transcript');
  try { fs.mkdirSync(subDir, { recursive: true }); } catch {}

  // CACHE subtitle per videoId — yt-dlp 429 sering kena; sub yang sama ga perlu diambil ulang
  const videoId = extractVideoId(url);
  if (videoId) {
    const cachedSub = findSrt(path.join(cacheDirOf(jobDir), 'subs', videoId));
    if (cachedSub) {
      try { fs.mkdirSync(subDir, { recursive: true }); fs.linkSync(cachedSub, path.join(subDir, path.basename(cachedSub))); }
      catch { fs.copyFileSync(cachedSub, path.join(subDir, path.basename(cachedSub))); }
      console.log(`[download] sub cache HIT ${videoId}`);
      return { srtPath: findSrt(subDir), warning: null };
    }
  }

  const outTpl = path.join(subDir, 'auto.%(ext)s');

  const langStack = [
    // ponytail: ID DULU (user: "youtube kan punya transcribe bahasa
    // indonesia kenapa gak pake itu aja"). Manual sub id = timing asli +
    // bahasa asli, jauh lebih akurat dari ASR LLM.
    // AUTO-SUB ID WAJIB SEBELUM nyentuh 'en' (user 2026-10-02: "transcrib
    // yang diucapkan, jangan dirubah rubah"). langStack lama:
    //   [--write-subs en, --write-auto-subs id]  ← EN DIDULUAN
    // → YouTube kasih EN/429 sebelum ID → subtitle Inggris di output
    // padahal auto.id ADA (video z4u_4YrtO5o: auto.id.srt exists).
    // Manual id (langStack 0-1) ga ada di video auto-caption-only → exit 0
    // tanpa file (senyap). AUTO id = yang actually jalan.
    ['--write-auto-subs', '--sub-langs', 'id'],
    ['--write-auto-subs', '--sub-langs', 'id-orig'],
    ['--write-subs', '--sub-langs', 'id'],
    ['--write-subs', '--sub-langs', 'id.*'],
    ['--write-auto-subs', '--sub-langs', 'id,en'],
    // EN = NAKBA TERAKHIR: cuman kalau ID bener-bener ga ada.
    ['--write-auto-subs', '--sub-langs', 'en'],
  ];

  let lastErr = '';
  for (let li = 0; li < langStack.length; li++) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const args = [
          '--no-playlist', '--skip-download', '--js-runtimes', 'node',
          ...langStack[li],
          '--convert-subs', 'srt',
          '-o', outTpl,
          url,
        ];
        const res = await new Promise((resolve, reject) => {
          const proc = spawn(ytDlpBin, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
          let stderr = '';
          proc.stderr.on('data', d => { stderr += d.toString(); });
          proc.on('error', e => reject(new Error('yt-dlp spawn error: ' + e.message)));
          proc.on('close', code => code === 0 ? resolve({ ok: true }) : reject(new Error(stderr.slice(0, 500))));
        });
        // cari file srt hasilnya
        const srt = findSrt(subDir);
        if (srt) {
          // store ke cache subs supaya job lain skip (429 ga kena lagi)
          if (videoId) {
            try {
              const csDir = path.join(cacheDirOf(jobDir), 'subs', videoId);
              fs.mkdirSync(csDir, { recursive: true });
              fs.linkSync(srt, path.join(csDir, path.basename(srt)));
              console.log(`[download] sub cache STORE ${videoId}`);
            } catch {}
          }
          return { srtPath: srt, warning: null };
        }
        lastErr = 'sub tidak ditemukan setelah download ok';
      } catch (e) {
        lastErr = (e.message || String(e)).slice(0, 400);
        const is429 = /429|Too Many Requests|rate.?limit/i.test(lastErr);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, is429 ? 3000 : 1500));
          continue;
        }
        if (is429) {
          // 429 persisten: jeda lebih lama sebelum ganti strategi bahasa
          await new Promise(r => setTimeout(r, 4000));
        }
      }
    }
  }
  return { srtPath: null, warning: `Subtitle tidak bisa diambil (mungkin 429/rate-limit): ${lastErr}` };
}

function findSrt(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => /\.srt$/i.test(f));
    if (!files.length) return null;
    // PRIORITAS ID: manual sub bahasa Indonesia = timing asli + bahasa asli
    // (user: "youtube kan punya transcribe bahasa indonesia, pake itu aja").
    // auto.en = auto-caption EN, timing telat & harus translate — fallback.
    const pick =
      files.find(f => /^sub_id\.|^.*\.id\.srt$/i.test(f)) ||
      files.find(f => /\.id\.srt$/i.test(f)) ||
      files.find(f => !/auto\.en|^.*\.en\.srt$/i.test(f)) ||
      files[0];
    return path.join(dir, pick);
  } catch { return null; }
}
