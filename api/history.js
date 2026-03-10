const path = require('path');
const fs = require('fs');

// ============================================================
// MAIN HANDLER — serves weekly history data
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
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  try {
    const historyPath = path.join(__dirname, '..', 'data', 'weekly-history.json');
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));

    // Support filtering by creator name via query parameter
    const { creator } = req.query || {};

    if (creator) {
      const data = history[creator];
      if (!data) {
        return res.status(404).json({ success: false, error: `Creator "${creator}" not found` });
      }
      return res.status(200).json({
        success: true,
        creator,
        weeks: data.length,
        data,
      });
    }

    // Return all history
    const creatorNames = Object.keys(history);
    return res.status(200).json({
      success: true,
      creators: creatorNames,
      weeksPerCreator: creatorNames.length > 0 ? history[creatorNames[0]].length : 0,
      data: history,
    });
  } catch (e) {
    console.error('History handler error:', e);
    return res.status(500).json({ error: e.message });
  }
};
