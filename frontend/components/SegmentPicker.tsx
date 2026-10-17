"use client";

import { useEffect, useState } from "react";
import { getJobSegments } from "@/lib/api";

interface Candidate {
  start: number;
  end: number;
  hook: string;
  overall: number;
  energy?: number;
  tags?: string[];
  label?: string;
}

interface JobSegments {
  candidates: Candidate[];
  totalSegments?: number;
  duration?: number | null;
  note?: string;
}

const TAG_LABEL: Record<string, string> = {
  hook: "Hook",
  shock: "Shock",
  humour: "Lucu",
  controversy: "Hot take",
  insight: "Insight",
  emotion: "Emosi",
};

function scoreColor(s: number) {
  if (s >= 8) return "text-emerald-400";
  if (s >= 6.5) return "text-yellow-400";
  if (s >= 5) return "text-orange-400";
  return "text-text-muted";
}
function scoreBar(s: number) {
  if (s >= 8) return "bg-emerald-500";
  if (s >= 6.5) return "bg-yellow-500";
  if (s >= 5) return "bg-orange-500";
  return "bg-border-light";
}

export default function SegmentPicker({
  jobId,
  open,
  onClose,
  onPick,
}: {
  jobId: string | null;
  open: boolean;
  onClose: () => void;
  onPick: (c: Candidate) => void;
}) {
  const [data, setData] = useState<JobSegments | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !jobId) return;
    setLoading(true);
    setPicked(null);
    getJobSegments(jobId)
      .then((d) => setData(d))
      .catch(() => setData({ candidates: [], note: "Gagal ambil segmen" }))
      .finally(() => setLoading(false));
  }, [open, jobId]);

  if (!open) return null;

  const cands = data?.candidates ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-bg-elevated border border-border rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-bold text-white">Pilih momen viral</h2>
            <p className="text-xs text-text-muted">
              {data?.totalSegments ? `${data.totalSegments} segmen transcript • ` : ""}
              di-score otomatis, pilih yang mau di-render
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-text-muted hover:text-white hover:bg-white/10 transition flex items-center justify-center"
            aria-label="Tutup"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-current" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && (
            <div className="py-12 text-center text-text-muted text-sm">Menganalisis transcript…</div>
          )}
          {!loading && cands.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-text-muted text-sm">
                {data?.note || "Belum ada kandidat. Tunggu sampai transcript selesai."}
              </p>
            </div>
          )}
          {!loading &&
            cands.map((c, i) => {
              const dur = c.end - c.start;
              const selected = picked === i;
              return (
                <button
                  key={i}
                  onClick={() => setPicked(i)}
                  className={`w-full text-left p-3.5 rounded-xl border transition flex gap-3.5 ${
                    selected
                      ? "border-primary bg-primary/10"
                      : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
                  }`}
                >
                  <div className="flex flex-col items-center min-w-[52px] pt-0.5">
                    <span className={`text-xl font-black ${scoreColor(c.overall)}`}>
                      {c.overall.toFixed(1)}
                    </span>
                    <span className="text-[9px] text-text-muted/60 uppercase">score</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] text-text-muted font-mono">
                        {fmtT(c.start)} – {fmtT(c.end)}
                      </span>
                      <span className="text-[10px] text-text-muted/60">·</span>
                      <span className="text-[10px] text-text-muted">{dur.toFixed(1)}s</span>
                      {c.label && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/10 text-text-muted">
                          {c.label}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-white truncate">“{c.hook}…”</p>
                    {c.tags && c.tags.length > 0 && (
                      <div className="flex gap-1.5 mt-1.5 flex-wrap">
                        {c.tags.slice(0, 4).map((t) => (
                          <span
                            key={t}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-primary/15 text-primary/70"
                          >
                            {TAG_LABEL[t] || t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="w-1.5 self-stretch rounded-full overflow-hidden bg-white/5 hidden sm:block">
                    <div
                      className={`w-full ${scoreBar(c.overall)}`}
                      style={{ height: `${Math.min(100, (c.overall / 10) * 100)}%`, marginTop: `${100 - Math.min(100, (c.overall / 10) * 100)}%` }}
                    />
                  </div>
                </button>
              );
            })}
        </div>

        <div className="px-5 py-4 border-t border-white/10 flex items-center justify-between">
          <span className="text-[10px] text-text-muted/60">
            {picked !== null
              ? `Terpilih: ${fmtT(cands[picked].start)} – ${fmtT(cands[picked].end)} (${(cands[picked].end - cands[picked].start).toFixed(1)}s)`
              : "Pilih segmen dulu"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm text-text-muted hover:text-white border border-white/10 hover:border-white/20 transition"
            >
              Batal
            </button>
            <button
              disabled={picked === null}
              onClick={() => {
                if (picked !== null) onPick(cands[picked]);
              }}
              className={`px-5 py-2 rounded-xl text-sm font-semibold transition ${
                picked === null
                  ? "bg-bg-3 text-text-muted/60 cursor-not-allowed"
                  : "bg-primary hover:bg-primary text-white"
              }`}
            >
              Render clip ini
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Format seconds to MM:SS
const fmtT = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};
