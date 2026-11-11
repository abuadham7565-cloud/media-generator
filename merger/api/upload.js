'use strict';
/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k>
 * رفع أجزاء الملفات الثنائية (octet-stream ≤4MB) وتخزينها كصفوف Blobs في Turso.
 * التسلسل صارم: chunk يجب أن يساوي عدد الأجزاء المستلمة — إعادة إرسال نفس الجزء
 * تعتبر مكررًا وتنجح (idempotent) لدعم إعادة المحاولة التلقائية من العميل.
 */
const config = require('../lib/config');
const { initSchema } = require('../lib/db');
const { api, json, fail, readBody, ID_RE } = require('../lib/http');
const jobs = require('../lib/jobs');
const storage = require('../lib/storage');

const MB = 1024 * 1024;

module.exports = api(async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'الطريقة غير مسموحة — استخدم POST');
  await initSchema();

  const q = req.query || {};
  const jobId = String(q.job || '');
  const seq = Number(q.seq);
  const chunk = Number(q.chunk);
  if (!ID_RE.test(jobId)) return fail(res, 404, 'المهمة غير موجودة');
  if (!Number.isInteger(seq) || seq < 0 || seq > 1000) return fail(res, 400, 'رقم المصدر seq غير صالح');
  if (!Number.isInteger(chunk) || chunk < 0) return fail(res, 400, 'رقم الجزء chunk غير صالح');

  const job = await jobs.getJob(jobId);
  if (!job) return fail(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
  if (job.status === 'processing' || job.status === 'done') {
    return fail(res, 409, `لا يمكن الرفع أثناء حالة المهمة «${job.status}»`);
  }

  const sources = await jobs.getSources(jobId);
  const src = sources.find((s) => s.seq === seq);
  if (!src) return fail(res, 404, 'المصدر المطلوب غير موجود في هذه المهمة');
  if (src.kind !== 'file') return fail(res, 409, 'هذا المصدر رابط ولا يحتاج إلى رفع ملفات');

  const ctype = String(req.headers['content-type'] || '');
  if (ctype.includes('multipart/form-data')) {
    return fail(res, 400, 'أرسل البيانات الثنائية الخام مباشرة (Content-Type: application/octet-stream) — بدون multipart');
  }

  // سقف الجزء 4MB — أي تجاوز يُرفض فورًا (413) دون تحميله كاملًا في الذاكرة
  const body = await readBody(req, config.uploadChunkBytes + 1);
  if (body.over) {
    return fail(res, 413, `حجم الجزء يتجاوز الحد الأقصى (${config.uploadChunkBytes / MB}MB للجزء الواحد)`);
  }
  if (!body.buf || body.buf.length === 0) return fail(res, 400, 'الجزء فارغ');

  // التسلسل الصارم — مع تسامح مع التكرار (إعادة إرسال نفس الجزء بعد فشل شبكي)
  if (chunk < src.chunksReceived) {
    return json(res, 200, {
      ok: true, duplicate: true, jobId, seq, chunk,
      received: src.received, size: src.size, complete: src.received === src.size,
      jobStatus: job.status,
    });
  }
  if (chunk > src.chunksReceived) {
    return fail(res, 409, `الجزء رقم ${chunk} خارج الترتيب — أرسل الجزء رقم ${src.chunksReceived} أولًا`);
  }

  const receivedAfter = src.received + body.buf.length;
  if (src.size != null && receivedAfter > src.size) {
    return fail(res, 413, 'البايتات المرسلة تتجاوز الحجم المعلن للملف');
  }

  // تقسيم الجزء (≤4MB) إلى صفوف ≤2MB تخزينًا — يتوافق مع حد طلبات Turso
  const rowsAdded = await storage.appendUploadChunk(jobId, src.id, src.rowsCount, body.buf);
  const complete = src.size == null ? false : receivedAfter === src.size;
  await jobs.updateSource(jobId, src.id, {
    received: receivedAfter,
    chunks_received: chunk + 1,
    rows_count: src.rowsCount + rowsAdded,
  });

  // اكتملت كل المصادر؟ نعيد المهمة إلى queued لتصبح جاهزة للدمج
  let jobStatus = job.status;
  if (complete) {
    const fresh = await jobs.getSources(jobId);
    if (jobs.isAllUploaded(fresh) && job.status === 'uploading') {
      await jobs.updateJob(jobId, { status: 'queued' });
      jobStatus = 'queued';
    }
  }

  return json(res, 200, {
    ok: true, jobId, seq, chunk,
    received: receivedAfter, size: src.size, complete, jobStatus,
  });
});
