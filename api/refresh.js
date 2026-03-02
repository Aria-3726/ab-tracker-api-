const fetch = require('node-fetch');

// ============================================================
// CREATOR REGISTRY — YouTube channel IDs + TikTok handles
// ============================================================
const CREATORS = [
  { name:'SemiVan',   region:'EN', ytChannel:'UCVM4WEdpJMnyttZEzoq3DDQ', ytHandle:'semivanski',  ttHandle:'semivanski' },
  { name:'SADE',      region:'EN', ytChannel:'UCuObJye_kQiTN1y2_INz0oQ', ytHandle:'sade999',     ttHandle:'yt_sade' },
  { name:'1ceStream', region:'EN', ytChannel:'UCmLiBHYkOLkral5MNAI2hOA', ytHandle:'1ceStream',   ttHandle:'1cestream' },
  { name:'Mitek',     region:'ES', ytChannel:'UCyqyI3k1sE2DVnnIdr5nO7w', ytHandle:'Mitekcl',     ttHandle:'mitekcl' },
  { name:'ZODAGA',    region:'ES', ytChannel:'UCyNWB280mlG9E_4gIvCu12w', ytHandle:'zodaga',      ttHandle:'zodaga' },
  { name:'_MATA_',    region:'ES', ytChannel:'UCja-Fg06B9IGNzpxwFPJKZw', ytHandle:'srmataa_',    ttHandle:'srmataa_' },
  { name:'purumi',    region:'JA', ytChannel:'UCKGjLEfyHz-JSj9GS8OlChQ', ytHandle:'kogimogo',    ttHandle:'purumnnin_' },
  { name:'GODCAT',    region:'TH', ytChannel:'UCIbzk4LhOrbD3xGJELOsC8Q', ytHandle:'GODCATz',     ttHandle:null },
  { name:'Moszx',     region:'TH', ytChannel:'UCiwfSWg1QQ1g_NBPj-5Eekw', ytHandle:'moszx2943',   ttHandle:'moszxll' },
  { name:'PYX',       region:'TH', ytChannel:'UCmzbI91mRAZTmmWN69Oxf1A', ytHandle:'payosx',      ttHandle:null },
  { name:'Oca',       region:'ID', ytChannel:'UCZe6NZYZRH1fPHB-SojxItQ', ytHandle:'ocadz',       ttHandle:'oca_dz' },
  { name:'imzogi',    region:'ID', ytChannel:'UCPGL26ihpdprfWGRqBbbW1w', ytHandle:'imzogi',      ttHandle:'imzogi' },
];

const YT_API_KEY = process.env.YT_API_KEY;

// ============================================================
// YOUTUBE: fetch latest 3 videos per creator via Data API v3
// Uses playlist items API (cheaper quota: 1 unit vs 100 for search)
// ============================================================
async function fetchYouTubeVideos(creator) {
  try {
    // Get uploads playlist ID (replace UC with UU in channel ID)
    const uploadsPlaylistId = creator.ytChannel.replace(/^UC/, 'UU');

    // Step 1: get latest 3 video IDs from uploads playlist (1 quota unit)
    const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=3&key=${YT_API_KEY}`;
    const playlistRes = await fetch(playlistUrl);
    const playlistData = await playlistRes.json();

    if (!playlistData.items || playlistData.items.length === 0) return [];

    // Step 2: get video statistics (1 quota unit)
    const videoIds = playlistData.items.map(i => i.snippet.resourceId.videoId).join(',');
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoIds}&key=${YT_API_KEY}`;
    const statsRes = await fetch(statsUrl);
    const statsData = await statsRes.json();

    return (statsData.items || []).map(v => ({
      creator: creator.name,
      region: creator.region,
      platform: 'youtube',
      title: v.snippet.title,
      date: v.snippet.publishedAt.split('T')[0],
      views: Number(v.statistics.viewCount || 0),
      likes: Number(v.statistics.likeCount || 0),
      comments: Number(v.statistics.commentCount || 0),
      url: `https://www.youtube.com/watch?v=${v.id}`,
      thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
    }));
  } catch (e) {
    console.error(`YT error [${creator.name}]:`, e.message);
    return [];
  }
}

// ============================================================
// TIKTOK: fetch latest videos via embed page parsing
// The embed page (/embed/@handle) returns SSR HTML with video data
// including id, desc, playCount — no auth required
// ============================================================
async function fetchTikTokVideos(creator) {
  if (!creator.ttHandle) return [];

  try {
    const embedUrl = `https://www.tiktok.com/embed/@${creator.ttHandle}`;
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 8000,
    });

    const html = await res.text();
    if (html.length < 5000) return []; // empty shell page, no data

    // Extract video objects from the embed page HTML
    // Pattern: "playCount":N,"privateItem":bool,"authorUniqueId":"handle"
    const playCountRe = /"playCount":(\d+),"privateItem":(true|false),"authorUniqueId":"([^"]*)"/g;
    const videos = [];
    let match;

    while ((match = playCountRe.exec(html)) !== null) {
      const playCount = parseInt(match[1]);
      const author = match[3];

      // Walk backwards to find the video ID and description
      const beforeStr = html.substring(Math.max(0, match.index - 2000), match.index);
      const idMatch = beforeStr.match(/.*"id":"(\d{15,25})","desc":"((?:[^"\\]|\\.)*)"/s);

      if (idMatch) {
        const desc = idMatch[2]
          .replace(/\\u[\dA-Fa-f]{4}/g, c => String.fromCharCode(parseInt(c.slice(2), 16)))
          .replace(/\\n/g, ' ')
          .replace(/\\"/g, '"')
          .trim();

        videos.push({
          creator: creator.name,
          region: creator.region,
          platform: 'tiktok',
          title: desc || 'TikTok Video',
          date: '', // embed page doesn't include createTime; will be marked as recent
          views: playCount,
          likes: 0,  // not available in embed
          comments: 0, // not available in embed
          url: `https://www.tiktok.com/@${creator.ttHandle}/video/${idMatch[1]}`,
          thumbnail: '',
        });
      }
    }

    return videos.slice(0, 3); // return top 3 (most recent)
  } catch (e) {
    console.error(`TT error [${creator.name}]:`, e.message);
    return [];
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
    // Fetch YouTube (all 12) and TikTok (10 with handles) in parallel
    const ytPromises = CREATORS.map(c => fetchYouTubeVideos(c));
    const ttPromises = CREATORS.map(c => fetchTikTokVideos(c));

    const [ytResults, ttResults] = await Promise.all([
      Promise.all(ytPromises),
      Promise.all(ttPromises),
    ]);

    const allYT = ytResults.flat();
    const allTT = ttResults.flat();
    const allContent = [...allYT, ...allTT];

    // Sort by date descending (TikTok without dates goes to end)
    allContent.sort((a, b) => (b.date || '0000').localeCompare(a.date || '0000'));

    // Format counts for display
    const formatted = allContent.map(item => ({
      ...item,
      viewsRaw: item.views,
      likesRaw: item.likes,
      commentsRaw: item.comments,
      views: formatCount(item.views),
      likes: item.likes > 0 ? formatCount(item.likes) : '',
      comments: item.comments > 0 ? formatCount(item.comments) : '',
    }));

    return res.status(200).json({
      success: true,
      updatedAt: new Date().toISOString(),
      totalYT: allYT.length,
      totalTT: allTT.length,
      total: formatted.length,
      data: formatted,
    });
  } catch (e) {
    console.error('Handler error:', e);
    return res.status(500).json({ error: e.message });
  }
};
