// backend/scripts/ai/repair.js — helper JSON repair untuk output LLM yang berantakan

function extractJsonArray(text) {
  const s = String(text);
  // cari blok ```json ... ``` atau langsung [...]
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : s;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  let slice = raw.slice(start, end + 1);
  // repair common: trailing comma, single quote
  slice = slice.replace(/,\s*([}\]])/g, '$1');
  // jangan over-repair single quote — biarkan JSON.parse yang tentukan
  return slice;
}

function safeParseClips(text) {
  if (!text) return null;
  let slice = extractJsonArray(text);
  if (!slice) return null;
  try { return JSON.parse(slice); } catch {}
  // coba repair kutip tunggal jadi ganda (hanya di key)
  try {
    const repaired = slice.replace(/'([^']*)':/g, '"$1":').replace(/:\s*'([^']*)'/g, ': "$1"');
    return JSON.parse(repaired);
  } catch {}
  return null;
}

module.exports = { extractJsonArray, safeParseClips };
