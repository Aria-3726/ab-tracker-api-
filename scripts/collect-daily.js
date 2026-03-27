#!/usr/bin/env node
/**
 * Daily Data Collection Script
 *
 * Fetches current YouTube subscriber counts, view counts, TikTok follower
 * counts AND view counts for all 12 signed creators, appends to
 * data/daily-history.json with fields compatible with weekly-history.json.
 *
 * Output fields per entry:
 *   d            — date (YYYY-MM-DD)
 *   yt           — YouTube subscriber count
 *   tt           — TikTok follower count (null if no handle)
 *   ytTotalViews — cumulative YouTube channel views (for delta calc)
 *   ytv          — daily YouTube views (delta from previous day)
 *   ttTotalViews — cumulative TikTok video plays (for delta calc)
 *   ttv          — daily TikTok views (delta from previous day)
 *   wv           — total daily views (ytv + ttv)
 *
 * Usage: YT_API_KEY=xxx node scripts/collect-daily.js
 * Triggered by: GitHub Actions cron (daily) or manual dispatch
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ============================================================
// CREATOR REGISTRY — same as api/creators.js
// ============================================================
const CREATORS = [
  { name:'SemiVan',   ytChannel:'UCVM4WEdpJMnyttZEzoq3DDQ', ttHandle:'semivanski' },
  { name:'SADE',      ytChannel:'UCuObJye_kQiTN1y2_INz0oQ', ttHandle:'yt_sade' },
  { name:'1ceStream', ytChannel:'UCmLiBHYkOLkral5MNAI2hOA', ttHandle:'1cestream' },
  { name:'Mitek',     ytChannel:'UCyqyI3k1sE2DVnnIdr5nO7w', ttHandle:'mitekcl' },
  { name:'ZODAGA',    ytChannel:'UCyNWB280mlG9E_4gIvCu12w', ttHandle:'zodaga' },
  { name:'_MATA_',    ytChannel:'UCja-Fg06B9IGNzpxwFPJKZw', ttHandle:'srmataa_' },
  { name:'purumi',    ytChannel:'UCKGjLEfyHz-JSj9GS8OlChQ', ttHandle:'purumnnin_' },
  { name:'GODCAT',    ytChannel:'UCIbzk4LhOrbD3xGJELOsC8Q', ttHandle:'godcat_2023' },
  { name:'Moszx',     ytChannel:'UCiwfSWg1QQ1g_NBPj-5Eekw', ttHandle:'moszxll' },
  { name:'PYX',       ytChannel:'UCmzbI91mRAZTmmWN69Oxf1A', ttHandle:'payosx' },
  { name:'Oca',       ytChannel:'UCZe6NZYZRH1fPHB-SojxItQ', ttHandle:'oca_dz' },
  { name:'imzogi',    ytChannel:'UCPGL26ihpdprfWGRqBbbW1w', ttHandle:'imzogi' },
];

const YT_API_KEY = process.env.YT_API_KEY;
const DAILY_PATH = path.join(__dirname, '..', 'data', 'daily-history.json');
const WEEKLY_PATH = path.join(__dirname, '..', 'data', 'weekly-history.json');
const MAX_DAILY_ENTRIES = 365;

// ============================================================
// YOUTUBE: Batch fetch subscriber counts + total view counts (1 quota unit)
// ============================================================
async function fetchYouTubeStats() {
  const channelIds = CREATORS.map(c => c.ytChannel).join(',');
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelIds}&key=${YT_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    throw new Error('YouTube API error: ' + data.error.message);
  }

  const map = {};
  (data.items || []).forEach(item => {
    map[item.id] = {
      subscriberCount: parseInt(item.statistics.subscriberCount || 0),
      viewCount: parseInt(item.statistics.viewCount || 0),
      videoCount: parseInt(item.statistics.videoCount || 0),
    };
  });
  return map;
}

// ============================================================
// TIKTOK: Fetch follower count AND video play counts from embed page
// Returns { followers, totalViews } or { followers: null, totalViews: null }
// ============================================================
async function fetchTikTokData(ttHandle) {
  if (!ttHandle) return { followers: null, totalViews: null, videoCount: null };

  try {
    const res = await fetch(`https://www.tiktok.com/embed/@${ttHandle}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 8000,
    });

    const html = await res.text();
    if (html.length < 5000) return { followers: null, totalViews: null, videoCount: null };

    // Extract follower count
    const followerMatch = html.match(/"followerCount":(\d+)/);
    const followers = followerMatch ? parseInt(followerMatch[1]) : null;

    // Extract video count
    const videoCountMatch = html.match(/"videoCount":(\d+)/);
    const videoCount = videoCountMatch ? parseInt(videoCountMatch[1]) : null;

    // Extract all video playCount values from embed page
    // The embed page contains recent videos with their play counts
    const playCountMatches = [...html.matchAll(/"playCount":(\d+)/g)];
    let totalViews = null;
    if (playCountMatches.length > 0) {
      totalViews = playCountMatches.reduce((sum, m) => sum + parseInt(m[1]), 0);
    }

    return { followers, totalViews, videoCount };
  } catch (e) {
    console.warn(`  TikTok fetch failed for @${ttHandle}: ${e.message}`);
    return { followers: null, totalViews: null, videoCount: null };
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  if (!YT_API_KEY) {
    console.error('ERROR: YT_API_KEY environment variable is required');
    process.exit(1);
  }

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  console.log(`Collecting daily snapshot for ${today}...`);

  // Load or seed daily history
  let daily = {};
  try {
    daily = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf-8'));
    console.log(`Loaded existing daily-history.json (${Object.keys(daily).length} creators)`);
  } catch {
    console.log('No existing daily-history.json, seeding from weekly-history.json...');
    try {
      const weekly = JSON.parse(fs.readFileSync(WEEKLY_PATH, 'utf-8'));
      for (const [name, entries] of Object.entries(weekly)) {
        if (entries.length > 0) {
          const last = entries[entries.length - 1];
          // Seed with full weekly fields so next day can compute deltas
          daily[name] = [{
            d: last.d,
            yt: last.yt,
            tt: last.tt,
            ytv: last.ytv || 0,
            ttv: last.ttv || 0,
            wv: last.wv || 0,
          }];
        }
      }
      console.log(`Seeded ${Object.keys(daily).length} creators from weekly data`);
    } catch (e) {
      console.warn('Could not seed from weekly data:', e.message);
    }
  }

  // Fetch live data
  console.log('Fetching YouTube subscriber counts + view counts...');
  const ytStats = await fetchYouTubeStats();
  console.log(`  Got stats for ${Object.keys(ytStats).length} channels`);

  console.log('Fetching TikTok follower counts + video views...');
  const ttResults = await Promise.all(
    CREATORS.map(c => fetchTikTokData(c.ttHandle))
  );

  let ttFollowerSuccess = 0;
  let ttViewSuccess = 0;
  ttResults.forEach(r => {
    if (r.followers !== null) ttFollowerSuccess++;
    if (r.totalViews !== null) ttViewSuccess++;
  });
  const ttTotal = CREATORS.filter(c => c.ttHandle).length;
  console.log(`  Got TikTok followers for ${ttFollowerSuccess}/${ttTotal}, views for ${ttViewSuccess}/${ttTotal} creators`);

  // Append today's snapshot
  for (let i = 0; i < CREATORS.length; i++) {
    const c = CREATORS[i];
    const channelStats = ytStats[c.ytChannel] || { subscriberCount: 0, viewCount: 0, videoCount: 0 };
    const ytSubs = channelStats.subscriberCount;
    const ytTotalViews = channelStats.viewCount;
    const ytVideos = channelStats.videoCount;
    const ttFollowers = ttResults[i].followers;
    const ttRecentViews = ttResults[i].totalViews;
    const ttVideos = ttResults[i].videoCount;

    if (!daily[c.name]) daily[c.name] = [];

    // Compute daily YouTube views delta from previous entry's ytTotalViews
    let ytDailyViews = 0;
    const prevEntries = daily[c.name].filter(e => e.d !== today);
    if (prevEntries.length > 0) {
      const prev = prevEntries[prevEntries.length - 1];
      if (prev.ytTotalViews && ytTotalViews > 0) {
        const delta = ytTotalViews - prev.ytTotalViews;
        // Only use positive deltas (negative means data anomaly)
        if (delta >= 0) {
          ytDailyViews = delta;
        }
      }
    }

    // TikTok daily views: compute delta from previous day's ttTotalViews
    // (mirrors YouTube approach — store cumulative total, compute daily delta)
    const ttTotalViews = ttRecentViews;  // sum of playCount from embed (cumulative)
    let ttDailyViews = 0;
    if (prevEntries.length > 0 && ttTotalViews !== null && ttTotalViews > 0) {
      const prev = prevEntries[prevEntries.length - 1];
      if (prev.ttTotalViews) {
        const delta = ttTotalViews - prev.ttTotalViews;
        // Only use positive deltas (negative means embed showed different videos)
        if (delta >= 0) {
          ttDailyViews = delta;
        }
      }
      // If no previous ttTotalViews, first day of delta tracking — ttv stays 0
    }

    // Idempotent: remove existing entry for today
    daily[c.name] = prevEntries;

    // Build entry with fields matching weekly-history.json format
    const entry = {
      d: today,
      yt: ytSubs,
      tt: ttFollowers,
      ytTotalViews: ytTotalViews,  // always store for next-day delta
      ytv: ytDailyViews,           // YouTube daily views
      ttTotalViews: ttTotalViews,  // always store for next-day delta
      ttv: ttDailyViews,           // TikTok daily views
      wv: ytDailyViews + ttDailyViews, // total daily views
      ytVidCount: ytVideos,        // YouTube total video count
      ttVidCount: ttVideos,        // TikTok total video count
    };
    daily[c.name].push(entry);

    // Trim to max entries
    if (daily[c.name].length > MAX_DAILY_ENTRIES) {
      daily[c.name] = daily[c.name].slice(-MAX_DAILY_ENTRIES);
    }

    console.log(`  ${c.name}: YT=${ytSubs}, TT=${ttFollowers !== null ? ttFollowers : 'N/A'}, YTv=${ytDailyViews}, TTv=${ttDailyViews}, WV=${entry.wv}`);
  }

  // Write back
  fs.writeFileSync(DAILY_PATH, JSON.stringify(daily, null, 2));
  console.log(`\nDaily snapshot saved to ${DAILY_PATH}`);
  console.log(`Total entries per creator: ~${daily[CREATORS[0].name].length}`);
}

main().catch(e => {
  console.error('Collection failed:', e);
  process.exit(1);
});
