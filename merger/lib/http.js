'use strict';
/**
 * أدوات HTTP مشتركة بين دوال Vercel: CORS مفتوح، أخطاء بصيغة {"error":"..."}،
 * قراءة الجسم الثنائي/JSON، وبناء روابط مطلقة من رابط الطلب الأصلي.
 */
const config = require('./config');

/** خطأ API يحمل كود HTTP ورسالة عربية (وحمولة بديلة اختيارية) */
class ApiError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

/** CORS مفتوح للجميع — الواجهة العامة مخصصة للمطورين */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition');
}

/** معالجة طلب OPTIONS (preflight) — يرجع true إن عالج الطلب */
function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** كل الأخطاء بصيغة موحدة {"error":"..."} */
function fail(res, status, message, payload) {
  if (payload) return json(res, status, payload);
  json(res, status, { error: message });
}

/**
 * بناء الرابط المطلق من رابط الطلب الأصلي (وليس localhost ثابتًا):
 * نعتمد x-forwarded-host / x-forwarded-proto خلف بروكسي Vercel، وإلا host من الطلب.
 */
function baseUrl(req) {
  const xfHost = req.headers['x-forwarded-host'];
  const xfProto = req.headers['x-forwarded-proto'];
  const host = (typeof xfHost === 'string' ? xfHost.split(',')[0].trim() : '') || req.headers.host || 'localhost';
  const proto = (typeof xfProto === 'string' ? xfProto.split(',')[0].trim() : '') || 'http';
  return `${proto}://${host}`;
}

function absUrl(req, pathAndQuery) {
  return baseUrl(req) + pathAndQuery;
}

/** قراءة الجسم الثنائي مع سقف حجم — يرجع {buf, over} بدل الرمي لتفادي 500 عامة */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        settled = true;
        req.destroy(); // قطع الاتصال مبكرًا بدل تحميل كل شيء في الذاكرة
        resolve({ buf: null, over: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!settled) resolve({ buf: Buffer.concat(chunks), over: false });
    });
    req.on('error', (e) => {
      if (!settled) reject(e);
    });
  });
}

/** قراءة JSON مع رسائل عربية واضحة عند التلف */
async function readJson(req, maxBytes = config.maxBodyJsonBytes) {
  const { buf, over } = await readBody(req, maxBytes);
  if (over) throw new ApiError(413, 'حجم الطلب كبير جدًا');
  if (!buf || buf.length === 0) throw new ApiError(400, 'الطلب فارغ — أرسل JSON صالحًا');
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw new ApiError(400, 'صيغة JSON غير صالحة');
  }
}

/**
 * غلاف موحد لدوال Vercel: CORS + preflight + التقاط الأخطاء.
 * كل دالة تبقى بنفس التوقيع المطلوب: module.exports = async (req, res) => {}
 */
function api(handler) {
  return async (req, res) => {
    setCors(res);
    if (handlePreflight(req, res)) return;
    try {
      await handler(req, res);
    } catch (e) {
      if (e instanceof ApiError) return fail(res, e.status, e.message, e.payload);
      console.error('[api] خطأ غير متوقع:', e && e.message);
      if (!res.headersSent) return fail(res, 500, 'خطأ داخلي في الخادم');
      try { res.destroy(); } catch (_) { /* تم بالفعل */ }
    }
  };
}

/** التحقق من صيغة معرف المهمة (يمنع مدخلات غريبة في الاستعلامات) */
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

module.exports = { ApiError, setCors, handlePreflight, json, fail, baseUrl, absUrl, readBody, readJson, api, ID_RE };
