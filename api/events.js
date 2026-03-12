const fetch = require('node-fetch');

// ============================================================
// EVENTS API — reads activity schedule from Google Sheets CSV
// Environment variable: EVENTS_SHEET_URL
// Falls back to demo data if not configured
// ============================================================

const EVENTS_SHEET_URL = process.env.EVENTS_SHEET_URL;

// Demo/fallback data when Google Sheets is not configured
const DEMO_EVENTS = [
  {
    name: 'S11赛季上线直播',
    startDate: '2026-03-05',
    endDate: '2026-03-07',
    creators: ['SemiVan', 'SADE', '1ceStream', 'purumi'],
    type: '直播',
    note: '新赛季上线推广直播活动'
  },
  {
    name: '1ce Cup 春季赛',
    startDate: '2026-03-15',
    endDate: '2026-03-22',
    creators: ['1ceStream', 'Oca', 'imzogi', 'ZODAGA'],
    type: '赛事',
    note: '社区锦标赛联动顶级主播'
  },
  {
    name: '皮肤联动推广',
    startDate: '2026-03-10',
    endDate: '2026-03-12',
    creators: ['SADE', 'Mitek', 'GODCAT'],
    type: '联动',
    note: '新皮肤上线合作推广'
  },
  {
    name: '社区赠品活动',
    startDate: '2026-03-20',
    endDate: '2026-03-25',
    creators: ['purumi', '_MATA_', 'Moszx', 'PYX'],
    type: '赠品',
    note: '春季社区回馈赠品活动'
  },
  {
    name: '泰国游戏展',
    startDate: '2026-04-01',
    endDate: '2026-04-03',
    creators: ['GODCAT', 'Moszx', 'PYX'],
    type: '推广',
    note: 'Thailand Game Show线下参展'
  }
];

// ============================================================
// CSV Parser — handles quoted fields with commas
// ============================================================
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  function splitRow(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = splitRow(lines[0]);
  const events = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    if (cols.length < 4 || !cols[0]) continue;

    // Map columns by header names (flexible ordering)
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = cols[idx] || ''; });

    const name = row['活动名称'] || cols[0] || '';
    const startDate = row['开始日期'] || cols[1] || '';
    const endDate = row['结束日期'] || cols[2] || '';
    const creatorsStr = row['参与主播'] || cols[3] || '';
    const type = row['活动类型'] || cols[4] || '';
    const note = row['备注'] || cols[5] || '';

    if (!name || !startDate) continue;

    events.push({
      name,
      startDate,
      endDate: endDate || startDate,
      creators: creatorsStr.split(',').map(s => s.trim()).filter(Boolean),
      type,
      note
    });
  }

  return events;
}

// ============================================================
// MAIN HANDLER
// ============================================================
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  try {
    let events;
    let source;

    if (EVENTS_SHEET_URL) {
      // Fetch from Google Sheets published CSV
      const csvRes = await fetch(EVENTS_SHEET_URL, { timeout: 8000 });
      if (!csvRes.ok) {
        throw new Error('Google Sheets fetch failed: ' + csvRes.status);
      }
      const csvText = await csvRes.text();
      events = parseCSV(csvText);
      source = 'google_sheets';
    } else {
      // Use demo data
      events = DEMO_EVENTS;
      source = 'demo';
    }

    // Sort by startDate descending (most recent first)
    events.sort((a, b) => b.startDate.localeCompare(a.startDate));

    // Add status field based on current date
    const today = new Date().toISOString().split('T')[0];
    events.forEach(e => {
      if (today < e.startDate) e.status = 'upcoming';
      else if (today > e.endDate) e.status = 'ended';
      else e.status = 'active';
    });

    return res.status(200).json({
      success: true,
      source,
      updatedAt: new Date().toISOString(),
      total: events.length,
      events
    });
  } catch (e) {
    console.error('Events API error:', e);
    return res.status(500).json({ error: e.message });
  }
};
