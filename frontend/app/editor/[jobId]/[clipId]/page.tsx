"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { getJob, streamUrl, type JobMeta, type Clip, type ClipFormat } from "@/lib/api";

type Tool = "select" | "split" | "text" | "sticker" | "media" | "filter" | "speed" | "volume" | "subtitle";

interface TextLayer {
  id: string;
  text: string;
  start: number;
  end: number;
  y: number; // 0-1 vertikal, relatif ke video
  size: number;
  color: string;
  bold: boolean;
  template?: string; // nama template subtitle
}

interface MediaLayer {
  id: string;
  src: string;
  kind: "image" | "video";
  start: number;
  end: number;
  y: number;
  x: number;
  scale: number;
}

export default function EditorPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.jobId as string;
  const clipId = params.clipId as string;

  const [job, setJob] = useState<JobMeta | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [loading, setLoading] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [splitPoint, setSplitPoint] = useState<number | null>(null);
  const [texts, setTexts] = useState<TextLayer[]>([]);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [volume, setVolume] = useState(100);
  const [speed, setSpeed] = useState(1);
  const [saving, setSaving] = useState(false);
  const [cssFilter, setCssFilter] = useState("");
  const [stickerPacks, setStickerPacks] = useState<{ id: string; name: string; stickers: string[] }[]>([]);
  const [stickerPack, setStickerPack] = useState("basic");
  const [mediaFiles, setMediaFiles] = useState<string[]>([]);
  const [mediaLayers, setMediaLayers] = useState<MediaLayer[]>([]);
  const [subtitleTemplate, setSubtitleTemplate] = useState("modern");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fmt = (clip?.files ? (Object.keys(clip.files)[0] as ClipFormat) : "9:16") as ClipFormat;

  useEffect(() => {
    getJob(jobId).then((j) => {
      setJob(j);
      const c = j.clips.find((x) => x.id === clipId) ?? null;
      setClip(c);
      setDuration((c?.end ?? 30) - (c?.start ?? 0));
      setLoading(false);
    });
    // fetch sticker packs
    const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4010";
    fetch(`${API}/api/media/stickers`)
      .then((r) => r.json())
      .then((d) => setStickerPacks(d.packs || []))
      .catch(() => {});
    // fetch media library
    fetch(`${API}/api/jobs/${jobId}/media`)
      .then((r) => r.json())
      .then((d) => setMediaFiles(d.files || []))
      .catch(() => {});
  }, [jobId, clipId]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onDur = () => { if (v.duration) setDuration(v.duration); };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onDur);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onDur);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [clip]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, duration || v.duration || 0));
    setCurrentTime(v.currentTime);
  }, [duration]);

  const handleSplit = useCallback(() => {
    if (currentTime <= 0.5 || currentTime >= duration - 0.5) return;
    setSplitPoint(currentTime);
  }, [currentTime, duration]);

  const addText = useCallback(() => {
    const id = `txt${Date.now()}`;
    setTexts((prev) => [...prev, {
      id, text: "Teks Baru",
      start: Math.min(currentTime, Math.max(0.5, duration - 2)),
      end: Math.min(currentTime + 2.5, duration),
      y: 0.72, size: 44, color: "#FFFFFF", bold: true,
    }]);
    setSelectedText(id);
  }, [currentTime, duration]);

  const updateText = useCallback((id: string, patch: Partial<TextLayer>) => {
    setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const deleteText = useCallback((id: string) => {
    setTexts((prev) => prev.filter((t) => t.id !== id));
    setSelectedText(null);
  }, []);

  const onTextPointerDown = (e: React.PointerEvent, t: TextLayer) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedText(t.id);
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const y = (ev.clientY - rect.top) / rect.height;
      updateText(t.id, { y: Math.max(0.06, Math.min(0.94, y)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onTimelinePointerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLDivElement;
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      seek(pct * duration);
    };
    move(e.nativeEvent as PointerEvent);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const applyVolume = (val: number) => {
    setVolume(val);
    if (videoRef.current) videoRef.current.volume = Math.min(1, val / 100);
  };

  const applySpeed = (val: number) => {
    setSpeed(val);
    if (videoRef.current) videoRef.current.playbackRate = val;
  };

  const addMediaLayer = (filename: string, kind: "image" | "video") => {
    const id = `media${Date.now()}`;
    setMediaLayers((prev) => [...prev, {
      id, src: filename, kind,
      start: currentTime, end: Math.min(currentTime + 4, duration),
      y: 0.35, x: 0.5, scale: 0.3,
    }]);
  };

  const uploadMedia = async (file: File) => {
    const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4010";
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(`${API}/api/jobs/${jobId}/media`, { method: "POST", body: fd });
      const d = await r.json();
      if (d.files?.length) {
        setMediaFiles((prev) => [...new Set([...prev, ...d.files])]);
        const f = d.files[0];
        addMediaLayer(f, /\.(mp4|mov|webm)$/i.test(f) ? "video" : "image");
      }
    } catch (e) {
      alert("Upload gagal: " + (e as Error).message);
    }
  };

  const saveEdits = async () => {
    setSaving(true);
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4010"}/api/jobs/${jobId}/clips/${clipId}/edit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            splitAt: splitPoint,
            texts, mediaLayers, volume, speed,
            subtitleTemplate,
            start: clip?.start, end: clip?.end,
          }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.taskId) router.push(`/?job=${data.taskId}`);
    } catch (e) {
      alert("Gagal simpan: " + (e as Error).message);
    }
    setSaving(false);
  };

  if (loading) return <div className="h-screen bg-black flex items-center justify-center text-zinc-500">Loading editor…</div>;
  if (!clip) return (
    <div className="h-screen bg-black flex items-center justify-center text-zinc-500">
      Clip tidak ditemukan. <button onClick={() => router.push("/")} className="ml-2 underline">Kembali</button>
    </div>
  );

  const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const activeText = texts.find((t) => t.id === selectedText) || null;
  const hasPanel = activeText || splitPoint !== null || tool !== "select";

  const TOOLS: { id: Tool; label: string; svg: string }[] = [
    { id: "select", label: "Pilih", svg: "M3 3l7.5 18 2.6-7.4L20.5 11z" },
    { id: "split", label: "Split", svg: "M6 3v18M18 3v18M6 12h12" },
    { id: "text", label: "Teks", svg: "M4 6h16M8 6v12M16 6v12M6 18h12" },
    { id: "sticker", label: "Stiker", svg: "M12 3a9 9 0 100 18 9 9 0 000-18zM9 10h.01M15 10h.01M8.5 14.5c2 2 5 2 7 0" },
    { id: "media", label: "Media", svg: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" },
    { id: "subtitle", label: "Sub", svg: "M4 6h16v12H4zM7 12h4M13 12h4" },
    { id: "filter", label: "Filter", svg: "M4 5h16l-6 8v6l-4-2v-4z" },
    { id: "speed", label: "Speed", svg: "M13 5l7 7-7 7M5 5l7 7-7 7" },
    { id: "volume", label: "Volume", svg: "M4 9v6h4l5 4V5L8 9H4z" },
  ];

  const SUBTITLE_TEMPLATES = [
    { id: "modern", name: "Modern", desc: "Bold putih, glow" },
    { id: "pop", name: "Pop Bounce", desc: "Outline pink, gen-z" },
    { id: "boxed", name: "Boxed", desc: "Kotak highlight" },
    { id: "retro", name: "Retro", desc: "Kuning, kiri atas" },
    { id: "minimal", name: "Minimal", desc: "Putih polos" },
    { id: "story", name: "Story Top", desc: "Subtitle di atas" },
  ];

  return (
    <div className="h-screen bg-[#0b0b0f] text-white flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="h-12 border-b border-white/10 flex items-center px-4 gap-3 shrink-0 bg-[#101015]">
        <button onClick={() => router.push("/")} className="text-zinc-400 hover:text-white text-sm flex items-center gap-1.5 transition">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Keluar
        </button>
        <div className="h-4 w-px bg-white/10" />
        <span className="text-sm font-medium truncate max-w-[40vw]">{clip.title || clipId}</span>
        <div className="flex-1" />
        <span className="text-[11px] font-mono text-zinc-500 tabular-nums">{fmtT(currentTime)} / {fmtT(duration)}</span>
        <button
          onClick={saveEdits}
          disabled={saving}
          className="px-5 py-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-sm font-bold hover:opacity-90 disabled:opacity-50 transition shadow-lg shadow-violet-500/20"
        >
          {saving ? "Rendering…" : "Export"}
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Tool rail */}
        <div className="w-[68px] border-r border-white/10 flex flex-col items-center py-4 gap-2 shrink-0 bg-[#101015]">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                if (t.id === "split") handleSplit();
                else if (t.id === "text") addText();
                else setTool(t.id);
              }}
              className={`w-14 h-14 rounded-2xl flex flex-col items-center justify-center gap-1 text-[10px] transition ${
                tool === t.id
                  ? "bg-white/15 text-white shadow-inner"
                  : "text-zinc-500 hover:bg-white/5 hover:text-white"
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d={t.svg} />
              </svg>
              {t.label}
            </button>
          ))}
        </div>

        {/* Stage */}
        <div className="flex-1 flex items-center justify-center min-w-0 p-6 bg-[radial-gradient(ellipse_at_center,#14141b_0%,#0b0b0f_70%)]">
          <div
            ref={stageRef}
            className="relative h-full flex items-center justify-center"
            style={{ aspectRatio: fmt === "9:16" ? "9 / 16" : fmt === "1:1" ? "1 / 1" : "16 / 9", maxHeight: "100%" }}
          >
            <video
              ref={videoRef}
              src={streamUrl(jobId, clipId, fmt)}
              className="absolute inset-0 w-full h-full object-contain rounded-xl"
              onClick={togglePlay}
              onPointerDown={(e) => { if (e.target === e.currentTarget) setSelectedText(null); }}
              playsInline
              style={{ filter: cssFilter || undefined }}
            />
            {/* text overlays — posisi relatif ke stage ( = area video ) */}
            {texts.map((t) => {
              const active = currentTime >= t.start && currentTime <= t.end;
              if (!active) return null;
              return (
                <div
                  key={t.id}
                  onPointerDown={(e) => onTextPointerDown(e, t)}
                  className={`absolute left-1/2 px-2 py-0.5 rounded cursor-move select-none touch-none transition-shadow ${
                    selectedText === t.id ? "ring-2 ring-sky-400/80 shadow-lg" : ""
                  }`}
                  style={{
                    top: `${t.y * 100}%`,
                    transform: "translate(-50%, -50%)",
                    fontSize: `clamp(12px, ${t.size * 0.55}px, ${t.size}px)`,
                    color: t.color,
                    fontWeight: t.bold ? 800 : 400,
                    textShadow: "0 2px 10px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,1)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.text}
                </div>
              );
            })}
            {/* media overlays (foto/video upload) */}
            {mediaLayers.map((m) => {
              const active = currentTime >= m.start && currentTime <= m.end;
              if (!active) return null;
              const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4010";
              return (
                <div
                  key={m.id}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    // drag media untuk pindah posisi
                    const stage = stageRef.current;
                    if (!stage) return;
                    const rect = stage.getBoundingClientRect();
                    const move = (ev: PointerEvent) => {
                      setMediaLayers((prev) => prev.map((x) => x.id === m.id ? {
                        ...x,
                        x: Math.max(0.05, Math.min(0.95, (ev.clientX - rect.left) / rect.width)),
                        y: Math.max(0.05, Math.min(0.95, (ev.clientY - rect.top) / rect.height)),
                      } : x));
                    };
                    const up = () => {
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                  }}
                  className="absolute cursor-move touch-none"
                  style={{
                    left: `${m.x * 100}%`,
                    top: `${m.y * 100}%`,
                    transform: "translate(-50%, -50%)",
                    width: `${m.scale * 100}%`,
                  }}
                >
                  {m.kind === "video" ? (
                    <video src={`${API}/api/jobs/${jobId}/media/${m.src}`} className="w-full rounded-lg" autoPlay loop muted playsInline />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${API}/api/jobs/${jobId}/media/${m.src}`} alt={m.src} className="w-full rounded-lg object-contain" />
                  )}
                </div>
              );
            })}
            {/* play overlay — ring saja, ga nutupin drag teks */}
            {!isPlaying && (
              <button
                onClick={togglePlay}
                className="absolute inset-0 flex items-center justify-center z-20 rounded-xl"
                style={{ pointerEvents: "none" }}
                aria-label="Play"
              >
                <div className="w-16 h-16 rounded-full bg-black/50 border border-white/25 backdrop-blur-sm flex items-center justify-center">
                  <div className="ml-1.5 w-0 h-0 border-t-[13px] border-t-transparent border-l-[22px] border-l-white border-b-[13px] border-b-transparent drop-shadow" />
                </div>
              </button>
            )}
          </div>
        </div>

        {/* Property panel */}
        <div className="w-72 border-l border-white/10 overflow-y-auto shrink-0 p-5 space-y-5 bg-[#101015]">
          {activeText && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Edit Teks</div>
                <button onClick={() => deleteText(activeText.id)} className="text-xs text-red-400 hover:text-red-300 transition">Hapus</button>
              </div>
              <textarea
                value={activeText.text}
                onChange={(e) => updateText(activeText.id, { text: e.target.value })}
                className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-sm outline-none focus:border-violet-400 resize-none transition"
                rows={2}
              />
              <div className="space-y-1">
                <label className="text-[10px] text-zinc-500 flex justify-between"><span>Ukuran</span><span>{activeText.size}px</span></label>
                <input
                  type="range" min="16" max="96" value={activeText.size}
                  onChange={(e) => updateText(activeText.id, { size: +e.target.value })}
                  className="w-full accent-violet-500"
                />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-[10px] text-zinc-500">Warna</label>
                <input
                  type="color" value={activeText.color}
                  onChange={(e) => updateText(activeText.id, { color: e.target.value })}
                  className="w-10 h-8 bg-transparent border border-white/10 rounded cursor-pointer"
                />
                <button
                  onClick={() => updateText(activeText.id, { bold: !activeText.bold })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${activeText.bold ? "bg-white text-black" : "bg-white/5 text-zinc-400 hover:text-white"}`}
                >
                  Bold
                </button>
              </div>
              <div className="text-[10px] text-zinc-600">Drag teks di preview untuk pindah posisi.</div>
              <div className="flex items-center justify-between pt-1 border-t border-white/5">
                <span className="text-[10px] text-zinc-500">Template:</span>
                <button
                  onClick={() => setTool("subtitle")}
                  className="text-[10px] text-violet-400 hover:text-violet-300 underline"
                >
                  {SUBTITLE_TEMPLATES.find((t) => t.id === subtitleTemplate)?.name || "modern"} →
                </button>
              </div>
            </div>
          )}

          {splitPoint !== null && (
            <div className="space-y-2">
              <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Split Point</div>
              <div className="text-sm bg-amber-400/10 border border-amber-400/30 rounded-xl px-3 py-2">
                Potong di <span className="font-mono text-amber-300">{fmtT(splitPoint)}</span>
              </div>
              <button onClick={() => setSplitPoint(null)} className="text-xs text-zinc-500 hover:text-white transition">
                Hapus split
              </button>
            </div>
          )}

          {tool === "volume" && (
            <div className="space-y-2">
              <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Volume</div>
              <input type="range" min="0" max="200" value={volume} onChange={(e) => applyVolume(+e.target.value)} className="w-full accent-violet-500" />
              <div className="text-sm font-mono text-zinc-300">{volume}%</div>
            </div>
          )}

          {tool === "speed" && (
            <div className="space-y-3">
              <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Kecepatan</div>
              <div className="grid grid-cols-4 gap-2">
                {[0.5, 1, 1.5, 2].map((s) => (
                  <button
                    key={s}
                    onClick={() => applySpeed(s)}
                    className={`py-2 rounded-lg text-xs transition ${speed === s ? "bg-violet-500 text-white font-bold" : "bg-white/5 text-zinc-400 hover:text-white"}`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          )}

          {tool === "filter" && (
            <div className="space-y-3">
              <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Filter</div>
              <div className="grid grid-cols-2 gap-2">
                {[["", "Normal"], ["grayscale(1)", "B&W"], ["sepia(0.7)", "Vintage"], ["contrast(1.35) saturate(1.2)", "Pop"], ["saturate(1.6)", "Vivid"], ["brightness(1.15) contrast(0.95)", "Soft"]].map(([f, name]) => (
                  <button
                    key={name}
                    onClick={() => setCssFilter(f)}
                    className={`py-2.5 rounded-lg text-xs transition ${cssFilter === f ? "bg-violet-500 text-white font-bold" : "bg-white/5 text-zinc-300 hover:bg-white/10"}`}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-zinc-600">Preview real-time. Saat export, filter diterapkan via FFmpeg.</div>
            </div>
          )}

          {tool === "sticker" && (
            <div className="space-y-3">
              <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Stiker</div>
              <div className="flex flex-wrap gap-1.5">
                {stickerPacks.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setStickerPack(p.id)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] transition ${stickerPack === p.id ? "bg-violet-500 text-white font-bold" : "bg-white/5 text-zinc-400 hover:text-white"}`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-4 gap-2">
                {(stickerPacks.find((p) => p.id === stickerPack)?.stickers || ["😀","🔥","💯"]).map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      const id = `txt${Date.now()}`;
                      setTexts((prev) => [...prev, {
                        id, text: s,
                        start: currentTime, end: Math.min(currentTime + 3, duration),
                        y: 0.3, size: 72, color: "#FFFFFF", bold: false,
                      }]);
                      setSelectedText(id);
                    }}
                    className="text-2xl p-2 rounded-xl hover:bg-white/10 transition"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {tool === "media" && (
            <div className="space-y-3">
              <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Foto / Video / GIF</div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-6 rounded-xl border border-dashed border-white/20 text-zinc-400 hover:text-white hover:border-white/40 transition text-sm"
              >
                + Upload Media
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadMedia(f);
                  e.target.value = "";
                }}
              />
              {mediaFiles.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {mediaFiles.map((f) => {
                    const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4010";
                    const isVid = /\.(mp4|mov|webm)$/i.test(f);
                    return (
                      <button
                        key={f}
                        onClick={() => addMediaLayer(f, isVid ? "video" : "image")}
                        className="aspect-square rounded-lg overflow-hidden border border-white/10 hover:border-violet-400 transition relative bg-white/5"
                      >
                        {isVid ? (
                          <span className="absolute inset-0 flex items-center justify-center text-[9px] text-zinc-400">▶ {f.slice(0, 10)}</span>
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`${API}/api/jobs/${jobId}/media/${f}`} alt={f} className="w-full h-full object-cover" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {mediaFiles.length === 0 && (
                <div className="text-[10px] text-zinc-600">Upload foto/video/GIF, lalu klik untuk tambah ke timeline.</div>
              )}
            </div>
          )}

          {tool === "subtitle" && (
            <div className="space-y-3">
              <div className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Template Subtitle</div>
              <div className="space-y-2">
                {SUBTITLE_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSubtitleTemplate(t.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition ${subtitleTemplate === t.id ? "border-violet-400 bg-violet-500/15" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{t.name}</span>
                      {subtitleTemplate === t.id && (
                        <span className="text-violet-400 text-xs">✓ dipilih</span>
                      )}
                    </div>
                    <div className="text-[10px] text-zinc-500">{t.desc}</div>
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-zinc-600">Template ini dipakai saat Export untuk semua teks overlay.</div>
            </div>
          )}

          {!hasPanel && (
            <div className="space-y-3 text-zinc-600">
              <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">Tips</div>
              <div className="text-xs leading-relaxed space-y-2">
                <div>• Klik timeline untuk seek cepat</div>
                <div>• Posisikan playhead, lalu klik <b className="text-zinc-400">✂ Split</b> untuk tandai potongan</div>
                <div>• Tool <b className="text-zinc-400">Teks</b> menambah overlay yang bisa di-drag</div>
                <div>• Klik <b className="text-zinc-400">Export</b> untuk render semua perubahan</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="h-40 border-t border-white/10 shrink-0 flex flex-col bg-[#101015]">
        <div className="h-10 flex items-center px-4 gap-3 border-b border-white/5">
          <button
            onClick={togglePlay}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition"
          >
            {isPlaying ? (
              <div className="flex gap-1">
                <div className="w-1 h-3.5 bg-white rounded-full" />
                <div className="w-1 h-3.5 bg-white rounded-full" />
              </div>
            ) : (
              <div className="ml-0.5 w-0 h-0 border-t-[7px] border-t-transparent border-l-[11px] border-l-white border-b-[7px] border-b-transparent" />
            )}
          </button>
          <span className="text-[11px] font-mono text-zinc-400 tabular-nums">{fmtT(currentTime)}</span>
          <div className="flex-1" />
          {splitPoint !== null && (
            <span className="text-[11px] text-amber-300 flex items-center gap-1">✂ {fmtT(splitPoint)}</span>
          )}
        </div>
        <div className="flex-1 relative px-4 py-3 select-none">
          {/* video track */}
          <div
            className="absolute left-4 right-4 top-3 h-12 rounded-xl bg-gradient-to-b from-zinc-800 to-zinc-900 border border-white/5 overflow-hidden cursor-pointer"
            onPointerDown={onTimelinePointerDown}
          >
            <div className="absolute inset-0 flex">
              {Array.from({ length: 16 }).map((_, i) => (
                <div key={i} className="flex-1 border-r border-black/40 bg-gradient-to-b from-white/[0.03] to-transparent" />
              ))}
            </div>
            {splitPoint !== null && (
              <div className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-20" style={{ left: `${(splitPoint / duration) * 100}%` }}>
                <div className="absolute -top-1 -left-1.5 w-3.5 h-3.5 rotate-45 bg-amber-400 rounded-sm" />
              </div>
            )}
            <div className="absolute top-0 bottom-0 w-0.5 bg-white z-10 shadow-[0_0_6px_rgba(255,255,255,0.6)]" style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
          </div>
          {/* ruler */}
          <div className="absolute left-4 right-4 bottom-1 h-3 flex justify-between px-0.5">
            {Array.from({ length: 9 }).map((_, i) => (
              <span key={i} className="text-[8px] text-zinc-600 font-mono">
                {fmtT((duration / 8) * i)}
              </span>
            ))}
          </div>
          {/* text track */}
          <div className="absolute left-4 right-4 bottom-6 h-6">
            {texts.map((t) => (
              <div
                key={t.id}
                onPointerDown={(e) => { e.stopPropagation(); setSelectedText(t.id); }}
                className={`absolute h-full rounded-md text-[9px] flex items-center px-2 overflow-hidden whitespace-nowrap cursor-pointer transition ${
                  selectedText === t.id ? "bg-sky-500/70" : "bg-sky-900/40 hover:bg-sky-800/50"
                }`}
                style={{
                  left: `${(t.start / duration) * 100}%`,
                  width: `${Math.max(3, ((t.end - t.start) / duration) * 100)}%`,
                }}
              >
                {t.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
