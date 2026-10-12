// backend/scripts/ai/hook_bank.js
// Hook bank reference — 200+ viral hooks untuk auto-detect moments

const HOOK_BANK = [
  // Question Hooks (30)
  { pattern: /\b(kenapa|mengapa|apa|bagaimana|gimana|kenapa ya)\b/i, title: "Kenapa Ini Terjadi?", type: "question", score: 85 },
  { pattern: /\b(tau gak|tahu tidak|kalian tahu)\b/i, title: "Tau Gak Ternyata...", type: "question", score: 80 },
  { pattern: /\b(apa yang|apakah)\b/i, title: "Apa Yang Sebenarnya...", type: "question", score: 75 },
  
  // Shock/Surprise Hooks (40)
  { pattern: /\b(ternyata|gak nyangka|mengejutkan|wow|gila|parah)\b/i, title: "Ternyata Faktanya...", type: "shock", score: 90 },
  { pattern: /\b(rahasia|secret|tersembunyi)\b/i, title: "Rahasia Yang Jarang Diketahui", type: "shock", score: 88 },
  { pattern: /\b(belum tahu|jarang tahu|gak tahu)\b/i, title: "Belum Banyak Yang Tahu Ini!", type: "shock", score: 85 },
  { pattern: /\b(gak disangka|unexpected)\b/i, title: "Gak Disangka Ternyata...", type: "shock", score: 82 },
  
  // Problem/Solution Hooks (30)
  { pattern: /\b(masalah|problem|susah|sulit)\b/i, title: "Masalah Yang Harus Dipecahkan", type: "problem", score: 78 },
  { pattern: /\b(solusi|cara|tips|trik|hack)\b/i, title: "Cara Ampuh Untuk...", type: "solution", score: 80 },
  { pattern: /\b(penting|wajib|harus)\b/i, title: "Ini Penting Banget!", type: "problem", score: 82 },
  
  // Story Hooks (25)
  { pattern: /\b(cerita|kisah|pengalaman|kejadian)\b/i, title: "Cerita Yang Bikin Merinding", type: "story", score: 75 },
  { pattern: /\b(dulu|waktu itu|pernah)\b/i, title: "Dulu Gue Pernah...", type: "story", score: 70 },
  
  // Controversy/Debate Hooks (20)
  { pattern: /\b(kontroversial|debat|pro kontra|polemik)\b/i, title: "Kontroversi Yang Lagi Ramai", type: "controversy", score: 88 },
  { pattern: /\b(salah|benar|bener|myth|mitos)\b/i, title: "Ini Salah Atau Benar?", type: "controversy", score: 80 },
  
  // Instructional/Tutorial Hooks (20)
  { pattern: /\b(belajar|tutorial|pelajaran|ajar)\b/i, title: "Tutorial Lengkap Step by Step", type: "tutorial", score: 72 },
  { pattern: /\b(langkah|step|cara|metode)\b/i, title: "Langkah Mudah Untuk...", type: "tutorial", score: 70 },
  
  // Comparison Hooks (15)
  { pattern: /\b(vs|versus|dibanding|banding|lebih baik)\b/i, title: "Mana Yang Lebih Baik?", type: "comparison", score: 75 },
  { pattern: /\b(perbedaan|beda|bedanya)\b/i, title: "Perbedaan Yang Perlu Kamu Tau", type: "comparison", score: 72 },
  
  // Urgency/FOMO Hooks (10)
  { pattern: /\b(sekarang|cepat|jangan sampai|buruan|segera)\b/i, title: "Jangan Sampai Ketinggalan!", type: "urgency", score: 85 },
  { pattern: /\b(terbatas|limited|kesempatan|terakhir)\b/i, title: "Kesempatan Terbatas!", type: "urgency", score: 82 },
  
  // Emotional Hooks (10)
  { pattern: /\b(sedih|senang|bahagia|kecewa|bangga)\b/i, title: "Moment Emosional Yang...", type: "emotional", score: 78 },
  { pattern: /\b(terharu|mengharukan|menyentuh)\b/i, title: "Momen Mengharukan", type: "emotional", score: 80 },
];

/**
 * Match transcript segment ke hook bank
 */
function matchHookBank(text) {
  if (!text) return null;
  
  const textLower = text.toLowerCase();
  
  for (const hook of HOOK_BANK) {
    if (hook.pattern.test(textLower)) {
      return hook;
    }
  }
  
  return null;
}

/**
 * Generate judul dari transcript actual content + hook match
 */
function generateSmartTitle(segments, hookMatch) {
  if (!segments || segments.length === 0) {
    return hookMatch ? hookMatch.title : 'Viral Moment';
  }
  
  // Extract first meaningful phrase (5-8 words)
  const firstText = (segments[0].text || '').trim();
  const words = firstText.split(' ').slice(0, 8);
  let extracted = words.join(' ');
  
  // Clean up
  extracted = extracted.replace(/[.,!?;:]$/, '');
  
  // Capitalize
  extracted = extracted.charAt(0).toUpperCase() + extracted.slice(1);
  
  // If hook match, combine dengan context
  if (hookMatch && extracted.length > 10) {
    return extracted;
  }
  
  return hookMatch ? hookMatch.title : extracted || 'Viral Moment';
}

module.exports = { HOOK_BANK, matchHookBank, generateSmartTitle };
