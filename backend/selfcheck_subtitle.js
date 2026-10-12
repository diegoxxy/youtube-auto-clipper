// self-check: VTT->SRT + offset subtitle burn (tanpa download ulang)
const path = require('path');
const fs = require('fs');
const { vttToSrt, dedupeSegments, parseSrt, findSrt } = require('./scripts/transcribe');
const { srtToAss } = require('./scripts/ffmpeg/processor');

const jobDir = 'C:/Users/diego/youtube-auto-clipper/backend/jobs/27e559c4-f398-463d-a5a4-c7c655a852f0';
const vtt = path.join(jobDir, 'nSnLXTdtIcw.en.vtt');
const outSrt = path.join(jobDir, 'transcript', 'transcript.srt');

console.log('1. findSrt detect .vtt:');
const found = findSrt(jobDir);
console.log('   ->', found ? path.basename(found) : 'NULL');
assert(found === vtt, 'findSrt harus nemu VTT di jobDir root');

console.log('2. VTT -> SRT:');
vttToSrt(vtt, outSrt);
const raw = parseSrt(fs.readFileSync(outSrt, 'utf8'));
console.log('   cue mentah:', raw.length);
assert(raw.length > 100, 'harus banyak cue');

console.log('3. dedupe rolling caption:');
const ded = dedupeSegments(raw);
const noDup = ded.filter(s => s.start < s.end).length;
console.log('   sesudah dedupe:', ded.length, '(0-dur dibuang:', noDup, ')');
assert(ded.length < raw.length, 'dedupe harus kurangi cue');
const sample = ded.find(s => s.start > 1140 && s.end < 1172);
console.log('   sample di window clip c2 (1141.5-1171.5):', sample ? `[${sample.start.toFixed(1)}] "${sample.text}"` : 'TIDAK ADA');
assert(sample, 'harus ada cue dalam window c2');

console.log('4. srtToAss dengan offset (clip c2, start=1141.5, dur=30):');
const assPath = path.join(jobDir, 'test_clip.ass');
const n = srtToAss(outSrt, assPath, 1141.5, 30);
console.log('   dialogue events:', n);
assert(n > 0, 'harus ada event dalam window offset');
const ass = fs.readFileSync(assPath, 'utf8');
const first = ass.split('\n').find(l => l.startsWith('Dialogue'));
console.log('   first event:', first.slice(0, 120));
assert(!/Dialogue: 0,0:19:/.test(ass), 'timestamp harus ter-shift, bukan absolut 1141s');

console.log('5. cek tidak ada timestamp absolut nyasar (>= 0:19:00):');
const bad = ass.split('\n').filter(l => l.startsWith('Dialogue') && /Dialogue: 0,(\d+):/.test(l) && parseInt(l.match(/Dialogue: 0,(\d+):/)[1], 10) > 0);
console.log('   event dgn jam >= 1:', bad.length);
assert(bad.length === 0, 'tidak boleh ada event jam-an');

fs.unlinkSync(assPath);
console.log('\nSEMUA CHECK LULUS');

function assert(c, m) { if (!c) { console.error('GAGAL: ' + m); process.exit(1); } }
