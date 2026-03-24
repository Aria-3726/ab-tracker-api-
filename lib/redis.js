/**
 * Upstash Redis REST API helper
 *
 * Uses plain HTTP fetch — no npm dependency needed.
 * Requires env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * Execute a single Redis command via Upstash REST API
 * @param {string} command - Redis command (GET, SET, HSET, etc.)
 * @param {...string} args - Command arguments
 * @returns {Promise<any>} Redis result
 */
async function redis(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  }

  const res = await fetch(`${UPSTASH_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

/**
 * Execute multiple Redis commands in a pipeline (single HTTP request)
 * @param {Array<Array<string>>} commands - Array of [command, ...args]
 * @returns {Promise<Array<any>>} Array of results
 */
async function redisPipeline(commands) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  }

  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const data = await res.json();
  // Pipeline returns array of {result, error} objects
  return data.map(item => {
    if (item.error) throw new Error(`Redis pipeline error: ${item.error}`);
    return item.result;
  });
}

module.exports = { redis, redisPipeline };
