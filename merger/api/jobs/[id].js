'use strict';
/**
 * GET    /api/jobs/<id> → الحالة + التقدم (0–100) + الرابط عند الاكتمال
 * DELETE /api/jobs/<id> → حذف فوري شامل (المهمة + المصادر + كل الأجزاء)
 * المسار الديناميكي يصل في req.query.id (على Vercel ومحاكي dev-server معًا).
 */
const { initSchema } = require('../../lib/db');
const { api, json, fail, baseUrl, ID_RE } = require('../../lib/http');
const jobs = require('../../lib/jobs');

module.exports = api(async (req, res) => {
  await initSchema();
  const id = String((req.query && req.query.id) || '');
  if (!ID_RE.test(id)) return fail(res, 404, 'المهمة غير موجودة');

  if (req.method === 'GET') {
    const job = await jobs.getJob(id);
    if (!job) return fail(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');

    const payload = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      remainingSeconds: Math.max(0, Math.floor((new Date(job.expiresAt).getTime() - Date.now()) / 1000)),
    };
    if (job.status === 'done') {
      const base = baseUrl(req);
      payload.videoUrl = `${base}/api/jobs/${id}/video`;
      payload.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
      payload.size = job.videoSize;
      payload.duration = job.duration;
      payload.resolution = job.resolution;
    }
    return json(res, 200, payload);
  }

  if (req.method === 'DELETE') {
    const job = await jobs.getJob(id);
    if (!job) return fail(res, 404, 'المهمة غير موجودة أو حُذفت مسبقًا');
    // حذف شامل في دفعة واحدة: jobs + sources + source_chunks + output_chunks
    await jobs.deleteCascade(id);
    return json(res, 200, { ok: true, jobId: id, deleted: true });
  }

  return fail(res, 405, 'الطريقة غير مسموحة — استخدم GET للحالة أو DELETE للحذف');
});
