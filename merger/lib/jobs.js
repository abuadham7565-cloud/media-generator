'use strict';
/**
 * منطق المهام: التحقق من المدخلات، الإنشاء، الاستعلام، تحديث الحالة/التقدم،
 * الحذف الشامل في دفعة واحدة، والتنظيف التلقائي للمهام المنتهية (24 ساعة).
 */
const crypto = require('crypto');
const config = require('./config');
const { getDb } = require('./db');
const { ApiError } = require('./http');

/** تحويل صف jobs إلى كائن camelCase */
function mapJob(row) {
  return {
    id: row.id,
    status: row.status,
    progress: Number(row.progress) || 0,
    error: row.error || null,
    videoSize: row.video_size == null ? null : Number(row.video_size),
    duration: row.duration == null ? null : Number(row.duration),
    resolution: row.resolution || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function mapSource(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    seq: Number(row.seq),
    kind: row.kind,
    url: row.url || null,
    name: row.name || null,
    mime: row.mime || null,
    size: row.size == null ? null : Number(row.size),
    received: Number(row.received) || 0,
    chunksReceived: Number(row.chunks_received) || 0,
    rowsCount: Number(row.rows_count) || 0,
  };
}

/**
 * التحقق من قائمة المصادر القادمة من POST /api/jobs
 * وترييطها إلى شكل موحد [{kind:'url'|'file', url?, name?, size?, mime?}]
 * — يرمي ApiError برسائل عربية وكود صحيح عند أي إساءة.
 */
function validateSources(raw) {
  if (!Array.isArray(raw)) throw new ApiError(400, 'أرسل قائمة مصادر صالحة: {"videos":[...]} أو {"sources":[...]}');
  if (raw.length === 0) throw new ApiError(400, 'لا توجد مصادر للدمج — أضف رابطًا أو ملفًا واحدًا على الأقل');
  if (raw.length > config.maxSources) {
    throw new ApiError(400, `عدد المصادر (${raw.length}) يتجاوز الحد الأقصى (${config.maxSources})`);
  }
  return raw.map((item, i) => {
    // يقبل نصًا مجردًا كرابط أو كائنًا بصيغة sources
    if (typeof item === 'string') item = { kind: 'url', url: item };
    if (!item || typeof item !== 'object') throw new ApiError(400, `المصدر رقم ${i + 1} غير صالح`);
    const kind = item.kind || (item.url ? 'url' : 'file');
    if (kind === 'url') {
      const url = String(item.url || '').trim();
      if (!url) throw new ApiError(400, `المصدر رقم ${i + 1}: الرابط فارغ`);
      let u;
      try { u = new URL(url); } catch (_) { throw new ApiError(400, `المصدر رقم ${i + 1}: رابط غير صالح`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new ApiError(400, `المصدر رقم ${i + 1}: بروتوكول غير مدعوم — استخدم http أو https`);
      }
      if (url.length > 2048) throw new ApiError(400, `المصدر رقم ${i + 1}: الرابط أطول من المسموح`);
      return { kind: 'url', url };
    }
    if (kind === 'file') {
      const name = String(item.name || `video-${i + 1}.mp4`).slice(0, 200);
      const size = Number(item.size);
      if (!Number.isInteger(size) || size <= 0) throw new ApiError(400, `الملف «${name}»: الحجم المعلن غير صالح`);
      if (size > config.sourceMaxBytes) {
        throw new ApiError(413, `حجم الملف «${name}» يتجاوز الحد المسموح (${Math.floor(config.sourceMaxBytes / 1048576)}MB لكل مصدر)`);
      }
      const mime = typeof item.mime === 'string' && item.mime ? item.mime.slice(0, 100) : 'video/mp4';
      return { kind: 'file', name, size, mime };
    }
    throw new ApiError(400, `المصدر رقم ${i + 1}: نوع غير مدعوم — استخدم kind=url أو kind=file`);
  });
}

/** إنشاء مهمة جديدة مع صفوف مصادرها في دفعة واحدة */
async function createJob(sources) {
  const db = getDb();
  const id = 'job-' + crypto.randomUUID().replace(/-/g, '');
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.retentionMs).toISOString();
  // إن وُجدت ملفات تحتاج رفعًا → uploading، وإلا المهمة جاهزة مباشرة
  const status = sources.some((s) => s.kind === 'file') ? 'uploading' : 'queued';
  const stmts = [
    {
      sql: 'INSERT INTO jobs (id, status, progress, created_at, expires_at) VALUES (?, ?, 0, ?, ?)',
      args: [id, status, createdAt, expiresAt],
    },
    ...sources.map((s, i) => ({
      sql: 'INSERT INTO sources (id, job_id, seq, kind, url, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        'src-' + crypto.randomUUID().replace(/-/g, ''),
        id, i, s.kind, s.url || null, s.name || null, s.mime || null, s.size == null ? null : s.size, createdAt,
      ],
    })),
  ];
  await db.batch(stmts, 'write');
  const job = await getJob(id);
  // نعيد صفوف المصادر من القاعدة لتحمل المعرفات الفعلية (src-...) المطلوبة للرفع
  const saved = await getSources(id);
  return { ...job, sources: saved };
}

async function getJob(id) {
  const r = await getDb().execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return r.rows.length ? mapJob(r.rows[0]) : null;
}

async function getSources(jobId) {
  const r = await getDb().execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? ORDER BY seq',
    args: [jobId],
  });
  return r.rows.map(mapSource);
}

/** قائمة مختصرة بأحدث المهام (GET /api/jobs) */
async function listJobs(limit = 20) {
  const r = await getDb().execute({
    sql: 'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?',
    args: [limit],
  });
  return r.rows.map(mapJob);
}

/** تحديث حقول مسموحة فقط في المهمة */
async function updateJob(id, fields) {
  const allowed = ['status', 'progress', 'error', 'video_size', 'duration', 'resolution'];
  const cols = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    cols.push(`${k} = ?`);
    args.push(v);
  }
  if (!cols.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`, args });
}

/** تحديث عدادات المصدر بعد استلام كل جزء رفع */
async function updateSource(jobId, sourceId, fields) {
  const cols = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = ?`);
    args.push(v);
  }
  if (!cols.length) return;
  args.push(jobId, sourceId);
  await getDb().execute({ sql: `UPDATE sources SET ${cols.join(', ')} WHERE job_id = ? AND id = ?`, args });
}

/**
 * حفظ تقدم المعالجة (0–100) في القاعدة:
 * 0–40 سحب المصادر، 40–90 ترميز، 90–100 حفظ الناتج.
 */
async function setProgress(id, pct) {
  const p = Math.max(0, Math.min(99, Math.round(pct)));
  await getDb().execute({ sql: 'UPDATE jobs SET progress = ? WHERE id = ?', args: [p, id] });
}

async function finishJob(id, { size, duration, resolution }) {
  await updateJob(id, { status: 'done', progress: 100, error: null, video_size: size, duration, resolution });
}

async function failJob(id, message) {
  await updateJob(id, { status: 'failed', error: String(message || 'خطأ غير معروف').slice(0, 500) });
}

/** هل اكتمل رفع كل مصادر الملفات؟ */
function isAllUploaded(sources) {
  return sources.every((s) => s.kind === 'url' || s.size == null || s.received === s.size);
}

/**
 * الحذف الفوري الشامل لمهمة: jobs + sources + source_chunks + output_chunks
 * في دفعة (معاملة) واحدة — لا بقايا Blobs في القاعدة.
 */
async function deleteCascade(id) {
  await getDb().batch(
    [
      { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
    ],
    'write'
  );
}

/**
 * التنظيف الكسول: حذف كل مهمة انتهت صلاحيتها (created_at + 24 ساعة)
 * — يُستدعى عند كل إنشاء/دمج وإن نقطة /api/cron اليومية.
 */
async function cleanupExpired() {
  const db = getDb();
  const now = new Date().toISOString();
  const r = await db.execute({ sql: 'SELECT id FROM jobs WHERE expires_at <= ?', args: [now] });
  let deleted = 0;
  for (const row of r.rows) {
    await deleteCascade(row.id);
    deleted++;
  }
  return deleted;
}

module.exports = {
  validateSources,
  createJob,
  getJob,
  getSources,
  listJobs,
  updateJob,
  updateSource,
  setProgress,
  finishJob,
  failJob,
  isAllUploaded,
  deleteCascade,
  cleanupExpired,
};
