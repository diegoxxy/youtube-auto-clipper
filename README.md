# YouTube Auto-Clipper — Setup Guide

**Buat klip vertikal short-form otomatis dari podcast/video panjang. Format adaptive (talking head ↔ band blur), subtitle karaoke pop-up, loud norm audio, render serial.**

---

## Quick Start

```bash
# 1. Clone/copy project ke PC baru
cd C:\path\to\youtube-auto-clipper

# 2. Install dependencies
npm run setup

# 3. Buat .env, setup API key (lihat bagian CONFIG bawah)
# Edit backend/.env + frontend/.env.local

# 4. Jalankan backend + frontend
npm run dev

# 5. Buka http://localhost:3050 di browser
```

---

## Persyaratan Sistem

### PC / OS
- **Windows 10/11** (64-bit)
- **RAM minimal:** 8GB (16GB recommended untuk rendering)
- **Disk:** 50GB minimum (video raw + cache besar)

### Software yang Harus Diinstall

#### 1. **Node.js** (v18 atau v20)
- Download: https://nodejs.org/
- Install via **Windows Installer** (rekomendasi)
- Verifikasi:
  ```bash
  node --version
  npm --version
  ```

#### 2. **FFmpeg** (full build dengan libass subtitle)
- **Paling mudah:** Winget (Windows Package Manager)
  ```bash
  winget install ffmpeg
  ```
- Atau download manual: https://ffmpeg.org/download.html
- Verifikasi:
  ```bash
  ffmpeg -version | grep libass
  ```
  (harus ada `libass` di output)

#### 3. **Python 3.11**
- Download: https://www.python.org/downloads/
- **Penting:** Saat install, centang **"Add Python to PATH"**
- Verifikasi:
  ```bash
  python --version
  pip --version
  ```

#### 4. **yt-dlp** (optional, tapi recommended)
- Buat download YouTube lebih reliable
  ```bash
  pip install yt-dlp
  ```

#### 5. **Python Dependencies**
- Setelah project di-clone, run:
  ```bash
  pip install opencv-python numpy scipy scikit-learn requests pydub
  ```

---

## Setup Project

### 1. Copy Folder Project

**Opsi A: Dari GitHub (RECOMMENDED)** 🎯

```bash
# Clone repo
git clone https://github.com/diegoxxy/youtube-auto-clipper.git
cd youtube-auto-clipper
```

**Opsi B: Download ZIP**
- Buka https://github.com/diegoxxy/youtube-auto-clipper
- Klik tombol hijau **Code** → **Download ZIP**
- Extract ke folder, ada `youtube-auto-clipper-main/`
- Rename jadi `youtube-auto-clipper` (biar path konsisten)

**Opsi C: Flashdisk / HDD eksternal**
```bash
# Copas folder langsung
# C:\Users\<username>\youtube-auto-clipper\
```

### 2. Install Dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install

# Root
cd ..
npm run setup
```

---

## Konfigurasi API AI

Buat file `.env` di folder **backend** (kalau belum ada):

```bash
# backend/.env
```

**Pilih salah satu provider AI di bawah:**

### Option 1: OpenAI (GPT-4o) — Recommended untuk akurasi tinggi

```env
# backend/.env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...your-key-here...
OPENAI_MODEL=gpt-4o-mini
```

**Dapatkan API Key:**
1. Buka https://platform.openai.com/api/keys
2. Buat **New secret key**
3. Copy, paste ke `.env`
4. **Estimate cost:** ~$0.20 per job (transkrip + segment + rank)

---

### Option 2: Anthropic (Claude 3.5 Sonnet) — Lebih murah

```env
# backend/.env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
```

**Dapatkan API Key:**
1. Buka https://console.anthropic.com/keys
2. Create new API key
3. Copy, paste ke `.env`
4. **Estimate cost:** ~$0.10 per job (lebih murah dari OpenAI)

---

### Option 3: Google Gemini — Paling murah

```env
# backend/.env
AI_PROVIDER=gemini
GEMINI_API_KEY=AIza...your-key-here...
GEMINI_MODEL=gemini-2.0-flash
```

**Dapatkan API Key:**
1. Buka https://aistudio.google.com/apikey
2. Klik **Get API Key**
3. Pilih project atau buat baru
4. Copy key, paste ke `.env`
5. **Estimate cost:** ~$0.02 per job (paling murah)

---

### Option 4: Ollama — **GRATIS & OFFLINE** (No API Key)

Pakai AI lokal di PC, nol biaya, nol internet needed (setelah download model).

**Setup:**
1. Download Ollama: https://ollama.ai
2. Install & jalankan `ollama serve`
3. Di terminal baru, pull model:
   ```bash
   ollama pull qwen2.5-coder:32b
   ```
4. Setup `.env`:
   ```env
   # backend/.env
   AI_PROVIDER=ollama
   OLLAMA_ENDPOINT=http://localhost:11434
   OLLAMA_MODEL=qwen2.5-coder:32b
   ```

**Keuntungan Ollama:**
- ✅ Gratis selamanya
- ✅ Offline (no internet needed)
- ✅ Private (data tidak ke server)
- ❌ Lambat (CPU-based, butuh GPU untuk cepat)

---

## Jalankan Application

### Backend (Port 4010)

```bash
cd backend
node server.js
```

**Output yang benar:**
```
[boot] FFmpeg OK
[boot] AI provider: openai
YouTube Auto-Clipper API running on port 4010
[debug] GET /health
```

### Frontend (Port 3050) — Terminal Baru

```bash
cd frontend
npm run dev
```

**Output yang benar:**
```
✓ Ready in 11s (localhost:3050)
```

### Akses Website

Buka **http://localhost:3050** di browser.

---

## Cara Pakai

1. **Paste YouTube URL** atau **Upload file MP4**
2. **Pilih format:**
   - `Crop Wajah` (9:16) — talking head, close-up
   - `Band + Blur` (9:16_fill) — band blur untuk banyak orang
   - `Adaptive` (smart) — auto pilih berdasarkan jumlah orang
3. **Pilih subtitle style:** Karaoke / Hormozi / MrBeast
4. **Submit** → Backend proses (download → transkrip → segment → rank → render)
5. **Download klip** setelah selesai

---

## Troubleshoot

### Error: `FFmpeg not found`
```bash
# Pastikan FFmpeg di PATH
ffmpeg -version

# Kalau tidak ditemukan, install via Winget:
winget install ffmpeg
```

### Error: `port 4010 in use`
```bash
# Cek siapa pakai port 4010
netstat -ano | findstr :4010

# Kill process (ganti PID)
taskkill /F /PID 12345
```

### Error: `Python not found`
```bash
# Verifikasi Python path
python --version

# Kalau tidak di PATH, set manual di backend/.env:
PYTHON_BIN=C:/Users/YourUsername/AppData/Local/Programs/Python/Python311/python.exe
```

### Backend slow / API timeout
- **OpenAI/Anthropic:** Check API rate limits & balance
- **Ollama:** GPU butuh CUDA untuk cepat (CPU = 5-10 menit per job)
- **Solusi:** Pakai Gemini (API lebih cepat), atau tunggu render selesai

### Video ga terdownload
```bash
# Cek yt-dlp
yt-dlp --version

# Manual test YouTube URL
yt-dlp -f 22 "https://www.youtube.com/watch?v=..."
```

---

## Customization

### Ganti Default Format

Edit `frontend/app/page.tsx` line 24:
```javascript
const [customFmt, setCustomFmt] = useState<"9:16" | "9:16_fill" | "16:9_fill" | "adaptive">("9:16");
// Ganti default dari "9:16" ke "adaptive"
```

### Ganti Subtitle Template Default

Edit `backend/server.js` line 650 (estimasi):
```javascript
subTpl: req.body.subTpl || "karaoke",  // Default template
// Opsi: "karaoke" | "hormozi" | "beast"
```

### Ganti FFmpeg Output Quality

Edit `backend/scripts/ffmpeg/processor.js` line ~1100 (estimasi):
```javascript
args.push('-b:v', '5000k');  // Bitrate video (naikkan untuk quality lebih tinggi)
```

---

## Tips Performa

### 1. Render Serial (Rekomendasi)
Backend render klip **satu per satu** (CONC=1 di `.env`), aman untuk spek rendah.

### 2. Gunakan Cache Video
Jika render 2+ job dari video sama → auto hardlink dari cache, skip download.

### 3. Ollama + GPU CUDA
Kalau punya GPU NVIDIA:
```bash
# Install CUDA support untuk Ollama
# https://github.com/ollama/ollama/blob/main/docs/gpu.md

# Pull model yang optimized GPU
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
```

---

## File Structure

```
youtube-auto-clipper/
├── backend/
│   ├── server.js           (main backend)
│   ├── .env                (config API + paths)
│   ├── scripts/
│   │   ├── download.js     (YouTube downloader)
│   │   ├── ffmpeg/
│   │   │   └── processor.js (FFmpeg render logic)
│   │   ├── subtitles/
│   │   │   └── templates.js (subtitle styles)
│   │   └── ai/
│   │       └── transcribe.js (AI transkrip + segment)
│   ├── jobs/               (rendered clips store here)
│   └── cache/              (downloaded video cache)
├── frontend/
│   ├── app/
│   │   └── page.tsx        (main UI)
│   ├── components/
│   │   ├── ProgressBar.tsx
│   │   ├── JobQueue.tsx
│   │   └── JobLogs.tsx
│   ├── lib/
│   │   └── api.ts          (API client)
│   └── .env.local          (frontend config)
├── README.md               (file ini)
└── package.json
```

---

## Deploy Online (Optional)

**Frontend:** Deploy ke Vercel (gratis)
```bash
# Push ke GitHub dulu
git push origin main

# Di Vercel dashboard, import repo
# Auto deploy setiap push
```

**Backend:** Tetap lokal (PC user) + expose via Cloudflare Tunnel (gratis)
```bash
# Install Cloudflare Tunnel
npm install -g wrangler

# Start tunnel (backend expose ke internet)
wrangler tunnel run http://localhost:4010
```

---

## Support

- **GitHub Issues:** https://github.com/your-username/youtube-auto-clipper/issues
- **Logs:** Cek `backend/logs/`, `frontend/logs/` untuk debug
- **API Docs:** GET http://localhost:4010/api/docs (kalau ada)

---

## License

MIT — Bebas pakai & modifikasi untuk proyek personal/komersial.

---

**Happy clipping! 🎬**
