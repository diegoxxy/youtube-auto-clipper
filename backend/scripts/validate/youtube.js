// validate/youtube.js — T-02
// Validasi URL YouTube + brief text/file untuk POST /api/jobs

const path = require('path');

const ALLOWED_HOSTS = ['youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com'];
const ALLOWED_EXTS = ['.txt', '.md', '.pdf'];
const MAX_BRIEF_CHARS = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

function isValidYouTubeUrl(url) {
  try {
    const u = new URL(String(url).trim());
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const hostOk = ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
    if (!hostOk) return false;
    // harus ada video id: v=, /shorts/, /embed/, atau youtu.be/<id>
    if (host === 'youtu.be') return u.pathname.length > 1;
    if (u.searchParams.has('v') && u.searchParams.get('v').length >= 6) return true;
    if (/^\/(shorts|embed|live)\//.test(u.pathname)) return true;
    // youtube.com/watch tanpa v invalid
    if (u.pathname === '/watch') return u.searchParams.has('v');
    // fallback: path ada id
    return u.pathname.length > 1;
  } catch { return false; }
}

function validateBriefText(brief) {
  if (brief == null || brief === '') return { ok: true, brief: null };
  const s = String(brief);
  if (s.length > MAX_BRIEF_CHARS) {
    return { ok: false, error: `Brief terlalu panjang (${s.length} char, max ${MAX_BRIEF_CHARS})` };
  }
  return { ok: true, brief: s.trim() || null };
}

function validateBriefFile(file) {
  // file dari multer: { originalname, mimetype, size, buffer }
  if (!file) return { ok: true, filename: null };
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `File brief terlalu besar (${(file.size/1024/1024).toFixed(2)}MB, max 2MB)` };
  }
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTS.includes(ext)) {
    return { ok: false, error: `Format file tidak didukung (${ext}). Pakai .txt/.md/.pdf` };
  }
  // MIME check longgar (browser bisa kirim text/plain untuk .md)
  const allowedMimes = ['text/plain', 'text/markdown', 'application/pdf', 'application/octet-stream'];
  // pdf wajib application/pdf, tapi biarkan lewat jika ext valid
  return { ok: true, filename: file.originalname, ext, size: file.size };
}

module.exports = { isValidYouTubeUrl, validateBriefText, validateBriefFile, MAX_BRIEF_CHARS, MAX_FILE_BYTES, ALLOWED_EXTS };
