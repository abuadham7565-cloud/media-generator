'use strict';
/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 * - يحمّل .env يدويًا (دون طباعة أي أسرار).
 * - يحلل المسارات الديناميكية (مثل /api/jobs/abc/process) ويضعها في req.query.id
 *   تمامًا كما تفعل دوال Vercel Node.
 * - يقدّم public/ كملفات ثابتة.
 * المنفذ من متغير PORT (افتراضي 4100).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// تحميل .env يدويًا — قيم لا تُطبع أبدًا
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
})();

const PORT = parseInt(process.env.PORT || '4100', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

// خريطة المسارات — المجموعة الأولى من التعبير النمطي تصبح req.query.id مثل Vercel
const ROUTES = [
  { methods: ['POST', 'GET'], re: /^\/api\/jobs\/?$/, mod: './api/jobs.js', idGroup: 0 },
  { methods: ['POST'], re: /^\/api\/upload$/, mod: './api/upload.js', idGroup: 0 },
  { methods: ['POST'], re: /^\/api\/jobs\/([^/]+)\/process$/, mod: './api/jobs/[id]/process.js', idGroup: 1 },
  { methods: ['GET', 'HEAD'], re: /^\/api\/jobs\/([^/]+)\/video$/, mod: './api/jobs/[id]/video.js', idGroup: 1 },
  { methods: ['GET', 'DELETE'], re: /^\/api\/jobs\/([^/]+)$/, mod: './api/jobs/[id].js', idGroup: 1 },
  { methods: ['GET'], re: /^\/api\/config$/, mod: './api/config.js', idGroup: 0 },
  { methods: ['GET'], re: /^\/api\/cron$/, mod: './api/cron.js', idGroup: 0 },
];

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let full = path.normalize(path.join(PUBLIC_DIR, rel));
  // منع الخروج من مجلد public (path traversal)
  if (!full.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    full = path.join(PUBLIC_DIR, 'index.html'); // صفحة واحدة — أي مسار آخر يعيد الواجهة
  }
  const ext = path.extname(full).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsed.pathname);
    // مثل Vercel: معاملات الاستعلام في req.query
    req.query = Object.fromEntries(parsed.searchParams);

    if (pathname.startsWith('/api/')) {
      for (const route of ROUTES) {
        const m = route.re.exec(pathname);
        if (!m) continue;
        if (!route.methods.includes(req.method)) {
          res.setHeader('Allow', route.methods.join(', '));
          return sendJson(res, 405, { error: 'الطريقة غير مسموحة على هذا المسار' });
        }
        if (route.idGroup === 1) req.query.id = m[1]; // المسار الديناميكي [id] → req.query.id
        const handler = require(path.join(__dirname, route.mod));
        return await handler(req, res);
      }
      return sendJson(res, 404, { error: 'المسار غير موجود' });
    }

    serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[dev-server] خطأ:', e && e.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'خطأ داخلي في الخادم' });
    else try { res.destroy(); } catch (_) { /* انتهى */ }
  }
});

// منع انهيار عملية التطوير بسبب أخطاء شاردة (مثل إغلاق مفاجئ للاتصال)
process.on('uncaughtException', (e) => console.error('[dev-server] استثناء غير معالج:', e.message));
process.on('unhandledRejection', (e) => console.error('[dev-server] وعد مرفوض:', (e && e.message) || e));

server.listen(PORT, () => {
  console.log(`dev-server جاهز على المنفذ ${PORT} — يحاكي بيئة Vercel (مصدر: ${require('./lib/ffmpeg').resolvePath ? 'ffmpeg حسب التوفر' : '-'})`);
});
