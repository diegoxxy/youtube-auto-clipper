# workflow.md — Cara Kerja Vibecoding di Repo Ini

> Tujuan: biar Claude & AI lain tidak bingung, tiap sesi lanjut tanpa reset. Single source of truth: `todo.md`.

## 1. Start Sesi

1. Baca `CLAUDE.md` -> `PRD.md` -> `architecture.md` -> `todo.md` (urutan itu).
2. Cek `GET /health` kalau backend sedang jalan. Jika `ffmpeg: null` atau `aiProvider: null`, ingatkan user (warn, jangan block).
3. Ambil 1 task teratas dari `todo.md ## Now` yang belum `[x]`. Jangan lompat.

## 2. Kerjakan 1 Task (Wajib Kecil)

- Buat branch opsional kalau task besar: `git checkout -b feat/T-0X-nama`.
- Edit file terkait (lihat `agents.md` kolom "File yang Dipegang").
- Tiap perubahan fase job: tulis `metadata.json` atomik (`tmp -> rename`), update `progress` & `status`.
- Commit kecil & jelas: `feat(T-01): add POST /api/jobs async` bukan `update files`.
- Update `todo.md`: centang `[x] 2026-09-10 — T-01 done` di `## Done`.

## 3. Verifikasi (Jangan Skip)

```bash
# Backend
cd backend && npm run dev
curl -X POST http://localhost:3000/api/jobs -H "Content-Type: application/json" -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","brief":"fokus hook lucu","options":{"clipCount":3}}'
curl http://localhost:3000/api/jobs/<jobId>   # polling sampai status=done
curl http://localhost:3000/health

# Frontend
cd frontend && npm run dev   # atau serve -s . -l 3001
# buka http://localhost:3001, coba flow URL+brief -> progress -> grid
```

- Jika task ubah API, test `curl` dulu sebelum sentuh frontend.
- Jika task ubah FFmpeg, test 1 clip lokal: `ffmpeg -ss 10 -i raw.mp4 -t 30 -vf "crop=..." -c:v libx264 -crf 28 out.mp4`.

## 4. Aturan Git

- `jobs/`, `*.mp4`, `*.mp3`, `.env` sudah di `.gitignore` — jangan `git add` manual.
- Legacy `POST /clip` jangan dihapus sampai `POST /api/jobs` stabil (deprecated via header `X-Deprecated`).
- PR/commit message akhiri dengan `Co-Authored-By: Claude Code <noreply@anthropic.com>` (aturan global).

## 5. Kalau Stuck / Skill Gagal

- Tulis `warnings[]` di `metadata.json`, lanjutkan pipeline (fallback heuristic).
- Jangan `throw` yang bikin job `failed` kecuali download fatal.
- Catat di `todo.md` atau `architecture.md` kalau butuh keputusan (mis. pilih OpenAI vs Anthropic).

## 6. Selesai Sesi

- Pastikan `todo.md` terupdate (apa yang done, apa next).
- Sebutkan jobId test terakhir & statusnya biar sesi berikut bisa lanjut tanpa tanya ulang.
