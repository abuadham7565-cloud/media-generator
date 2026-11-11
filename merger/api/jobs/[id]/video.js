'use strict';
/**
 * GET /api/jobs/<id>/video → بث الفيديو الناتج من صفوف Blobs في Turso.
 * نقطة حرجة: دعم Range (206 + Content-Range) ليعمل التقديم/الترجيع في المشغل —
 * نحوّل صفوف الـ Blobs إلى تدفق مع تقليم أول/آخر جزء حسب المدى المطلوب.
 * ?download=1 → ترويسة تنزيل بدل التشغيل المباشر.
 */
const { initSchema } = require('../../../lib/db');
const { api, fail, ID_RE } = require('../../../lib/http');
const jobs = require('../../../lib/jobs');
const storage = require('../../../lib/storage');

module.exports = api(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'الطريقة غير مسموحة — استخدم GET');
  }
  await initSchema();

  const id = String((req.query && req.query.id) || '');
  if (!ID_RE.test(id)) return fail(res, 404, 'المهمة غير موجودة');

  const job = await jobs.getJob(id);
  if (!job) return fail(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
  if (job.status !== 'done' || !job.videoSize) {
    return fail(res, 409, `الفيديو غير جاهز بعد — حالة المهمة «${job.status}»`);
  }

  const total = job.videoSize;
  const download = req.query.download === '1' || req.query.download === 'true';

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes'); // نُعلن دعم المدى للمشغل
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (download) {
    res.setHeader('Content-Disposition', `attachment; filename="merged-${id.slice(0, 8)}.mp4"`);
  }

  // تحليل ترويسة Range: bytes=start-end | bytes=start- | bytes=-suffix
  let start = 0;
  let end = total - 1;
  let status = 200;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return fail(res, 416, 'مدى البايتات المطلوب غير صالح');
    }
    if (m[1] === '') {
      // لاحقة: آخر N بايت
      const n = Math.min(parseInt(m[2], 10), total);
      start = total - n;
      end = total - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
    }
    if (!Number.isFinite(start) || start >= total || start > end) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return fail(res, 416, 'المدى المطلوب خارج حدود الملف');
    }
    status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  }

  res.statusCode = status;
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();

  // صفحات من 8 صفوف من القاعدة → تدفق مع تقليم أول/آخر جزء حسب المدى
  const stream = storage.createRangeStream(id, start, end);
  res.on('close', () => stream.destroy()); // تنظيف عند إغلاق العميل (منع تسريب)
  stream.pipe(res);
});
