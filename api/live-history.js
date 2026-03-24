/**
 * Live History API — returns completed live stream records
 *
 * GET /api/live-history?creator=SemiVan&limit=50
 * Response: { streams: [{ creator, platform, streamId, title, startTime, endTime, durationMin, pcu, acu, ... }] }
 */

const { redis } = require('../lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const creatorFilter = req.query.creator || null;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    // Fetch from Redis list (most recent first — LPUSH order)
    const raw = await redis('LRANGE', 'live:history', '0', String(limit - 1));

    let streams = (raw || []).map(s => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);

    // Filter by creator if specified
    if (creatorFilter) {
      streams = streams.filter(s => s.creator === creatorFilter);
    }

    return res.status(200).json({
      success: true,
      total: streams.length,
      streams,
    });

  } catch (e) {
    console.error('Live history error:', e);
    return res.status(500).json({ error: e.message });
  }
};
