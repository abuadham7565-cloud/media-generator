#!/usr/bin/env node
/**
 * اختبار وحدات لمحرك الدمج والتخزين — يجري فعليًا ضد قاعدة Turso الحقيقية:
 *  1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (أحدهما بلا صوت)
 *  2) دمجهما عبر محرك الدمج مباشرة (runMerge) والتحقق من: الاكتمال، الدقة = أكبر دقة،
 *     المدة ≈ مجموع المدد، وجود الصوت
 *  3) تخزين الناتج في Turso واسترجاعه بتطابق sha256
 *  4) مسار رفع الأجزاء (appendUploadChunk → assembleSourceToFile) بتطابق sha256
 *  5) حدود الحجم (config) ورفض القوائم الفارغة
 *  6) الحذف الشامل (deleteCascade) وترك الجداول نظيفة
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

// تحميل .env يدويًا (نفس آلية dev-server) — القيم لا تُطبع
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
})();

const config = require('../lib/config');
const { probeFile, planCanvas, runMerge } = require('../lib/merge');
const storage = require('../lib/storage');
const jobs = require('../lib/jobs');
const { validateSources } = require('../lib/jobs');
const { getDb, initSchema } = require('../lib/db');
const ffmpegBin = require('ffmpeg-static');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name} ${extra}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merger-unit-'));

async function makeClip(file, w, h, secs, withAudio) {
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=30:duration=${secs}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  await exec(ffmpegBin, args, { timeout: 120000 });
}

async function sha256(bufOrPath) {
  if (Buffer.isBuffer(bufOrPath)) return crypto.createHash('sha256').update(bufOrPath).digest('hex');
  const buf = await fsp.readFile(bufOrPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  console.log('— اختبار الوحدات: محرك الدمج + التخزين في Turso —');
  await initSchema();

  // 1) توليد مقطعين مختلفي الدقة
  const clipA = path.join(TMP, 'a.mp4'); // 320x240 بصوت
  const clipB = path.join(TMP, 'b.mp4'); // 640x480 بلا صوت
  await makeClip(clipA, 320, 240, 4, true);
  await makeClip(clipB, 640, 480, 3, false);
  const pa = await probeFile(clipA);
  const pb = await probeFile(clipB);
  check('توليد المقطعين بـ ffmpeg', pa.width === 320 && pb.width === 640);
  check('المقطع الأول بصوت والثاني بلا صوت', pa.hasAudio === true && pb.hasAudio === false);

  // 2) الدمج المباشر عبر المحرك
  const canvas = planCanvas([pa, pb]);
  const out = path.join(TMP, 'merged.mp4');
  let lastPct = 0;
  await runMerge({ inputs: [clipA, clipB], probes: [pa, pb], canvas, outPath: out, preset: 'veryfast', onProgress: (p) => { lastPct = p; } });
  const pm = await probeFile(out);
  check('اكتمال الدمج وتوليد الملف', fs.existsSync(out) && fs.statSync(out).size > 10000);
  check(`الدقة = أكبر دقة مدخل (${canvas.width}x${canvas.height})`, pm.width === canvas.width && pm.height === canvas.height);
  const dur = Math.abs(pm.duration - (pa.duration + pb.duration));
  check(`المدة ≈ مجموع المدد (${(pa.duration + pb.duration).toFixed(1)}s ± 0.8)`, dur <= 0.8, `الفرق ${dur.toFixed(2)}s`);
  check('وجود مسار صوتي في الناتج (بُوّلد صامت للمصدر الثاني)', pm.hasAudio === true);
  check('بث التقدم من ffmpeg يعمل', lastPct > 0 && lastPct <= 100);

  // 3) تخزين الناتج في Turso واسترجاعه بتطابق sha256
  const job = await jobs.createJob([
    { kind: 'url', url: 'https://example.com/unit-a.mp4' },
    { kind: 'url', url: 'https://example.com/unit-b.mp4' },
  ]);
  check('إنشاء مهمة في Turso', !!job.id);
  await storage.saveOutputFromFile(job.id, out, () => {});
  const rows = await storage.readOutputRows(job.id, 0, 10 ** 9); // تعيد Buffers مجهزة
  const restored = Buffer.concat(rows);
  check('استرجاع الناتج من Turso بتطابق sha256', (await sha256(restored)) === (await sha256(out)), `${restored.length} بايت`);

  // 4) مسار رفع الأجزاء
  const fjob = await jobs.createJob([{ kind: 'file', name: 'unit-src.mp4', size: fs.statSync(clipA).size, mime: 'video/mp4' }]);
  const src = fjob.sources[0];
  const rawA = await fsp.readFile(clipA);
  const CHUNK = 1024 * 1024; // جزء 1MB للاختبار (الحد 4MB)
  let rowSeq = 0;
  for (let off = 0; off < rawA.length; off += CHUNK) {
    rowSeq += await storage.appendUploadChunk(fjob.id, src.id, rowSeq, rawA.subarray(off, Math.min(off + CHUNK, rawA.length)));
  }
  const assembled = path.join(TMP, 'assembled.mp4');
  await storage.assembleSourceToFile(fjob.id, src.id, assembled);
  check('رفع الأجزاء ثم التجميع بتطابق sha256', (await sha256(assembled)) === (await sha256(clipA)));

  // 5) الحدود
  check('حدود config الافتراضية', config.maxSources === 10 && config.sourceMaxBytes === 200 * 1048576 && config.outputMaxBytes === 150 * 1048576 && config.maxTotalDurationSec === 600);
  let rejected = false;
  try { validateSources([]); } catch (e) { rejected = e.status === 400; }
  check('رفض قائمة مصادر فارغة برسالة 400', rejected);
  let rejectedBig = false;
  try { validateSources(Array.from({ length: 11 }, (_, i) => ({ kind: 'url', url: `https://x.com/v${i}.mp4` }))); } catch (e) { rejectedBig = e.status === 400; }
  check('رفض أكثر من 10 مصادر برسالة 400', rejectedBig);

  // 6) الحذف الشامل وترك الجداول نظيفة
  await jobs.deleteCascade(job.id);
  await jobs.deleteCascade(fjob.id);
  const db = getDb();
  const leftovers = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM output_chunks WHERE job_id IN (?, ?)",
    args: [job.id, fjob.id],
  });
  check('الحذف الشامل يزيل كل الصفوف', Number(leftovers.rows[0].n) === 0);

  await fsp.rm(TMP, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
  if (fail > 0) { console.log('الفاشلة:', failures.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('خطأ غير متوقع:', e); process.exit(1); });
