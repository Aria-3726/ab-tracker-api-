/**
 * Live Status API — returns currently active live streams
 *
 * GET /api/live-status
 * Response: { streams: [{ creator, platform, streamId, title, startTime, currentViewers, pcu }] }
 */

const { redis, redisPipeline } = require('../lib/redis');
const { CREATORS } = require('../lib/creators');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Read all active stream keys for both platforms
    const keys = [];
    CREATORS.forEach(c => {
      keys.push(`live:active:${c.name}:youtube`);
      keys.push(`live:active:${c.name}:tiktok`);
    });

    const results = await redisPipeline(keys.map(k => ['GET', k]));

    const streams = [];
    for (let i = 0; i < results.length; i++) {
      if (!results[i]) continue;

      try {
        const data = JSON.parse(results[i]);
        const creatorIdx = Math.floor(i / 2);
        const platform = i % 2 === 0 ? 'youtube' : 'tiktok';
        const creatorName = CREATORS[creatorIdx].name;

        // Get the latest viewer snapshot
        const viewerKey = `live:viewers:${creatorName}:${platform}:${data.streamId}`;
        const lastSnapshot = await redis('LINDEX', viewerKey, '-1');
        let currentViewers = null;
        let pcu = null;

        if (lastSnapshot) {
          const parsed = JSON.parse(lastSnapshot);
          currentViewers = parsed.v;
        }

        // Get all snapshots to compute PCU
        const allSnapshots = await redis('LRANGE', viewerKey, '0', '-1');
        if (allSnapshots && allSnapshots.length > 0) {
          const viewers = allSnapshots.map(s => JSON.parse(s).v);
          pcu = Math.max(...viewers);
        }

        streams.push({
          creator: creatorName,
          platform,
          streamId: data.streamId,
          title: data.title || '',
          startTime: data.startTime,
          currentViewers,
          pcu,
          samples: allSnapshots ? allSnapshots.length : 0,
        });
      } catch {}
    }

    return res.status(200).json({
      success: true,
      updatedAt: new Date().toISOString(),
      liveCount: streams.length,
      streams,
    });

  } catch (e) {
    console.error('Live status error:', e);
    return res.status(500).json({ error: e.message });
  }
};
