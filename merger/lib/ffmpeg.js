'use strict';
/**
 * أدوات ffmpeg/ffprobe: حل المسارات (ffmpeg-static كأساسي مع سقوط آمن للنظامي)
 * وضمان صلاحية التنفيذ في الاستضافة.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

// مسارات بديلة للنظام عند غياب حزم npm الثابتة
const SYSTEM_FALLBACKS = {
  ffmpeg: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'],
  ffprobe: ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe', '/opt/homebrew/bin/ffprobe'],
};

const cache = {};

/** حل المسار: حزم static أولًا ثم الثنائي النظامي */
function resolvePath(kind) {
  if (cache[kind]) return cache[kind];
  let p = null;
  try {
    if (kind === 'ffmpeg') {
      const m = require('ffmpeg-static'); // يصدّر مسار السلسلة النصية مباشرة
      if (typeof m === 'string' && fs.existsSync(m)) p = m;
    } else {
      const m = require('ffprobe-static'); // يصدّر { path }
      if (m && typeof m.path === 'string' && fs.existsSync(m.path)) p = m.path;
    }
  } catch (_) {
    // الحزمة غير متاحة — سقوط آمن إلى الثنائي النظامي
  }
  if (!p) {
    for (const c of SYSTEM_FALLBACKS[kind]) {
      if (fs.existsSync(c)) { p = c; break; }
    }
  }
  if (!p) throw new Error(`لم يتم العثور على الثنائي ${kind} ولا في الحزم ولا في النظام`);
  cache[kind] = p;
  return p;
}

/**
 * ensureExecutable: ثنائيات ffmpeg قد تفقد صلاحية التنفيذ في الاستضافة (+x مفقود
 * أو نظام ملفات بدون exec). الحل: نسخ الملف إلى /tmp وإعطاؤه 755 ثم التحقق فعليًا
 * بتنفيذ -version — إذا نجح نستخدم النسخة المؤقتة ونجلبها في الكاش.
 */
async function ensureExecutable(kind) {
  const orig = resolvePath(kind);
  try {
    await execFileP(orig, ['-version'], { maxBuffer: 1024 * 1024 });
    return orig;
  } catch (_) {
    const tmp = path.join(os.tmpdir(), `vm-${kind}-${path.basename(orig)}`);
    await fsp.copyFile(orig, tmp);
    await fsp.chmod(tmp, 0o755);
    await execFileP(tmp, ['-version'], { maxBuffer: 1024 * 1024 }); // تحقق نهائي — فشل هنا = خطأ واضح
    cache[kind] = tmp;
    return tmp;
  }
}

module.exports = { ensureExecutable, resolvePath };
