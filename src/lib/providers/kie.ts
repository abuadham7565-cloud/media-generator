// مزود kie.ai — Jobs API الموحد
// الأشكال هنا مقاسة فعليًا بنداءات حقيقية (createTask + recordInfo) لا مختلقة:
//   POST /api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
//   GET  /api/v1/jobs/recordInfo  → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//          "resultJson":"{\"resultUrls\":[\"...\"]}",   ← نص JSON داخل JSON يحتاج JSON.parse ثانيًا
//          "failMsg":"..."}}
import { ProviderError, type ProviderKeyRow } from "../types";
import { jfetch, str, type ProviderAdapter } from "./types";

const KIE_BASE = "https://api.kie.ai";

function requireOk(code: number, body: Record<string, unknown>) {
  const apiCode = Number(body.code ?? 0);
  const msg = str(body.msg || body.message) || `HTTP ${code}`;
  if (code === 401 || code === 403 || code === 402 || code >= 400) throw new ProviderError(code, msg);
  if (apiCode !== 0 && apiCode !== 200) throw new ProviderError(apiCode >= 400 ? apiCode : code, msg);
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const { res, json } = await jfetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
    requireOk(res.status, json);
    const taskId = str((json.data as Record<string, unknown>)?.taskId);
    if (!taskId) throw new ProviderError(res.status, "استجابة غير متوقعة من المزود (لا يوجد taskId)");
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    const { res, json } = await jfetch(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${key.api_key}` } },
    );
    requireOk(res.status, json);
    const data = (json.data as Record<string, unknown>) ?? {};
    const state = str(data.state).toLowerCase();

    if (state === "success" || state === "completed") {
      // resultJson نص JSON داخل JSON — تحليل ثانٍ
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(str(data.resultJson) || "{}") as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls.filter(Boolean) : [];
      } catch { urls = []; }
      if (urls.length === 0) return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج" };
      return { status: "completed", urls };
    }
    if (state === "fail" || state === "failed" || state === "error") {
      return { status: "failed", error: str(data.failMsg || data.failCode) || "فشل التوليد لدى المزود" };
    }
    // waiting | queuing | generating | حالات غير معروفة → قيد المعالجة
    const rawProgress = Number(data.progress);
    return {
      status: "processing",
      progress: Number.isFinite(rawProgress) && rawProgress > 0 ? rawProgress : undefined,
    };
  },
};
