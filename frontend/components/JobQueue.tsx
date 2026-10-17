"use client";

import { useState, useEffect } from "react";
import { apiUrl } from "@/lib/api";

export function JobQueue({ excludeJobId }: { excludeJobId?: string | null }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchRunning = async () => {
      try {
        setLoading(true);
        const res = await fetch(apiUrl("/api/jobs"));
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        const active = (Array.isArray(data) ? data : (data.jobs || [])).filter(
          (j: any) => !["done", "failed"].includes(j.status)
        );
        setJobs(active);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Fetch gagal");
      } finally {
        setLoading(false);
      }
    };
    const iv = setInterval(fetchRunning, 3000);
    fetchRunning();
    return () => clearInterval(iv);
  }, []);

  const cancelJob = async (jobId: string) => {
    if (!confirm(`Cancel job ${jobId.slice(0, 8)}?`)) return;
    try {
      const res = await fetch(apiUrl(`/api/jobs/${jobId}/cancel`), {
        method: "POST",
      });
      if (!res.ok) throw new Error("Cancel gagal");
      setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error");
    }
  };

  const visible = jobs.filter((j) => j.jobId !== excludeJobId);

  if (visible.length === 0) return null;

  return (
    <div className="space-y-2 max-h-48 overflow-y-auto card p-3">
      <div className="text-xs font-semibold text-text-muted mb-2">
        {visible.length} Job Berjalan
      </div>
      {visible.map((j) => (
        <div
          key={j.jobId}
          className="flex items-center justify-between gap-2 text-xs bg-bg p-2 rounded border border-border"
        >
          <div className="flex-1 min-w-0">
            <div className="font-mono truncate text-text">
              {j.jobId.slice(0, 8)}
            </div>
            <div className="text-text-muted truncate">
              {j.videoInfo?.title || "?"}
            </div>
            <div className="text-text-muted">
              {j.status} · {j.progress}%{" "}
              {j.clips && `· ${j.clips.length} clip`}
            </div>
          </div>
          <button
            onClick={() => cancelJob(j.jobId)}
            className="px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded text-xs whitespace-nowrap"
          >
            Cancel
          </button>
        </div>
      ))}
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}
