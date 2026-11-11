'use strict';
/**
 * GET /api/cron → حذف كل المهام المنتهية صلاحيتها (+24 ساعة) وكل أجزائها.
 * مجدولة يوميًا عبر vercel.json (crons). تُستدعى أيضًا كسولًا عند الإنشاء/الدمج.
 */
const { initSchema } = require('../lib/db');
const { api, json, fail } = require('../lib/http');
const jobs = require('../lib/jobs');

module.exports = api(async (req, res) => {
  if (req.method !== 'GET') return fail(res, 405, 'الطريقة غير مسموحة — استخدم GET');
  await initSchema();
  const deleted = await jobs.cleanupExpired();
  return json(res, 200, { ok: true, deleted, at: new Date().toISOString() });
});
