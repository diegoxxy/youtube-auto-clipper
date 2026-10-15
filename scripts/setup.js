const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const log = (m) => console.log(`\n[setup] ${m}`);
const run = (cmd, cwd) => {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
};
const has = (cmd) => spawnSync(cmd, ['--version'], { shell: true, stdio: 'ignore' }).status === 0;

// 1. Cek prasyarat
log('Cek prasyarat...');
if (!has('node')) { console.error('❌ Node.js tidak ada. Install dulu: https://nodejs.org'); process.exit(1); }
if (!has('ffmpeg')) {
  console.error('❌ FFmpeg tidak ada di PATH.');
  console.error('   Windows: winget install Gyan.FFmpeg');
  console.error('   macOS  : brew install ffmpeg');
  process.exit(1);
}
log('Node + FFmpeg OK');

// 2. Install dependencies
log('Install BACKEND packages...');
run('npm install', path.join(ROOT, 'backend'));

log('Install FRONTEND packages...');
run('npm install', path.join(ROOT, 'frontend'));

// 3. Python deps (opsional — skip kalau python tidak ada)
const py = has('python') ? 'python' : (has('python3') ? 'python3' : null);
if (py) {
  const req = path.join(ROOT, 'backend', 'scripts', 'requirements.txt');
  if (fs.existsSync(req)) {
    log(`Install PYTHON packages (${py})...`);
    try { run(`${py} -m pip install -r "${req}"`); }
    catch (e) { log('⚠️  Python deps gagal — fitur face-tracking/transkrip mungkin tidak jalan.'); }
  }
} else {
  log('⚠️  Python tidak ditemukan — fitur transkrip/face-tracking dilewati.');
}

// 4. .env template
const envPath = path.join(ROOT, 'backend', '.env');
if (!fs.existsSync(envPath)) {
  log('Buat backend/.env template...');
  fs.writeFileSync(envPath,
`# Isi salah satu (yang kamu punya). Lihat README untuk opsi lain.
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
# Pakai Ollama lokal? (tanpa API key, offline)
# AI_PROVIDER=ollama
# OLLAMA_URL=http://localhost:11434
`);
  log('❗ EDIT backend/.env — isi API key AI-mu sebelum jalanin app.');
} else {
  log('backend/.env sudah ada — dilewati.');
}

log('✅ SETUP SELESAI');
log('Jalanin app: npm start   (atau double-click "Start App.bat")');