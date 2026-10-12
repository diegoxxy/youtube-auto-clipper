// backend/scripts/ai/viral_moments.js
// Auto-detect viral moments dari video tanpa fixed clipCount/duration

/**
 * Analyze transcript + video metadata → detect viral moments.
 * Return: dynamic clips array (bukan fixed count)
 */
function detectViralMoments({ transcriptSegments, duration, videoInfo }) {
  if (!transcriptSegments || transcriptSegments.length === 0) {
    // Fallback: generate 3-5 clips berbeda durasi
    return generateFallbackMoments(duration);
  }
  
  const moments = [];
  
  // 1. Detect hook potential (first 10% of video)
  const hookWindow = duration * 0.1;
  const hookSegments = transcriptSegments.filter(s => s.start < hookWindow);
  if (hookSegments.length > 0) {
    moments.push({
      start: 0,
      end: Math.min(hookWindow, 30), // max 30s hook
      type: 'hook',
      title: 'Hook Opening — First Impression',
      viralScore: 85,
      reason: 'Opening statement untuk grab attention',
    });
  }
  
  // 2. Detect topic shifts (pauses + sentence endings)
  const { detectTopicBoundaries, splitIntoTopics } = require('./topic_detector');
  const boundaries = detectTopicBoundaries(transcriptSegments);
  const topics = splitIntoTopics(transcriptSegments, boundaries);
  
  for (const topic of topics) {
    const topicDur = topic.end - topic.start;
    
    // Skip topic terlalu pendek (< 5s) — terlalu singkat ga ada value
    if (topicDur < 5) continue;
    
    // Use full topic duration (natural sesuai konteks obrolan)
    // Max 120s untuk safety (video panjang)
    const clipEnd = topicDur > 120 ? topic.start + 120 : topic.end;
    
    moments.push({
      start: topic.start,
      end: clipEnd,
      type: 'topic',
      title: generateViralTitle(topic.segments),
      viralScore: calculateViralScore(topic),
      reason: `Topic complete: ${(clipEnd - topic.start).toFixed(0)}s, confidence ${(topic.confidence * 100).toFixed(0)}%`,
    });
  }
  
  // 3. Detect climax/insight (middle-to-end sections dengan keyword triggers)
  const insightKeywords = ['rahasia', 'penting', 'harus tahu', 'ini dia', 'ternyata', 'mengejutkan', 'wow'];
  for (const seg of transcriptSegments) {
    const text = (seg.text || '').toLowerCase();
    const hasInsight = insightKeywords.some(kw => text.includes(kw));
    
    if (hasInsight && seg.start > hookWindow) {
      // Title = kutipan ASLI transcript (AI mati = title seragam sebelumnya).
      // Ambil 5-7 kata pertama dari cue insight, kapitalisasi judul.
      const words = text.trim().split(/\s+/).slice(0, 6).join(' ');
      const dynamicTitle = words
        ? words.replace(/\b\w/g, (m) => m.toUpperCase()).replace(/[.!?]$/, '') + '!'
        : 'Insight Mengejutkan!';
      // ARC NARASI butuh ruang: setup+konteks+statement. seg.start-3 ke
      // seg.end+10 = 10-16s (terlalu pendek, user complaint). Perluas:
      // Referensi viral TikTok: arc 40-70s. Setup pertanyaan -8s, jawaban +20s.
      const arcStart = Math.max(0, seg.start - 8);
      const arcEnd = Math.min(duration, seg.end + 20);
      const arcLen = arcEnd - arcStart;
      // Kalau konteks baru <35s, cari kalimat Q&A sekitarnya biar arc kedengeran
      // utuh (referensi: pertanyaan di awal, jawaban di 80-90% durasi).
      const arc = arcLen < 35
        ? { start: Math.max(0, arcStart - 10), end: Math.min(duration, arcEnd + 10) }
        : { start: arcStart, end: arcEnd };
      moments.push({
        start: arc.start,
        end: arc.end < arc.start + 20 ? Math.min(duration, arc.start + 20) : arc.end,
        type: 'insight',
        title: dynamicTitle,
        viralScore: 90,
        reason: `Keyword trigger: "${text.slice(0, 40)}"`,
      });
    }
  }
  
  // Sort by viralScore, dedupe overlapping moments, ambil top (max 10)
  moments.sort((a, b) => b.viralScore - a.viralScore);
  
  // Dedupe: remove overlapping moments (keep higher score)
  const deduped = [];
  for (const m of moments) {
    const overlap = deduped.some(d => {
      return (m.start >= d.start && m.start < d.end) || (m.end > d.start && m.end <= d.end) || (m.start <= d.start && m.end >= d.end);
    });
    if (!overlap) deduped.push(m);
    if (deduped.length >= 10) break;
  }
  
  return deduped;
}

function generateFallbackMoments(duration) {
  // Fallback: 3-5 clips spread merata, durasi bervariasi
  const count = duration > 300 ? 5 : 3;
  const moments = [];
  
  for (let i = 0; i < count; i++) {
    const clipDur = 20 + Math.random() * 30; // 20-50s random
    const start = (duration / count) * i;
    const end = Math.min(start + clipDur, duration);
    
    moments.push({
      start,
      end,
      type: 'auto',
      title: `Moment ${i + 1} — Auto-detected`,
      viralScore: 50 + Math.random() * 30,
      reason: 'Fallback auto segment',
    });
  }
  
  return moments;
}

function generateViralTitle(segments) {
  if (!segments || segments.length === 0) return 'Viral Moment';
  
  const { matchHookBank, generateSmartTitle } = require('./hook_bank');
  
  // Match first segment ke hook bank
  const firstText = (segments[0].text || '').trim();
  const hookMatch = matchHookBank(firstText);
  
  // Generate smart title dari actual content + hook pattern
  return generateSmartTitle(segments, hookMatch);
}

function calculateViralScore(topic) {
  // Simple scoring: durasi ideal (15-45s) = high score
  const dur = topic.end - topic.start;
  let score = 50;
  
  if (dur >= 15 && dur <= 45) score += 30;
  if (topic.confidence > 0.7) score += 20;
  
  return Math.min(100, score);
}

module.exports = { detectViralMoments };
