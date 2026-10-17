import { type JobMeta } from "@/lib/api";

const STEPS: Record<string, { name: string; detail?: (job: JobMeta) => string }> = {
  queued: { name: "Mengantre", detail: (j) => {
    const queuePos = j._queuePos || "?";
    return `Antrian #${queuePos}. Pos di belakang ~${j._queueWait || "3-5"} menit`;
  }},
  downloading: { name: "Mengunduh video", detail: (j) => {
    const source = (j.videoInfo as any)?._source || "download";
    const isCached = source === "cache";
    const dur = j.videoInfo?.duration ? Math.ceil(j.videoInfo.duration / 60) : "?";
    const label = isCached ? "Cache HIT: skip 1.4GB" : `Download ${dur}m video`;
    return `${j.progress}% · ${label}`;
  }},
  transcribing: { name: "Transkripsi", detail: (j) => `${j.progress}% transkripsi audio (~5-10 menit)` },
  segmenting: { name: "Analisis momen", detail: (j) => `${j.progress}% deteksi momen viral (~3 menit)` },
  ranking: { name: "Ranking viral", detail: (j) => `${j.progress}% scoring klip (~2 menit)` },
  ranked: { name: "Momen siap dipilih", detail: () => "Pilih momen viral di bawah ↓" },
  clipping: { 
    name: "Memotong klip", 
    detail: (j) => {
      const clipCount = j.options?.clipCount || 5;
      const clipsRendered = (j.clips || []).filter(c => c.files && Object.keys(c.files).length > 0).length;
      const remain = clipCount - clipsRendered;
      const estimate = remain > 0 ? remain * 12 : 0;
      return `${clipsRendered}/${clipCount} klip · ${j.progress}% · ~${estimate > 0 ? estimate : 1} menit lagi`;
    }
  },
  done: { name: "Selesai", detail: () => "Semua klip siap!" },
  failed: { name: "Gagal memproses", detail: (j) => j.error?.slice(0, 100) || "Error tidak diketahui" },
};

export function ProgressBar({ job }: { job: JobMeta }) {
  const done = job.status === "done";
  const failed = job.status === "failed";
  const step = STEPS[job.status] ?? { name: "Memproses", detail: () => "" };
  const detail = step.detail?.(job) || "";

  // stuck detection: kalau progress ga update >5 menit + status bukan queued/done/failed
  const isStuck = (() => {
    if (done || failed || job.status === "queued") return false;
    const last = (job as any)._lastProgressUpdate;
    if (!last) return false;
    const age = Date.now() - new Date(last).getTime();
    return age > 5 * 60 * 1000; // 5 menit
  })();

  return (
    <div className="card rounded-2xl px-5 py-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1">
          <div className="font-medium text-text">{step.name}</div>
          {detail && <div className="text-xs text-text-muted mt-1">{detail}</div>}
          {isStuck && (
            <div className="text-xs text-amber-300 mt-1.5 flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 bg-amber-400 rounded-full" />
              Progress tidak update sejak 5+ menit — render sedang lambat atau stuck
            </div>
          )}
        </div>
      </div>
      <div className="h-2 bg-bg-2/80 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            failed ? "bg-red-500" : "bg-primary"
          }`}
          style={{ width: `${Math.max(2, job.progress)}%` }}
        />
      </div>
      {failed && job.error && (
        <div className="mt-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {job.error}
        </div>
      )}
    </div>
  );
}