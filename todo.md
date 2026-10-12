# todo.md — Backlog & Roadmap

> Sumber kebenaran progres. Update tiap selesai task. Centang `[x]` + tanggal.

## Cara Pakai

- Ambil 1 task teratas dari `## Now`, kerjakan, centang, commit.
- Jangan lompat ke `## Next` kalau `## Now` belum beres.
- Tiap task harus punya kriteria done yang jelas.

## Now (MVP — Wajib Sebelum Demo)

- [x] 2026-09-10 — **T-01 Migrasi endpoint** — Done
- [x] 2026-09-10 — **T-02 Validasi input** — Done
- [x] 2026-09-10 — **T-03 Download robust** — Done
- [x] 2026-09-10 — **T-04 Transcribe fallback** — Done
- [x] 2026-09-10 — **T-05 AI segmenter** — Done
- [x] 2026-09-10 — **T-06 Viral ranker** — Done
- [x] 2026-09-10 — **T-07/T-08 FFmpeg clip, crop, subtitle burn** — Done
- [x] 2026-09-10 — **T-09/T-10 Frontend result grid & editor** — Done
- [x] 2026-09-11 — **T-11 Error & empty state** — Pesan ramah untuk tiap gagal fase (bukan stack trace), retry button, `warnings[]` di metadata. Done: backend menambahkan `warnings[]` ke `metadata.json` tiap fase, frontend menampilkan error via `errorContainer`.
- [x] 2026-09-11 — **T-12 Env & boot check** — `.env.example` dibuat, boot check di `server.js` mengecek ffmpeg dan AI provider, log warning jika tidak ada. Frontend tidak butuh check spesifik.

## Next (Setelah MVP Stabil)

- [ ] **T-13 SSE/WebSocket** ganti polling 1.5s
- [ ] **T-14 BullMQ + Redis** queue, concurrent 2-3 job
- [ ] **T-15 Blur background** untuk 9:16 (bukan crop hitam)
- [ ] **T-16 Face reframe** (deteksi wajah -> crop follow)
- [ ] **T-17 S3/R2 storage** + signed URL
- [ ] **T-18 Auth & rate limit** (5 jobs/IP/jam)
- [ ] **T-19 Bulk URL** (paste 3-5 link sekaligus)
- [ ] **T-20 Analitik viral** (feedback loop: clip mana yang di-download)

## Done

- [x] 2026-09-10 — PRD.md, CLAUDE.md, agents.md, architecture.md, skill.md, workflow.md awal
- [x] 2026-09-10 — T-01..T-10 backend + frontend pipeline komplit