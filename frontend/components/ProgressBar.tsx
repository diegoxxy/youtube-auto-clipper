import { type JobMeta } from "@/lib/api";

const STEPS: Record<string, string> = {
  queued: "Mengantre",
  downloading: "Mengunduh video",
  transcribing: "Transkripsi",
  segmenting: "Analisis momen",
  ranking: "Ranking viral",
  clipping: "Memotong klip",
  done: "Selesai",
  failed: "Gagal",
};

export function ProgressBar({ job }: { job: JobMeta }) {
  const done = job.status === "done";
  const failed = job.status === "failed";
  if (done || failed) return null;

  return (
    <div className="glass rounded-2xl px-5 py-4">
      <div className="flex items-center justify-between text-sm mb-2">
        <span className="font-medium text-zinc-300">
          {failed ? "Gagal memproses" : STEPS[job.status] ?? "Memproses"}
        </span>
        <span className="text-zinc-500 tabular-nums">{job.progress}%</span>
      </div>
      <div className="h-2 bg-ink-2/80 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            failed ? "bg-red-500" : "bg-gradient-to-r from-brand to-brand-2"
          }`}
          style={{ width: `${Math.max(2, job.progress)}%` }}
        />
      </div>
    </div>
  );
}