// backend/scripts/ai/topic_detector.js
// Detect topic boundaries dari transcript untuk smart segmentation

/**
 * Detect topic changes dari transcript segments.
 * Return boundaries (timestamps where topic shifts).
 * ponytail: embeddings + semantic similarity → add when deps available
 */
function detectTopicBoundaries(transcriptSegments) {
  if (!transcriptSegments || transcriptSegments.length === 0) return [];
  
  const boundaries = [];
  
  // Heuristic: pause detection (gap > 2s between segments)
  for (let i = 1; i < transcriptSegments.length; i++) {
    const prev = transcriptSegments[i - 1];
    const curr = transcriptSegments[i];
    const gap = curr.start - prev.end;
    
    if (gap > 2.0) {
      boundaries.push({
        timestamp: prev.end,
        type: 'pause',
        confidence: Math.min(gap / 5, 1.0), // max confidence at 5s gap
      });
    }
  }
  
  // Heuristic: sentence end markers (. ? !) followed by capital letter
  for (let i = 1; i < transcriptSegments.length; i++) {
    const prev = transcriptSegments[i - 1];
    const curr = transcriptSegments[i];
    const prevText = (prev.text || '').trim();
    const currText = (curr.text || '').trim();
    
    if (/[.?!]$/.test(prevText) && /^[A-Z]/.test(currText)) {
      // Avoid dupe with pause boundary
      const existingPause = boundaries.find(b => Math.abs(b.timestamp - prev.end) < 1.0);
      if (!existingPause) {
        boundaries.push({
          timestamp: prev.end,
          type: 'sentence',
          confidence: 0.6,
        });
      }
    }
  }
  
  return boundaries.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Split transcript into topic chunks based on boundaries.
 * Each chunk = coherent topic segment.
 */
function splitIntoTopics(transcriptSegments, boundaries) {
  if (!transcriptSegments || transcriptSegments.length === 0) return [];
  if (!boundaries || boundaries.length === 0) {
    // No boundaries: entire transcript = 1 topic
    return [{
      start: transcriptSegments[0].start,
      end: transcriptSegments[transcriptSegments.length - 1].end,
      segments: transcriptSegments,
      confidence: 0.3,
    }];
  }
  
  const topics = [];
  let currentStart = transcriptSegments[0].start;
  let currentSegments = [];
  
  for (const seg of transcriptSegments) {
    const boundary = boundaries.find(b => b.timestamp >= seg.start && b.timestamp <= seg.end);
    
    if (boundary && currentSegments.length > 0) {
      // Close current topic
      topics.push({
        start: currentStart,
        end: currentSegments[currentSegments.length - 1].end,
        segments: currentSegments,
        confidence: boundary.confidence,
      });
      currentStart = seg.start;
      currentSegments = [seg];
    } else {
      currentSegments.push(seg);
    }
  }
  
  // Last topic
  if (currentSegments.length > 0) {
    topics.push({
      start: currentStart,
      end: currentSegments[currentSegments.length - 1].end,
      segments: currentSegments,
      confidence: 0.5,
    });
  }
  
  return topics;
}

module.exports = { detectTopicBoundaries, splitIntoTopics };
