// واجهة المزودات الموحدة + مساعدات مشتركة
import { ProviderError, type ProviderKeyRow } from "../types";

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(key: ProviderKeyRow, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: ProviderKeyRow, model: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(
    key: ProviderKeyRow,
    providerTaskId: string,
  ): Promise<{ status: "processing" | "completed" | "failed"; urls?: string[]; error?: string; progress?: number }>;
}

// fetch مع مهلة افتراضية 30 ثانية — أخطاء الشبكة تُرمى كـ ProviderError بلا حالة (temporary)
export async function jfetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ res: Response; json: Record<string, unknown> }> {
  const { timeoutMs = 30_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(null, `تعذر الاتصال بالمزود: ${(e as Error).message}`);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // جسم غير JSON — نكتفي بالحالة
  }
  return { res, json };
}

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
