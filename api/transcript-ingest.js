// /api/transcript-ingest — Cowork (on Karen's Mac) posts Meet / Dialpad
// transcripts here. Phase 1 is a stub: accept, store to Redis, return 200.
// Full processing (Claude Opus summarization, per-dimension scoring) is
// Phase 4 (v1.3 §13 Phase 4 #22–25).

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const ALLOWED_SOURCES = new Set(['meet', 'dialpad', 'other']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const provided =
    req.headers['x-internal-secret'] ||
    (req.body && typeof req.body === 'object' ? req.body.secret : null);

  if (!process.env.INTERNAL_SECRET || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { candidate_id, source, transcript, metadata } = req.body || {};

  if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });
  if (!ALLOWED_SOURCES.has(source)) {
    return res.status(400).json({ error: `source must be one of ${[...ALLOWED_SOURCES].join(', ')}` });
  }
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'transcript (string) required' });
  }

  const now = new Date();
  const key = `recruit:transcript:${candidate_id}:${source}:${now.getTime()}`;

  await redis.set(key, {
    candidate_id,
    source,
    transcript,
    metadata: metadata || {},
    received_at: now.toISOString(),
    processing_status: 'raw_stored_phase1_no_scoring'
  });

  return res.status(200).json({
    ok: true,
    key,
    note: 'Phase 1 stub — transcript stored raw; scoring deferred to Phase 4.'
  });
}
