# موقع دمج الفيديوهات — Video Merger API v2

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على **Vercel**.
Node.js خالص (CommonJS) بلا خطوة بناء — واجهة ثابتة في `public/` + دوال Vercel Serverless في `api/`.
كل شيء يُخزَّن في قاعدة **Turso (libSQL)**: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs). لا S3 ولا خدمات خارجية.

## المزايا

- واجهة عربية RTL بثيم داكن حديث (سماوي/بنفسجي): إضافة روابط، رفع ملفات بالسحب والإفلات، إعادة ترتيب المصادر، شريط تقدم حي، صفحة نتيجة بعدّاد تنازلي 24 ساعة، وقسم توثيق API داخل الصفحة.
- دمج حتى **10 مقاطع** بجودة عالية: H.264 (CRF 18) + AAC 192k + `+faststart` — MP4 يعمل فورًا على الويب.
- توحيد تلقائي لكل المصادر: scale+pad لأكبر دقة (حتى 1920×1080)، fps=30، والمصدر بلا صوت يُكمل بمسار صامت.
- بث الفيديو يدعم **Range (206)** للتقديم/الترجيع، و`?download=1` للتحميل.
- رفع الملفات أجزاءً ثنائية **4MB** مع إعادة محاولة ×3 (تفادي حد حجم الطلب في Vercel).
- حذف تلقائي بعد **24 ساعة**: تنظيف كسول عند كل إنشاء/دمج + نقطة `/api/cron` مجدولة يوميًا.

## النشر على Vercel — خطوة بخطوة

1. **أنشئ قاعدة Turso مجانية** (إن لم تكن جاهزة):
   ```bash
   # بعد تثبيت turso cli وتسجيل الدخول
   turso db create <اسم-القاعدة>
   turso db show <اسم-القاعدة> --url      # ← TURSO_DATABASE_URL
   turso db tokens create <اسم-القاعدة>   # ← TURSO_AUTH_TOKEN
   ```
2. ارفع هذا المجلد (`merger/`) إلى مستودع GitHub (يمكن أن يكون مجلدًا فرعيًا في نفس مستودع مشروع MCP — انظر README الجذر).
3. في Vercel: **Add New… → Project** → اختر المستودع.
   - إن كان المجلد فرعيًا: **Settings → General → Root Directory** = `merger`.
   - الإطار يُكتشف تلقائيًا كـ **Other** (لا Build Command).
4. **Settings → Environment Variables** أضف (لـ Production وPreview):

   | المتغير | إلزامي | الوصف |
   |---|---|---|
   | `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso مثل `libsql://<db>-<org>.aws-ap-northeast-1.turso.io` |
   | `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
   | `MAX_SOURCES` | ❌ | الحد الأقصى للمقاطع (افتراضي 10) |
   | `SOURCE_MAX_MB` | ❌ | الحد الأقصى لكل مصدر (افتراضي 200) |
   | `OUTPUT_MAX_MB` | ❌ | الحد الأقصى للناتج (افتراضي 150) |
   | `MAX_TOTAL_DURATION_SEC` | ❌ | مجموع مدد المقاطع (افتراضي 600) |
   | `FFMPEG_PRESET` | ❌ | preset الترميز (افتراضي medium) |

5. **Deploy**. الجداول تُنشأ تلقائيًا عند أول طلب — لا migrations.
6. ملاحظات الخطة المجانية: أقصى مدة دالة `maxDuration: 300` ثانية (مضبوطة في `vercel.json`)، حد حجم الطلب ≈ 4.5MB (لهذا الرفع أجزاء)، وحجم قاعدة Turso المجانية ≈ 5GB — الناتج يُحذف تلقائيًا بعد 24 ساعة فلا يتراكم.

## التوثيق — API عام بلا تسجيل دخول (CORS مفتوح)

كل الأخطاء بصيغة `{"error":"..."}` برسائل عربية وأكواد صحيحة (400/404/409/413/405).

### `POST /api/jobs` — إنشاء مهمة دمج

```bash
curl -X POST https://<domain>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'
```
```json
201 {
  "jobId": "job-xxxx",
  "status": "queued" | "uploading",
  "statusUrl": "https://<domain>/api/jobs/job-xxxx",
  "processUrl": "https://<domain>/api/jobs/job-xxxx/process",
  "expiresAt": "2026-11-12T01:00:00.000Z",
  "uploads": [ { "seq": 0, "uploadUrl": "https://<domain>/api/upload?job=job-xxxx&seq=0", "uploadChunkBytes": 4194304 } ],
  "uploadChunkBytes": 4194304
}
```
يقبل أيضًا `{"sources":[{"kind":"url","url":"..."},{"kind":"file","name":"a.mp4","size":123,"mime":"video/mp4"}]}`.
الملفات تُرفع عبر `uploads[].uploadUrl` بأجزاء ثنائية `application/octet-stream` ≤4MB بالترتيب (`chunk=0,1,2...`) مع إعادة محاولة ×3.

### `POST /api/jobs/{id}/process` — تنفيذ الدمج (متزامن ~10-60 ثانية)

```bash
curl -X POST https://<domain>/api/jobs/job-xxxx/process
```
```json
200 {
  "status": "done",
  "videoUrl": "https://<domain>/api/jobs/job-xxxx/video",
  "downloadUrl": "https://<domain>/api/jobs/job-xxxx/video?download=1",
  "size": 11460947, "duration": 20.0, "resolution": "1280x720",
  "expiresAt": "..."
}
```
- المهمة قيد المعالجة فعله → `202`.
- التقدم يُخزَّن في القاعدة: 0–40 سحب المصادر، 40–90 ترميز، 100 اكتمال.

### `GET /api/jobs/{id}` — الحالة والتقدم

```bash
curl https://<domain>/api/jobs/job-xxxx
```
```json
{ "id":"job-xxxx", "status":"queued|uploading|processing|done|failed", "progress":0-100,
  "videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"...","error":null,"expiresAt":"..." }
```
انتبه: قد يرد الجسم فيه `error` بلا `status` → عاملها `failed` فورًا.

### `GET /api/jobs/{id}/video` — بث الناتج

يدعم `Range` (استجابة 206 + `Content-Range`) ليعمل التقديم في المشغل، و`?download=1` لتنزيل ملف MP4 مباشرة.

### `DELETE /api/jobs/{id}` — حذف فوري شامل

يحذف كل صفوف المهمة (jobs + sources + source_chunks + output_chunks) دفعة واحدة.

### `GET /api/config` — الحدود العامة + version

### `GET /api/cron` — حذف المهام المنتهية (مجدولة يوميًا من `vercel.json`)

## التشغيل المحلي والاختبارات

```bash
npm install            # أو bun install
cp .env.example .env   # ثم املأ متغيري Turso
npm run dev            # خادم تطوير يحاكي Vercel على المنفذ 4100
npm run test:unit      # 14 فحصًا: المحرك + التخزين (sha256) + الرفع + الحدود + الحذف
npm run test:http      # 18 فحصًا: HTTP كامل ضد خادم التطوير (Port 4101)
```

## الحدود

| الحد | القيمة |
|---|---|
| عدد المقاطع | 10 كحد أقصى |
| حجم كل مصدر | 200MB |
| حجم الناتج | 150MB |
| مجموع المدد | 600 ثانية |
| مدة الاحتفاظ | 24 ساعة ثم حذف تلقائي |
| حجم جزء الرفع | 4MB (ثنائي) |
