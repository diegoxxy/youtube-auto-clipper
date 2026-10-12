# PRD — YouTube Auto Clipper AI

> Versi: 1.0 — 2026-09-10
> Status: Draft untuk vibecoding
> Folder: `C:\Users\diego\youtube-auto-clipper`

## 1. Ringkasan Produk

YouTube Auto Clipper AI = website yang ubah video YouTube panjang jadi beberapa clip pendek siap upload. User cukup paste link + upload/tulis brief (mau clip seperti apa). AI paham brief, cari momen relevan di transcript/audio, potong otomatis jadi N clip, kasih ranking viral, lalu user bisa edit ringan (trim, subtitle, format) sebelum download.

Masalah yang diselesaikan:
- Manual clipping lama & asal potong
- Brief tidak dipahami konteksnya
- Tidak tahu clip mana yang paling berpotensi viral
- Harus re-encode manual untuk 9:16 / 1:1 / 16:9

## 2. Target User

- Content creator / clipper (podcast, edukasi, entertainment)
- Social media manager yang butuh 10-20 shorts per minggu dari 1 long-form
- Agency yang clipping massal pakai brief klien

## 3. Goals & Non-Goals

**Goals (MVP):**
- Input: 1 YouTube URL + brief (text/file: .txt/.md/.pdf)
- Output: 3-10 clip kandidat (30-90 detik) dengan viral score & alasan
- Pilih format: 9:16 (1080x1920 crop center + auto reframe kalau bisa), 1:1, 16:9
- Editor ringan: trim, toggle subtitle, preview, download per clip & bulk zip

**Non-Goals MVP:**
- Multi-user auth / payment / team workspace (next phase)
- Auto-upload ke TikTok/IG/YT (cukup download dulu)
- Speaker diarization sempurna & face tracking reframe (nice to have)

## 4. User Flow Utama

```
1. Landing -> Paste YouTube URL (validasi) + Brief (textarea + upload)
   + Opsi: jumlah clip (3/5/10), durasi target (30/60/90s), bahasa subtitle
   -> Klik "Generate Clips"

2. Processing (async job)
   Progress: download -> transcribe (Whisper) -> LLM segmentasi (brief-aware)
   -> viral ranking -> crop/encode preview
   Polling / SSE ke frontend

3. Result Grid
   Card per clip: thumbnail, 00:00-00:45, viral score (0-100), hook label,
   alasan AI ("menjawab brief poin #2, hook kuat di 5 detik pertama"),
   durasi, format badge

4. Editor (klik card)
   Video preview + waveform/transcript highlight
   - Trim handle (start/end)
   - Subtitle: on/off, style (TikTok big white + stroke), posisi, terjemahan ID/EN
   - Format switch: 9:16 / 1:1 / 16:9 (live preview, crop center dulu)
   - Download: MP4 (H.264, AAC)
```

## 5. Functional Requirements

### FR-1 Input
- Validasi URL YouTube (youtube.com/watch, youtu.be, shorts)
- Brief: textarea (max 5000 char) + file upload (txt/md/pdf, max 2MB)
- Jika brief kosong, fallback ke auto highlight (hook umum)

### FR-2 Processing Pipeline
- `download` via yt-dlp (fallback jika skill gagal)
- `transcribe` Whisper / YouTube transcript API (prioritas transcript resmi jika ada)
- `LLM segment` — system prompt: paham brief -> output JSON array `{start, end, title, reason, keywords}`
- `viral ranking` — LLM kedua / heuristic: hook strength, curiosity gap, emotion, clarity, CTA (skor 0-100 + tier S/A/B)
- `clip & encode` FFmpeg: potong, crop, burn subtitle (ASS dari SRT)

### FR-3 Output
- Minimal 3 clip, maksimal 10 (user pilih). Durasi clamp 15-180 detik.
- Metadata per clip: `id, start, end, duration, score, tier, reason, transcript_excerpt`
- Preview MP4 (720p cepat dulu, final 1080p saat download)

### FR-4 Editor
- Trim tanpa re-encode ulang full (fast seek) untuk preview, re-encode saat download
- Subtitle: SRT -> ASS styled, toggle, font size/position preset
- Format: 9:16 center crop, 1:1 center, 16:9 passthrough. Blur background opsi next.

### FR-5 Export
- Download per clip + "Download All (.zip)"
- Filename: `{channel}_{title}_{clip#}_{format}.mp4`

## 6. Non-Functional Requirements

- Job timeout 15 menit / video (long video 2 jam)
- Concurrent jobs 2-3 per instance (queue)
- Job persistence di `backend/jobs/{jobId}/` + `metadata.json`
- Error message jelas (bukan stack trace ke user)
- FFmpeg wajib ada di PATH (cek di startup)

## 7. Tech Stack (Existing + Rencana)

- Backend: Node.js + Express (sudah ada `backend/server.js`)
- Frontend: static `frontend/index.html` + Tailwind CDN (sudah ada) -> next: pecah jadi komponen JS
- Video: ffmpeg (sudah auto-detect), yt-dlp, whisper / transcript skill
- AI: OpenAI atau Anthropic API (pluggable, env `AI_PROVIDER`, `AI_API_KEY`)
- Storage: local `jobs/` dulu (next: S3/R2)
- Job runner: in-process async dulu (next: BullMQ)

## 8. Data Model (Job)

```json
{
  "jobId": "1757...",
  "url": "https://youtube.com/watch?v=...",
  "brief": "fokus pada momen lucu dan insight bisnis",
  "briefFile": "brief.pdf",
  "status": "queued|downloading|transcribing|segmenting|ranking|clipping|done|failed",
  "progress": 0,
  "options": { "clipCount": 5, "targetDuration": 60, "formats": ["9:16"], "subtitleLang": "id" },
  "videoInfo": { "id": "...", "title": "...", "duration": 3600 },
  "clips": [{ "id": "c1", "start": 123.4, "end": 180.2, "score": 88, "tier": "S", "reason": "..." }],
  "error": null
}
```

## 9. API Contract MVP

```
POST /api/jobs         { url, brief, briefFile, options } -> { jobId }
GET  /api/jobs/:id     -> job status + clips
GET  /api/jobs/:id/stream?clip=c1&format=9:16  -> preview
GET  /api/jobs/:id/download?clip=c1&format=9:16&sub=1 -> mp4
POST /api/jobs/:id/reclip  { clipId, start, end, format, sub } -> new clip
```

Saat ini endpoint lama `POST /clip` masih ada (legacy single-clip). Pertahankan tapi tandai deprecated, migrasi ke `/api/jobs`.

## 10. Edge Cases

- Video private/deleted/age-restricted -> error ramah
- Tanpa transcript & whisper gagal -> tetap clip pakai heuristic audio energy
- Brief bahasa campur -> LLM auto detect
- Video >2 jam -> batasi analisis 0-90 menit pertama atau sampling

## 11. Metrics Sukses

- 80% clip yang di-generate sesuai brief (manual review 20 video)
- Viral score korelasi dengan CTR manual (next: feedback loop)
- Waktu end-to-end <3 menit untuk video 30 menit

## 12. Open Questions

- AI provider final? (OpenAI vs Anthropic — buat adapter)
- Reframe wajah otomatis perlu? (MVP center crop dulu)
- Perlu auth sebelum launch public?
