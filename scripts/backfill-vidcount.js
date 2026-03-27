#!/usr/bin/env node
/**
 * Backfill YouTube Video Count History
 *
 * Fetches all video publish dates from each creator's uploads playlist,
 * then computes cumulative video count for every date in weekly-history.json
 * and daily-history.json. Writes ytVidCount back into both files.
 *
 * Usage: YT_API_KEY=xxx node scripts/backfill-vidcount.js
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const CREATORS = [
  { name:'SemiVan',   ytChannel:'UCVM4WEdpJMnyttZEzoq3DDQ' },
  { name:'SADE',      ytChannel:'UCuObJye_kQiTN1y2_INz0oQ' },
  { name:'1ceStream', ytChannel:'UCmLiBHYkOLkral5MNAI2hOA' },
  { name:'Mitek',     ytChannel:'UCyqyI3k1sE2DVnnIdr5nO7w' },
  { name:'ZODAGA',    ytChannel:'UCyNWB280mlG9E_4gIvCu12w' },
  { name:'_MATA_',    ytChannel:'UCja-Fg06B9IGNzpxwFPJKZw' },
  { name:'purumi',    ytChannel:'UCKGjLEfyHz-JSj9GS8OlChQ' },
  { name:'GODCAT',    ytChannel:'UCIbzk4LhOrbD3xGJELOsC8Q' },
  { name:'Moszx',     ytChannel:'UCiwfSWg1QQ1g_NBPj-5Eekw' },
  { name:'PYX',       ytChannel:'UCmzbI91mRAZTmmWN69Oxf1A' },
  { name:'Oca',       ytChannel:'UCZe6NZYZRH1fPHB-SojxItQ' },
  { name:'imzogi',    ytChannel:'UCPGL26ihpdprfWGRqBbbW1w' },
];

const YT_API_KEY = process.env.YT_API_KEY;
const WEEKLY_PATH = path.join(__dirname, '..', 'data', 'weekly-history.json');
const DAILY_PATH  = path.join(__dirname, '..', 'data', 'daily-history.json');

/**
 * Fetch ALL video publish dates from a channel's uploads playlist.
 * Paginates through all pages (50 items per page, 1 quota unit each).
 * Returns sorted array of date strings: ['2025-01-15', '2025-02-03', ...]
 */
async function fetchAllVideoPublishDates(channelId) {
  const playlistId = 'UU' + channelId.substring(2);
  const dates = [];
  let pageToken = '';
  let page = 0;

  while (true) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=50&key=${YT_API_KEY}` +
      (pageToken ? `&pageToken=${pageToken}` : '');

    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();

    if (data.error) {
      console.error(`  API error for ${channelId}: ${data.error.message}`);
      break;
    }

    const items = data.items || [];
    for (const item of items) {
      const published = item.contentDetails.videoPublishedAt;
      if (published) {
        dates.push(published.split('T')[0]); // YYYY-MM-DD
      }
    }

    page++;
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
    } else {
      break;
    }
  }

  dates.sort();
  console.log(`  Fetched ${dates.length} videos across ${page} pages`);
  return dates;
}

/**
 * Given sorted publish dates and a target date, return how many videos
 * were published on or before that date.
 */
function countVideosAsOf(sortedDates, targetDate) {
  // Binary search for efficiency
  let lo = 0, hi = sortedDates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid] <= targetDate) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main() {
  if (!YT_API_KEY) {
    console.error('ERROR: YT_API_KEY environment variable is required');
    process.exit(1);
  }

  // Load data files
  let weekly = {};
  let daily = {};
  try { weekly = JSON.parse(fs.readFileSync(WEEKLY_PATH, 'utf-8')); } catch {}
  try { daily  = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf-8')); } catch {}

  console.log(`Loaded weekly: ${Object.keys(weekly).length} creators, daily: ${Object.keys(daily).length} creators\n`);

  for (const c of CREATORS) {
    console.log(`Processing ${c.name}...`);
    const publishDates = await fetchAllVideoPublishDates(c.ytChannel);

    if (publishDates.length === 0) {
      console.log(`  No videos found, skipping\n`);
      continue;
    }

    console.log(`  Date range: ${publishDates[0]} → ${publishDates[publishDates.length - 1]}`);

    // Backfill weekly entries
    if (weekly[c.name]) {
      for (const entry of weekly[c.name]) {
        entry.ytVidCount = countVideosAsOf(publishDates, entry.d);
      }
      console.log(`  Updated ${weekly[c.name].length} weekly entries`);
    }

    // Backfill daily entries
    if (daily[c.name]) {
      for (const entry of daily[c.name]) {
        entry.ytVidCount = countVideosAsOf(publishDates, entry.d);
      }
      console.log(`  Updated ${daily[c.name].length} daily entries`);
    }

    console.log();

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  // Write back
  fs.writeFileSync(WEEKLY_PATH, JSON.stringify(weekly, null, 2));
  fs.writeFileSync(DAILY_PATH, JSON.stringify(daily, null, 2));
  console.log('Done! Both weekly-history.json and daily-history.json updated with ytVidCount.');
}

main().catch(e => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
