"use client";

import { useState, useEffect } from "react";
import { apiUrl } from "@/lib/api";

export function JobLogs({ jobId }: { jobId: string }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(apiUrl(`/api/jobs/${jobId}/logs?limit=100`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setLogs(data.lines || []);
        setError(null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };

    fetchLogs();
    if (!autoRefresh) return;
    const timer = setInterval(fetchLogs, 3000);
    return () => clearInterval(timer);
  }, [jobId, autoRefresh]);

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-text">Log Backend</h3>
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`text-xs px-3 py-1.5 rounded-lg transition ${
            autoRefresh
              ? "bg-primary/20 text-primary border border-primary/50"
              : "bg-bg-2 text-text-muted border border-border hover:border-border-light"
          }`}
        >
          {autoRefresh ? "⏸ Pause" : "▶ Resume"}
        </button>
      </div>
      {loading && <div className="text-sm text-text-muted">Memuat log...</div>}
      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {!loading && !error && logs.length === 0 && (
        <div className="text-sm text-text-muted">Tidak ada log backend untuk job ini.</div>
      )}
      {logs.length > 0 && (
        <div className="bg-bg-2/60 border border-border rounded-xl p-3 max-h-80 overflow-y-auto font-mono text-xs text-text space-y-0.5">
          {logs.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
