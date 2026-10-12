"use client";

import { useState, useEffect } from "react";
import { createJob, createUploadJob, getJob, type JobMeta, type JobOptions } from "@/lib/api";
import { ClipCard } from "@/components/ClipCard";
import { ProgressBar } from "@/components/ProgressBar";
import { Hero } from "@/components/Hero";
import SegmentPicker from "@/components/SegmentPicker";


export default function Home() {
  const [mode, setMode] = useState<"youtube" | "upload">("youtube");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [brief, setBrief] = useState("");
  const [segOpen, setSegOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refId, setRefId] = useState<string | null>(null);
  const [subTpl, setSubTpl] = useState("karaoke");
  const [fmtMode, setFmtMode] = useState<"auto" | "custom">("auto");
  const [customFmt, setCustomFmt] = useState<"9:16" | "9:16_fill" | "9:16_split" | "16:9" | "16:9_fill">("9:16_fill");

  // ponytail: jobId cuma di React state → refresh halaman = hasil clip hilang.
  // Persist ke localStorage; restore + re-fetch job saat mount. Backend tetap
  // source of truth (job ga akan pernah hilang dari metadata.json).
  const KEY = "ytac:jobId";
  const [jobId, setJobIdState] = useState<string | null>(null);
  const [job, setJob] = useState<JobMeta | null>(null);
  const setJobId = (id: string | null) => {
    setJobIdState(id);
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch { /* private mode / storage diblokir: fallback ke state doang */ }
  };
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let id: string | null = null;
    try { id = localStorage.getItem(KEY); } catch { id = null; }
    if (!id) return;
    setRestoring(true);
    getJob(id)
      .then((meta) => { setJobIdState(id); setJob(meta); })
      .catch(() => { try { localStorage.removeItem(KEY); } catch {} })
      .finally(() => setRestoring(false));
  }, []);


  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setJob(null);
    if (mode === "youtube" && !url.trim()) return setError("Masukkan URL YouTube dulu!");
    if (mode === "upload" && !file) return setError("Pilih file video dulu!");
    setLoading(true);
    try {
      const opts: Partial<JobOptions> = { clipCount: 5, formats: [fmtMode === "custom" ? customFmt : "9:16"], formatMode: fmtMode, subtitleLang: "id", includeSubtitles: true, subtitleTemplate: subTpl, refId };
      const res = mode === "upload"
        ? await createUploadJob({ file: file!, brief: brief.trim() || undefined, options: opts })
        : await createJob({ url: url.trim(), brief: brief.trim() || undefined, options: opts });
      setJobId(res.jobId);
      poll(res.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal buat job");
    } finally {
      setLoading(false);
    }
  }

  function poll(id: string) {
    // ponytail: progress HANYA NAIK. Polling paralel/late-response bisa kasih
    // metadata versi LAMA (progress 78 abis render c1, terus dapet 55 dari
    // request yang lemot) → bar mundur (user 2026-10-03: "progress sering
    // maju mundur"). Simpan high-water mark, tolak update yg turun.
    let lastProgress = 0;
    const timer = setInterval(async () => {
      try {
        const meta = await getJob(id);
        if (typeof meta.progress === "number" && meta.progress < lastProgress) {
          return;  // response lama, buang
        }
        if (typeof meta.progress === "number") lastProgress = meta.progress;
        setJob(meta);
        if (meta.status === "done" || meta.status === "failed") clearInterval(timer);
      } catch {
        clearInterval(timer);
      }
    }, 1500);
  }

  const busy = !!job && !["done", "failed"].includes(job.status);

  // Job terakhir ke-restore pas refresh; kasih jalan buat mulai job baru
  // tanpa harus nunggu restore selesai.
  const resetJob = () => {
    setJobId(null);
    setJob(null);
  };

  // Template CapCut populer buat clipping. Preview video 4s lewat /api/subtitle-preview/:id.
  const SUB_TEMPLATES = [
    { id: "karaoke", name: "Karaoke Kuning", desc: "Kata aktif nyala kuning" },
    { id: "hormozi", name: "Hormozi Box", desc: "Box hitam + kata hijau" },
    { id: "beast", name: "MrBeast Pop", desc: "Kapital, glow hijau" },
    { id: "clean", name: "Clean Minimal", desc: "Putih polos, tipis" },
    { id: "bold", name: "Bold Kuning", desc: "TikTok PWK style" },
    { id: "ttbox", name: "TikTok Box", desc: "Box kuning kontras" },
  ];

  return (
    <main className="min-h-screen pb-24">
      <Hero />
      {restoring && (
        <div className="max-w-3xl mx-auto px-4 mb-3 text-center text-sm text-zinc-400">
          Mengambil clip terakhir…
        </div>
      )}

      {/* Input section */}
      <section className="max-w-3xl mx-auto px-4 -mt-10 relative z-10" id="generate">
        <form onSubmit={handleGenerate} className="glass rounded-3xl p-6 md:p-8 space-y-5 glow">
          {/* Mode toggle: YouTube vs Upload */}
          <div className="flex gap-2 bg-ink-2/60 border border-edge rounded-2xl p-1.5">
            {(["youtube", "upload"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(null); }}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition ${
                  mode === m ? "bg-brand/20 text-white border border-brand/50" : "text-zinc-400 hover:text-white"
                }`}
              >
                {m === "youtube" ? "🔗 Link YouTube" : "📁 Upload Video"}
              </button>
            ))}
          </div>

          {mode === "youtube" ? (
            <div>
              <label className="text-sm font-medium text-zinc-400 block mb-2">Link Video YouTube</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                className="w-full bg-ink-2/80 border border-edge rounded-2xl px-4 py-3.5 text-base outline-none focus:border-brand placeholder:text-zinc-600 transition"
              />
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium text-zinc-400 block mb-2">
                File Video <span className="text-zinc-600">(mp4 / webm / mkv / mov — maks 1GB)</span>
              </label>
              <label className="flex flex-col items-center justify-center gap-2 w-full bg-ink-2/80 border-2 border-dashed border-edge rounded-2xl px-4 py-8 cursor-pointer hover:border-brand/60 transition">
                <span className="text-3xl">🎬</span>
                {file ? (
                  <span className="text-sm text-white font-medium">{file.name}</span>
                ) : (
                  <span className="text-sm text-zinc-400">Klik untuk pilih file, atau drag & drop di sini</span>
                )}
                {file && (
                  <span className="text-xs text-zinc-500">{(file.size / (1024 * 1024)).toFixed(1)} MB</span>
                )}
                <input
                  type="file"
                  accept="video/*,.mp4,.webm,.mkv,.mov,.avi"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-zinc-400 block mb-2">
              Brief / Instruksi (opsional)
            </label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Contoh: fokus momen lucu + insight bisnis, buang bagian basa-basi"
              rows={3}
              className="w-full bg-ink-2/80 border border-edge rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand placeholder:text-zinc-600 transition resize-none"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-zinc-400 block mb-2">Template Subtitle</label>
            <p className="text-xs text-zinc-500 px-1 py-1">Klik template untuk lihat preview video 4 detik. Karaoke = kata aktif nyala warna.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mt-2">
              {SUB_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSubTpl(t.id)}
                  className={`relative rounded-xl overflow-hidden border-2 transition aspect-[9/16] ${
                    subTpl === t.id ? "border-brand shadow-lg shadow-brand/30" : "border-edge hover:border-zinc-600"
                  }`}
                >
                  <video
                    src={`${process.env.NEXT_PUBLIC_API_URL || ""}/api/subtitle-preview/${t.id}`}
                    muted
                    loop
                    playsInline
                    autoPlay
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 to-transparent px-2 py-3 text-left">
                    <span className="block text-[11px] font-bold text-white leading-tight">{t.name}</span>
                    <span className="block text-[9px] text-zinc-300 leading-tight">{t.desc}</span>
                  </span>
                  {subTpl === t.id && (
                    <span className="absolute top-1.5 right-1.5 z-10 text-[10px] font-black bg-brand text-white rounded-full px-2 py-0.5">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-zinc-400 block mb-2">Durasi clip</label>
            <p className="text-xs text-zinc-500 px-1 py-2">Otomatis — mengikuti topik yang dibahas, selesai saat topik kelar (5-90s)</p>
          </div>

          <div>
            <label className="text-sm font-medium text-zinc-400 block mb-2">Format video</label>
            <div className="flex gap-2 bg-ink-2/60 border border-edge rounded-2xl p-1.5 mb-2">
              {(["auto", "custom"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setFmtMode(m)}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold transition ${
                    fmtMode === m ? "bg-brand/20 text-white border border-brand/50" : "text-zinc-400 hover:text-white"
                  }`}
                >
                  {m === "auto" ? "🤖 Auto (AI pilih)" : "🎯 Custom"}
                </button>
              ))}
            </div>
            {fmtMode === "auto" ? (
              <p className="text-xs text-zinc-500 px-1 py-1">
                AI analisis tiap clip: podcast/talking-head → crop 9:16 ke wajah; entertainment/kamera gerak/music video → video gede band 79% + background blur tipis (gaya TikTok). Semua untuk TikTok/Reels/Shorts.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                {([
                  { id: "9:16", name: "Crop Wajah", desc: "Fokus speaker (tracking)" },
                  { id: "9:16_fill", name: "Band + Blur", desc: "9:16 band, auto-split" },
                  { id: "9:16_split", name: "2 Kolom", desc: "Force split panel" },
                                    { id: "16:9_fill", name: "Landscape TikTok", desc: "Video utuh + blur atas-bawah" },
                                    { id: "16:9", name: "16:9 YouTube", desc: "Full HD landscape" },
                ] as const).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setCustomFmt(f.id)}
                    className={`rounded-xl border-2 px-3 py-2.5 text-left transition ${
                      customFmt === f.id ? "border-brand bg-brand/10" : "border-edge hover:border-zinc-600"
                    }`}
                  >
                    <span className="block text-sm font-bold text-white">{f.name}</span>
                    <span className="block text-[11px] text-zinc-400">{f.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-zinc-400 block mb-2">
              Reference Video (opsional) — AI belajar gaya editing dari video ini
            </label>
            <label className="flex items-center gap-3 w-full bg-ink-2/80 border border-edge rounded-2xl px-4 py-3 cursor-pointer hover:border-brand/60 transition">
              <span className="text-xl">🎨</span>
              {refFile ? (
                <span className="text-sm text-white">{refFile.name}</span>
              ) : (
                <span className="text-sm text-zinc-400">Upload video referensi</span>
              )}
              <input
                type="file"
                accept="video/*,.mp4,.webm,.mkv"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setRefFile(f);
                  try {
                    const fd = new FormData();
                    fd.append("video", f);
                    const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
                    const res = await fetch(`${apiUrl}/api/references/upload`, { method: "POST", body: fd });
                    const data = await res.json();
                    if (res.ok) setRefId(data.refId);
                  } catch (err) {
                    console.error("Upload reference gagal:", err);
                  }
                }}
              />
            </label>
          </div>

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || busy || (!url.trim() && !file)}
            className="w-full py-4 rounded-2xl font-semibold text-base bg-gradient-to-r from-brand to-brand-2 text-white hover:opacity-90 active:scale-[0.99] transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading || busy ? (job?.status === "queued" ? "Mengantre..." : "Memproses...") : "⚡ Generate Clips"}
          </button>
        </form>
      </section>

      {/* Progress / Results */}
      {job && (
        <section className="max-w-5xl mx-auto px-4 mt-12 space-y-6">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wider text-zinc-500">
              {job.status === "done" ? "Clip tersimpan" : "Job berjalan"} · tidak hilang saat refresh
            </span>
            <button
              onClick={resetJob}
              className="text-xs text-zinc-400 hover:text-white border border-edge rounded-lg px-3 py-1.5 hover:border-zinc-500 transition"
            >
              ＋ Job baru
            </button>
          </div>
          <ProgressBar job={job} />

          {job.error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              {job.error}
            </p>
          )}

          {job.videoInfo && (
            <div className="glass rounded-2xl px-5 py-4 flex flex-wrap items-center gap-4 text-sm">
              <span className="font-semibold text-white">{job.videoInfo.title}</span>
              <span className="text-zinc-500">
                {Math.floor((job.videoInfo.duration ?? 0) / 60)} menit · {job.url}
              </span>
            </div>
          )}

          {job.status === "done" && (
            <button
              onClick={() => setSegOpen(true)}
              className="mb-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-500/15 border border-violet-400/40 text-violet-300 text-sm font-semibold hover:bg-violet-500/25 transition"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-none stroke-current" strokeWidth="2">
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
                <circle cx="12" cy="12" r="3.2" />
              </svg>
              Pilih momen viral
            </button>
          )}

          {job.clips.length > 0 && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {job.clips.map((clip) => (
                <ClipCard key={clip.id} job={job} clip={clip} />
              ))}
            </div>
          )}
        </section>
      )}


      <SegmentPicker
        jobId={job?.jobId ?? null}
        open={segOpen}
        onClose={() => setSegOpen(false)}
        onPick={async (c) => {
          if (!job) return;
          setSegOpen(false);
          setRendering(true);
          setError("");
          try {
            const r = await fetch(
              `${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/jobs/${job.jobId}/render-clip`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  start: c.start,
                  end: c.end,
                  format: "9:16",
                  subtitleTemplate: subTpl,
                }),
              }
            );
            const d = await r.json();
            if (!r.ok || !d.success) throw new Error(d.error || "render gagal");
            // refresh job
            const j = await getJob(job.jobId);
            setJob(j);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal render segmen");
          } finally {
            setRendering(false);
          }
        }}
      />

      {rendering && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3.5 bg-[#1a1a24] border border-violet-400/40 rounded-2xl shadow-2xl shadow-violet-500/10">
          <div className="w-4 h-4 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
          <span className="text-sm text-violet-200 font-medium">Render clip… (face tracking)</span>
        </div>
      )}
    </main>
  );
}