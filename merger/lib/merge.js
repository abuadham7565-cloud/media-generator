'use strict';
/**
 * محرك الدمج — قلب المشروع:
 * 1) ffprobe لكل مصدر (الدقة، fps، المدة، وجود صوت).
 * 2) توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة بين المدخلات
 *    (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p، ثم concat.
 * 3) مصدر بلا صوت؟ يُضاف مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج.
 * 4) ترميز نهائي libx264 CRF 18 + AAC 192k/44100Hz + +faststart (MP4 جاهز للويب فورًا).
 * 5) تقدم حقيقي من -progress pipe:1: 0–40 سحب المصادر، 40–90 ترميز، 90–100 حفظ.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { once } = require('events');

const execFileP = promisify(execFile);

const config = require('./config');
const { ApiError } = require('./http');
const { ensureExecutable } = require('./ffmpeg');
const jobs = require('./jobs');
const storage = require('./storage');

const MB = 1024 * 1024;

/* ------------------------------ ffprobe ------------------------------ */

/** قراءة معلومات ملف عبر ffprobe (JSON) */
async function probeFile(file) {
  const bin = await ensureExecutable('ffprobe');
  let stdout;
  try {
    ({ stdout } = await execFileP(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 16 * MB }
    ));
  } catch (e) {
    throw new ApiError(400, 'تعذر قراءة أحد ملفات الفيديو — قد يكون تالفًا أو غير مدعوم');
  }
  let info;
  try { info = JSON.parse(stdout); } catch (_) { throw new ApiError(400, 'تعذر تحليل بيانات الفيديو'); }
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new ApiError(400, 'أحد المصادر لا يحتوي على مسار فيديو مرئي');
  // معدل الإطارات بصيغة كسر "30/1" — نقيّمه بأمان
  const parseRate = (s) => {
    if (!s) return 0;
    const [n, d] = String(s).split('/').map(Number);
    return d ? n / d : n || 0;
  };
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30;
  const duration =
    parseFloat(info.format && info.format.duration) ||
    parseFloat(v.duration) ||
    0;
  return {
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps,
    duration,
    hasAudio: Boolean(a),
    videoCodec: v.codec_name || 'unknown',
  };
}

/* --------------------------- بناء الفلاتر --------------------------- */

/** أكبر دقة بين المدخلات مع سقف 1920×1080 وأبعاد زوجية */
function planCanvas(sizes) {
  let w = 0;
  let h = 0;
  for (const s of sizes) {
    w = Math.max(w, s.width || 0);
    h = Math.max(h, s.height || 0);
  }
  if (!w || !h) { w = 1280; h = 720; } // احتياط نظري
  w = Math.min(w, 1920);
  h = Math.min(h, 1080);
  if (w % 2) w--;
  if (h % 2) h--;
  return { width: w, height: h };
}

/**
 * بناء filter_complex الكامل:
 * - كل مدخل: scale+pad إلى لوحة واحدة (فريم أسود حول الأصغر)، fps=30، setsar=1، yuv420p
 * - الصوت: إما إعادة تشكيل موحدة 44100Hz ستيرو، أو anullsrc صامت مقصوص على مدة المصدر
 * - أخيرًا concat=n=:v=1:a=1 — كل قطعة تقدَّم بزوج [v][a] لضمان التزامن
 */
function buildFilterComplex(infos) {
  const n = infos.length;
  const { width: W, height: H } = planCanvas(infos);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    if (infos[i].hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت → مسار صامت بنفس مدته بدل أن يفشل الدمج
      const d = Math.max(0.04, infos[i].duration || 0).toFixed(3);
      parts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${d}[a${i}]`);
    }
  }
  const pairs = infos.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${pairs}concat=n=${n}:v=1:a=1[v][a]`);
  return { filter: parts.join(';'), width: W, height: H };
}

/* ------------------------------ الترميز ------------------------------ */

/**
 * تنفيذ ffmpeg: مدخلات موحدة عبر filter_complex، ترميز libx264 CRF 18 + AAC 192k/44100،
 * +faststart للويب، وقراءة التقدم من -progress pipe:1 (out_time_us).
 */
async function runMerge({ inputs, probes, outPath, preset, onProgress }) {
  const ff = await ensureExecutable('ffmpeg');
  const { filter } = buildFilterComplex(probes);
  const totalDur = probes.reduce((a, p) => a + (p.duration || 0), 0);

  const args = ['-y', '-hide_banner', '-nostdin'];
  for (const f of inputs) args.push('-i', f);
  args.push(
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '18', '-preset', preset || config.ffmpegPreset,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats', // سطور key=value على stdout لقراءة التقدم
    outPath
  );

  let stderrTail = '';
  await new Promise((resolve, reject) => {
    const child = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let outBuf = '';
    let lastReported = -1;
    child.stdout.on('data', (d) => {
      outBuf += d.toString();
      const lines = outBuf.split('\n');
      outBuf = lines.pop(); // آخر سطر قد يكون غير مكتمل
      let outTimeUs = null;
      let ended = false;
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const us = Number(v);
          if (Number.isFinite(us)) outTimeUs = k === 'out_time_us' ? us : us / 1000;
        } else if (k === 'progress' && v === 'end') {
          ended = true;
        }
      }
      // نسبة الترميز من المدة الإجمالية → تنعكس على النطاق 40–90 عبر onProgress الخارجي
      if (onProgress && totalDur > 0 && outTimeUs != null) {
        const frac = Math.max(0, Math.min(1, outTimeUs / 1e6 / totalDur));
        const pct = Math.round(frac * 100);
        if (pct !== lastReported) { lastReported = pct; onProgress(frac); }
      }
      if (ended && onProgress) onProgress(1);
    });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) return resolve();
      const tail = stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ');
      reject(new ApiError(500, 'فشل ترميز الفيديو: ' + (tail || `رمز الخروج ${code}`)));
    });
  });
}

/* --------------------------- تنزيل الروابط --------------------------- */

/** تنزيل رابط مباشر إلى /tmp مع عدّ البايتات ورفض تجاوز حد الحجم أثناء التنزيل */
async function downloadToFile(url, dst, maxBytes, onFrac) {
  let u;
  try { u = new URL(url); } catch (_) { throw new ApiError(400, 'رابط المصدر غير صالح'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ApiError(400, 'بروتوكول الرابط غير مدعوم — استخدم http أو https');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000); // مهلة 150 ثانية لكل مصدر
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new ApiError(400, `فشل تنزيل المصدر من الرابط (HTTP ${res.status})`);
    }
    const clen = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    if (clen > maxBytes) {
      throw new ApiError(413, `حجم المصدر من الرابط (${Math.ceil(clen / MB)}MB) يتجاوز الحد المسموح (${Math.floor(maxBytes / MB)}MB)`);
    }
    const total = clen;
    let received = 0;
    const ws = fs.createWriteStream(dst);
    ws.on('error', () => {});
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        // فحص الحجم بمعدّل البايتات الفعلية الواردة (وليس الترويسة فقط)
        if (received > maxBytes) {
          ctrl.abort();
          ws.destroy();
          throw new ApiError(413, `حجم المصدر من الرابط يتجاوز الحد المسموح (${Math.floor(maxBytes / MB)}MB)`);
        }
        if (!ws.write(Buffer.from(chunk))) await once(ws, 'drain');
        if (total && onFrac) onFrac(Math.min(0.99, received / total));
      }
      await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    } catch (e) {
      ws.destroy();
      throw e;
    }
    if (received === 0) throw new ApiError(400, 'المصدر من الرابط فارغ');
    if (onFrac) onFrac(1);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, 'فشل تنزيل المصدر من الرابط: ' + (e.name === 'AbortError' ? 'انتهت المهلة' : (e.message || 'خطأ شبكة')));
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- تنسيق المهمة كاملة ------------------------- */

/**
 * مزخرف تقرير التقدم: لا نكتب في القاعدة مع كل إطار ffmpeg —
 * فقط عند تغيّر نسبي أو مرور وقت (لتخفيف الضغط على Turso).
 */
function makeReporter(onProgress) {
  let lastPct = -100;
  let lastTs = 0;
  return (pct) => {
    const now = Date.now();
    if (pct - lastPct >= 1.5 || now - lastTs > 2500 || pct >= 100) {
      lastPct = pct;
      lastTs = now;
      onProgress(pct);
    }
  };
}

/**
 * تنفيذ مهمة كاملة من القاعدة حتى الناتج المحفوظ:
 * تجميع/تنزيل المصادر → فحص الحدود → دمج → حفظ أجزاء الناتج → إنجاز.
 * تُنظف ملفات /tmp دائمًا في finally (لا اعتماد على نظام ملفات دائم).
 */
async function processJob(jobId, onProgress) {
  const report = makeReporter(onProgress || (() => {}));

  // فحص اكتمال رفع الملفات قبل القفل (قراءة فقط — لا نفرش حالة failed بلا داعٍ)
  const preSources = await jobs.getSources(jobId);
  for (const s of preSources) {
    if (s.kind === 'file' && s.size != null && s.received !== s.size) {
      throw new ApiError(409, `الملف «${s.name}» غير مكتمل (${s.received}/${s.size} بايت) — أكمل رفع الأجزاء أولًا`);
    }
  }

  // قفل بسيط ضد التزامن: استعلام التحديث ينجح لمستدعي واحد فقط
  const db = require('./db').getDb();
  const upd = await db.execute({
    sql: "UPDATE jobs SET status = 'processing', progress = 0, error = NULL WHERE id = ? AND status IN ('queued','uploading','failed')",
    args: [jobId],
  });
  if ((upd.rowsAffected || 0) === 0) {
    const cur = await jobs.getJob(jobId);
    if (cur && cur.status === 'processing') {
      throw new ApiError(202, 'المهمة قيد المعالجة فعله', { status: 'processing', progress: cur.progress });
    }
    throw new ApiError(409, 'حالة المهمة لا تسمح بالمعالجة');
  }

  const sources = preSources.length ? preSources : await jobs.getSources(jobId);
  if (!sources.length) {
    await jobs.failJob(jobId, 'لا توجد مصادر في هذه المهمة');
    throw new ApiError(400, 'لا توجد مصادر في هذه المهمة');
  }

  const stamp = `${jobId}-${Date.now()}`;
  const tmpDir = os.tmpdir();
  const localFiles = [];
  const outPath = path.join(tmpDir, `vm-out-${stamp}.mp4`);
  let tmpBytes = 0;

  try {
    // المرحلة 0–40: سحب المصادر (تنزيل الروابط أو تجميع الملفات المرفوعة من الأجزاء)
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dst = path.join(tmpDir, `vm-src-${stamp}-${i}.bin`);
      localFiles.push(dst);
      if (s.kind === 'url') {
        await downloadToFile(s.url, dst, config.sourceMaxBytes, (frac) => {
          report(((i + frac) / sources.length) * 40);
        });
      } else {
        await storage.assembleSourceToFile(jobId, s.id, dst);
        report(((i + 1) / sources.length) * 40);
      }
      const st = await fsp.stat(dst).catch(() => null);
      tmpBytes += st ? st.size : 0;
      // حماية داخلية لسعة /tmp في بيئة الاستضافة — رسالة واضحة بدل الانهيار
      if (tmpBytes > config.tmpSourcesLimitBytes) {
        throw new ApiError(413, `الحجم الإجمالي للمصادر (${Math.ceil(tmpBytes / MB)}MB) يتجاوز سعة بيئة التنفيذ — قلّل عدد المصادر أو أحجامها`);
      }
    }

    // فحص الحدود قبل الترميز: مدة إجمالية + حد أقصى للمصادر مضمون سلفًا
    const probes = [];
    for (const f of localFiles) probes.push(await probeFile(f));
    const totalDur = probes.reduce((a, p) => a + (p.duration || 0), 0);
    if (totalDur <= 0) throw new ApiError(400, 'تعذر تحديد مدة المصادر');
    if (totalDur > config.maxTotalDurationSec) {
      throw new ApiError(400, `المدة الإجمالية للمصادر (${Math.round(totalDur)} ثانية) تتجاوز الحد (${config.maxTotalDurationSec} ثانية)`);
    }

    // المرحلة 40–90: الترميز الموحد
    await runMerge({
      inputs: localFiles,
      probes,
      outPath,
      preset: config.ffmpegPreset,
      onProgress: (frac) => report(40 + frac * 50),
    });

    // فحص حجم الناتج
    const outStat = await fsp.stat(outPath);
    if (outStat.size > config.outputMaxBytes) {
      throw new ApiError(413, `حجم الفيديو الناتج (${Math.ceil(outStat.size / MB)}MB) يتجاوز الحد (${Math.floor(config.outputMaxBytes / MB)}MB)`);
    }

    // قياسات الناتج الفعلية من الملف نفسه
    const outProbe = await probeFile(outPath);

    // المرحلة 90–100: حفظ الناتج كصفوف Blobs ثم إنهاء المهمة
    await storage.saveOutputFromFile(jobId, outPath, (bytes) => {
      report(90 + (bytes / outStat.size) * 9.5);
    });
    // بعد نجاح الدمج احذف أجزاء المصادر — الناتج فقط هو المطلوب
    await storage.deleteSourceChunks(jobId);
    const resolution = `${outProbe.width}x${outProbe.height}`;
    await jobs.finishJob(jobId, { size: outStat.size, duration: outProbe.duration, resolution });
    report(100);

    return {
      status: 'done',
      size: outStat.size,
      duration: outProbe.duration,
      resolution,
    };
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : 'خطأ غير متوقع أثناء المعالجة';
    await jobs.failJob(jobId, msg).catch(() => {});
    throw e;
  } finally {
    // تنظيف /tmp في كل الحالات
    for (const f of [...localFiles, outPath]) {
      try { await fsp.unlink(f); } catch (_) { /* غير موجود */ }
    }
  }
}

module.exports = { probeFile, planCanvas, buildFilterComplex, runMerge, downloadToFile, processJob };
