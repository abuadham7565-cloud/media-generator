#!/usr/bin/env node
/**
 * اختبار HTTP كامل ضد خادم التطوير (يحاكي Vercel):
 *  1) GET /api/config
 *  2) مهمة من رابطين عامين → process → بث مع Range (206 + Content-Range)
 *  3) مهمة مختلطة (رابط + ملف مرفوع بالأجزاء عبر /api/upload)
 *  4) حذف → 404 بعده
 *  5) JSON تالف → 400 · قائمة فارغة → 400
 *  6) تنظيف كل ما أنشأه الاختبار
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
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

const PORT = Number(process.env.TEST_PORT || 4101);
const BASE = `http://127.0.0.1:${PORT}`;
const ffmpegBin = require('ffmpeg-static');

let pass = 0;
let fail = 0;
const failures = [];
const createdJobs = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${name} ${extra}`); }
}

async function call(method, p, { body, headers = {}, raw } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body && !raw ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* جسم غير JSON */ }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  console.log(`— اختبار HTTP كامل ضد ${BASE} —`);

  // 1) config
  const cfg = await call('GET', '/api/config');
  check('GET /api/config يعيد الحدود', cfg.status === 200 && cfg.json.maxSources === 10 && cfg.json.version);

  // 2) مهمة من رابطين عامين → process → Range 206
  const u1 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
  const u2 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4';
  const mk = await call('POST', '/api/jobs', { body: { videos: [u1, u2] } });
  check('POST /api/jobs يعيد 201 مع jobId', mk.status === 201 && !!mk.json.jobId && mk.json.status === 'queued');
  createdJobs.push(mk.json.jobId);
  check('روابط الاستجابة مطلقة (statusUrl/processUrl)', /^https?:\/\//.test(mk.json.statusUrl || '') && /\/process$/.test(mk.json.processUrl || ''));

  const proc = await call('POST', `/api/jobs/${mk.json.jobId}/process`, { body: {} });
  check('process متزامن يعيد done', proc.status === 200 && proc.json.status === 'done', JSON.stringify(proc.json).slice(0, 120));
  check('videoUrl/downloadUrl على نطاق الخدمة نفسها', /\/api\/jobs\/.+\/video/.test(proc.json.videoUrl || '') && /download=1/.test(proc.json.downloadUrl || ''));
  check('بيانات الناتج (size/duration/resolution/expiresAt)', proc.json.size > 0 && proc.json.duration > 5 && /^\d+x\d+$/.test(proc.json.resolution || '') && !!proc.json.expiresAt);

  const range = await fetch(`${BASE}/api/jobs/${mk.json.jobId}/video`, { headers: { Range: 'bytes=1000-1999' } });
  const rangeBuf = Buffer.from(await range.arrayBuffer());
  check('بث Range يعيد 206 + Content-Range صحيح', range.status === 206 && range.headers.get('content-range') === `bytes 1000-1999/${proc.json.size}` && rangeBuf.length === 1000);
  const full = await fetch(`${BASE}/api/jobs/${mk.json.jobId}/video`);
  check('البث الكامل 200 بنوع video/mp4', full.status === 200 && (full.headers.get('content-type') || '').includes('video/mp4'));
  await full.arrayBuffer();

  // 3) مهمة مختلطة (رابط + ملف مرفوع بالأجزاء)
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merger-http-'));
  const clip = path.join(TMP, 'clip.mp4');
  await exec(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', clip], { timeout: 120000 });
  const clipBuf = await fsp.readFile(clip);
  const mixed = await call('POST', '/api/jobs', { body: { sources: [{ kind: 'url', url: u1 }, { kind: 'file', name: 'clip.mp4', size: clipBuf.length, mime: 'video/mp4' }] } });
  check('إنشاء مهمة مختلطة → uploading + uploads[]', mixed.status === 201 && mixed.json.status === 'uploading' && Array.isArray(mixed.json.uploads) && mixed.json.uploads.length === 1);
  createdJobs.push(mixed.json.jobId);
  const up0 = mixed.json.uploads[0];
  const CHUNK = 1024 * 1024; // أجزاء 1MB (الحد 4MB)
  let uploadOk = true;
  for (let off = 0, k = 0; off < clipBuf.length; off += CHUNK, k++) {
    const part = clipBuf.subarray(off, Math.min(off + CHUNK, clipBuf.length));
    const up = await fetch(`${BASE}/api/upload?job=${mixed.json.jobId}&seq=1&chunk=${k}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: part });
    if (up.status !== 200) uploadOk = false;
  }
  check('رفع الأجزاء الثنائية عبر /api/upload', uploadOk);
  const mproc = await call('POST', `/api/jobs/${mixed.json.jobId}/process`, { body: {} });
  check('دمج المهمة المختلطة يكتمل', mproc.status === 200 && mproc.json.status === 'done', JSON.stringify(mproc.json).slice(0, 120));
  fs.rmSync(TMP, { recursive: true, force: true });

  // 4) الحذف ثم 404
  const del = await call('DELETE', `/api/jobs/${mk.json.jobId}`);
  check('DELETE يعيد حذفًا ناجحًا', del.status === 200 || del.status === 204);
  const after = await call('GET', `/api/jobs/${mk.json.jobId}`);
  check('بعد الحذف: 404', after.status === 404);
  const vidAfter = await fetch(`${BASE}/api/jobs/${mk.json.jobId}/video`);
  check('بعد الحذف: بث الفيديو 404', vidAfter.status === 404);
  createdJobs.pop(); // حُذفت

  // 5) رفض المدخلات التالفة
  const bad = await fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{تالف' });
  check('JSON تالف → 400 برسالة عربية', bad.status === 400 && /خطأ|غير صالح/.test(await bad.text()));
  const empty = await call('POST', '/api/jobs', { body: { videos: [] } });
  check('قائمة فارغة → 400', empty.status === 400);
  const nf = await call('GET', '/api/jobs/job-does-not-exist');
  check('مهمة غير موجودة → 404', nf.status === 404);

  // 6) تنظيف ما أنشأه الاختبار
  for (const id of createdJobs) await call('DELETE', `/api/jobs/${id}`);
  const list = await call('GET', '/api/jobs');
  const mine = (list.json.jobs || []).filter((j) => createdJobs.includes(j.id));
  check('تنظيف مهام الاختبار من القاعدة', mine.length === 0);

  console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
  if (fail > 0) { console.log('الفاشلة:', failures.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('خطأ غير متوقع:', e); process.exit(1); });
