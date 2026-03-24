#!/usr/bin/env node
/**
 * Export Live History from Redis → data/live-history.json
 *
 * Pulls completed live stream records from Upstash Redis and appends
 * them to the local JSON file for permanent storage. Clears exported
 * entries from Redis to prevent duplicates.
 *
 * Run via GitHub Actions daily or manually:
 *   UPSTASH_REDIS_REST_URL=xxx UPSTASH_REDIS_REST_TOKEN=xxx node scripts/export-live-history.js
 */

const fs = require('fs');
const path = require('path');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'live-history.json');
const MAX_ENTRIES = 1000;

async function redisCmd(command, ...args) {
  const res = await fetch(`${UPSTASH_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

async function main() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('ERROR: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
    process.exit(1);
  }

  // Load existing history
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    console.log(`Loaded ${history.length} existing records from live-history.json`);
  } catch {
    console.log('No existing live-history.json, starting fresh');
  }

  // Fetch all records from Redis (most recent first)
  const raw = await redisCmd('LRANGE', 'live:history', '0', '-1');
  if (!raw || raw.length === 0) {
    console.log('No new records in Redis. Nothing to export.');
    return;
  }

  const newRecords = raw.map(s => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);

  console.log(`Found ${newRecords.length} records in Redis`);

  // Deduplicate by streamId + platform + creator
  const existingKeys = new Set(
    history.map(r => `${r.creator}:${r.platform}:${r.streamId}`)
  );

  let added = 0;
  for (const record of newRecords) {
    const key = `${record.creator}:${record.platform}:${record.streamId}`;
    if (!existingKeys.has(key)) {
      history.push(record);
      existingKeys.add(key);
      added++;
      console.log(`  + ${record.creator} ${record.platform} ${record.startTime} PCU=${record.pcu} ACU=${record.acu}`);
    }
  }

  // Sort by startTime descending (most recent first)
  history.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  // Cap at max entries
  if (history.length > MAX_ENTRIES) {
    history = history.slice(0, MAX_ENTRIES);
  }

  // Write back
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`\nExported ${added} new records. Total: ${history.length}`);

  // Clear Redis history list after successful export
  if (added > 0) {
    await redisCmd('DEL', 'live:history');
    console.log('Cleared Redis live:history list');
  }
}

main().catch(e => {
  console.error('Export failed:', e);
  process.exit(1);
});
