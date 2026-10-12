# CLAUDE.md — Panduan untuk Claude/AI di Repo Ini

> Baca file ini dulu sebelum edit apapun. Ini sumber kebenaran untuk vibecoding di `youtube-auto-clipper`.

## 1. Apa Ini

YouTube Auto Clipper AI — paste link YouTube + brief -> AI potong jadi 3-10 clip viral-ready (30-90s), ranking viral, pilih format 9:16/1:1/16:9, editor ringan, download.

Detail produk: baca `PRD.md`. Arsitektur: `architecture.md`. Task aktif: `todo.md`.

## 2. Struktur Repo

```
youtube-auto-clipper/
├── PRD.md, CLAUDE.md, agents.md, architecture.md, todo.md, skill.md, workflow.md
├── backend/
│   ├── server.js          # Express, endpoint /clip (legacy) + /api/jobs (baru)
│   ├── package.json
│   ├── jobs/{jobId}/      # runtime: metadata.json, video, clips
│   └── scripts/           # helper FFmpeg / LLM adapter
├── frontend/
│   ├── index.html         # Tailwind CDN, vanilla JS (akan dipecah)
│   └── assets/
├── scripts/               # util dev
└── test_output/
```

## 3. Cara Jalanin

```bash
cd backend && npm install && npm run dev   # http://localhost:3000
cd frontend && npm run dev                 # http://localhost:3001 (serve static)
# FFmpeg wajib di PATH: ffmpeg -version
# Env AI (buat segmenter/ranker): AI_PROVIDER=openai|anthropic, AI_API_KEY=...
```

Health: `GET /health`. Legacy clip: `POST /clip`. Baru: `POST /api/jobs` (lihat `PRD.md` §9).

## 4. Aturan Coding (Wajib)

- Node 18+, Express. Jangan ganti framework tanpa diskusi.
- FFmpeg via `spawn`, jangan `exec` untuk file besar. Selalu handle `stderr` & `close code`.
- Job itu async: tulis `metadata.json` tiap perubahan `status/progress`, frontend polling.
- Jangan expose stack trace ke client. Log di server, kirim `{error: "pesan ramah"}`.
- Format video: H.264 + AAC, `yuv420p`, `+faststart`. 9:16 crop center dulu (reframe wajah next).
- Subtitle: SRT -> ASS styled (TikTok style) lalu `burn` via FFmpeg.
- Validasi input ketat: URL YouTube, brief max 5000 char / file max 2MB.
- Tulis terse, tanpa fluff. Komentar hanya jika logic tidak obvious.

## 5. Skill & Tools yang Dipakai

Lihat `skill.md`. Pemetaan:
- Download -> `youtube-clipper/download_video.py` atau `yt-dlp`
- Transcript -> `baoyu-youtube-transcript/main.ts` atau Whisper
- Clip/crop/burn -> `youtube-clipper/clip_video.py, burn_subtitles.py` + FFmpeg langsung
- Branding/speed/export -> skill masing-masing (opsional)

Kalau skill gagal, fallback ke FFmpeg/yt-dlp langsung — jangan hard-fail job.

## 6. Workflow Kerja

Lihat `workflow.md`. Ringkas: baca `todo.md` -> ambil 1 task -> edit -> test manual (`curl` / buka frontend) -> commit.

## 7. Hal yang Jangan Dilakukan

- Jangan hapus endpoint `/clip` sebelum `/api/jobs` stabil (deprecated dulu).
- Jangan simpan API key di repo. Pakai `.env` (gitignore).
- Jangan tulis file besar ke git (`jobs/`, `*.mp4` sudah ignore).
- Jangan bikin auth/payment sebelum MVP clip flow beres.

## 8. Prompt AI Segmenter/Ranker (Referensi)

System prompt ada di `backend/scripts/prompts/` (akan dibuat). Kontrak output harus JSON array valid — selalu `JSON.parse` dengan try/catch + fallback heuristic.
