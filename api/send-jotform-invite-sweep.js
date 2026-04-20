// /api/send-jotform-invite-sweep — runs every 2 minutes via Vercel Cron.
//
// Scans recruit:stage:Applied for candidates whose zset score (intake time)
// falls in the [now-10min, now-5min] window. For each, calls
// /api/send-jotform-invite to do the actual send.
//
// Two-window approach (5–10 min, not "anything older than 5 min") means
// candidates that arrived during a missed cron run still get picked up on
// subsequent runs while still old enough to feel less robotic.
//
// Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Manual
// invocation can use `x-internal-secret: ${INTERNAL_SECRET}`.

import { Redis } from '@upstash/redis';

import { shouldSendJotformInvite, jotformInviteSkipReason } from './_lib/jotformInvite.js';

const redis = Redis.fromEnv();

const WINDOW_START_MIN_AGO = 10 * 60 * 1000;  // 10 min
const WINDOW_END_MIN_AGO   = 5  * 60 * 1000;  // 5  min

function authorized(req) {
  const bearer = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && bearer === `Bearer ${process.env.CRON_SECRET}`) return true;
  const secret = req.headers['x-internal-secret'];
  if (process.env.INTERNAL_SECRET && secret === process.env.INTERNAL_SECRET) return true;
  return false;
}

async function callSendInvite(candidate_id) {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
  const r = await fetch(`${base}/api/send-jotform-invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SECRET || ''
    },
    body: JSON.stringify({ candidate_id })
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, ok: r.ok };
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const now = Date.now();
  const minScore = now - WINDOW_START_MIN_AGO;
  const maxScore = now - WINDOW_END_MIN_AGO;

  // Candidates who entered Applied between 10 and 5 minutes ago.
  const ids = await redis.zrange('recruit:stage:Applied', minScore, maxScore, { byScore: true });

  const scanned = ids.length;
  const invited = [];
  const skipped = [];
  const errors = [];

  for (const candidate_id of ids) {
    const candidate = await redis.get(`recruit:candidate:${candidate_id}`);
    if (!candidate) {
      errors.push({ candidate_id, error: 'record_missing' });
      continue;
    }
    if (!shouldSendJotformInvite(candidate)) {
      skipped.push({ candidate_id, reason: jotformInviteSkipReason(candidate) });
      continue;
    }
    try {
      const r = await callSendInvite(candidate_id);
      if (r.ok && r.body?.ok === true) {
        invited.push({ candidate_id, transitioned: r.body.transitioned_to_jotform });
      } else {
        errors.push({ candidate_id, status: r.status, body: r.body });
      }
    } catch (err) {
      errors.push({ candidate_id, error: err.message });
    }
  }

  const summary = {
    ok: true,
    window: { from_ms_ago: WINDOW_START_MIN_AGO, to_ms_ago: WINDOW_END_MIN_AGO },
    scanned,
    invited_count: invited.length,
    skipped_count: skipped.length,
    error_count: errors.length,
    invited,
    skipped,
    errors,
    ran_at: new Date().toISOString()
  };

  // Persist the last 100 sweep runs for observability.
  await redis.set(`recruit:sweep_log:jotform_invite:${now}`, summary, { ex: 60 * 60 * 24 * 7 });

  return res.status(200).json(summary);
}
