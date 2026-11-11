'use strict';
/**
 * GET /api/config → الحدود العامة + version — للعرض في الواجهة وللمطورين.
 */
const config = require('../lib/config');
const { api, json, fail } = require('../lib/http');

module.exports = api(async (req, res) => {
  if (req.method !== 'GET') return fail(res, 405, 'الطريقة غير مسموحة — استخدم GET');
  return json(res, 200, {
    version: config.version,
    maxSources: config.maxSources,
    sourceMaxMb: Math.floor(config.sourceMaxBytes / 1048576),
    outputMaxMb: Math.floor(config.outputMaxBytes / 1048576),
    maxTotalDurationSec: config.maxTotalDurationSec,
    uploadChunkBytes: config.uploadChunkBytes,
    retentionHours: Math.round(config.retentionMs / 3600000),
    ffmpegPreset: config.ffmpegPreset,
  });
});
