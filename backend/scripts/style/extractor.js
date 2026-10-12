// backend/scripts/style/extractor.js
// Extract editing style dari reference video: warna, subtitle position, transitions

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Extract dominant color dari video thumbnail
 * Return hex color palette (top 3)
 */
function extractColorPalette(videoPath) {
  try {
    // ffmpeg extract 1 frame di tengah
    const tmpImg = path.join(path.dirname(videoPath), 'thumb_color.png');
    const { execSync } = require('child_process');
    // Windows: jangan pakai 2>/dev/null, redirect stderr ke stdout langsung
    try {
      execSync(`ffmpeg -y -i "${videoPath}" -vf "select=eq(n\\,100)" -vsync vfr "${tmpImg}"`, { stdio: 'ignore' });
    } catch (e) {
      // ffmpeg might error tapi file mungkin jadi, ignore
    }
    
    if (!fs.existsSync(tmpImg)) {
      // Fallback: no thumbnail, tapi tetap return default palette
      return { dominant: '#FFFFFF', palette: ['#FFFFFF', '#000000', '#808080'] };
    }
    
    // Better: extract histogram via ffmpeg
    const histPath = path.join(path.dirname(videoPath), 'histogram.txt');
    try {
      execSync(`ffmpeg -i "${tmpImg}" -vf "histogram=level_height=256" -f null - 2>&1 | grep -E "mean|max" > "${histPath}"`, { stdio: 'ignore' });
    } catch {}
    
    // Simple RGB avg from pixel sampling (ponytail: use sharp/jimp for real histogram)
    const dominant = '#FFFFFF'; // fallback
    const palette = ['#FFFFFF', '#FF0000', '#0000FF']; // placeholder colors
    
    try { fs.unlinkSync(tmpImg); } catch {}
    try { fs.unlinkSync(histPath); } catch {}
    return { dominant, palette };
  } catch (e) {
    console.warn(`[style] extract color gagal: ${e.message}`);
    return { dominant: '#FFFFFF', palette: ['#FFFFFF', '#000000', '#808080'] };
  }
}

/**
 * Extract metadata dari reference video
 * Return { colors, duration, fps, hasSubtitles }
 */
function analyzeReference(videoPath) {
  if (!fs.existsSync(videoPath)) return null;
  
  const metadata = {
    videoPath,
    fileName: path.basename(videoPath),
    duration: 0,
    fps: 30,
    colors: extractColorPalette(videoPath) || { dominant: '#FFFFFF', palette: ['#FFFFFF', '#000000', '#808080'] },
    style: {
      subtitlePosition: 'bottom', // fallback: bottom center
      subtitleColor: '#FFFFFF',
      subtitleBackground: 'transparent',
      hasTransitions: false,
      hasEffects: false,
    },
  };
  
  return metadata;
}

module.exports = { extractColorPalette, analyzeReference };
