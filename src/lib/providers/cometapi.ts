// مزود CometAPI — المزود الثاني
// صور متزامنة عبر نقطة images المتوافقة مع OpenAI (تعيد الرابط أو b64_json فورًا)،
// والفيديو عبر نقطة مهام غير متزامنة بنفس نمط create/check.
// ملاحظة: لا يوجد مفتاح CometAPI في هذه البيئة لقياس الأشكال حيًا — لذلك التحليل هنا
// متسامح (يتعامل مع صيغ الحقول الشائعة). إن اختلفت الاستجابة الحقيقية تُتبع توثيق
// api.cometapi.com الرسمي دون تغيير بقية المنطق.
import { ProviderError, type ProviderKeyRow } from "../types";
import { jfetch, str, type ProviderAdapter } from "./types";

const COMET_BASE = (process.env.COMETAPI_BASE || "https://api.cometapi.com").replace(/\/+$/, "");

function httpError(status: number, body: Record<string, unknown>): ProviderError {
  const msg = str(body.error ?? body.message) || `HTTP ${status}`;
  return new ProviderError(status, typeof body.error === "object" ? str((body.error as Record<string, unknown>).message) : msg);
}

export const cometApiAdapter: ProviderAdapter = {
  async createImageSync(key, model, input) {
    const { res, json } = await jfetch(`${COMET_BASE}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: input.prompt, n: 1 }),
      timeoutMs: 120_000, // توليد متزامن قد يستغرق وقتًا أطول
    });
    if (!res.ok) throw httpError(res.status, json);
    const data = json.data as Array<Record<string, unknown>> | undefined;
    const first = Array.isArray(data) ? data[0] : undefined;
    const url = str(first?.url);
    if (url) return { urls: [url] };
    const b64 = str(first?.b64_json);
    if (b64) return { urls: [`data:image/png;base64,${b64}`] }; // رابط بيانات — يعرض مباشرة
    throw new ProviderError(res.status, "استجابة غير متوقعة من المزود (لا رابط ولا b64_json)");
  },

  async createTask(key, model, input) {
    const { res, json } = await jfetch(`${COMET_BASE}/v1/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) throw httpError(res.status, json);
    const data = (json.data as Record<string, unknown>) ?? json;
    const taskId = str(data.task_id || data.taskId || data.id);
    if (!taskId) throw new ProviderError(res.status, "استجابة غير متوقعة من المزود (لا يوجد معرف مهمة)");
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    const { res, json } = await jfetch(`${COMET_BASE}/v1/tasks/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key.api_key}` },
    });
    if (!res.ok) throw httpError(res.status, json);
    const data = (json.data as Record<string, unknown>) ?? json;
    const status = str(data.status ?? data.state).toLowerCase();

    if (["succeeded", "success", "completed", "complete", "done"].includes(status)) {
      // روابط محتملة بأسماء شائعة في التوثيق
      const candidates: unknown[] = [
        data.output, data.result, data.urls, data.video_url, data.image_url, data.videoUrl, data.imageUrl,
      ];
      const urls: string[] = [];
      for (const c of candidates) {
        if (typeof c === "string" && c.startsWith("http")) urls.push(c);
        if (Array.isArray(c)) for (const u of c) if (typeof u === "string" && u.startsWith("http")) urls.push(u);
      }
      if (urls.length === 0) return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتائج" };
      return { status: "completed", urls };
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      return { status: "failed", error: str(data.error ?? data.message) || "فشل التوليد لدى المزود" };
    }
    return { status: "processing", progress: undefined };
  },
};
