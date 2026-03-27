const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

// ============================================================
// CREATOR REGISTRY — same channel IDs as refresh.js
// ============================================================
const CREATORS = [
  { name:'SemiVan',   region:'EN', ytChannel:'UCVM4WEdpJMnyttZEzoq3DDQ', ttHandle:'semivanski' },
  { name:'SADE',      region:'EN', ytChannel:'UCuObJye_kQiTN1y2_INz0oQ', ttHandle:'yt_sade' },
  { name:'1ceStream', region:'EN', ytChannel:'UCmLiBHYkOLkral5MNAI2hOA', ttHandle:'1cestream' },
  { name:'Mitek',     region:'ES', ytChannel:'UCyqyI3k1sE2DVnnIdr5nO7w', ttHandle:'mitekcl' },
  { name:'ZODAGA',    region:'ES', ytChannel:'UCyNWB280mlG9E_4gIvCu12w', ttHandle:'zodaga' },
  { name:'_MATA_',    region:'ES', ytChannel:'UCja-Fg06B9IGNzpxwFPJKZw', ttHandle:'srmataa_' },
  { name:'purumi',    region:'JA', ytChannel:'UCKGjLEfyHz-JSj9GS8OlChQ', ttHandle:'purumnnin_' },
  { name:'GODCAT',    region:'TH', ytChannel:'UCIbzk4LhOrbD3xGJELOsC8Q', ttHandle:'godcat_2023' },
  { name:'Moszx',     region:'TH', ytChannel:'UCiwfSWg1QQ1g_NBPj-5Eekw', ttHandle:'moszxll' },
  { name:'PYX',       region:'TH', ytChannel:'UCmzbI91mRAZTmmWN69Oxf1A', ttHandle:'payosx' },
  { name:'Oca',       region:'ID', ytChannel:'UCZe6NZYZRH1fPHB-SojxItQ', ttHandle:'oca_dz' },
  { name:'imzogi',    region:'ID', ytChannel:'UCPGL26ihpdprfWGRqBbbW1w', ttHandle:'imzogi' },
];

const YT_API_KEY = process.env.YT_API_KEY;

// ============================================================
// Load business config (monthly fees, baselines, etc.)
// ============================================================
let businessConfig = null;
function getBusinessConfig() {
  if (businessConfig) return businessConfig;
  try {
    const configPath = path.join(__dirname, '..', 'data', 'creators-config.json');
    businessConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error('Failed to load creators-config.json:', e.message);
    businessConfig = [];
  }
  return businessConfig;
}

// ============================================================
// YOUTUBE: Batch fetch subscriber counts for all channels
// Single API call, 1 quota unit
// ============================================================
async function fetchYouTubeStats() {
  const channelIds = CREATORS.map(c => c.ytChannel).join(',');
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${YT_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.error('YT API error:', data.error.message);
      return {};
    }

    const statsMap = {};
    (data.items || []).forEach(item => {
      statsMap[item.id] = {
        subscriberCount: parseInt(item.statistics.subscriberCount || 0),
        viewCount: parseInt(item.statistics.viewCount || 0),
        videoCount: parseInt(item.statistics.videoCount || 0),
      };
    });
    return statsMap;
  } catch (e) {
    console.error('YT stats fetch error:', e.message);
    return {};
  }
}

// ============================================================
// TIKTOK: Attempt to fetch follower count from embed page
// ============================================================
async function fetchTikTokFollowers(ttHandle) {
  if (!ttHandle) return null;

  try {
    const embedUrl = `https://www.tiktok.com/embed/@${ttHandle}`;
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 6000,
    });

    const html = await res.text();
    if (html.length < 5000) return null;

    // Try to extract followerCount from embedded JSON
    const followerMatch = html.match(/"followerCount":(\d+)/);
    if (followerMatch) {
      return parseInt(followerMatch[1]);
    }

    return null;
  } catch (e) {
    console.error(`TT follower error [${ttHandle}]:`, e.message);
    return null;
  }
}

// ============================================================
// FORMAT HELPERS
// ============================================================
function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ============================================================
// MAIN HANDLER
// ============================================================
module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!YT_API_KEY) {
    return res.status(500).json({ error: 'YT_API_KEY not configured' });
  }

  try {
    const config = getBusinessConfig();

    // Fetch YouTube stats (single batch call) and TikTok followers in parallel
    const [ytStats, ...ttResults] = await Promise.all([
      fetchYouTubeStats(),
      ...CREATORS.map(c => fetchTikTokFollowers(c.ttHandle)),
    ]);

    // Build enriched creators array
    const creators = CREATORS.map((c, i) => {
      const biz = config.find(bc => bc.name === c.name) || {};
      const ytData = ytStats[c.ytChannel] || {};

      // Use live YT subscriber count, fallback to config
      const ytSubs = ytData.subscriberCount || biz.ytSubs || 0;
      const baseline = biz.baseline || 0;

      // Use live TikTok follower count, fallback to config
      const ttFollowersLive = ttResults[i];
      const ttFollowers = ttFollowersLive || biz.ttFollowers || null;
      const ttBaseline = biz.ttBaseline || null;

      const monthlyViews = biz.monthlyViews || 0;
      const monthlyFee = biz.monthlyFee || 0;

      // Compute derived metrics
      const growth = baseline > 0 ? ((ytSubs - baseline) / baseline * 100).toFixed(1) : '0.0';
      const cpm = monthlyViews > 0 ? (monthlyFee / monthlyViews * 1000).toFixed(2) : '0.00';

      return {
        name: c.name,
        handle: biz.handle || ('@' + (c.ttHandle || c.ytChannel)),
        region: c.region,
        ytSubs,
        ytSubsFormatted: formatCount(ytSubs),
        baseline,
        monthlyViews,
        monthlyFee,
        abVideos: biz.abVideos || '',
        avgViews: biz.avgViews || '',
        sentiment: biz.sentiment || 'neutral',
        sentimentScore: biz.sentimentScore || 50,
        sentimentNote: biz.sentimentNote || '',
        uploadFreq: biz.uploadFreq || '',
        contentFocus: biz.contentFocus || '',
        ytUrl: biz.ytUrl || `https://www.youtube.com/@${c.ytChannel}`,
        ttUrl: biz.ttUrl || (c.ttHandle ? `https://www.tiktok.com/@${c.ttHandle}` : null),
        ttFollowers: typeof ttFollowers === 'number' ? formatCount(ttFollowers) : (ttFollowers || null),
        ttFollowersRaw: typeof ttFollowers === 'number' ? ttFollowers : null,
        ttLikes: biz.ttLikes || null,
        ttBaseline,
        growth,
        cpm,
        // Extra live stats from YouTube
        ytTotalViews: ytData.viewCount || null,
        ytVideoCount: ytData.videoCount || null,
      };
    });

    // Compute aggregates for hero stats
    const totalYtSubs = creators.reduce((s, c) => s + c.ytSubs, 0);
    const totalTtFollowers = creators.reduce((s, c) => s + (c.ttFollowersRaw || 0), 0);
    const totalBudget = creators.reduce((s, c) => s + c.monthlyFee, 0);
    const totalMonthlyViews = creators.reduce((s, c) => s + c.monthlyViews, 0);
    const weightedCpm = totalMonthlyViews > 0 ? (totalBudget / totalMonthlyViews * 1000).toFixed(2) : '0.00';

    return res.status(200).json({
      success: true,
      updatedAt: new Date().toISOString(),
      aggregates: {
        creatorCount: creators.length,
        regionCount: [...new Set(creators.map(c => c.region))].length,
        totalYtSubs,
        totalYtSubsFormatted: formatCount(totalYtSubs),
        totalTtFollowers,
        totalTtFollowersFormatted: formatCount(totalTtFollowers),
        totalBudget,
        totalMonthlyViews,
        weightedCpm,
      },
      creators,
    });
  } catch (e) {
    console.error('Handler error:', e);
    return res.status(500).json({ error: e.message });
  }
};
