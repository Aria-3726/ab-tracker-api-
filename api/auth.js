// ============================================================
// AUTH API — simple fixed password verification
// Environment variable: AUTH_PASSWORD
// ============================================================

module.exports = function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
  if (!AUTH_PASSWORD) {
    return res.status(500).json({ error: 'AUTH_PASSWORD not configured' });
  }

  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ success: false, error: '请输入密码' });
    }

    if (password === AUTH_PASSWORD) {
      return res.status(200).json({ success: true });
    } else {
      return res.status(401).json({ success: false, error: '密码错误' });
    }
  } catch (e) {
    console.error('Auth error:', e);
    return res.status(500).json({ error: e.message });
  }
};
