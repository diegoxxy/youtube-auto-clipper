// self-check: burn subtitle end-to-end pakai VTT lama (bukti fix pipeline)
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { vttToSrt, dedupeSegments, parseSrt } = require('./scripts/transcribe');
const { processClip } = require('./scripts/ffmpeg/processor');

const jobDir = 'C:/Users/diego/youtube-auto-clipper/backend/jobs/27e559c4-f398-463d-a5a4-c7c655a852f0';
const vtt = path.join(jobDir, 'nSnLXTdtIcw.en.vtt');
const srt = path.join(jobDir, 'transcript', 'transcript.srt');
const video = path.join(jobDir, 'nSnLXTdtIcw.mp4');
const out = path.join(jobDir, 'BURN_TEST.mp4');

(async () => {
  console.log('1) VTT -> SRT');
  vttToSrt(vtt, srt);
  const segs = dedupeSegments(parseSrt(fs.readFileSync(srt, 'utf8')));
  console.log('   segments:', segs.length);
  if (!segs.length) throw new Error('no segments');

  console.log('2) burn clip dari detik 1141.5 selama 30s');
  await processClip({
    ffmpegPath: 'ffmpeg',
    videoPath: video,
    output: out,
    start: 1141.5,
    end: 1171.5,
    format: '9:16',
    srtPath: srt,
  });
  const st = fs.statSync(out);
  console.log('   output:', out, (st.size / 1e6).toFixed(2), 'MB');
  if (st.size < 100000) throw new Error('output terlalu kecil');

  console.log('3) verifikasi ada stream video+audio');
  const probe = execSync(`ffprobe -v error -show_entries stream=index,codec_type,codec_name -of csv=p=0 "${out}"`, { encoding: 'utf8' });
  console.log(probe.trim().split('\n').map(l => '   ' + l).join('\n'));
  if (!probe.includes('video') || !probe.includes('audio')) throw new Error('stream kurang');
  console.log('\nBURN TEST LULUS');
})().catch(e => { console.error('GAGAL:', e.message); process.exit(1); });
