// Subtitle design templates (ASS format styles)
// PlayResX/Y = 1080x1920 (9:16). Font size ~70-76 = pas readable di HP.
// MarginV tinggi (140-160) = safe area: di atas icon/comment/share reels & shorts.

function getTemplate(name = 'modern') {
  const templates = {
// Template CapCut populer buat clipping (verified style TikTok/Reels 2026).
// ponytail: preview 4s render pakai srt dummy lewat endpoint /api/subtitle-preview.
    karaoke: {
      name: 'Karaoke Kuning (CapCut)',
      description: 'Per-kata, kata aktif kuning + outline tebal — CapCut viral',
      karaoke: true,
      uppercase: true,
      highlightColor: '&H0000FFFF&',
      style: `
[Script Info]
Title: Modern Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,150,1
Style: Default,Arial Black,78,&H0000FFFF&,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,800,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    hormozi: {
      name: 'Hormozi Box (CapCut)',
      description: 'Kotak hitam + kata aktif hijau — gaya Alex Hormozi',
      karaoke: true,
      uppercase: true,
      highlightColor: '&H0000FF00&',
      style: `
[Script Info]
Title: Hormozi Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,82,&H00FFFFFF&,&H000000FF,&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,3,10,0,2,30,30,700,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    beast: {
      name: 'MrBeast Pop (CapCut)',
      description: 'KAPITAL putih, kata aktif hijau glow — high energy',
      karaoke: true,
      uppercase: true,
      highlightColor: '&H0000FF00&',
      style: `
[Script Info]
Title: MrBeast Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,86,&H00FFFFFF&,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,4,2,50,50,620,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    clean: {
      name: 'Clean Minimal (CapCut)',
      description: 'Putih polos tipis, bawah — aesthetic/vlog',
      style: `
[Script Info]
Title: Clean Minimal Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Segoe UI,74,&H00FFFFFF&,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,0,0,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    modern: {
      name: 'Modern Bold Centered',
      description: 'Tebal putih, centered, glow — default',
      style: `
[Script Info]
Title: Modern Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,76,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    retro: {
      name: 'Retro (Top-Left Yellow)',
      description: 'Kuning, kiri atas, efek vintage 80s',
      style: `
[Script Info]
Title: Retro Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Courier New,68,&H0000FFFF,&H00000000,&H00000000,&H00000000,-1,-1,0,0,100,100,0,0,1,3,2,1,40,40,1500,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    minimal: {
      name: 'Minimal (Bottom White)',
      description: 'Putih polos, bawah center, clean & simple',
      style: `
[Script Info]
Title: Minimal Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Segoe UI,72,&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,0,0,140,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    tegas: {
      name: 'Tegas (All Caps Bold)',
      description: 'Huruf KAPITAL semua, tebal, outline hitam tebal, lower-center — punchy, ga nutupin wajah',
      style: `
[Script Info]
Title: Tegas Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,82,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,40,40,480,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
        boxed: {
      name: 'Boxed Highlight (CapCut Style)',
      description: 'Kotak hitam semi-transparan, kuning highlight kata kunci',
      style: `
[Script Info]
Title: Boxed Highlight Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,72,&H00FFFFFF,&H000000FF,&H00000000,&H88000000,-1,0,0,0,100,100,0,0,3,4,2,2,40,40,150,1
Style: Highlight,Arial Black,72,&H0000FFFF,&H000000FF,&H00000000,&H88000000,-1,0,0,0,100,100,0,0,3,4,2,2,40,40,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    pop: {
      name: 'Pop Bounce (Gen Z Style)',
      description: 'Putih tebal, outline pink, vibe tiktok fyp',
      style: `
[Script Info]
Title: Pop Bounce Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Verdana,76,&H00FFFFFF,&H000000FF,&H00FF2D95,&H00FF2D95,-1,0,0,0,100,100,0,0,1,5,3,2,50,50,160,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    story: {
      name: 'Story Time (Top)',
      description: 'Subtitle di atas, biar caption/desc ga tabrakan',
      style: `
[Script Info]
Title: Story Time Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,2,8,40,40,1400,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    // FIX user: "subtitle tegas, KAPITAL SEMUA, posisi agak tengah-bawah tapi jangan nutupi wajah"
    // MarginV 430 = bawah-tengah safe area reels; Alignment 2 (center-bawah).
    // Nutup wajah? wajah orang duduk podcast ada di 40-55% tinggi (y 760-1050) → 430 dari bawah = y 1490, AMAN.
// Style referensi TikTok user: putih tebal KAPITAL, TANPA box, posisi TENGAH (55-60% tinggi).
// MarginV 800 = ~58% tinggi (dari bawah) — di bawah dagu pembicara, ga nutupi wajah (wajah 40-50%).
// BorderStyle 1 = outline, bukan 3 (box). Outline 3px hitam + shadow 2.
    bold: {
      name: 'Bold Statement (Kapital)',
      description: 'Kapital, tebal putih, tengah bawah, tanpa box — style TikTok',
      uppercase: true,
      // Referensi TikTok: 2-4 kata per baris, 2 baris. WPC 3 = sweet spot.
      wordsPerCue: 3,
      // Referensi TikTok (PWK/GADO, verified 4 screenshot): kata dasar KUNING,
      // KATA TERAKHIR putih + outline hitam tebal (punch).
      highlightColor: '&H00FFFFFF&',
      style: `
[Script Info]
Title: Bold Statement Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,78,&H0000FFFF&,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,800,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
    ttbox: {
      name: 'TikTok Box (Kuning + Kontras)',
      // Style referensi TikTok (PWK/GADO): text KUNING di box hitam tebal,
      // kata terakhir KONTRAS (putih/merah), shadow merah 3D, 1-2 kata/cue.
      // Posisi 45-65% dari atas = MarginV 640-900.
      description: 'Kapital, box kuning, kata akhir kontras — TikTok viral',
      uppercase: true,
      wordsPerCue: 2,
      highlightColor: '&H00FFFFFF&',
      style: `
[Script Info]
Title: TikTok Box Subtitle
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,74,&H0000FFFF&,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,8,3,2,20,20,760,1
Style: Alt,Arial Black,74,&H00FFFFFF&,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,8,3,2,20,20,760,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`,
    },
  };
  return templates[name] || templates.modern;
}

function listTemplates() {
  const names = ['karaoke', 'hormozi', 'beast', 'clean', 'bold', 'ttbox', 'modern', 'retro', 'minimal', 'boxed', 'pop', 'story', 'tegas'];
  return names.map(name => {
    const t = getTemplate(name);
    return { name, title: t.name, description: t.description, karaoke: t.karaoke === true };
  });
}

// Caption presets gaya CapCut/Submagic (port style dari mehbul/chopify, MIT)
// Warna ASS format &HAABBGGRR. Highlight = kata aktif di-highlight warna cerah.
const CAPTION_STYLES = {
  modern:   { font: 'Arial Black', weight: -1, highlight: '&H00FFFF&' }, // kuning
  hormozi:  { font: 'Arial Black', weight: -1, highlight: '&H0000FF&' }, // merah
  mrbeast:  { font: 'Arial Black', weight: -1, highlight: '&H00FF00&' }, // hijau
  podcast:  { font: 'Arial',       weight: 1,  highlight: '&H0000FF&' }, // merah, regular
};

function listCaptionStyles() {
  return Object.keys(CAPTION_STYLES).map((id) => ({
    id,
    name: { modern: 'Modern', hormozi: 'Hormozi', mrbeast: 'MrBeast', podcast: 'Podcast' }[id] || id,
    desc: {
      modern: 'Highlight kuning, bold — clean & punchy',
      hormozi: 'Highlight merah, gaya Alex Hormozi',
      mrbeast: 'Highlight hijau, high energy',
      podcast: 'Regular weight, subtle — cocok interview',
    }[id] || '',
  }));
}

module.exports = { getTemplate, listTemplates, CAPTION_STYLES, listCaptionStyles };
