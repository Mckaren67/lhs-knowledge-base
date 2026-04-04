const store = {};

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing key' });
    store[key] = value;
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const { key } = req.query;
    if (key) return res.status(200).json({ value: store[key] || null });
    return res.status(200).json({ data: store });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
