'use strict';
/**
 * طبقة التخزين فوق Turso: كل Blob (أجزاء المصادر والفيديو الناتج) يُقسَّم إلى صفوف
 * صغيرة (2MB) لأن حد طلبات HTTP في Turso لا يسمح بـ Blobs أكبر — مفحوص فعليًا.
 * القراءة تدفقية بصفحات من 8 صفوف مع backpressure حقيقي.
 */
const fs = require('fs');
const fsp = fs.promises;
const { PassThrough } = require('stream');
const { once } = require('events');
const config = require('./config');
const { getDb } = require('./db');

const ROW = config.blobRowBytes; // 2MB — الصفوف كلها بهذا الحجم عدا الأخير (للناتج فقط)

/** توحيد شكل قيمة BLOB العائدة من libsql (ArrayBuffer | Uint8Array | string) إلى Buffer */
function toBuffer(v) {
  if (v == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  return Buffer.from(v);
}

/**
 * تخزين جزء رفع قادم من العميل (≤4MB) كصفوف ≤2MB في source_chunks.
 * نعيد عدد الصفوف المضافة ليُحدَّث عداد rows_count في جدول sources.
 */
async function appendUploadChunk(jobId, sourceId, startRowSeq, buf) {
  const db = getDb();
  const rows = [];
  for (let off = 0; off < buf.length; off += ROW) {
    rows.push(buf.subarray(off, Math.min(off + ROW, buf.length)));
  }
  if (rows.length === 0) rows.push(Buffer.alloc(0));
  const stmts = rows.map((r, i) => ({
    sql: 'INSERT INTO source_chunks (job_id, source_id, seq, data) VALUES (?, ?, ?, ?)',
    args: [jobId, sourceId, startRowSeq + i, Buffer.from(r)],
  }));
  // دفعات صغيرة لكل طلب HTTP — حجم الدفعة ≈ insertBatchRows × 2MB (أمان فوق حد Turso)
  for (let i = 0; i < stmts.length; i += config.insertBatchRows) {
    await db.batch(stmts.slice(i, i + config.insertBatchRows), 'write');
  }
  return rows.length;
}

/** تجميع ملف مصدر من صفوفه إلى ملف في /tmp — قراءة تدفقية بصفحات من 8 صفوف */
async function assembleSourceToFile(jobId, sourceId, outPath) {
  const db = getDb();
  const ws = fs.createWriteStream(outPath);
  ws.on('error', () => { /* تُلتقط عبر await أدناه */ });
  let seq = 0;
  try {
    while (true) {
      const r = await db.execute({
        sql: 'SELECT seq, data FROM source_chunks WHERE job_id = ? AND source_id = ? AND seq >= ? ORDER BY seq LIMIT ?',
        args: [jobId, sourceId, seq, config.readPageRows],
      });
      if (r.rows.length === 0) break;
      for (const row of r.rows) {
        const b = toBuffer(row.data);
        if (b.length && !ws.write(b)) await once(ws, 'drain'); // backpressure حقيقي
      }
      seq = Number(r.rows[r.rows.length - 1].seq) + 1;
      if (r.rows.length < config.readPageRows) break;
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
  } catch (e) {
    ws.destroy();
    try { await fsp.unlink(outPath); } catch (_) { /* غير موجود */ }
    throw e;
  }
  return seq; // عدد الصفوف المقروءة
}

/**
 * حفظ ملف الفيديو الناتج في output_chunks:
 * صفوف ثابتة الحجم (2MB) عدا الأخير — هذا ما يجعل إزاحة أي صف = seq × 2MB
 * ويسمح ببث Range دقيق دون قراءة كامل الملف.
 */
async function saveOutputFromFile(jobId, filePath, onProgress) {
  const db = getDb();
  const fh = await fsp.open(filePath, 'r');
  const buf = Buffer.alloc(ROW);
  let seq = 0;
  let total = 0;
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await db.batch(batch, 'write');
    batch = [];
    batchBytes = 0;
  };
  try {
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, ROW, null);
      if (!bytesRead) break;
      const piece = Buffer.from(buf.subarray(0, bytesRead)); // نسخة مستقلة لأن buf يُعاد استخدامه
      batch.push({
        sql: 'INSERT INTO output_chunks (job_id, seq, data) VALUES (?, ?, ?)',
        args: [jobId, seq++, piece],
      });
      batchBytes += bytesRead;
      total += bytesRead;
      if (batch.length >= config.insertBatchRows || batchBytes >= 6 * 1024 * 1024) {
        await flush();
        if (onProgress) onProgress(total);
      }
    }
    await flush();
  } finally {
    await fh.close();
  }
  return { size: total, rows: seq };
}

/** قراءة صفوف الناتج ضمن مدى صفوف محدد [fromSeq..toSeq] */
async function readOutputRows(jobId, fromSeq, toSeq) {
  const r = await getDb().execute({
    sql: 'SELECT seq, data FROM output_chunks WHERE job_id = ? AND seq >= ? AND seq <= ? ORDER BY seq',
    args: [jobId, fromSeq, toSeq],
  });
  return r.rows.map((row) => toBuffer(row.data));
}

/**
 * بث الناتج مع دعم Range: نحوّل صفوف الـ Blobs إلى تدفق PassThrough،
 * نجلب صفحات من 8 صفوف فقط، ونقلّم أول/آخر جزء حسب المدى المطلوب [start..end].
 * الإزاحة الحسابية ممكنة لأن كل صف عدا الأخير بطول ROW بالضبط.
 */
function createRangeStream(jobId, start, end) {
  const pt = new PassThrough({ highWaterMark: 512 * 1024 });
  (async () => {
    const firstRow = Math.floor(start / ROW);
    const lastRow = Math.floor(end / ROW);
    for (let pageStart = firstRow; pageStart <= lastRow; pageStart += config.readPageRows) {
      const pageEnd = Math.min(pageStart + config.readPageRows - 1, lastRow);
      const rows = await readOutputRows(jobId, pageStart, pageEnd);
      if (rows.length === 0) break; // بيانات ناقصة — ننهي التدفق (نادر جدًا)
      for (let i = 0; i < rows.length; i++) {
        const rowIdx = pageStart + i;
        const buf = rows[i];
        const rowStart = rowIdx * ROW;
        // تقليم الحدود: أبقِ البايتات الواقعة داخل [start..end] فقط
        const from = Math.max(start, rowStart) - rowStart;
        const to = Math.min(end, rowStart + buf.length - 1) - rowStart;
        if (to < from) continue;
        if (!pt.write(buf.subarray(from, to + 1))) await once(pt, 'drain');
      }
    }
    pt.end();
  })().catch((err) => pt.destroy(err));
  return pt;
}

/** حذف أجزاء المصادر بعد نجاح الدمج — الناتج فقط هو المطلوب إبقاءه */
async function deleteSourceChunks(jobId) {
  await getDb().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] });
}

module.exports = {
  appendUploadChunk,
  assembleSourceToFile,
  saveOutputFromFile,
  readOutputRows,
  createRangeStream,
  deleteSourceChunks,
  toBuffer,
};
