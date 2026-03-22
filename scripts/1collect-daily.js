#!/usr/bin/env node
/**
 * Daily Data Collection Script
 *
 * Fetches current YouTube subscriber counts and TikTok follower counts
 * for all 12 signed creators, appends to data/daily-history.json.
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
  { name:'GODCAT',    ytChannel:'UCIbzk4LhOrbD3xGJELOsC8Q', ttHandle:null },
  { name:'Moszx',     ytChannel:'UCiwfSWg1QQ1g_NBPj-5Eekw', ttHandle:'moszxll' },
  { name:'PYX',       ytChannel:'UCmzbI91mRAZTmmWN69Oxf1A', ttHandle:null },
  { name:'Oca',       ytChannel:'UCZe6NZYZRH1fPHB-SojxItQ', ttHandle:'oca_dz' },
  { name:'imzogi',    ytChannel:'UCPGL26ihpdprfWGRqBbbW1w', ttHandle:'imzogi' },
];

const YT_API_KEY = process.env.YT_API_KEY;
const DAILY_PATH = path.join(__dirname, '..', 'data', 'daily-history.json');
const WEEKLY_PATH = path.join(__dirname, '..', 'data', 'weekly-history.json');
const MAX_DAILY_ENTRIES = 365;

// ============================================================
// YOUTUBE: Batch fetch subscriber counts (1 quota unit)
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
    map[item.id] = parseInt(item.statistics.subscriberCount || 0);
  });
  return map;
}

// ============================================================
// TIKTOK: Fetch follower count from embed page
// ============================================================
async function fetchTikTokFollowers(ttHandle) {
  if (!ttHandle) return null;

  try {
    const res = await fetch(`https://www.tiktok.com/embed/@${ttHandle}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 8000,
    });

    const html = await res.text();
    if (html.length < 5000) return null;

    const m = html.match(/"followerCount":(\d+)/);
    return m ? parseInt(m[1]) : null;
  } catch (e) {
    console.warn(`  TikTok fetch failed for @${ttHandle}: ${e.message}`);
    return null;
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
          daily[name] = [{ d: last.d, yt: last.yt, tt: last.tt }];
        }
      }
      console.log(`Seeded ${Object.keys(daily).length} creators from weekly data`);
    } catch (e) {
      console.warn('Could not seed from weekly data:', e.message);
    }
  }

  // Fetch live data
  console.log('Fetching YouTube subscriber counts...');
  const ytStats = await fetchYouTubeStats();
  console.log(`  Got stats for ${Object.keys(ytStats).length} channels`);

  console.log('Fetching TikTok follower counts...');
  const ttResults = await Promise.all(
    CREATORS.map(c => fetchTikTokFollowers(c.ttHandle))
  );

  let ttSuccess = 0;
  ttResults.forEach(r => { if (r !== null) ttSuccess++; });
  console.log(`  Got TikTok data for ${ttSuccess}/${CREATORS.filter(c => c.ttHandle).length} creators`);

  // Append today's snapshot
  for (let i = 0; i < CREATORS.length; i++) {
    const c = CREATORS[i];
    const ytSubs = ytStats[c.ytChannel] || 0;
    const ttFollowers = ttResults[i];

    if (!daily[c.name]) daily[c.name] = [];

    // Idempotent: remove existing entry for today
    daily[c.name] = daily[c.name].filter(e => e.d !== today);

    // Append
    daily[c.name].push({ d: today, yt: ytSubs, tt: ttFollowers });

    // Trim to max entries
    if (daily[c.name].length > MAX_DAILY_ENTRIES) {
      daily[c.name] = daily[c.name].slice(-MAX_DAILY_ENTRIES);
    }

    console.log(`  ${c.name}: YT=${ytSubs}, TT=${ttFollowers !== null ? ttFollowers : 'N/A'}`);
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
