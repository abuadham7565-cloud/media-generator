# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP (Model Context Protocol)** يجمع ثلاث قدرات في أداة واحدة، مع لوحة إدارة عربية (RTL):

1. **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل المدمج: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة وبالترتيب المطلوب

التطبيق Next.js واحد فيه جزءان:

- **خادم MCP** على المسار `/mcp` (نقل Streamable HTTP عبر SDK الرسمي) يعرض **5 أدوات** يستدعيها نموذج الذكاء الاصطناعي من أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK).
- **واجهة ويب عربية RTL** لإدارة مفاتيح API، ومتابعة المهام حيًّا، وعرض إعدادات الربط جاهزة للنسخ.

## القواعد الجوهرية (مطبَّقة حرفيًا)

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر؛ تُخزَّن روابط النتائج فقط في قاعدة البيانات.
- **مفاتيح متسلسلة صارمة** بترتيب الإضافة (`created_at ASC`) — لا round-robin — مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة: نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي.
- **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — التبديل صامت تمامًا من وجهة نظره.
- مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` («بانتظار توفر مفتاح صالح…») وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- **إخفاء المفاتيح إلزامي** في كل الاستجابات (`maskKey`).
- توليد غير متزامن: الأداة تعيد `task_id` فورًا مع نافذة انتظار قصيرة تبث **إشعارات تقدم حية**، ثم يتابع العميل بأداة `get_task`.

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة (تُعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id`) |
| `generate_video` | توليد فيديو بصوت متزامن + image-to-video اختياري |
| `merge_videos` | دمج مقاطع (`urls` مباشرة أو `task_ids` لمهام مكتملة بالترتيب) — الناتج يُحفظ لدى خدمة الدمج ~24 ساعة فقط |
| `get_task` | تتبع أي مهمة (توليد أو دمج) مع تحديث حي من المزود |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

## هيكل المستودع

```
/                 ← تطبيق Next.js (خادم MCP + لوحة الإدارة)
  src/lib/        ← Turso + المفاتيح + الموديلات + المزودان + منسّق التوليد + عميل الدمج
  src/app/mcp/    ← مسار MCP (Streamable HTTP)
  src/app/api/    ← keys / tasks / health
  src/app/page.tsx← لوحة الإدارة العربية
merger/           ← مشروع خدمة دمج الفيديوهات المستقل (Node خالص + Vercel Functions + ffmpeg)
merger/README.md  ← توثيق خدمة الدمج الكامل
```

## التشغيل المحلي

```bash
npm install
cp .env.example .env.local   # املأ القيم
npm run dev                  # http://localhost:3000
npm run typecheck            # tsc --noEmit
```

ثم اختبار MCP بـ curl:

```bash
# 1) تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
# ← خذ mcp-session-id من ترويسة الاستجابة

# 2) قائمة الأدوات (أرسل notifications/initialized أولًا ثم:)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <معرف-الجلسة>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso عبر HTTP (متوافق مع Vercel serverless) |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ للدمج | رابط خدمة الدمج المنشورة (مجلد `merger/`) |
| `MCP_ACCESS_TOKEN` | ❌ | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | ❌ | تجاوز أسماء الموديلات لكل مزود |

> `.env*` مستثناة من Git منذ أول commit — لا أسرار في المستودع، ولا مفاتيح كاملة في الردود أو السجلات.

## النشر على Vercel (مشروعان من نفس المستودع)

### المشروع الأول: لوحة الإدارة + خادم MCP

1. اربط المستودع بـ Vercel: **Add New… → Project** → اختر المستودع (الجذر — يُكتشف Next.js تلقائيًا).
2. أضف متغيرات البيئة: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE` (وكذلك `MCP_ACCESS_TOKEN` إن أردت حماية).
3. **Deploy**. (مسار `/mcp` مضبوط على `maxDuration = 300` لدعم نوافذ الانتظار.)

### المشروع الثاني: خدمة دمج الفيديو

1. **Add New… → Project** من نفس المستودع مرة أخرى.
2. **Settings → General → Root Directory** = `merger`.
3. أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` فقط (الجداول تُنشأ تلقائيًا).
4. **Deploy**، ثم انسخ رابطه (مثل `https://video-merger-xxxx.vercel.app`) وضعه في `MERGER_API_BASE` للمشروع الأول، وأعد نشره.

### ربط أي عميل MCP بعد النشر

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع `https://<مشروعك>.vercel.app/mcp` في «Server URL».
- **Claude Desktop** (`claude_desktop_config.json`):
  ```json
  { "mcpServers": { "media-generator": { "type": "http", "url": "https://<مشروعك>.vercel.app/mcp" } } }
  ```
- **Cursor / Windsurf / Cline** (`mcp.json`):
  ```json
  { "mcpServers": { "media-generator": { "url": "https://<مشروعك>.vercel.app/mcp" } } }
  ```

> ملاحظة: الفيديو يحتاج دقائق — يعيد السيرفر `task_id` فورًا، ويتابَع تلقائيًا بـ `get_task` كل 10 ثوانٍ؛ وأثناء الانتظار يُبَث تقدم حي (Progress notifications). ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة — نزّلها سريعًا.

## كيف تجرّب API بمفاتيحك؟

1. افتح لوحة الإدارة (`/`) → «مدير المفاتيح» → أضف مفتاح kie.ai (ومفاتيح CometAPI إن توفرت).
2. التجربة تسلسلية: أول مفتاح أُضيف يُجرَّب أولًا، وعند فشله (مفتاح غير صالح/رصيد منتهٍ/حد استخدام) يُعلَّم تلقائيًا (`disabled`/`exhausted`) وينتقل للثاني فورًا دون أن يشعر العميل.
3. استدعِ `generate_image` أو `generate_video` من عميل MCP أو راقب المهام حيًّا في «لوحة المهام».
