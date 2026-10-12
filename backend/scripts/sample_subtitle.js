// backend/scripts/sample_subtitle.js
// Generate sample subtitle untuk upload video (no transcript available)

const fs = require('fs');
const path = require('path');

/**
 * Generate sample SRT subtitle dengan natural topic shifts.
 * Variasi durasi + pause untuk trigger topic detection.
 */
function generateSampleSubtitle(duration, outputPath) {
  // Topic-based samples dengan natural length
  const topics = [
    {
      sentences: [
        "Hai semuanya, selamat datang!",
        "Hari ini kita akan bahas sesuatu yang menarik banget.",
        "Pastikan nonton sampai habis ya."
      ],
      avgDur: 2.5  // Hook: 7-8s total
    },
    {
      sentences: [
        "Jadi ceritanya begini.",
        "Kemarin saya nemuin rahasia yang jarang orang tahu.",
        "Ini bisa banget ngubah cara kalian ngelakuin hal ini.",
        "Serius deh, game changer banget!"
      ],
      avgDur: 3  // Topic 1: 12s
    },
    {
      sentences: [
        "Oke sekarang kita masuk ke step by step ya.",
        "Pertama, kalian perlu siapin ini dulu.",
        "Terus yang kedua, jangan lupa bagian ini penting banget.",
        "Kalau ini kelewat, hasilnya bakal beda jauh."
      ],
      avgDur: 3.5  // Topic 2: 14s
    },
    {
      sentences: [
        "Nah ini dia yang paling banyak ditunggu.",
        "Trik rahasianya ada di sini nih.",
        "Kalian harus coba sendiri buat ngerasain bedanya.",
        "Dijamin hasilnya mengejutkan!"
      ],
      avgDur: 3  // Topic 3: 12s
    },
    {
      sentences: [
        "Oke guys, itu tadi penjelasan lengkapnya.",
        "Kalau ada yang mau ditanyain, tulis di komen ya.",
        "Jangan lupa like, share, dan subscribe.",
        "See you di video berikutnya!"
      ],
      avgDur: 2.5  // Outro: 10s
    }
  ];
  
  let srt = '';
  let segmentIndex = 1;
  let currentTime = 0;
  
  // Generate clips dari topics sampai duration habis
  while (currentTime < duration) {
    for (const topic of topics) {
      if (currentTime >= duration) break;
      
      for (const sentence of topic.sentences) {
        if (currentTime >= duration) break;
        
        const segDur = topic.avgDur + (Math.random() * 1 - 0.5); // variasi ±0.5s
        const start = currentTime;
        const end = Math.min(currentTime + segDur, duration);
        
        srt += `${segmentIndex}\n`;
        srt += `${formatTime(start)} --> ${formatTime(end)}\n`;
        srt += `${sentence}\n\n`;
        
        segmentIndex++;
        currentTime = end;
      }
      
      // Pause antar topic (1-2s) untuk topic detection trigger
      if (currentTime < duration) {
        currentTime += 1 + Math.random(); // pause 1-2s
      }
    }
  }
  
  fs.writeFileSync(outputPath, srt, 'utf8');
  return segmentIndex - 1;
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

module.exports = { generateSampleSubtitle };
