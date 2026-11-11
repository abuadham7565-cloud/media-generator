// تحويل صفوف المهام إلى صيغة عرض آمنة للواجهة (بلا معرفات داخلية حساسة)
import type { TaskRow } from "./types";

export interface TaskViewDto {
  id: string;
  type: string;
  status: string;
  progress: number;
  model: string;
  prompt: string;
  error_message: string | null;
  result_urls: string[];
  attempts_count: number;
  created_at: string;
  completed_at: string | null;
}

export function parse(t: TaskRow): TaskViewDto {
  let urls: string[] = [];
  let attempts = 0;
  try {
    const u = JSON.parse(t.result_urls_json || "[]");
    urls = Array.isArray(u) ? u.filter((x) => typeof x === "string") : [];
  } catch { urls = []; }
  try {
    const a = JSON.parse(t.attempts_json || "[]");
    attempts = Array.isArray(a) ? a.length : 0;
  } catch { attempts = 0; }
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    progress: t.progress,
    model: t.model,
    prompt: t.prompt,
    error_message: t.error_message,
    result_urls: urls,
    attempts_count: attempts,
    created_at: t.created_at,
    completed_at: t.completed_at,
  };
}
