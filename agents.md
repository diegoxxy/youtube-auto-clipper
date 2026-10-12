# agents.md — Peran AI & Sub-agent

> Supaya Claude/AI tidak bingung siapa ngapain. Semua agent jalan di repo yang sama, koordinasi via `todo.md`.

## 1. Agent Utama

| Agent | Peran | File yang Dipegang |
|-------|-------|---------------------|
| **orchestrator** (kamu) | Bagi tugas, jaga `PRD.md` & `architecture.md` tetap sinkron | semua `*.md` |
| **backend-dev** | Express, job queue, FFmpeg, yt-dlp, adapter AI | `backend/server.js`, `backend/scripts/*` |
| **frontend-dev** | UI flow, polling, editor, preview | `frontend/index.html`, `frontend/assets/*` |
| **ai-engineer** | Prompt segmenter & viral ranker, JSON contract, fallback | `backend/scripts/prompts/*`, `backend/scripts/ai/*` |

> Saat vibecoding, cukup sebut "kamu jadi backend-dev" — AI akan fokus ke file di kolom kanan.

## 2. Kapan Pakai Sub-agent (Agent Tool)

- Audit multi-file / cari bug menyebar -> `Explore` / `general-purpose`
- Refactor besar multi-file -> `Workflow` (user harus ketik `ultracode` atau minta eksplisit)
- Tanya cara pakai Claude Code / API -> `claude-code-guide`

Jangan spawn sub-agent untuk edit 1-2 file kecil.

## 3. Kontrak Antar Agent

- **Input -> Output via `backend/jobs/{jobId}/metadata.json`**. Semua agent baca/tulis file yang sama, jangan pakai memory.
- Status job: `queued -> downloading -> transcribing -> segmenting -> ranking -> clipping -> done | failed`
- Progress: 0-100, update tiap fase. Frontend polling `GET /api/jobs/:id`.
- Jika satu agent gagal (mis. transcript), tulis `warning` di metadata, lanjutkan fase berikut (fallback).

## 4. Handoff Checklist

Sebelum oper ke agent lain:
- [ ] `metadata.json` sudah tulis status & error/warning terbaru
- [ ] `todo.md` centang task yang selesai
- [ ] Tidak ada `console.log` debug tertinggal (pakai `console.warn` untuk warning yang memang perlu)
