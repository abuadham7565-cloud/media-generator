'use strict';
/**
 * POST /api/jobs  → إنشاء مهمة دمج جديدة (روابط و/أو ملفات)
 * GET  /api/jobs  → قائمة مختصرة بأحدث المهام
 */
const config = require('../lib/config');
const { initSchema } = require('../lib/db');
const { api, json, fail, baseUrl, readJson, ApiError } = require('../lib/http');
const jobs = require('../lib/jobs');

module.exports = api(async (req, res) => {
  await initSchema();

  if (req.method === 'POST') {
    const body = await readJson(req);

    // يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{kind,url|file}]} — أو نصًا واحدًا
    let raw;
    if (body && Array.isArray(body.sources)) {
      raw = body.sources;
    } else if (body && Array.isArray(body.videos)) {
      raw = body.videos;
    } else if (body && typeof body.videos === 'string') {
      raw = [body.videos];
    }
    const normalized = jobs.validateSources(raw);

    // تنظيف كسول للمهام المنتهية — لا يعطل الطلب عند أي خلل
    jobs.cleanupExpired().catch(() => {});

    const created = await jobs.createJob(normalized);
    const base = baseUrl(req); // روابط مطلقة من رابط الطلب الأصلي
    const resp = {
      jobId: created.id,
      status: created.status,
      statusUrl: `${base}/api/jobs/${created.id}`,
      processUrl: `${base}/api/jobs/${created.id}/process`,
      expiresAt: created.expiresAt,
    };
    // إن وُجدت ملفات: نرجع رابط رفع لكل مصدر + حجم الجزء الثابت 4MB
    const files = normalized.filter((s) => s.kind === 'file');
    if (files.length) {
      resp.uploadChunkBytes = config.uploadChunkBytes;
      resp.uploads = files.map((s) => ({
        seq: s.seq,
        name: s.name,
        size: s.size,
        mime: s.mime,
        chunks: Math.ceil(s.size / config.uploadChunkBytes),
        uploadUrl: `${base}/api/upload?job=${created.id}&seq=${s.seq}&chunk=0`,
      }));
    }
    return json(res, 201, resp);
  }

  if (req.method === 'GET') {
    const list = await jobs.listJobs(20);
    return json(res, 200, {
      jobs: list.map((j) => ({
        jobId: j.id,
        status: j.status,
        progress: j.progress,
        resolution: j.resolution,
        size: j.videoSize,
        createdAt: j.createdAt,
        expiresAt: j.expiresAt,
      })),
    });
  }

  return fail(res, 405, 'الطريقة غير مسموحة — استخدم POST لإنشاء مهمة أو GET للقائمة');
});
