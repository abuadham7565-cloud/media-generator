// نظام المفاتيح المتسلسلة — قلب المشروع
// القاعدة الجوهرية: ترتيب تسلسلي صارم بحسب الإضافة (created_at ASC, id ASC) — لا round-robin
import { randomUUID } from "node:crypto";
import { turso, ensureSchema } from "./turso";
import type { ErrorClass, ProviderId, ProviderKeyRow } from "./types";

// إخفاء المفتاح إلزامي في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

function mapKey(r: Record<string, unknown>): ProviderKeyRow {
  return {
    id: String(r.id ?? ""),
    provider: String(r.provider ?? "kie") as ProviderId,
    label: String(r.label ?? ""),
    api_key: String(r.api_key ?? ""),
    status: String(r.status ?? "active"),
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

// تجلب المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي بالضبط.
// المستنزف (exhausted) يبقى في القائمة والقاعدة — الاستثناء الوحيد هو disabled.
export async function getKeyPool(providers: string[]): Promise<ProviderKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(",");
  const rs = await turso.execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return rs.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}

export async function getApiKeyRow(id: string): Promise<ProviderKeyRow | null> {
  await ensureSchema();
  const rs = await turso.execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  if (rs.rows.length === 0) return null;
  return mapKey(rs.rows[0] as unknown as Record<string, unknown>);
}

export interface PublicMaskedKey {
  id: string; provider: string; label: string; masked_key: string; status: string;
  usage_count: number; success_count: number; fail_count: number;
  last_used_at: string | null; last_checked_at: string | null; last_error: string | null; created_at: string;
}

export const toPublic = (k: ProviderKeyRow): PublicMaskedKey => ({
  id: k.id, provider: k.provider, label: k.label, masked_key: maskKey(k.api_key), status: k.status,
  usage_count: k.usage_count, success_count: k.success_count, fail_count: k.fail_count,
  last_used_at: k.last_used_at, last_checked_at: k.last_checked_at, last_error: k.last_error, created_at: k.created_at,
});

export async function listKeys(): Promise<PublicMaskedKey[]> {
  await ensureSchema();
  const rs = await turso.execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return rs.rows.map((r) => toPublic(mapKey(r as unknown as Record<string, unknown>)));
}

export async function addKey(provider: ProviderId, apiKey: string, label = ""): Promise<{ ok: boolean; error?: string; key?: PublicMaskedKey }> {
  await ensureSchema();
  // رفض التكرار لنفس المزود
  const dup = await turso.execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  if (dup.rows.length > 0) return { ok: false, error: "هذا المفتاح مضاف مسبقًا لنفس المزود." };
  const id = randomUUID();
  await turso.execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')",
    args: [id, provider, label, apiKey],
  });
  const row = await getApiKeyRow(id);
  return { ok: true, key: row ? toPublic(row) : undefined };
}

export async function setKeyStatus(id: string, status: "active" | "disabled"): Promise<boolean> {
  await ensureSchema();
  const rs = await turso.execute({ sql: "UPDATE api_keys SET status = ? WHERE id = ?", args: [status, id] });
  return rs.rowsAffected > 0;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const rs = await turso.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return rs.rowsAffected > 0;
}

// تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — يُستدعى دائمًا
export async function recordKeyAttempt(
  key: ProviderKeyRow,
  ok: boolean,
  errorClass: ErrorClass | null,
  error: string | null,
): Promise<void> {
  await ensureSchema();
  const status = !ok && errorClass === "disabled" ? "disabled" : !ok && errorClass === "exhausted" ? "exhausted" : key.status;
  await turso.execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = ?,
            last_checked_at = ?,
            last_error = ?,
            status = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, new Date().toISOString(), new Date().toISOString(), error, status, key.id],
  });
}

// تصنيف موحّد لأخطاء المزودين (جدول 4.2 في المواصفة)
// ملاحظة: نفحص نفاد الرصيد قبل 400 عمدًا لأن بعض المزودين يرسلونه بحالة 400
export function classifyProviderError(status: number | null, rawMessage: string): ErrorClass {
  const msg = (rawMessage || "").toLowerCase();
  if (status === 401 || status === 403) return "disabled";
  if (/invalid api key|unauthorized|forbidden|authentication/.test(msg)) return "disabled";
  if (status === 402) return "exhausted";
  if (/insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(msg)) return "exhausted";
  if ((status === 400 || status === 404 || status === 422) && /model not found|unsupported model|model_not_found/.test(msg)) return "provider";
  if (status === 400 || status === 422) return "params";
  if (status === 429 || (status !== null && status >= 500) || status === null) return "temporary";
  return "temporary";
}

// هل رسالة فشل منتصف المهمة تشبه مشكلات مفتاح/رصيد؟ (تستدعي التبديل التلقائي)
export function isKeyishFailure(message: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key/i.test(message || "");
}

// تنقية الأخطاء قبل وصولها لنموذج الذكاء الاصطناعي — لا ذكر للمفاتيح أو الرصيد أبدًا
export function sanitizeForClient(message: string): string {
  if (isKeyishFailure(message) || /api[-_ ]?key|مفتاح|رصيد/i.test(message || "")) {
    return "خطأ مؤقت في المزود — ستُعاد المحاولة تلقائيًا.";
  }
  return message || "خطأ غير معروف";
}
