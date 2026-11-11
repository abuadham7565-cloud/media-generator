// منسّق التوليد — التدفق الكامل مع التبديل التسلسلي الصامت للمفاتيح
//
// القواعد الجوهرية المنفَّذة هنا:
// 1) المهمة تُسجَّل في Turso قبل أي نداء خارجي.
// 2) المرشحون (المفاتيح) يُجرَّبون بالترتيب التسلسلي الصارم؛ أول نجاح يربط المهمة به.
// 3) فشل مفتاح/رصيد في منتصف المهمة ⇒ إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
// 4) فشل الإنشاء على كل المفاتيح ⇒ المهمة تبقى processing «بانتظار توفر مفتاح صالح…»
//    وتُعاد المحاولة تلقائيًا مع كل get_task (بتهدئة ~45 ثانية).
// 5) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا (sanitizeForClient).
import { randomUUID } from "node:crypto";
import { ProviderError, type ErrorClass, type ModelDef, type MediaType, type ProviderId, type ProviderKeyRow, type TaskRow } from "./types";
import {
  classifyProviderError,
  getApiKeyRow,
  getKeyPool,
  isKeyishFailure,
  recordKeyAttempt,
  sanitizeForClient,
} from "./keys";
import { getTask, getTaskByProviderTaskId, insertTask, updateTask } from "./turso";
import { resolveModel } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometApiAdapter } from "./providers/cometapi";
import type { ProviderAdapter } from "./providers/types";
import * as merger from "./merger";
import type { AttemptRecord } from "./types";

const ADAPTERS: Record<string, ProviderAdapter> = { kie: kieAdapter, cometapi: cometApiAdapter };

const WAITING_KEYS_MSG = "بانتظار توفر مفتاح صالح…";
const WAITING_MERGER_MSG = "بانتظار جهوزية خدمة الدمج…";
const RETRY_COOLDOWN_MS = 45_000; // تهدئة إعادة المحاولة حتى لا نضغط المزودين
const POLL_INTERVAL_MS = 3_000;   // استعلام كل 3 ثوانٍ أثناء نافذة الانتظار

const DEFAULT_WAIT: Record<MediaType, number> = { image: 90, video: 25, merge: 60 };

export interface ProgressEvent { progress: number; total: number; message: string; }
export type ProgressCb = (p: ProgressEvent) => Promise<void>;

export interface RunOutcome {
  taskId: string;
  state: "completed" | "processing" | "failed" | "no_keys";
  urls?: string[];
  message?: string;
  progress?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clampWait = (v: unknown, dflt: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(240, Math.floor(n)));
};
const safeParse = (s: string): Record<string, unknown> => {
  try { return JSON.parse(s || "{}") as Record<string, unknown>; } catch { return {}; }
};
const parseUrls = (s: string | null): string[] => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && !!u) : [];
  } catch { return []; }
};
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const classifyErr = (e: unknown): ErrorClass =>
  e instanceof ProviderError ? classifyProviderError(e.status, e.message) : classifyProviderError(null, errMessage(e));

function mkAttempt(key: ProviderKeyRow | null, ok: boolean, errorClass: ErrorClass | null, error: string | null, provider?: string): AttemptRecord {
  return { provider: provider ?? key?.provider ?? "?", keyId: key?.id ?? "-", keyLabel: key?.label ?? "", ok, errorClass, error, at: new Date().toISOString() };
}

// بناء input لكل مزود حسب النوع — نرسل الحقول ذات المعنى فقط
export function buildInput(modelDef: ModelDef, type: "image" | "video", args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: args.prompt };
  if (type === "image") {
    if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (args.resolution) input.resolution = args.resolution;
    if (args.background && args.background !== "auto") input.background = args.background; // تُطبق عند 1K فقط
    if (args.output_format) input.output_format = args.output_format;
  } else {
    if (args.image_url) input.image_url = args.image_url;
    if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (args.resolution && args.resolution !== "480p") input.resolution = args.resolution;
    if (args.enable_audio !== undefined) input.enable_audio = Boolean(args.enable_audio);
    if (args.duration) input.duration = Number(args.duration);
  }
  return input;
}

// تعريف بديل إن لم يعد الموديل في السجل (من مهام قديمة)
function fallbackDef(model: string, type: MediaType, provider: string | null): ModelDef {
  const providers = (provider && provider !== "merger" ? [provider as ProviderId] : ["kie"]) as ProviderId[];
  return { canonical: model, aliases: [], type, providers, providerModel: { kie: model, cometapi: model } };
}

// ————— إنشاء المهمة لدى المزود على مرشحين متتاليين —————
type AttemptResult =
  | { state: "sync"; urls: string[]; idx: number; key: ProviderKeyRow }
  | { state: "created"; providerTaskId: string; idx: number; key: ProviderKeyRow }
  | { state: "no_candidate" }
  | { state: "failed_params"; message: string };

async function attemptCreateRange(
  taskId: string,
  modelDef: ModelDef,
  type: "image" | "video",
  input: Record<string, unknown>,
  pool: ProviderKeyRow[],
  startIdx: number,
): Promise<AttemptResult> {
  for (let i = Math.max(0, startIdx); i < pool.length; i++) {
    const key = pool[i];
    const adapter = ADAPTERS[key.provider];
    if (!adapter) continue;
    const providerModel = modelDef.providerModel[key.provider] || modelDef.canonical;
    try {
      // صور متزامنة إن دعم المزود ذلك (CometAPI)
      if (type === "image" && adapter.createImageSync) {
        const r = await adapter.createImageSync(key, providerModel, input);
        await recordKeyAttempt(key, true, null, null);
        await updateTask(taskId, {
          provider: key.provider, provider_task_id: null, key_id: key.id,
          status: "completed", progress: 100, result_urls_json: JSON.stringify(r.urls),
          attempt: mkAttempt(key, true, null, null),
        });
        return { state: "sync", urls: r.urls, idx: i, key };
      }
      const { providerTaskId } = await adapter.createTask(key, providerModel, input);
      await recordKeyAttempt(key, true, null, null);
      await updateTask(taskId, {
        provider: key.provider, provider_task_id: providerTaskId, key_id: key.id,
        status: "processing", progress: 5,
        attempt: mkAttempt(key, true, null, null),
      });
      return { state: "created", providerTaskId, idx: i, key };
    } catch (e) {
      const cls = classifyErr(e);
      const msg = errMessage(e);
      await recordKeyAttempt(key, false, cls, msg);
      await updateTask(taskId, { attempt: mkAttempt(key, false, cls, msg) });
      if (cls === "params") {
        // خطأ معطيات الطلب — تبديل المفاتيح لن يحل شيئًا: توقف فورًا
        const m = sanitizeForClient(msg);
        await updateTask(taskId, { status: "failed", error_message: m });
        return { state: "failed_params", message: m };
      }
      // disabled / exhausted / provider / temporary ⇒ المفتاح التالي فورًا — التبديل صامت
      continue;
    }
  }
  return { state: "no_candidate" };
}

// ————— التوليد (صورة/فيديو) —————
export async function runGeneration(opts: {
  modelDef: ModelDef;
  type: "image" | "video";
  args: Record<string, unknown>;
  prompt: string;
  onProgress?: ProgressCb;
}): Promise<RunOutcome> {
  const { modelDef, type, args, prompt, onProgress } = opts;
  const input = buildInput(modelDef, type, args);

  const pool = await getKeyPool(modelDef.providers);
  const taskId = randomUUID();
  // سجّل المهمة قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  await insertTask({
    id: taskId, provider: null, provider_task_id: null, key_id: null,
    model: modelDef.canonical, type, prompt, params_json: JSON.stringify(args),
  });

  if (pool.length === 0) {
    await updateTask(taskId, { error_message: `لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}` });
    return { taskId, state: "no_keys" };
  }

  const created = await attemptCreateRange(taskId, modelDef, type, input, pool, 0);
  if (created.state === "failed_params") return { taskId, state: "failed", message: created.message };
  if (created.state === "no_candidate") {
    // فشل على كل المفاتيح — تبقى processing وتُستأنف تلقائيًا مع كل get_task
    await updateTask(taskId, { status: "processing", progress: 0, error_message: WAITING_KEYS_MSG });
    return { taskId, state: "processing", progress: 0 };
  }
  if (created.state === "sync") {
    await onProgress?.({ progress: 100, total: 100, message: "اكتمل التوليد 100%" });
    return { taskId, state: "completed", urls: created.urls };
  }

  // مهمة غير متزامنة — نافذة انتظار قصيرة تبث تقدمًا حيًا
  return await waitWindow({
    taskId, modelDef, type, input, pool,
    idx: created.idx, key: created.key, providerTaskId: created.providerTaskId,
    waitSec: clampWait(args.wait_seconds, DEFAULT_WAIT[type]),
    onProgress,
  });
}

// نافذة الانتظار: استعلام كل 3 ثوانٍ + إشعارات تقدم + تبديل مفاتيح فوري عند أي فشل مفتاح/رصيد
async function waitWindow(ctx: {
  taskId: string; modelDef: ModelDef; type: "image" | "video";
  input: Record<string, unknown>; pool: ProviderKeyRow[];
  idx: number; key: ProviderKeyRow; providerTaskId: string;
  waitSec: number; onProgress?: ProgressCb;
}): Promise<RunOutcome> {
  const { taskId, modelDef, type, input, pool, onProgress } = ctx;
  let idx = ctx.idx;
  let key = ctx.key;
  let providerTaskId = ctx.providerTaskId;
  const deadline = Date.now() + ctx.waitSec * 1000;
  let tick = 0;

  // التبديل للمفتاح التالي بنفس task_id — أو الدخول في حالة «بانتظار مفتاح صالح»
  const switchKey = async (): Promise<RunOutcome | { recreated: true }> => {
    const rec = await attemptCreateRange(taskId, modelDef, type, input, pool, idx + 1);
    if (rec.state === "sync") {
      await onProgress?.({ progress: 100, total: 100, message: "اكتمل التوليد 100%" });
      return { taskId, state: "completed" as const, urls: rec.urls };
    }
    if (rec.state === "created") {
      idx = rec.idx; key = rec.key; providerTaskId = rec.providerTaskId;
      tick = 0;
      return { recreated: true };
    }
    if (rec.state === "failed_params") return { taskId, state: "failed" as const, message: rec.message };
    await updateTask(taskId, { status: "processing", error_message: WAITING_KEYS_MSG });
    return { taskId, state: "processing" as const };
  };

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    tick++;
    try {
      const check = await ADAPTERS[key.provider].checkTask(key, providerTaskId);

      if (check.status === "completed" && check.urls?.length) {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(check.urls) });
        await onProgress?.({ progress: 100, total: 100, message: "اكتمل التوليد 100%" });
        return { taskId, state: "completed", urls: check.urls };
      }
      if (check.status === "failed") {
        if (isKeyishFailure(check.error || "")) {
          // فشل مفتاح/رصيد معلن من المزود في منتصف المهمة ⇒ استئناف بنفس task_id على التالي
          const r = await switchKey();
          if (!("recreated" in r)) return r;
          continue;
        }
        // فشل حقيقي (انتهاك سياسة/معطيات) ⇒ failed نهائي
        const m = sanitizeForClient(check.error || "فشل التوليد لدى المزود");
        await updateTask(taskId, { status: "failed", error_message: m });
        return { taskId, state: "failed", message: m };
      }
      // processing — حدّث التقدم وابث إشعارًا
      const p = Math.max(5, Math.min(95, check.progress ?? Math.min(95, 4 + tick * 2)));
      await updateTask(taskId, { status: "processing", progress: p });
      await onProgress?.({ progress: Math.round(p), total: 100, message: `قيد التوليد… ${Math.round(p)}%` });
    } catch (e) {
      const cls = classifyErr(e);
      const msg = errMessage(e);
      await recordKeyAttempt(key, false, cls, msg);
      await updateTask(taskId, { attempt: mkAttempt(key, false, cls, msg) });
      if (cls === "disabled" || cls === "exhausted") {
        // المفتاح صار غير صالح/مستنزف أثناء الفحص ⇒ بدّل فورًا
        const r = await switchKey();
        if (!("recreated" in r)) return r;
        continue;
      }
      // provider / params / temporary أثناء الفحص ⇒ نعاملها كمؤقتة ونستمر حتى انتهاء النافذة
      continue;
    }
  }
  // انتهت النافذة والنتيجة لم تظهر ⇒ processing والعميل يتابع بـ get_task
  return { taskId, state: "processing", progress: 50 };
}

// ————— صياغات العرض العربية —————
export interface TaskView {
  taskId: string;
  state: "completed" | "processing" | "failed" | "not_found";
  text: string;
  isError: boolean;
  urls?: string[];
  progress?: number;
}

function urlsOf(t: TaskRow): string[] {
  const urls = parseUrls(t.result_urls_json);
  if (t.provider === "merger" && urls.length === 0 && t.provider_task_id) {
    // رابط احتياطي على نطاق خدمة الدمج
    urls.push(`${merger.mergerBase()}/api/jobs/${t.provider_task_id}/video`);
  }
  return urls;
}

function completedView(t: TaskRow): TaskView {
  const urls = urlsOf(t);
  let text: string;
  if (t.type === "image") {
    text = `✅ تم توليد الصورة بنجاح\n\n${urls.map((u) => `![image](${u})`).join("\n\n")}\n\n${urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}`;
  } else if (t.type === "video") {
    text = `✅ تم توليد الفيديو بنجاح\n\n${urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}`;
  } else {
    text = `✅ تم دمج المقاطع بنجاح\n\n${urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  return { taskId: t.id, state: "completed", text, isError: false, urls, progress: 100 };
}

function processingView(t: TaskRow): TaskView {
  const p = Math.max(0, Math.min(99, Math.round(t.progress || 0)));
  return {
    taskId: t.id,
    state: "processing",
    text: `⏳ المهمة قيد المعالجة — task_id: ${t.id}\n\nالتقدم: ${p}%\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    isError: false,
    progress: p,
  };
}

function failedView(t: TaskRow): TaskView {
  return { taskId: t.id, state: "failed", text: `❌ فشلت المهمة: ${t.error_message || "سبب غير معروف"}`, isError: true };
}

function lastAttemptMs(t: TaskRow): number | null {
  try {
    const arr = JSON.parse(t.attempts_json || "[]") as AttemptRecord[];
    const last = arr[arr.length - 1];
    return last?.at ? Date.parse(last.at) : null;
  } catch { return null; }
}

// ————— get_task: تحديث حي من المزود/الخدمة + نفس منطق التبديل —————
export async function refreshAndGetTask(taskId: string): Promise<TaskView> {
  const t = await getTask(taskId);
  if (!t) return { taskId, state: "not_found", text: `❌ لا توجد مهمة بهذا المعرّف: ${taskId}`, isError: true };
  if (t.status === "completed") return completedView(t);
  if (t.status === "failed") return failedView(t);
  if (t.type === "merge") return refreshMergeView(t);

  const type = (t.type === "video" ? "video" : "image") as "image" | "video";
  const modelDef = resolveModel(t.model) ?? fallbackDef(t.model, type, t.provider);
  const args = safeParse(t.params_json) as Record<string, unknown>;
  const input = buildInput(modelDef, type, args);
  const pool = await getKeyPool(modelDef.providers);

  if (t.provider && t.provider !== "merger" && t.provider_task_id) {
    // مفتاح المهمة الحالي — إن عُطّل نستخدم أول مفتاح نشط لنفس المزود
    let key = t.key_id ? await getApiKeyRow(t.key_id) : null;
    if (!key || key.status === "disabled") key = pool.find((k) => k.provider === t.provider) ?? null;
    if (!key) {
      await updateTask(t.id, { status: "processing", error_message: WAITING_KEYS_MSG });
      return processingView(t);
    }
    let idx = pool.findIndex((k) => k.id === key!.id);
    if (idx < 0) idx = 0;

    const switchKey = async (): Promise<TaskView | { recreated: true }> => {
      const rec = await attemptCreateRange(t.id, modelDef, type, input, pool, idx + 1);
      if (rec.state === "sync") {
        const fresh = await getTask(t.id);
        return fresh ? completedView(fresh) : processingView(t);
      }
      if (rec.state === "created") {
        const fresh = await getTask(t.id);
        return fresh ? processingView(fresh) : processingView(t);
      }
      if (rec.state === "failed_params") {
        await updateTask(t.id, { status: "failed", error_message: rec.message });
        return failedView({ ...t, status: "failed", error_message: rec.message });
      }
      await updateTask(t.id, { status: "processing", error_message: WAITING_KEYS_MSG });
      return processingView({ ...t, error_message: WAITING_KEYS_MSG });
    };

    try {
      const check = await ADAPTERS[key.provider].checkTask(key, t.provider_task_id);
      if (check.status === "completed" && check.urls?.length) {
        await updateTask(t.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify(check.urls), key_id: key.id });
        return completedView({ ...t, status: "completed", progress: 100, result_urls_json: JSON.stringify(check.urls) });
      }
      if (check.status === "failed") {
        if (isKeyishFailure(check.error || "")) {
          const r = await switchKey();
          if (!("recreated" in r)) return r;
          return processingView(t);
        }
        const m = sanitizeForClient(check.error || "فشل التوليد لدى المزود");
        await updateTask(t.id, { status: "failed", error_message: m });
        return failedView({ ...t, status: "failed", error_message: m });
      }
      const p = Math.max(t.progress, Math.min(99, check.progress ?? t.progress));
      await updateTask(t.id, { status: "processing", progress: p });
      return processingView({ ...t, progress: p });
    } catch (e) {
      const cls = classifyErr(e);
      const msg = errMessage(e);
      await recordKeyAttempt(key, false, cls, msg);
      await updateTask(t.id, { attempt: mkAttempt(key, false, cls, msg) });
      if (cls === "disabled" || cls === "exhausted") {
        const r = await switchKey();
        if (!("recreated" in r)) return r;
      }
      return processingView(t);
    }
  }

  // لم ينجح الإنشاء بعد على أي مفتاح ⇒ أعد المحاولة على المجموعة كاملة (بتهدئة 45 ثانية)
  const last = lastAttemptMs(t);
  if (last && Date.now() - last < RETRY_COOLDOWN_MS) return processingView(t);
  if (pool.length === 0) return processingView(t);
  const rec = await attemptCreateRange(t.id, modelDef, type, input, pool, 0);
  if (rec.state === "sync") { const fresh = await getTask(t.id); return fresh ? completedView(fresh) : processingView(t); }
  if (rec.state === "created") { const fresh = await getTask(t.id); return fresh ? processingView(fresh) : processingView(t); }
  if (rec.state === "failed_params") {
    await updateTask(t.id, { status: "failed", error_message: rec.message });
    return failedView({ ...t, status: "failed", error_message: rec.message });
  }
  await updateTask(t.id, { status: "processing", error_message: WAITING_KEYS_MSG });
  return processingView(t);
}

// ————— دمج الفيديو —————
// قفل في الذاكرة: process يُطلق مرة واحدة فقط لكل مهمة دمج ولا يتزامن مع get_task
const g = globalThis as unknown as { __mergeLaunched?: Set<string>; __mergeInFlight?: Set<string> };
g.__mergeLaunched ??= new Set<string>();
g.__mergeInFlight ??= new Set<string>();

function launchMergeProcess(jobId: string): void {
  if (g.__mergeLaunched!.has(jobId) || g.__mergeInFlight!.has(jobId)) return;
  g.__mergeLaunched!.add(jobId);
  g.__mergeInFlight!.add(jobId);
  void (async () => {
    try {
      const r = await merger.processMergeJob(jobId);
      const t = await getTaskByProviderTaskId("merger", jobId);
      if (!t || t.status === "completed" || t.status === "failed") return;
      if (r.done && r.videoUrl) {
        await updateTask(t.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify([r.videoUrl]) });
      } else if (r.httpError) {
        // خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
        await updateTask(t.id, { status: "failed", error_message: sanitizeForClient(r.error || "فشل الدمج في الخدمة") });
      }
    } catch {
      // خطأ شبكة من طرفنا — مؤقت: تُستأنف المهمة عبر get_task
    } finally {
      g.__mergeInFlight!.delete(jobId);
    }
  })();
}

export async function runMerge(opts: { args: Record<string, unknown>; onProgress?: ProgressCb }): Promise<RunOutcome> {
  const { args, onProgress } = opts;

  // 1) حل task_ids أولًا (روابطها بالترتيب) ثم urls المباشرة بنفس ترتيبها
  const resolved: string[] = [];
  const failures: string[] = [];
  for (const tid of (Array.isArray(args.task_ids) ? args.task_ids : []) as string[]) {
    const t = await getTask(String(tid));
    if (!t) { failures.push(`المعرّف ${tid}: غير موجود`); continue; }
    if (t.status !== "completed") { failures.push(`المعرّف ${tid}: حالته «${t.status}» — يلزم مهمة مكتملة`); continue; }
    const urls = parseUrls(t.result_urls_json);
    if (urls.length === 0) { failures.push(`المعرّف ${tid}: مكتملة لكن بلا روابط نتائج`); continue; }
    resolved.push(...urls);
  }
  const direct = ((Array.isArray(args.urls) ? args.urls : []) as string[]).map(String);
  const combined = [...resolved, ...direct];
  const detail = failures.length ? `\n\nتفاصيل كل معرّف فاشل:\n- ${failures.join("\n- ")}` : "";

  if (combined.length < 2) {
    return { taskId: "", state: "failed", message: `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${detail}` };
  }
  if (combined.length > 10) {
    return { taskId: "", state: "failed", message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  if (!combined.every((u) => /^https?:\/\//i.test(u))) {
    return { taskId: "", state: "failed", message: `❌ الروابط يجب أن تكون روابط http/https مباشرة وعامة.${detail}` };
  }
  if (!merger.mergerConfigured()) {
    return { taskId: "", state: "failed", message: "❌ خدمة الدمج غير مهيأة على السيرفر — اضبط متغير البيئة MERGER_API_BASE برابط خدمة الدمج ثم أعد المحاولة." };
  }

  // 2) سجّل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId, provider: "merger", provider_task_id: null, key_id: null,
    model: "video-merger", type: "merge",
    prompt: `دمج ${combined.length} مقاطع فيديو`,
    params_json: JSON.stringify({ ...args, combinedUrls: combined }),
  });

  // 3) أنشئ المهمة لدى الخدمة ثم أطلق process خلفيًا وبمرة واحدة فقط
  let jobId: string;
  try {
    const job = await merger.createMergeJob(combined);
    jobId = job.jobId;
    await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 2, attempt: mkAttempt(null, true, null, null, "merger") });
    launchMergeProcess(jobId);
  } catch (e) {
    if (e instanceof ProviderError && e.status === null) {
      // خطأ شبكة من طرفنا → مؤقت: تبقى processing وتُعاد المحاولة مع get_task
      await updateTask(taskId, { status: "processing", error_message: WAITING_MERGER_MSG, attempt: mkAttempt(null, false, "temporary", e.message, "merger") });
      return { taskId, state: "processing" };
    }
    const m = sanitizeForClient(errMessage(e));
    await updateTask(taskId, { status: "failed", error_message: m, attempt: mkAttempt(null, false, "provider", errMessage(e), "merger") });
    return { taskId, state: "failed", message: m };
  }

  // 4) نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم + كتابة الحالة في Turso فورًا كل مرة
  const deadline = Date.now() + clampWait(args.wait_seconds, DEFAULT_WAIT.merge) * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    tick++;
    const st = await merger.getMergeJob(jobId);
    if (st.status === "done" && st.videoUrl) {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl]) });
      await onProgress?.({ progress: 100, total: 100, message: "اكتمل الدمج 100%" });
      return { taskId, state: "completed", urls: [st.videoUrl] };
    }
    if (st.status === "not_found") {
      const m = "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
      await updateTask(taskId, { status: "failed", error_message: m });
      return { taskId, state: "failed", message: m };
    }
    if (st.status === "failed") {
      // خطأ معلن من الخدمة = فشل نهائي فوري
      const m = sanitizeForClient(st.error || "فشل الدمج في الخدمة");
      await updateTask(taskId, { status: "failed", error_message: m });
      return { taskId, state: "failed", message: m };
    }
    const p = Math.max(2, Math.min(95, st.progress ?? Math.min(90, 5 + tick * 4)));
    await updateTask(taskId, { status: "processing", progress: p });
    await onProgress?.({ progress: Math.round(p), total: 100, message: `قيد الدمج… ${Math.round(p)}%` });
  }
  return { taskId, state: "processing" };
}

// تحديث حي لمهمة دمج عند get_task
async function refreshMergeView(t: TaskRow): Promise<TaskView> {
  if (!t.provider_task_id) {
    // لم ينجح الإنشاء بعد لدى الخدمة ⇒ أعد المحاولة بعد تهدئة 45 ثانية
    const last = lastAttemptMs(t);
    if (last && Date.now() - last < RETRY_COOLDOWN_MS) return processingView(t);
    const args = safeParse(t.params_json) as Record<string, unknown>;
    const combined = (Array.isArray(args.combinedUrls) ? args.combinedUrls : []) as string[];
    if (!merger.mergerConfigured() || combined.length < 2) return processingView(t);
    try {
      const job = await merger.createMergeJob(combined);
      await updateTask(t.id, { provider_task_id: job.jobId, status: "processing", progress: 2, attempt: mkAttempt(null, true, null, null, "merger") });
      launchMergeProcess(job.jobId);
      return processingView({ ...t, provider_task_id: job.jobId, status: "processing" });
    } catch (e) {
      if (e instanceof ProviderError && e.status === null) {
        await updateTask(t.id, { attempt: mkAttempt(null, false, "temporary", e.message, "merger") });
        return processingView(t);
      }
      const m = sanitizeForClient(errMessage(e));
      await updateTask(t.id, { status: "failed", error_message: m, attempt: mkAttempt(null, false, "provider", errMessage(e), "merger") });
      return failedView({ ...t, status: "failed", error_message: m });
    }
  }

  const jobId = t.provider_task_id as string;
  // إن كانت قيد المعالجة ولم يُنفَّذ process بعد فنفّذه الآن (القفل يمنع التزامن)
  launchMergeProcess(jobId);

  const st = await merger.getMergeJob(jobId);
  if (st.status === "done" && st.videoUrl) {
    await updateTask(t.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl]) });
    return completedView({ ...t, status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl]) });
  }
  if (st.status === "not_found") {
    const m = "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
    await updateTask(t.id, { status: "failed", error_message: m });
    return failedView({ ...t, status: "failed", error_message: m });
  }
  if (st.status === "failed") {
    const m = sanitizeForClient(st.error || "فشل الدمج في الخدمة");
    await updateTask(t.id, { status: "failed", error_message: m });
    return failedView({ ...t, status: "failed", error_message: m });
  }
  const p = Math.max(t.progress, Math.min(99, st.progress ?? t.progress));
  await updateTask(t.id, { status: "processing", progress: p });
  return processingView({ ...t, progress: p });
}
