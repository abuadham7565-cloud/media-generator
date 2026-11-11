// عميل خدمة دمج الفيديو — Video Merger API v2
// بلا مفاتيح أو توثيق. المخرجات: MP4 (H.264 + AAC). لا توجد معاملات resolution/fps.
// قاعدة حتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري،
// أما أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة وتستمر بالاستعلام.
import { ProviderError } from "./types";
import { str } from "./providers/types";

// الافتراضي حسب المواصفة عنصر نائب — تُعامل القيمة الفارغة/النائبة كـ «غير مهيأة»
const RAW_BASE = (process.env.MERGER_API_BASE || "https://xxxxxxxx").replace(/\/+$/, "");
export const mergerBase = (): string => RAW_BASE;
export function mergerConfigured(): boolean {
  return !!RAW_BASE && !RAW_BASE.includes("xxxxxxxx");
}

async function mfetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { timeoutMs = 45_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${mergerBase()}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // خطأ شبكة من طرفنا → مؤقت (status=null)
    throw new ProviderError(null, `تعذر الاتصال بخدمة الدمج: ${(e as Error).message}`);
  }
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* جسم فارغ أو ثنائي */ }
  return { status: res.status, body };
}

// فحص جهوزية الخدمة عبر /api/config بمهلة 4 ثوانٍ (يُستخدم في /api/health)
export async function mergerHealth(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const { status } = await mfetch("/api/config", { timeoutMs: 4_000 });
    return status === 200;
  } catch {
    return false;
  }
}

export async function createMergeJob(urls: string[]): Promise<{ jobId: string; expiresAt?: string }> {
  const { status, body } = await mfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  });
  if (status < 200 || status >= 300) {
    throw new ProviderError(status, str(body.error) || `HTTP ${status}`);
  }
  const jobId = str(body.jobId);
  if (!jobId) throw new ProviderError(status, "استجابة غير متوقعة من خدمة الدمج (لا يوجد jobId)");
  return { jobId, expiresAt: str(body.expiresAt) || undefined };
}

// تنفيذ الدمج — blocking (~10-15 ثانية). يُطلق مرة واحدة خلفيًا مع قفل في الذاكرة.
export async function processMergeJob(jobId: string): Promise<{ done: boolean; videoUrl?: string; downloadUrl?: string; error?: string; httpError: boolean }> {
  const { status, body } = await mfetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    timeoutMs: 280_000, // الدمج المتزامن قد يطول — دون حد أقصى للدالة
  });
  if (status >= 200 && status < 300) {
    return { done: true, videoUrl: str(body.videoUrl) || undefined, downloadUrl: str(body.downloadUrl) || undefined, httpError: false };
  }
  if (status === 202) return { done: false, httpError: false };
  return { done: false, error: str(body.error) || `HTTP ${status}`, httpError: true };
}

export type MergeStatus = "queued" | "processing" | "done" | "failed" | "not_found";

export interface MergeState {
  status: MergeStatus;
  progress?: number; // 0..100 مضمون
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

const DONE_SET = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAIL_SET = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

// تحليل الحالة دفاعيًا — progress قد يرد كسرًا 0..1 فيُضرب في 100،
// وقد يرد الجسم فيه error بلا حقل status → تُعامل failed فورًا
export async function getMergeJob(jobId: string): Promise<MergeState> {
  let out: { status: number; body: Record<string, unknown> };
  try {
    out = await mfetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET", timeoutMs: 20_000 });
  } catch {
    // خطأ شبكة من طرفنا → مؤقت
    return { status: "processing" };
  }
  const { status, body } = out;
  if (status === 404) return { status: "not_found" };

  const rawStatus = str(body.status).toLowerCase();
  const rawError = str(body.error);
  if (!rawStatus && rawError) return { status: "failed", error: rawError };
  if (status >= 400) return { status: "failed", error: rawError || `HTTP ${status}` };

  let progress: number | undefined = Number(body.progress);
  if (!Number.isFinite(progress) || progress < 0) progress = undefined;
  else if (progress <= 1) progress = Math.round(progress * 100);
  else progress = Math.round(progress);

  if (DONE_SET.has(rawStatus)) {
    const videoUrl = str(body.videoUrl) || str(body.downloadUrl) || `${mergerBase()}/api/jobs/${jobId}/video`;
    return { status: "done", progress: 100, videoUrl, downloadUrl: str(body.downloadUrl) || `${mergerBase()}/api/jobs/${jobId}/video?download=1` };
  }
  if (FAIL_SET.has(rawStatus)) return { status: "failed", error: rawError || "فشل الدمج في الخدمة" };
  return { status: "processing", progress: progress ?? 0 };
}

// حذف فوري (تنظيف اختياري بعد الاختبارات)
export async function deleteMergeJob(jobId: string): Promise<void> {
  try {
    await mfetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", timeoutMs: 15_000 });
  } catch {
    // فشل التنظيف لا يُرمى خطؤه — التنظيف اختياري
  }
}
