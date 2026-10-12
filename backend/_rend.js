// CLI render helper: node _rend.js <jobId> <start> <end> <format> <tag>
// Bypass server (render-clip POST blok event loop). Direct call processClip.
const path = require('path');
const fs = require('fs');
const { processClip } = require('./scripts/ffmpeg/processor');

const FFMPEG = 'C:/Users/diego/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';
const [,, jobId, s0, s1, fmt, tag] = process.argv;
const B = __dirname;
const jobDir = path.join(B, 'jobs', jobId);
const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'metadata.json'), 'utf8'));

(async () => {
  const start = parseFloat(s0), end = parseFloat(s1);
  const sub0 = meta.srtPath && fs.existsSync(path.join(jobDir, meta.srtPath)) ? path.join(jobDir, meta.srtPath) : null;
  const sub1 = path.join(jobDir, 'transcript', 'transcript.srt');
  const sub2 = path.join(jobDir, 'subs', 'auto.id.srt');
  const sub = sub0 || (fs.existsSync(sub1) ? sub1 : (fs.existsSync(sub2) ? sub2 : null));
  console.log(`[rend] srt=${sub || 'NONE (tanpa subtitle)'}`);
  const out = path.join(jobDir, 'clips', `${tag || 't'}_${Math.round(start)}_${fmt.replace(':', '')}.mp4`);
  console.log(`[rend] job ${jobId} ${start}-${end} ${fmt} tag=${tag}`);
  await processClip({
    ffmpegPath: FFMPEG,
    videoPath: path.join(jobDir, 'raw.mp4'),
    output: out,
    start, end, format: fmt,
    srtPath: fs.existsSync(sub) ? sub : null,
    subtitleTemplate: 'modern'
  });
  console.log(`[rend] DONE out=${path.basename(out)} ${fs.existsSync(out) ? fs.statSync(out).size + ' bytes' : '???'}`);
  process.exit(0);
})().catch(e => { console.error('[rend] FAIL', e.message); process.exit(1); });
