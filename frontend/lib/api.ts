export type JobStatus =
  | "queued"
  | "downloading"
  | "transcribing"
  | "segmenting"
  | "ranking"
  | "ranked"
  | "clipping"
  | "done"
  | "failed";

export interface JobOptions {
  clipCount: number;
  targetDuration?: number;
  formats: ClipFormat[];
  formatMode?: "auto" | "custom";
  subtitleLang: string;
  includeSubtitles: boolean;
  subtitleTemplate?: string;
  refId?: string | null;
}

export type ClipFormat = "9:16" | "1:1" | "16:9" | "9:16_fill" | "9:16_split" | "16:9_fill" | "adaptive";

export interface Clip {
  id: string;
  start: number;
  end: number;
  duration?: number;
  score?: number;
  tier?: "S" | "A" | "B" | "C";
  title?: string;
  reason?: string;
  hookLabel?: string;
  keywords?: string[];
  transcript_excerpt?: string;
  files?: Partial<Record<ClipFormat, string>>;
  file?: string;
}

export interface JobMeta {
  jobId: string;
  url: string;
  brief?: string;
  status: JobStatus;
  progress: number;
  options: JobOptions;
  videoInfo?: { id: string; title: string; duration: number; channel?: string } | null;
  clips: Clip[];
  warnings?: string[];
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  _queuePos?: number;         // antrian nomor berapa
  _queueWait?: number;        // waktu tunggu (ms)
  _lastProgressUpdate?: string; // timestamp update terakhir
}

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request gagal (${res.status})`);
  return data as T;
}

export function createJob(input: {
  url: string;
  brief?: string;
  options: Partial<JobOptions>;
}): Promise<{ jobId: string; status: JobStatus }> {
  return jfetch("/api/jobs", { method: "POST", body: JSON.stringify(input) });
}

export async function createUploadJob(input: {
  file: File;
  brief?: string;
  options: Partial<JobOptions>;
}): Promise<{ jobId: string; status: JobStatus }> {
  const fd = new FormData();
  fd.append("video", input.file);
  if (input.brief) fd.append("brief", input.brief);
  fd.append("clipCount", String(input.options.clipCount ?? 5));
  fd.append("targetDuration", String(input.options.targetDuration ?? 60));
  fd.append("formats", JSON.stringify(input.options.formats ?? ["9:16"]));
  fd.append("subtitleLang", input.options.subtitleLang ?? "id");
  fd.append("includeSubtitles", String(input.options.includeSubtitles !== false));
  const res = await fetch(apiUrl("/api/jobs/upload"), { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Upload gagal (${res.status})`);
  return data as { jobId: string; status: JobStatus };
}

export function getJob(id: string): Promise<JobMeta> {
  return jfetch(`/api/jobs/${encodeURIComponent(id)}`);
}

export function getJobSegments(id: string): Promise<{
  candidates: Array<{ start: number; end: number; hook: string; overall: number; energy?: number; tags?: string[]; label?: string }>;
  totalSegments?: number;
  duration?: number | null;
  note?: string;
}> {
  return jfetch(`/api/jobs/${encodeURIComponent(id)}/segments`);
}

export function streamUrl(jobId: string, clipId: string, format: ClipFormat): string {
  return apiUrl(`/api/jobs/${jobId}/stream?clip=${clipId}&format=${encodeURIComponent(format)}`);
}

// Cover thumbnail per clip (fix card abu-abu): frame @35% durasi, JPEG 480px.
// onError fallback → play button polos (clip belum selesai render).
export function thumbUrl(jobId: string, clipId: string, format: ClipFormat): string {
  return apiUrl(`/api/jobs/${jobId}/thumb?clip=${clipId}&format=${encodeURIComponent(format)}`);
}

export function downloadUrl(jobId: string, clipId: string, format: ClipFormat): string {
  return apiUrl(`/api/jobs/${jobId}/download?clip=${clipId}&format=${encodeURIComponent(format)}`);
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function tierColor(tier?: Clip["tier"]): string {
  switch (tier) {
    case "S": return "text-amber-300 border-amber-400/40 bg-amber-400/10";
    case "A": return "text-emerald-300 border-emerald-400/40 bg-emerald-400/10";
    case "B": return "text-sky-300 border-sky-400/40 bg-sky-400/10";
    default: return "text-zinc-300 border-zinc-500/40 bg-zinc-500/10";
  }
}