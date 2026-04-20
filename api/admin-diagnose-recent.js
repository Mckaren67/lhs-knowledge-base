// /api/admin-diagnose-recent — protected diagnostic for "what happened in
// Redis in the last N minutes".
//
// Scans intake logs, candidate records, red alerts, sweep logs, email threads,
// and inbound SMS logs, filters to anything timestamped within the window
// (default 5 minutes), and returns JSON. Read-only — no writes.
//
// INTERNAL_SECRET-gated. Query params:
//   minutes  — window size (default 5, max 60)
//
// Usage:
//   curl -s "https://<deploy>/api/admin-diagnose-recent?minutes=5" \
//     -H "x-internal-secret: $INTERNAL_SECRET" | jq .

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

function parseTs(x) {
  if (x == null) return null;
  if (typeof x === 'number') return x > 1e12 ? x : x * 1000;
  const n = Date.parse(String(x));
  return Number.isFinite(n) ? n : null;
}

// A record is "recent" if ANY plausible timestamp field falls in the window.
function mostRecentTs(record) {
  if (!record || typeof record !== 'object') return null;
  const candidates = [
    record.timestamp,
    record.received_at,
    record.stage_entered_at,
    record.last_updated,
    record.created_at,
    record.ran_at
  ];
  let best = null;
  for (const c of candidates) {
    const t = parseTs(c);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best;
}

async function scanKeys(pattern) {
  let cursor = 0;
  const keys = [];
  do {
    const [next, batch] = await redis.scan(cursor, { match: pattern, count: 500 });
    cursor = Number(next);
    if (batch?.length) keys.push(...batch);
  } while (cursor !== 0);
  return keys;
}

async function readRecent(pattern, windowMs, nowMs) {
  const keys = await scanKeys(pattern);
  const total = keys.length;
  const records = await Promise.all(keys.map(async k => ({ key: k, value: await redis.get(k) })));
  const recent = [];
  for (const { key, value } of records) {
    const ts = mostRecentTs(value);
    if (ts != null && nowMs - ts <= windowMs) {
      recent.push({ key, ts_ms: ts, age_sec: Math.round((nowMs - ts) / 1000), value });
    }
  }
  recent.sort((a, b) => b.ts_ms - a.ts_ms);
  return { total, recent_count: recent.length, recent };
}

export default async function handler(req, res) {
  const provided = req.headers['x-internal-secret']
    || (req.body && typeof req.body === 'object' ? req.body.secret : null);
  if (!process.env.INTERNAL_SECRET || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const minutes = Math.min(60, Math.max(1, Number(req.query?.minutes) || 5));
  const windowMs = minutes * 60 * 1000;
  const nowMs = Date.now();

  const [intakeLog, candidates, placeholders, redAlerts, sweepLog, inboundSms, emailThreads, pendingGit] = await Promise.all([
    readRecent('recruit:intake_log:*',              windowMs, nowMs),
    readRecent('recruit:candidate:*',               windowMs, nowMs),
    readRecent('recruit:placeholder:*',             windowMs, nowMs),
    readRecent('recruit:redalert:*',                windowMs, nowMs),
    readRecent('recruit:sweep_log:*',               windowMs, nowMs),
    readRecent('recruit:inbound_sms:*',             windowMs, nowMs),
    readRecent('recruit:email_thread:*',            windowMs, nowMs),
    readRecent('recruit:pending_git:*',             windowMs, nowMs)
  ]);

  const counter = await redis.get('recruit:counter:candidate_id');
  const hiringMode = await redis.get('recruit:settings:hiring_mode');

  return res.status(200).json({
    ok: true,
    window_minutes: minutes,
    window_start: new Date(nowMs - windowMs).toISOString(),
    window_end: new Date(nowMs).toISOString(),
    counter_now: counter,
    hiring_mode: hiringMode,
    summary: {
      intake_log:     { total: intakeLog.total,     recent: intakeLog.recent_count },
      candidates:     { total: candidates.total,    recent: candidates.recent_count },
      placeholders:   { total: placeholders.total,  recent: placeholders.recent_count },
      red_alerts:     { total: redAlerts.total,     recent: redAlerts.recent_count },
      sweep_log:      { total: sweepLog.total,      recent: sweepLog.recent_count },
      inbound_sms:    { total: inboundSms.total,    recent: inboundSms.recent_count },
      email_threads:  { total: emailThreads.total,  recent: emailThreads.recent_count },
      pending_git:    { total: pendingGit.total,    recent: pendingGit.recent_count }
    },
    recent: {
      intake_log:    intakeLog.recent,
      candidates:    candidates.recent,
      placeholders:  placeholders.recent,
      red_alerts:    redAlerts.recent,
      sweep_log:     sweepLog.recent,
      inbound_sms:   inboundSms.recent,
      email_threads: emailThreads.recent,
      pending_git:   pendingGit.recent
    }
  });
}
