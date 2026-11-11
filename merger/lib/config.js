'use strict';
/**
 * الإعدادات المركزية — تُقرأ من متغيرات البيئة مع قيم افتراضية آمنة.
 * كل الحدود قابلة للضبط من بيئة الاستضافة دون تعديل الكود.
 */
const MB = 1024 * 1024;

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const config = {
  version: '2.0.0',
  // الحدود العامة (قابلة للضبط)
  maxSources: intEnv('MAX_SOURCES', 10),
  sourceMaxBytes: intEnv('SOURCE_MAX_MB', 200) * MB,
  outputMaxBytes: intEnv('OUTPUT_MAX_MB', 150) * MB,
  maxTotalDurationSec: intEnv('MAX_TOTAL_DURATION_SEC', 600),
  ffmpegPreset: process.env.FFMPEG_PRESET || 'medium',

  // ثوابت النقل والتخزين
  uploadChunkBytes: 4 * MB,   // حجم جزء الرفع الثنائي من العميل (octet-stream)
  blobRowBytes: 2 * MB,       // كل Blob يُقسَّم إلى صفوف 2MB (أمان فوق حد HTTP في Turso — مفحوص فعليًا)
  readPageRows: 8,            // القراءة التدفقية: 8 صفوف لكل استعلام
  insertBatchRows: 4,         // صفوف الإدخال لكل دفعة كتابة (≈8MB لكل طلب — ضمن حدود Turso المفحوصة)

  // مدة الاحتفاظ بالمهام والناتج
  retentionMs: 24 * 60 * 60 * 1000, // 24 ساعة

  // حد JSON لجسم الطلبات الإدارية
  maxBodyJsonBytes: 512 * 1024,

  // حماية داخلية إضافية: أقصى مجموع لأحجام المصادر في /tmp أثناء المعالجة
  // (بيئة الاستضافة المؤقتة محدودة السعة — منع الانهيار برسالة واضحة بدلًا منهاره صامت)
  tmpSourcesLimitBytes: 400 * MB,
};

module.exports = config;
