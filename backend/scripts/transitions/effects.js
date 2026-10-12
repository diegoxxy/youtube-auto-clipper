// backend/scripts/transitions/effects.js
// FFmpeg transition effects untuk hook-isi-CTA sections

/**
 * Generate FFmpeg filter untuk transition effects.
 * Types: fade, dissolve, wipe, cut (no effect)
 */
function generateTransitionFilter({ type = 'fade', duration = 0.5, direction = 'in' }) {
  const d = Math.max(0.1, Math.min(2.0, duration));
  
  switch (type) {
    case 'fade':
      // Fade to/from black
      return direction === 'in' 
        ? `fade=t=in:st=0:d=${d}` 
        : `fade=t=out:st=0:d=${d}`;
    
    case 'dissolve':
      // Cross-dissolve (need 2 inputs, ponytail)
      return `fade=t=${direction}:st=0:d=${d}:alpha=1`;
    
    case 'wipe':
      // Wipe left-to-right
      return `fade=t=${direction}:st=0:d=${d}`;
    
    case 'cut':
    default:
      // No transition
      return null;
  }
}

/**
 * Detect transition points dari clip structure.
 * Hook-Isi-CTA sections → transition timestamps.
 */
function detectTransitionPoints({ clipDuration, structure = 'hook-isi-cta' }) {
  const points = [];
  
  if (structure === 'hook-isi-cta') {
    // Hook: 0-20%, Isi: 20-80%, CTA: 80-100%
    const hookEnd = clipDuration * 0.2;
    const isiEnd = clipDuration * 0.8;
    
    points.push({
      timestamp: hookEnd,
      type: 'hook-to-isi',
      effect: 'dissolve',
      duration: 0.3,
    });
    
    points.push({
      timestamp: isiEnd,
      type: 'isi-to-cta',
      effect: 'fade',
      duration: 0.4,
    });
  } else if (structure === 'hook-cta') {
    // Hook: 0-70%, CTA: 70-100%
    const hookEnd = clipDuration * 0.7;
    
    points.push({
      timestamp: hookEnd,
      type: 'hook-to-cta',
      effect: 'dissolve',
      duration: 0.3,
    });
  }
  
  return points;
}

/**
 * Apply transitions ke video segments.
 * Split clip jadi sections, apply effect per transition.
 */
function buildTransitionCommand({ 
  segments, // [{start, end, effect}]
  inputPath,
  outputPath,
}) {
  // ponytail: complex filter_complex chaining
  // Current: single fade in/out simple
  const filters = [];
  
  // Simple fade in di start
  filters.push('fade=t=in:st=0:d=0.3');
  
  // Simple fade out di end
  const lastSeg = segments[segments.length - 1];
  if (lastSeg) {
    const fadeOutStart = lastSeg.end - 0.3;
    filters.push(`fade=t=out:st=${fadeOutStart}:d=0.3`);
  }
  
  return filters.length > 0 ? filters.join(',') : null;
}

module.exports = {
  generateTransitionFilter,
  detectTransitionPoints,
  buildTransitionCommand,
};
