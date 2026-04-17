// Simple in-memory key/value store for The Bridge dashboard.
// Replace with Upstash Redis or Vercel KV when ready — interface:
//   GET  /api/bridge-data            -> returns the current state object
//   POST /api/bridge-data { kind, payload, at } -> append to eventLog + shallow-merge
// The dashboard has a graceful seed-data fallback, so this endpoint is optional.

let state = {};
const eventLog = [];

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ state, events: eventLog.slice(-50) });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (body.kind && body.payload \!== undefined) {
      eventLog.push({ kind: body.kind, payload: body.payload, at: body.at || new Date().toISOString() });
    }
    if (body.state && typeof body.state === 'object') {
      state = { ...state, ...body.state };
    }
    return res.status(200).json({ ok: true, events: eventLog.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
