"use client";

import { memo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type Clip,
  type JobMeta,
  streamUrl,
  thumbUrl,
  downloadUrl,
  fmtTime,
  tierColor,
} from "@/lib/api";

function ClipCardInner({ job, clip }: { job: JobMeta; clip: Clip }) {
  const [playing, setPlaying] = useState(false);
  const [noThumb, setNoThumb] = useState(false);
  const router = useRouter();
  const fmt: (typeof job.options.formats)[number] =
    job.options.formats[0] ?? "9:16";
  const src = streamUrl(job.jobId, clip.id, fmt);
  const thumb = thumbUrl(job.jobId, clip.id, fmt);
  const clipDuration = (clip.end ?? clip.start + (job.options.targetDuration ?? 30)) - clip.start;
  const isPortrait = fmt.startsWith("9:16");
  const ts = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60), h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };

  return (
    <div className="glass rounded-2xl overflow-hidden group hover:border-zinc-500/60 transition">
      <div className={`relative ${isPortrait ? "aspect-[9/16]" : "aspect-video"} bg-ink-2 overflow-hidden`}>
        {playing ? (
          <video
            key={src}
            src={src}
            controls
            autoPlay
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <button
            onClick={() => setPlaying(true)}
            className="absolute inset-0 flex items-center justify-center hover:bg-black/30 transition"
            aria-label="Putar preview"
          >
            {!noThumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumb}
                alt={clip.title || "clip cover"}
                onError={() => setNoThumb(true)}
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <video
                src={`${src}#t=1`}
                preload="metadata"
                muted
                playsInline
                className="absolute inset-0 w-full h-full object-contain bg-black pointer-events-none"
              />
            )}
            <span className="relative z-10 w-14 h-14 rounded-full bg-white/10 border border-white/20 backdrop-blur flex items-center justify-center group-hover:scale-110 transition">
              <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
            <span className="absolute bottom-2 left-2 z-10 px-2 py-0.5 rounded-md bg-black/70 text-[11px] font-mono">
              {fmtTime(clip.start)} – {fmtTime(clip.end ?? clip.start + (job.options.targetDuration ?? 30))}
            </span>
          </button>
        )}
        {/* tier badge */}
        {clip.tier && (
          <span className={`absolute top-2 right-2 px-2 py-0.5 rounded-lg text-xs font-bold border ${tierColor(clip.tier)}`}>
            Tier {clip.tier}
          </span>
        )}
        {/* score */}
        {typeof clip.score === "number" && (
          <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/70 text-[11px] font-bold text-emerald-400">
            ⚡ {clip.score}
          </span>
        )}
      </div>

      <div className="p-4 space-y-3">
        {clip.title && <h3 className="font-semibold leading-snug">{clip.title}</h3>}
        {/* Timestamp dari source video */}
        <p className="text-xs text-zinc-600">
          📹 {ts(clip.start)} – {ts(clip.end ?? clip.start + (job.options.targetDuration ?? 30))} 
          ({Math.round((clip.end ?? clip.start + (job.options.targetDuration ?? 30)) - clip.start)}s)
        </p>
        {clip.reason && (
          <p className="text-sm text-zinc-500 leading-relaxed whitespace-pre-line">{clip.reason}</p>
        )}
        {clip.hookLabel && (
          <span className="inline-block text-[11px] px-2 py-0.5 rounded-full bg-brand/10 border border-brand/30 text-brand-2">
            {clip.hookLabel}
          </span>
        )}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button
            onClick={() => router.push(`/editor/${job.jobId}/${clip.id}`)}
            className="px-3 py-2.5 rounded-xl text-sm font-semibold bg-zinc-800 hover:bg-zinc-700 transition flex-1"
          >
            ✏️ Edit
          </button>
          <a
            href={downloadUrl(job.jobId, clip.id, fmt)}
            className="flex-1 text-center py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-brand to-brand-2 hover:opacity-90 transition"
          >
            Download
          </a>
        </div>
      </div>
    </div>
  );
}

export const ClipCard = memo(ClipCardInner);