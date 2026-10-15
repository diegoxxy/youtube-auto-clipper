const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const http = require('http');

const PROJECT_ROOT = __dirname;
const log = (msg) => console.log(`[main] ${msg}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cek port bisa diakses (backend: /health, frontend: halaman apa aja)
const checkPort = (port, pathName = '/') => {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: pathName, timeout: 3000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
};

const waitFor = async (port, label, pathName, tries = 15) => {
  log(`Waiting for ${label} (${port})...`);
  for (let i = 0; i < tries; i++) {
    if (await checkPort(port, pathName)) { log(`${label} READY ✓`); return true; }
    await sleep(2000);
  }
  return false;
};

const openBrowser = (url) => {
  const p = os.platform();
  if (p === 'win32') spawn('cmd', ['/c', 'start', '', url], { shell: false });
  else if (p === 'darwin') spawn('open', [url]);
  else spawn('xdg-open', [url]);
};

(async () => {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  YouTube Auto Clipper — OFFLINE APP');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. BACKEND dulu, tunggu bener-bener ready
  const backend = spawn('node', ['server.js'], {
    cwd: path.join(PROJECT_ROOT, 'backend'),
    stdio: 'inherit', shell: true,
  });
  backend.on('error', (e) => { log(`Backend ERROR: ${e.message}`); process.exit(1); });

  const backendOk = await waitFor(4010, 'Backend', '/health');
  if (!backendOk) {
    log('❌ Backend gagal start. Cek error di atas. (pastikan backend/.env sudah diisi)');
    process.exit(1);
  }

  // 2. FRONTEND baru nyala setelah backend siap
  const frontend = spawn('npx', ['next', 'dev', '-p', '3050'], {
    cwd: path.join(PROJECT_ROOT, 'frontend'),
    stdio: 'inherit', shell: true,
  });
  frontend.on('error', (e) => { log(`Frontend ERROR: ${e.message}`); process.exit(1); });

  const feOk = await waitFor(3050, 'Frontend', '/', 30);
  if (!feOk) {
    log('❌ Frontend gagal start. Cek error di atas.');
    process.exit(1);
  }

  // 3. BARU buka browser
  log('Kedua service UP — buka browser...');
  openBrowser('http://localhost:3050');

  log('───────────────────────────────────────');
  log('  Backend : http://localhost:4010');
  log('  Frontend: http://localhost:3050');
  log('  Tutup jendela ini = app mati.');
  log('───────────────────────────────────────');

  process.on('SIGINT', () => { backend.kill(); frontend.kill(); process.exit(0); });
})();