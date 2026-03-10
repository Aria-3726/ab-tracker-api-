const path = require('path');
const fs = require('fs');

// ============================================================
// MAIN HANDLER — serves daily history data
// ============================================================
module.exports = function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  try {
    const filePath = path.join(__dirname, '..', 'data', 'daily-history.json');
    const daily = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Support filtering by creator name
    const { creator } = req.query || {};

    if (creator) {
      const data = daily[creator];
      if (!data) {
        return res.status(404).json({ success: false, error: `Creator "${creator}" not found` });
      }
      return res.status(200).json({
        success: true,
        creator,
        days: data.length,
        data,
      });
    }

    // Return all daily history
    const creatorNames = Object.keys(daily);
    return res.status(200).json({
      success: true,
      creators: creatorNames,
      daysPerCreator: creatorNames.length > 0 ? daily[creatorNames[0]].length : 0,
      data: daily,
    });
  } catch (e) {
    console.error('Daily history handler error:', e);
    return res.status(500).json({ error: e.message });
  }
};
