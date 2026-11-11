'use strict';
/**
 * قاعدة Turso (libSQL) — كل شيء يُخزَّن هنا: المهام، أجزاء ملفات المصادر، والفيديو الناتج.
 * لا S3 ولا خدمات خارجية — فقط Turso + ffmpeg.
 */
const { createClient } = require('@libsql/client');

let client = null;
let schemaPromise = null;

function getDb() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      const err = new Error('متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان');
      err.status = 500;
      throw err;
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

/**
 * إنشاء جداول هذا المشروع مرة واحدة لكل عملية (عملية Vercel / عملية dev-server).
 * ملاحظة مهمة: لا نلمس جداول المشاريع الأخرى الموجودة في نفس القاعدة (tasks, api_keys).
 */
function initSchema() {
  if (!schemaPromise) {
    const db = getDb();
    schemaPromise = db
      .batch(
        [
          // جدول المهام — الحالات: queued → (uploading) → processing → done | failed
          `CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'queued',
            progress INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            video_size INTEGER,
            duration REAL,
            resolution TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          )`,
          // مصادر المهمة (روابط أو ملفات مرفوعة) — seq يحدد ترتيب الدمج
          `CREATE TABLE IF NOT EXISTS sources (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            url TEXT,
            name TEXT,
            mime TEXT,
            size INTEGER,
            received INTEGER NOT NULL DEFAULT 0,
            chunks_received INTEGER NOT NULL DEFAULT 0,
            rows_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          )`,
          // أجزاء ملفات المصادر — مفتاح أساسي مركب (job_id, source_id, seq)
          `CREATE TABLE IF NOT EXISTS source_chunks (
            job_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, source_id, seq)
          )`,
          // أجزاء الفيديو الناتج — صفوف ثابتة الحجم (2MB) لدعم حساب الإزاحات في بث Range
          `CREATE TABLE IF NOT EXISTS output_chunks (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, seq)
          )`,
        ],
        'write'
      )
      .catch((e) => {
        schemaPromise = null; // السماح بإعادة المحاولة في الطلب التالي
        throw e;
      });
  }
  return schemaPromise;
}

module.exports = { getDb, initSchema };
