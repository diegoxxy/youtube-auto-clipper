// backend/scripts/ai/adapter.js — T-05/T-06
// Pluggable LLM adapter: openai | anthropic | heuristic fallback (tanpa API key tetap jalan).
// Env: AI_PROVIDER=openai|anthropic, AI_API_KEY=..., AI_MODEL=...

const fs = require('fs');
const path = require('path');
const { safeParseClips } = require('./repair');
const { detectTopicBoundaries, splitIntoTopics } = require('./topic_detector');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function normalizeClips(raw, { duration, clipCount, targetDuration }) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    let start = Number(c.start);
    let end = Number(c.end);
    if (!isFinite(start) || !isFinite(end)) continue;
    // clamp ke durasi — ponytail: arc narasi butuh ruang, floor 20s (8-180s)
    start = clamp(start, 0, Math.max(0, (duration || 3600) - 20));
    end = clamp(end, start + 20, Math.min(duration || 3600, start + 180));
    const dur = end - start;
    if (dur < 20 || dur > 180) continue;
    out.push({
      id: String(c.id || `c${out.length + 1}`),
      start: Math.round(start * 10) / 10,
      end: Math.round(end * 10) / 10,
      duration: Math.round(dur * 10) / 10,
      // format per-clip: AI pilih framing (9:16 crop vs 9:16_fill blurred bg).
      // whitelist — nilai lain/gagal = fallback 9:16.
      format: (c.format === '9:16_fill') ? '9:16_fill' : '9:16',
      title: String(c.title || `Clip ${out.length + 1}`).slice(0, 80),
      reason: String(c.reason || '').slice(0, 300),
      keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 6).map(String) : [],
    });
    if (out.length >= clipCount) break;
  }
  // jika kurang dari clipCount dan ada durasi, heuristic fill di caller
  return out;
}

function heuristicSegment({ transcriptSegments, duration, clipCount, targetDuration, brief }) {
  const dur = duration || (transcriptSegments.length ? transcriptSegments[transcriptSegments.length - 1].end : 600);
  
  // NEW: Auto-detect viral moments (no fixed clipCount/duration)
  const { detectViralMoments } = require('./viral_moments');
  const moments = detectViralMoments({ transcriptSegments, duration: dur, videoInfo: {} });
  
  if (moments.length > 0) {
    return moments.map((m, i) => ({
      id: `c${i + 1}`,
      start: Math.round(m.start * 10) / 10,
      end: Math.round(m.end * 10) / 10,
      duration: Math.round((m.end - m.start) * 10) / 10,
      format: '9:16_fill',
      title: m.title,
      reason: m.reason,
      keywords: [],
    }));
  }
  
  // Fallback: fixed-duration jika viral detection gagal (min 20s = ruang arc narasi)
  const n = clamp(clipCount || 5, 1, 10);
  const chunk = Math.max(20, Math.min(180, targetDuration || 60));
  const step = n > 1 ? Math.max(chunk, (dur - chunk) / (n - 1)) : 0;
  const clips = [];
  for (let i = 0; i < n; i++) {
    const start = clamp(i * step, 0, Math.max(0, dur - chunk));
    const end = clamp(start + chunk, start + 20, dur);
    clips.push({
      id: `c${i + 1}`,
      start: Math.round(start * 10) / 10,
      end: Math.round(end * 10) / 10,
      duration: Math.round((end - start) * 10) / 10,
      title: brief ? `Clip ${i + 1} — sesuai brief` : `Highlight ${i + 1}`,
      reason: brief ? `Fallback heuristic: bagi rata, relevan dengan brief "${brief.slice(0, 60)}"` : 'Fallback heuristic: bagi rata durasi (LLM tidak tersedia)',
      keywords: [],
      format: '9:16_fill',
    });
  }
  return clips;
}

function heuristicRank(clips) {
  // skor turun bertahap + variasi hookLabel
  const labels = ['Hook kuat', 'Curiosity gap', 'Insight padat', 'Story beat', 'CTA jelas', 'Emosi tinggi'];
  return clips.map((c, i) => {
    const score = clamp(82 - i * 7 + (i % 2 ? 3 : 0), 35, 92);
    const tier = score >= 85 ? 'S' : score >= 70 ? 'A' : 'B';
    return { ...c, score, tier, hookLabel: labels[i % labels.length], rankReason: 'Heuristic (LLM tidak tersedia)' };
  }).sort((a, b) => b.score - a.score);
}

function buildTranscriptPrompt(segments, maxChars = 18000) {
  if (!segments || !segments.length) return '(transcript kosong — pakai heuristic)';
  let out = '';
  for (const s of segments) {
    const line = `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out;
}

function loadPrompt(name) {
  const p = path.join(__dirname, '..', 'prompts', name);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

async function callOpenAI({ prompt, model }) {
  const key = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('AI_API_KEY kosong');
  const m = model || process.env.AI_MODEL_FAST || process.env.AI_MODEL || 'gpt-4o-mini';
  // ponytail: AI_MODEL=Claude 3.3s/req vs gpt-4o-mini 0.23s/req — segment/rank butuh cepat, bukan pinter
  // AI_BASE_URL: OpenAI-compatible endpoint (mis. 9router lokal http://localhost:20128/v1).
  // Default ke api.openai.com kalau tidak diset.
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  // Router lokal (non-openai.com) = Responses API (/v1/responses), bukan chat/completions.
  // /chat/completions di 9router balas content kosong — /responses yang jalan (tested).
  const usesResponses = !!process.env.AI_BASE_URL && !/api\.openai\.com/.test(base);
  const url = usesResponses ? `${base}/responses` : `${base}/chat/completions`;
  const body = usesResponses
    ? JSON.stringify({ model: m, input: [{ role: 'user', content: prompt }], stream: false })
    : JSON.stringify({ model: m, temperature: 0.3, stream: false, messages: [{ role: 'user', content: prompt }] });
  const res = await fetch(url, {
    method: 'POST',
    // 9Router (localhost:20128) auth via x-api-key, BUKAN Authorization Bearer
    // (Bearer ditolak "Invalid API key" meski key isActive=1 di DB router).
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body,
  });
  if (!res.ok) throw new Error(`OpenAI-compatible ${res.status}: ${await res.text().then(t => t.slice(0, 500))}`);
  const body2 = await res.text();
  // Router OpenAI-compatible kadang balas SSE walau stream:false — parse dua-duanya.
  let j;
  try {
    j = JSON.parse(body2);
  } catch {
    const chunks = body2.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(t => t && t !== '[DONE]');
    let acc = '';
    let last = null;
    let lastResponse = null;
    for (const c of chunks) {
      try {
        const o = JSON.parse(c);
        last = o;
        // Responses API streaming: tiap event punya `delta` output text
        if (o.type === 'response.output_text.delta' && o.delta) acc += o.delta;
        else if (o.type === 'response.completed' && o.response) lastResponse = o.response;
        else acc += o.output_text || o.choices?.[0]?.delta?.content || o.choices?.[0]?.message?.content || '';
      } catch {}
    }
    if (!acc) {
      acc = lastResponse?.output_text || last?.output_text || last?.choices?.[0]?.message?.content || '';
      if (typeof acc !== 'string') acc = '';
    }
    return acc;
  }
  return j.output_text || j.choices?.[0]?.message?.content || '';
}

async function callAnthropic({ prompt, model }) {
  const key = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('AI_API_KEY kosong');
  const m = model || process.env.AI_MODEL || 'claude-3-5-haiku-20241022';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: m, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text().then(t => t.slice(0, 500))}`);
  const j = await res.json();
  return j.content?.map(c => c.text).join('') || '';
}

async function segment({ transcriptSegments, brief, duration, clipCount = 5, targetDuration = 60, referenceStyle = null, sourceInfo = null }) {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  const warnings = [];
  const tmpl = loadPrompt('segment.txt');
  const transcript = buildTranscriptPrompt(transcriptSegments);
  const filled = tmpl
    .replace('{{BRIEF}}', brief || '(kosong — pilih hook umum)')
    .replace('{{DURATION}}', String(duration || 0))
    .replace('{{CLIP_COUNT}}', String(clipCount))
    .replace('{{TARGET_DURATION}}', String(targetDuration))
    .replace('{{SOURCE_INFO}}', sourceInfo || '(tidak ada info source — mungkin video pendek, pakai transcript saja)')
    .replace('{{REFERENCE_STYLE}}', referenceStyle || '(tidak ada referensi — pakai pola viral standar)')
    .replace('{{TRANSCRIPT}}', transcript);

  let rawText = '';
  try {
    if (provider === 'openai') rawText = await callOpenAI({ prompt: filled });
    else if (provider === 'anthropic') rawText = await callAnthropic({ prompt: filled });
    else throw new Error('AI_PROVIDER tidak diset — pakai heuristic');
  } catch (e) {
    warnings.push(`LLM segment gagal: ${String(e.message).slice(0, 400)} — fallback heuristic`);
    const clips = heuristicSegment({ transcriptSegments, duration, clipCount, targetDuration, brief });
    return { clips, warnings, rawText: null };
  }

  const parsed = safeParseClips(rawText);
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
    warnings.push('LLM output bukan JSON array valid — fallback heuristic');
    const clips = heuristicSegment({ transcriptSegments, duration, clipCount, targetDuration, brief });
    return { clips, warnings, rawText };
  }
  let clips = normalizeClips(parsed, { duration, clipCount, targetDuration });
  if (clips.length < clipCount) {
    const need = clipCount - clips.length;
    const filler = heuristicSegment({ transcriptSegments, duration, clipCount: need, targetDuration, brief });
    // offset filler agar tidak duplikat start
    const maxEnd = clips.length ? Math.max(...clips.map(c => c.end)) : 0;
    for (const f of filler) { f.start = clamp(f.start + maxEnd, 0, (duration || 600) - f.duration); f.end = f.start + f.duration; }
    clips = [...clips, ...filler].slice(0, clipCount);
    warnings.push(`LLM hanya hasilkan ${parsed.length} clip, dilengkapi heuristic ${need}`);
  }
  return { clips, warnings, rawText };
}

async function rank({ clips, transcriptSegments, brief }) {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  const warnings = [];
  if (!clips || !clips.length) return { clips: [], warnings };

  // excerpt per clip dari transcript
  const withExcerpt = clips.map(c => {
    const ex = (transcriptSegments || []).filter(s => s.start >= c.start - 2 && s.end <= c.end + 2).map(s => s.text).join(' ').slice(0, 400);
    return { ...c, transcript_excerpt: ex || c.reason || '' };
  });

  const tmpl = loadPrompt('rank.txt');
  const filled = tmpl
    .replace('{{CLIPS_JSON}}', JSON.stringify(withExcerpt.map(({ id, start, end, title, reason, hookType, transcript_excerpt }) => ({ id, start, end, title, reason, hookType: hookType || null, transcript_excerpt })), null, 2))
    .replace('{{BRIEF}}', brief || '(kosong)');

  let rawText = '';
  try {
    if (provider === 'openai') rawText = await callOpenAI({ prompt: filled });
    else if (provider === 'anthropic') rawText = await callAnthropic({ prompt: filled });
    else throw new Error('AI_PROVIDER tidak diset — heuristic rank');
  } catch (e) {
    warnings.push(`LLM rank gagal: ${String(e.message).slice(0, 400)} — heuristic`);
    return { clips: heuristicRank(clips), warnings, rawText: null };
  }

  const parsed = safeParseClips(rawText);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    warnings.push('LLM rank output invalid — heuristic');
    return { clips: heuristicRank(clips), warnings, rawText };
  }
  const byId = new Map(parsed.map(p => [String(p.id), p]));
  const merged = clips.map(c => {
    const r = byId.get(String(c.id));
    if (!r) return { ...c, score: 50, tier: 'B', hookLabel: '—', rankReason: '' };
    const score = clamp(parseInt(r.score, 10) || 50, 0, 100);
    const tier = score >= 85 ? 'S' : score >= 70 ? 'A' : 'B';
    const structure = r.structure && typeof r.structure === 'object' ? {
      hookSec: Number(r.structure.hookSec) || 0,
      hookScore: clamp(parseInt(r.structure.hookScore, 10) || 0, 0, 100),
      retentionScore: clamp(parseInt(r.structure.retentionScore, 10) || 0, 0, 100),
      notes: String(r.structure.notes || '').slice(0, 200),
    } : null;
    const edits = Array.isArray(r.edits) ? r.edits.slice(0, 8).map(e => ({
      type: String(e?.type || 'trim_jeda').slice(0, 30),
      at: Number(e?.at) || 0,
      note: String(e?.note || '').slice(0, 120),
    })) : [];
    return { ...c, score, tier, hookLabel: String(r.hookLabel || tier).slice(0, 40), rankReason: String(r.reason || '').slice(0, 300), structure, edits };
  }).sort((a, b) => b.score - a.score);
  return { clips: merged, warnings, rawText };
}

module.exports = { segment, rank, heuristicSegment, heuristicRank, buildTranscriptPrompt, callOpenAI };
