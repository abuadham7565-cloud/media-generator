'use strict';
/**
 * POST /api/jobs/<id>/process → تنفيذ الدمج كاملًا (متزامن) حتى رابط الفيديو النهائي.
 * - لو المهمة قيد المعالجة فعله → 202 {"status":"processing","progress":n}
 * - لو مكتملة سلفًا → 200 بنفس نتيجة الإنجاز (idempotent)
 * - لو فشلت سلفًا → يُسمح بإعادة المحاولة (الأجزاء لا تُحذف إلا بعد النجاح)
 */
const { initSchema } = require('../../../lib/db');
const { api, json, fail, baseUrl, ID_RE } = require('../../../lib/http');
const jobs = require('../../../lib/jobs');
const { processJob } = require('../../../lib/merge');

module.exports = api(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'الطريقة غير مسموحة — استخدم POST');
  await initSchema();

  const id = String((req.query && req.query.id) || '');
  if (!ID_RE.test(id)) return fail(res, 404, 'المهمة غير موجودة');

  const job = await jobs.getJob(id);
  if (!job) return fail(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');

  // قيد المعالجة فعله → 202 (يستمر الاستطلاع على GET /api/jobs/<id>)
  if (job.status === 'processing') {
    return json(res, 202, { status: 'processing', progress: job.progress });
  }

  // مكتملة → إعادة النتيجة نفسها دون إعادة دمج
  if (job.status === 'done') {
    const base = baseUrl(req);
    return json(res, 200, {
      status: 'done',
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: job.videoSize,
      duration: job.duration,
      resolution: job.resolution,
      expiresAt: job.expiresAt,
    });
  }

  // تنظيف كسول للمهام المنتهية قبل البدء
  await jobs.cleanupExpired().catch(() => {});

  try {
    const result = await processJob(id, (pct) => {
      jobs.setProgress(id, pct).catch(() => {});
    });
    const base = baseUrl(req);
    const fresh = await jobs.getJob(id);
    return json(res, 200, {
      status: 'done',
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: fresh ? fresh.expiresAt : null,
    });
  } catch (e) {
    // الأخطاء المعروفة (رمز + رسالة عربية) — غيرها 500 برسالة عامة آمنة
    if (e && e.status && e.status !== 202) {
      return fail(res, e.status, e.message);
    }
    if (e && e.status === 202) {
      return json(res, 202, e.payload || { status: 'processing', progress: 0 });
    }
    return fail(res, 500, 'فشل تنفيذ الدمج — جرّب مجددًا');
  }
});
