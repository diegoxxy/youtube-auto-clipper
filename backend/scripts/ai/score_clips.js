/**
 * Viral clip scorer — port heuristik dari mehbul/chopify (MIT) ke JS.
 * Input:  transcript segments [{start, end, text}]
 * Output: [{start, end, hook, overall}] — score 0-10 + label
 *
 * Zero dependency, zero paid API. Kerja murni di teks transcript.
 * Dipakai untuk: kasih pilihan clip ke user SEBELUM render.
 */

const FILLER_TOKENS = new Set(['um', 'uh', 'uhh', 'umm', 'erm', 'er', 'hmm', 'mmm', 'mm', 'ah', 'eh']);
const FILLER_SEQS = ['you know', 'i mean', 'kind of', 'sort of'];

const CUES = {
  hook: [
    'the secret', 'nobody tells you', "here's the thing", 'here is the thing',
    'what most people', 'the truth is', "here's why", 'here is why', 'imagine',
    'the problem is', 'the biggest mistake', 'let me tell you', 'you need to',
    "here's how", 'here is how', 'the trick', 'the key', 'listen', 'story',
    'rahasianya', 'gak ada yang', 'masalahnya', 'coba bayangin', 'pokoknya',
  ],
  shock: [
    'insane', 'crazy', 'shocking', 'unbelievable', 'never', 'nobody', 'everyone',
    'banned', 'illegal', 'mistake', 'wrong', 'destroyed', 'worst', 'best',
    'huge', 'million', 'billion', 'dead', 'killed', 'gila', 'ngeri', 'jarang',
    'terlarang', 'salah', 'hancur', 'terburuk', 'terbaik',
  ],
  humour: ['haha', 'lol', 'laugh', 'joke', 'funny', 'hilarious', 'kidding', 'ridiculous', 'ketawa', 'lucu', 'baper'],
  controversy: [
    'i disagree', 'unpopular opinion', 'hot take', 'controversial',
    'stop doing', "don't do", 'do not do', 'overrated', 'underrated',
    'everyone is wrong', 'myth', 'lie', 'scam', 'ga setuju', 'menurut gue',
    'jangan', 'mitos', 'bohong',
  ],
  insight: [
    'because', 'the reason', 'how it works', 'step one', 'first', 'second',
    'third', 'the way', 'what happens', 'if you', 'the difference',
    'framework', 'system', 'lesson', 'learned', 'the point',
    'karena', 'caranya', 'langkah', 'pertama', 'kedua', 'kalau lo',
  ],
  emotion: [
    'love', 'hate', 'afraid', 'scared', 'amazing', 'terrible', 'proud',
    'embarrassed', 'angry', 'excited', 'grateful', 'hurts', 'cried',
    'dream', 'hope', 'believe', 'cinta', 'benci', 'takut', 'bangga',
    'marah', 'semangat', 'bersyukur', 'mimpi', 'harap',
  ],
};

const LABELS = [
  'Hook kuat', 'Momence gila', 'Lucu', 'Hot take', 'Mind blown',
  'Emosional', 'Insight berharga', 'Energi tinggi',
];

function tokens(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function cueHit(text, list) {
  const low = (text || '').toLowerCase();
  return list.some((c) => low.includes(c));
}

/**
 * Score satu window transcript.
 * @param {{start:number,end:number,text:string}[]} segs
 * @returns {{overall:number, hook:string, energy:number, tags:string[]}}
 */
function scoreWindow(segs) {
  const text = (segs.map((s) => s.text).join(' ') || '').trim();
  if (!text) return { overall: 0, hook: '', energy: 0, tags: [] };

  const words = tokens(text);
  const dur = Math.max(1, (segs[segs.length - 1].end - segs[0].start) || 1);
  const wps = words.length / dur; // energy: words per second

  const toks = new Set(words);
  let filler = 0;
  words.forEach((w) => { if (FILLER_TOKENS.has(w)) filler++; });
  const low = text.toLowerCase();
  FILLER_SEQS.forEach((s) => {
    const parts = s.split(' ');
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (parts.every((p, k) => words[i + k] === p)) filler++;
    }
  });

  const tags = [];
  const subscores = {};
  Object.keys(CUES).forEach((k) => {
    const hit = cueHit(text, CUES[k]);
    subscores[k] = hit ? 1 : 0;
    if (hit) tags.push(k);
  });

  // energy score: bicara cepat & padat = menarik (cap di 3 wps)
  const energyScore = Math.min(1, wps / 3.0);
  // filler penalty: banyak filler = ngawur
  const cleanRatio = words.length ? Math.max(0, 1 - (filler / words.length) * 2) : 0;

  // bobot: hook & shock paling gede
  const weights = { hook: 1.0, shock: 0.85, humour: 0.6, controversy: 0.8, insight: 0.65, emotion: 0.55 };
  let cueSum = 0;
  let wSum = 0;
  Object.keys(weights).forEach((k) => {
    cueSum += subscores[k] * weights[k];
    wSum += weights[k];
  });
  const cueScore = wSum ? cueSum / wSum : 0;

  // complete-arc: kalimat berakhir punctuation (ga digantung)
  const tail = text.trim();
  const endsClean = /[.!??"']$/.test(tail) || true; // ponytail: subtitle SRT sering ga ada punct di akhir, anggap ok
  const arcScore = endsClean ? 1 : 0.5;

  const overall = Math.min(10, (
    cueScore * 6.0 +
    energyScore * 1.5 +
    arcScore * 1.0 +
    cleanRatio * 1.5
  ));

  // hook title: 6 kata pertama yg non-filler
  const clean = words.filter((w) => !FILLER_TOKENS.has(w)).slice(0, 8);
  const hook = clean.length ? clean.join(' ') : text.slice(0, 40);

  return {
    overall: Math.round(overall * 10) / 10,
    hook: hook.charAt(0).toUpperCase() + hook.slice(1),
    energy: Math.round(wps * 100) / 100,
    tags,
  };
}

/**
 * Pecah transcript jadi candidate windows, score semuanya.
 * @param {{start:number,end:number,text:string}[]} segs transcript segments
 * @param {object} opts {minDur=8, maxDur=90, step=5, maxClips=10, minScore=5}
 * @returns {{start,end,hook,overall,energy,tags}[]}
 */
function scoreTranscript(segs, opts = {}) {
  if (!Array.isArray(segs) || !segs.length) return [];
  const minDur = opts.minDur || 8;
  const maxDur = opts.maxDur || 90;
  const step = opts.step || 5;
  const maxClips = opts.maxClips || 10;
  const minScore = opts.minScore || 5;

  const tEnd = segs[segs.length - 1].end;
  const cands = [];

  // untuk tiap titik mulai, cari durasi terbaik (greedy: coba beberapa durasi)
  const durations = [12, 20, 30, 45, 60, 90].filter((d) => d >= minDur && d <= maxDur);
  for (let t = segs[0].start; t < tEnd - minDur; t += step) {
    for (const dur of durations) {
      const end = t + dur;
      if (end > tEnd + 2) break;
      const window = segs.filter((s) => s.start < end && s.end > t);
      if (!window.length) continue;
      const r = scoreWindow(window);
      cands.push({ start: Math.round(t * 10) / 10, end: Math.round(end * 10) / 10, ...r });
    }
  }

  // dedupe overlapping: ambil score tertinggi, buang yang overlap >50%
  cands.sort((a, b) => b.overall - a.overall);
  const picked = [];
  for (const c of cands) {
    const cDur = c.end - c.start;
    const overlap = picked.some((p) => {
      const o = Math.min(c.end, p.end) - Math.max(c.start, p.start);
      return o > 0 && o / Math.min(cDur, p.end - p.start) > 0.5;
    });
    if (!overlap) picked.push(c);
    if (picked.length >= maxClips * 3) break;
  }

  return picked
    .filter((c) => c.overall >= minScore)
    .sort((a, b) => b.overall - a.overall)
    .slice(0, maxClips)
    .map((c, i) => ({ ...c, label: LABELS[i % LABELS.length] }));
}

module.exports = { scoreTranscript, scoreWindow, CUES, LABELS };
