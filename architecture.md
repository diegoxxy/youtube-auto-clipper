# architecture.md — Arsitektur YouTube Auto Clipper AI

> Stack: Node.js + Express + FFmpeg + yt-dlp + LLM (pluggable) + Vanilla JS + Tailwind CDN
> Runtime storage: `backend/jobs/{jobId}/` (local, next: S3/R2)

## 1. Overview

```
[Browser / frontend/index.html]
        |  POST /api/jobs {url, brief, options}
        v
[Express — backend/server.js]
  -> validasi URL + brief
  -> buat jobId, tulis metadata.json {status: queued}
  -> enqueue in-memory (next: BullMQ)
  -> return {jobId} segera (async)
        |
        v (background runner, update progress 0-100)
  [Pipeline — 6 fase]
  1. download    (yt-dlp / youtube-clipper skill)
  2. transcribe  (YouTube transcript API -> Whisper fallback)
  3. segment     (LLM brief-aware -> JSON clips)
  4. rank        (LLM viral score 0-100 + tier S/A/B)
  5. clip        (FFmpeg potong + crop 9:16/1:1/16:9 + burn ASS subtitle)
  6. finalize    (metadata.json + preview 720p, final 1080p on download)
        |
        v
  [GET /api/jobs/:id]  polling frontend (SSE next)
  [GET /api/jobs/:id/download?clip=c1&format=9:16&sub=1]
```

Legacy `POST /clip` (single clip, sync) tetap ada tapi deprecated — jangan tambah fitur di sana.

## 2. Frontend

- `frontend/index.html` — single page sekarang, akan dipecah:
  - `assets/app.js` — state job, polling, render result grid
  - `assets/editor.js` — trim handle, subtitle toggle, format switch
  - `assets/api.js` — wrapper fetch ke `/api/jobs`
- Styling: Tailwind CDN (tanpa build). Next: pindah ke Vite kalau komponen >5.
- State: `localStorage jobId` terakhir, polling `GET /api/jobs/:id` tiap 1.5s saat `status != done/failed`.
- Preview: `<video src="/api/jobs/:id/stream?clip=c1&format=9:16">` (range request).

## 3. Backend

### 3.1 Server (`backend/server.js`)

- Port: `PORT` env atau `findAvailablePort(3000)`.
- Middleware: `express.json()`, `cors`, `express.static(../frontend)`.
- Env wajib: `AI_PROVIDER`, `AI_API_KEY` (cek di startup, warn kalau kosong -> pipeline tetap jalan tanpa segment/rank LLM, pakai heuristic).
- FFmpeg: auto-detect `where ffmpeg` saat boot, fail fast kalau tidak ada.

### 3.2 Job Model & Storage

```
backend/jobs/{jobId}/
├── metadata.json      # sumber kebenaran (status, progress, clips, error)
├── raw.mp4            # hasil download
├── raw.mp3            # audio extract (untuk Whisper)
├── transcript.srt     # transcript
├── transcript.json    # timestamped segments
└── clips/
    ├── c1_9-16.mp4    # per clip per format (generate on demand + cache)
    ├── c1_16-9.mp4
    └── c1.srt
```

`metadata.json` tulis atomik (write tmp -> rename). Frontend & semua fase baca file yang sama.

### 3.3 Pipeline Detail

| Fase | Input | Output | Fallback |
|------|-------|--------|----------|
| download | URL | raw.mp4 + videoInfo | retry 1x, error ramah jika private/deleted |
| transcribe | raw.mp4 | transcript.srt | coba YouTube transcript dulu, baru Whisper |
| segment | transcript + brief | `[{start,end,title,reason,keywords}]` | kalau LLM gagal -> heuristic (peak audio + keyword match) |
| rank | clips + transcript | `score 0-100, tier, hookLabel` | heuristic: position + keyword density |
| clip | raw.mp4 + clips | clips/*.mp4 preview | FFmpeg `ss` fast seek, `c:v libx264, c:a aac, -movflags +faststart` |
| finalize | — | progress=100, status=done | zip all on demand |

Format crop:
- `9:16` → `crop=ih*9/16:ih` center, scale `1080:1920`, fallback blur background next.
- `1:1` → `crop=ih:ih` center, scale `1080:1080`.
- `16:9` → passthrough scale `1280:720` preview / `1920:1080` final.

Subtitle: SRT -> ASS (style TikTok: Fontsize 18, Outline 2, MarginV 120) -> `burn` via `subtitles=clip.ass`.

### 3.4 API Contract (Baru)

```
POST /api/jobs
  body: { url, brief?, briefFile?, options: { clipCount, targetDuration, formats, subtitleLang } }
  -> 201 { jobId, status: "queued" }

GET /api/jobs/:id
  -> { jobId, status, progress, videoInfo, clips, error, warnings }

GET /api/jobs/:id/stream?clip=c1&format=9:16
  -> video/mp4 (range)

GET /api/jobs/:id/download?clip=c1&format=9:16&sub=1
  -> attachment mp4

POST /api/jobs/:id/reclip
  body: { clipId, start, end, format, sub }
  -> { clipId: newId }
```

## 4. AI Adapter

`backend/scripts/ai/adapter.js` — interface tunggal:

```js
segment({ transcript, brief, clipCount, targetDuration }) -> clips[]
rank({ clips, transcript }) -> clips dengan score/tier
```

Provider via env: `openai` / `anthropic`. Prompt di `backend/scripts/prompts/segment.txt` & `rank.txt`. Output wajib JSON array, parse dengan `try/catch`, repair dengan `json-repair` kalau perlu, clamp durasi 15-180s.

## 5. Error & Observability

- Tiap fase `try/catch`, tulis `warnings[]` di metadata, lanjutkan kalau tidak fatal.
- Fatal (download gagal, FFmpeg tidak ada) -> `status: failed`, `error: "pesan ramah"`.
- Log server: `console.log` fase + jobId, `console.warn` untuk fallback.
- Health: `GET /health` -> `{status, ffmpeg, aiProvider}`.

## 6. Keamanan & Batasan

- Validasi URL: hanya `youtube.com`, `youtu.be`, `m.youtube.com`.
- Brief file: max 2MB, ekstensi `txt/md/pdf`, scan MIME.
- Rate limit next: 5 jobs / IP / jam (in-memory dulu).
- `jobs/` di `.gitignore`, jangan commit `*.mp4`, `*.mp3`.
- API key tidak pernah log / kirim ke frontend.

## 7. Roadmap Teknis

- MVP: pipeline in-process, polling, local storage (sekarang).
- Next: BullMQ + Redis, SSE/WebSocket, S3/R2, auth, reframe wajah (face detection crop).
