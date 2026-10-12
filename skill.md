# skill.md — Skill & Tooling Map

> Agar vibecoding lancar: skill apa dipakai di fase mana, plus fallback kalau skill gagal. Jangan hard-code path absolut user lain — pakai `process.env.HOME/USERPROFILE`.

## 1. Skill yang Dipakai (Existing di `~/.agent/skills/`)

| Skill | Script | Dipakai di Fase | Fungsi |
|-------|--------|-----------------|--------|
| `baoyu-youtube-transcript` | `main.ts` (bun) | transcribe | Ambil transcript resmi YouTube -> SRT |
| `youtube-clipper` | `download_video.py` | download | Download MP4 via yt-dlp wrapper |
| `youtube-clipper` | `clip_video.py` | clip | Potong video `start-end` via FFmpeg |
| `youtube-clipper` | `burn_subtitles.py` | subtitle | Burn SRT/ASS ke video |
| `youtube-clipper` | `analyze_subtitles.py` | segment/rank | Heuristic hook analysis (fallback LLM) |
| `branding` | `add_watermark.py` | branding (opsional) | Watermark text/logo |
| `video-speed-adjustment` | `adjust_speed.py` | speed (opsional) | Ubah playback speed |
| `claude-video-export` | `export_video.py` | finalize | Re-encode web-optimized |

Helper di `backend/server.js`:
```js
runSkill(skillName, scriptName, args) -> Promise<string>
```
Env: `PYTHONIOENCODING=utf-8`, `YT_CLIPPER_JSON_ONLY=1` untuk youtube-clipper.

## 2. Fallback (Wajib)

- Skill gagal -> jangan fail job. Tulis `warnings[]` di `metadata.json`, lanjut fase berikut.
- `download` gagal -> retry 1x, kalau masih gagal -> `status: failed` dengan pesan ramah (private/deleted/age-restricted).
- `transcribe` gagal -> coba ekstrak audio `ffmpeg -i raw.mp4 -vn audio.mp3` -> Whisper next (T-04).
- `segment/rank` LLM gagal -> heuristic: bagi durasi jadi N segmen rata + score dummy 50.

## 3. Skill Baru yang Akan Dibuat (T-05 s/d T-08)

```
backend/scripts/
├── ai/
│   ├── adapter.js       # segment() + rank(), pluggable OpenAI/Anthropic
│   └── repair.js        # json-repair untuk output LLM yang berantakan
├── prompts/
│   ├── segment.txt      # system prompt brief-aware clipping
│   └── rank.txt         # system prompt viral scoring
├── ffmpeg/
│   ├── crop.js          # filter crop untuk 9:16 / 1:1 / 16:9
│   └── subtitle.js      # SRT -> ASS (TikTok style)
└── validate/
    └── youtube.js       # isValidYouTubeUrl + brief file check
```

Adapter contract:
```js
segment({ transcript, brief, clipCount, targetDuration }) -> [{start,end,title,reason,keywords}]
rank({ clips, transcript }) -> [{...clip, score, tier, hookLabel}]
```
Output wajib JSON array valid, clamp `15 <= duration <= 180`.

## 4. FFmpeg Preset (Dipakai Langsung Tanpa Skill)

- Preview: `-c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 96k -movflags +faststart -pix_fmt yuv420p`
- Final download: `-crf 23` (lebih bagus)
- Crop 9:16: `-vf "crop=ih*9/16:ih,scale=1080:1920:flags=lanczos"`
- Subtitle burn: `-vf "subtitles=clip.ass:fontsdir=./fonts"`

FFmpeg path auto-detect `where ffmpeg` saat boot (`backend/server.js`).

## 5. Aturan Penambahan Skill Baru

- Taruh script di `backend/scripts/` atau `scripts/` (bukan di `~/.agent/skills/` global).
- Daftarkan di tabel atas + update `architecture.md` §3.3.
- Selalu sediakan fallback heuristic — skill AI tidak boleh bikin job `failed` sendirian.
