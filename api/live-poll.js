/**
 * Live Stream Polling Endpoint
 *
 * Called every 5 minutes by external cron service (e.g. cron-job.org).
 * Checks all 12 creators for active YouTube/TikTok live streams,
 * records concurrent viewer counts in Redis, and finalizes stream
 * records when streams end.
 *
 * Flow:
 *   1. Fetch YouTube RSS feeds (free) to find recent video IDs
 *   2. Check new/known-live video IDs via YouTube Data API for concurrentViewers
 *   3. Scrape TikTok @handle/live pages for live viewer counts
 *   4. Store viewer snapshots in Redis (keyed per stream)
 *   5. When a stream ends: compute PCU, ACU, duration → push to history list
 *
 * Security: Protected by LIVE_POLL_SECRET header
 *
 * POST /api/live-poll
 * Header: x-poll-secret: <secret>
 */

const fetch = require('node-fetch');
const { redis, redisPipeline } = require('../lib/redis');
const { CREATORS } = require('../lib/creators');

const YT_API_KEY = process.env.YT_API_KEY;
const POLL_SECRET = process.env.LIVE_POLL_SECRET;

// Redis key prefixes
const K = {
  active:   (name, platform) => `live:active:${name}:${platform}`,
  viewers:  (name, platform, streamId) => `live:viewers:${name}:${platform}:${streamId}`,
  history:  'live:history',
  seenVids: (name) => `live:seen:${name}`,
};

// ============================================================
// YOUTUBE: Parse RSS feed for recent video IDs (free, no quota)
// ============================================================
async function fetchYouTubeRSS(channelId) {
  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const res = await fetch(url, { timeout: 8000 });
    const xml = await res.text();

    // Extract video IDs from <yt:videoId>xxx</yt:videoId>
    const ids = [];
    const regex = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      ids.push(match[1]);
    }
    return ids.slice(0, 5); // Only check 5 most recent
  } catch (e) {
    console.warn(`RSS fetch failed for ${channelId}: ${e.message}`);
    return [];
  }
}

// ============================================================
// YOUTUBE: Check video IDs for live stream status + concurrent viewers
// Uses videos.list (1 quota unit per call, max 50 IDs per call)
// ============================================================
async function checkYouTubeLiveStatus(videoIds) {
  if (!videoIds.length || !YT_API_KEY) return {};

  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoIds.join(',')}&key=${YT_API_KEY}`;

  try {
    const res = await fetch(url, { timeout: 8000 });
    const data = await res.json();
    if (data.error) {
      console.error('YT videos API error:', data.error.message);
      return {};
    }

    const results = {};
    for (const item of (data.items || [])) {
      const lsd = item.liveStreamingDetails;
      if (!lsd) continue;

      results[item.id] = {
        videoId: item.id,
        title: item.snippet.title,
        isLive: !!lsd.concurrentViewers,
        concurrentViewers: lsd.concurrentViewers ? parseInt(lsd.concurrentViewers) : null,
        scheduledStart: lsd.scheduledStartTime || null,
        actualStart: lsd.actualStartTime || null,
        actualEnd: lsd.actualEndTime || null,
      };
    }
    return results;
  } catch (e) {
    console.error('YT live check error:', e.message);
    return {};
  }
}

// ============================================================
// TIKTOK: Check if creator is live by scraping the live page
// ============================================================
async function checkTikTokLive(ttHandle) {
  if (!ttHandle) return null;

  try {
    const url = `https://www.tiktok.com/@${ttHandle}/live`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 8000,
      redirect: 'manual',
    });

    // If redirected away from /live, user is not live
    if (res.status >= 300 && res.status < 400) return null;

    const html = await res.text();
    if (html.length < 3000) return null;

    // Extract room/stream ID
    const roomIdMatch = html.match(/"roomId":"(\d+)"/) || html.match(/"room_id":"(\d+)"/);
    // Extract viewer count
    const viewerMatch = html.match(/"viewer_count":(\d+)/) ||
                        html.match(/"user_count":(\d+)/) ||
                        html.match(/"liveRoomUserInfo".*?"userCount":(\d+)/);
    // Extract stream title
    const titleMatch = html.match(/"title":"([^"]*)"/) || html.match(/"room_title":"([^"]*)"/);

    const viewers = viewerMatch ? parseInt(viewerMatch[1]) : null;

    // If we can't find a room ID or viewer count, user probably isn't live
    if (!roomIdMatch && viewers === null) return null;

    return {
      roomId: roomIdMatch ? roomIdMatch[1] : 'unknown',
      title: titleMatch ? titleMatch[1] : '',
      viewers: viewers || 0,
      isLive: true,
    };
  } catch (e) {
    console.warn(`TikTok live check failed for @${ttHandle}: ${e.message}`);
    return null;
  }
}

// ============================================================
// Finalize a stream: compute PCU, ACU, duration → push to history
// ============================================================
async function finalizeStream(creatorName, platform, streamData) {
  const viewerKey = K.viewers(creatorName, platform, streamData.streamId);

  // Fetch all viewer snapshots
  const rawSnapshots = await redis('LRANGE', viewerKey, '0', '-1');
  const snapshots = (rawSnapshots || []).map(s => JSON.parse(s));

  if (snapshots.length === 0) return null;

  const viewers = snapshots.map(s => s.v);
  const pcu = Math.max(...viewers);
  const acu = Math.round(viewers.reduce((a, b) => a + b, 0) / viewers.length);

  const startTime = streamData.startTime || snapshots[0].t;
  const endTime = new Date().toISOString();
  const durationMin = Math.round((new Date(endTime) - new Date(startTime)) / 60000);

  const record = {
    creator: creatorName,
    platform,
    streamId: streamData.streamId,
    title: streamData.title || '',
    startTime,
    endTime,
    durationMin,
    pcu,
    acu,
    samples: snapshots.length,
    replayViews: null,  // filled later by daily collection
    sentiment: null,    // filled later by AI analysis
  };

  // Push to history list and clean up
  await redisPipeline([
    ['LPUSH', K.history, JSON.stringify(record)],
    ['DEL', K.active(creatorName, platform)],
    ['DEL', viewerKey],
    // Keep history list capped at 500 entries
    ['LTRIM', K.history, '0', '499'],
  ]);

  return record;
}

// ============================================================
// MAIN HANDLER
// ============================================================
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const secret = req.headers['x-poll-secret'] || req.query.secret;
  if (!POLL_SECRET || secret !== POLL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date().toISOString();
  const log = [];

  try {
    // ----------------------------------------------------------
    // STEP 1: YouTube — fetch RSS feeds in parallel
    // ----------------------------------------------------------
    const rssResults = await Promise.all(
      CREATORS.map(c => fetchYouTubeRSS(c.ytChannel).then(ids => ({ name: c.name, ids })))
    );

    // Collect all unique video IDs to check, plus any currently-active stream IDs
    const videoIdsToCheck = new Set();
    const creatorByVideoId = {};

    for (const { name, ids } of rssResults) {
      for (const id of ids) {
        videoIdsToCheck.add(id);
        creatorByVideoId[id] = name;
      }
    }

    // Also check any video IDs we already know are live (from Redis)
    const activeKeys = CREATORS.map(c => K.active(c.name, 'youtube'));
    let activeStreams = [];
    try {
      activeStreams = await redisPipeline(activeKeys.map(k => ['GET', k]));
    } catch (e) {
      console.warn('Failed to read active streams:', e.message);
      activeStreams = activeKeys.map(() => null);
    }

    const previouslyLive = {};
    activeStreams.forEach((raw, i) => {
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        previouslyLive[CREATORS[i].name] = data;
        if (data.streamId) {
          videoIdsToCheck.add(data.streamId);
          creatorByVideoId[data.streamId] = CREATORS[i].name;
        }
      } catch {}
    });

    // ----------------------------------------------------------
    // STEP 2: YouTube — batch check live status (1 API call)
    // ----------------------------------------------------------
    const allVideoIds = [...videoIdsToCheck];
    const ytLiveResults = allVideoIds.length > 0
      ? await checkYouTubeLiveStatus(allVideoIds)
      : {};

    // Process YouTube results
    const pipelineCmds = [];

    for (const [videoId, info] of Object.entries(ytLiveResults)) {
      const creatorName = creatorByVideoId[videoId];
      if (!creatorName) continue;

      if (info.isLive) {
        // Stream is live — record viewer snapshot
        const streamData = {
          streamId: videoId,
          title: info.title,
          startTime: info.actualStart || now,
        };

        pipelineCmds.push(
          ['SET', K.active(creatorName, 'youtube'), JSON.stringify(streamData), 'EX', '3600'],
          ['RPUSH', K.viewers(creatorName, 'youtube', videoId),
            JSON.stringify({ t: now, v: info.concurrentViewers })],
          ['EXPIRE', K.viewers(creatorName, 'youtube', videoId), '86400'],
        );

        log.push({ creator: creatorName, platform: 'youtube', status: 'live', viewers: info.concurrentViewers });
      } else if (info.actualEnd && previouslyLive[creatorName]) {
        // Stream just ended — finalize
        const record = await finalizeStream(creatorName, 'youtube', previouslyLive[creatorName]);
        if (record) {
          log.push({ creator: creatorName, platform: 'youtube', status: 'ended', pcu: record.pcu, acu: record.acu });
        }
      }
    }

    // Check for streams that disappeared from API (no longer in ytLiveResults but were active)
    for (const [creatorName, data] of Object.entries(previouslyLive)) {
      const liveInfo = ytLiveResults[data.streamId];
      if (!liveInfo || (!liveInfo.isLive && !liveInfo.actualEnd)) {
        // Stream disappeared — probably ended, finalize with what we have
        const record = await finalizeStream(creatorName, 'youtube', data);
        if (record) {
          log.push({ creator: creatorName, platform: 'youtube', status: 'ended_inferred', pcu: record.pcu, acu: record.acu });
        }
      }
    }

    // ----------------------------------------------------------
    // STEP 3: TikTok — check live pages in parallel
    // ----------------------------------------------------------
    const ttLiveResults = await Promise.all(
      CREATORS.map(c => checkTikTokLive(c.ttHandle).then(r => ({ name: c.name, result: r })))
    );

    // Read TikTok active streams from Redis
    const ttActiveKeys = CREATORS.map(c => K.active(c.name, 'tiktok'));
    let ttActiveStreams = [];
    try {
      ttActiveStreams = await redisPipeline(ttActiveKeys.map(k => ['GET', k]));
    } catch (e) {
      ttActiveStreams = ttActiveKeys.map(() => null);
    }

    const ttPreviouslyLive = {};
    ttActiveStreams.forEach((raw, i) => {
      if (!raw) return;
      try {
        ttPreviouslyLive[CREATORS[i].name] = JSON.parse(raw);
      } catch {}
    });

    for (const { name, result } of ttLiveResults) {
      if (result && result.isLive) {
        const streamId = result.roomId;
        const streamData = {
          streamId,
          title: result.title,
          startTime: ttPreviouslyLive[name]?.startTime || now,
        };

        pipelineCmds.push(
          ['SET', K.active(name, 'tiktok'), JSON.stringify(streamData), 'EX', '3600'],
          ['RPUSH', K.viewers(name, 'tiktok', streamId),
            JSON.stringify({ t: now, v: result.viewers })],
          ['EXPIRE', K.viewers(name, 'tiktok', streamId), '86400'],
        );

        log.push({ creator: name, platform: 'tiktok', status: 'live', viewers: result.viewers });
      } else if (ttPreviouslyLive[name]) {
        // Was live, now not — finalize
        const record = await finalizeStream(name, 'tiktok', ttPreviouslyLive[name]);
        if (record) {
          log.push({ creator: name, platform: 'tiktok', status: 'ended', pcu: record.pcu, acu: record.acu });
        }
      }
    }

    // Execute all pending Redis writes
    if (pipelineCmds.length > 0) {
      await redisPipeline(pipelineCmds);
    }

    return res.status(200).json({
      ok: true,
      polledAt: now,
      creatorsChecked: CREATORS.length,
      ytVideoIdsChecked: allVideoIds.length,
      events: log,
    });

  } catch (e) {
    console.error('Live poll error:', e);
    return res.status(500).json({ error: e.message });
  }
};
