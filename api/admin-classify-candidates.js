// /api/admin-classify-candidates — read-only triage endpoint.
//
// Scans recruit:candidate:* and buckets each record into:
//   NOISE            — definitely not a job application (internal email,
//                      billing/receipt, notifications, Claude flagged as
//                      "not a job application", etc.)
//   LIKELY_CANDIDATE — Indeed fingerprint detected (source === "Indeed" or
//                      Claude's summary mentions Indeed).
//   UNCERTAIN        — neither signal present; needs human review.
//
// Returns counts + full per-record metadata for LIKELY_CANDIDATE and
// UNCERTAIN. NOISE returns only a sample (first 10) to keep the response
// small — the full set can be enumerated by filtering client-side or by
// re-running with ?include_noise_full=true.
//
// INTERNAL_SECRET-gated. Read-only — performs no deletes.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const NOISE_EMAIL_PATTERNS = [
  '@lifestylehomeservice.com',
  '@housecallpro.com',
  'forwarding-noreply@google.com',
  'no-reply@',
  'noreply@',
  '@notifications',
  'notifications@',
  'billing@',
  'receipts@',
  'invoice@',
  'support@',
  '@squarespace.com',
  '@mailchimp.com',
  '@sendgrid.net'
];

const NOISE_SUMMARY_KEYWORDS = [
  'not a job application',
  'not a candidate application',
  'system email',
  'invoice',
  'receipt',
  'bill',
  'payroll',
  'notification',
  'verification',
  'confirmation system',
  'housecall pro',
  'housecallpro',
  'forwarding',
  'newsletter',
  'internal email',
  'marketing'
];

const INDEED_SUMMARY_KEYWORDS = [
  'indeed',
  'applied via indeed',
  'indeed application'
];

function classify(candidate) {
  const email   = (candidate.email || '').toLowerCase();
  const summary = (candidate.aria_meta?.summary || '').toLowerCase();
  const concerns = (candidate.aria_meta?.concerns || []).join(' ').toLowerCase();
  const combined = summary + ' ' + concerns;
  const fullName = (candidate.full_name || '').toLowerCase().trim();
  const source   = candidate.source;

  // Strongest positive signal: the extraction flagged it as Indeed.
  if (source === 'Indeed') {
    return { bucket: 'LIKELY_CANDIDATE', reason: 'source=Indeed' };
  }
  for (const kw of INDEED_SUMMARY_KEYWORDS) {
    if (combined.includes(kw)) {
      return { bucket: 'LIKELY_CANDIDATE', reason: `summary matched "${kw}"` };
    }
  }

  // Noise: internal / system / vendor email domain.
  for (const pattern of NOISE_EMAIL_PATTERNS) {
    if (email.includes(pattern)) {
      return { bucket: 'NOISE', reason: `email matched "${pattern}"` };
    }
  }

  // Noise: Claude explicitly flagged non-candidate-ness.
  for (const kw of NOISE_SUMMARY_KEYWORDS) {
    if (combined.includes(kw)) {
      return { bucket: 'NOISE', reason: `summary matched "${kw}"` };
    }
  }

  // Weak noise: no name extractable and not from Indeed → almost certainly
  // not a real application.
  if (fullName === 'unknown' || fullName === '') {
    return { bucket: 'NOISE', reason: 'no name extractable (full_name=Unknown)' };
  }

  return { bucket: 'UNCERTAIN', reason: 'no strong positive or noise signal' };
}

function slim(candidate, classification) {
  return {
    candidate_id: candidate.candidate_id,
    full_name: candidate.full_name,
    email: candidate.email,
    phone: candidate.phone,
    source: candidate.source,
    status: candidate.status,
    score_value: candidate.score_value,
    created: candidate.stage_entered_at || candidate.last_updated || null,
    aria_summary: candidate.aria_meta?.summary || null,
    classification_reason: classification.reason
  };
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

export default async function handler(req, res) {
  const provided = req.headers['x-internal-secret']
    || (req.body && typeof req.body === 'object' ? req.body.secret : null);
  if (!process.env.INTERNAL_SECRET || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const includeNoiseFull = req.query?.include_noise_full === 'true' || req.query?.include_noise_full === '1';

  const keys = await scanKeys('recruit:candidate:*');
  const results = await Promise.all(keys.map(async k => ({ key: k, candidate: await redis.get(k) })));

  const noise = [];
  const likely = [];
  const uncertain = [];
  const broken = [];

  for (const { key, candidate } of results) {
    if (!candidate || typeof candidate !== 'object') {
      broken.push({ key });
      continue;
    }
    const cls = classify(candidate);
    const slim_rec = slim(candidate, cls);
    if (cls.bucket === 'NOISE')           noise.push(slim_rec);
    else if (cls.bucket === 'LIKELY_CANDIDATE') likely.push(slim_rec);
    else                                   uncertain.push(slim_rec);
  }

  // Sort each bucket by candidate_id ascending (so #001 first).
  const byId = (a, b) => String(a.candidate_id).localeCompare(String(b.candidate_id), undefined, { numeric: true });
  noise.sort(byId);
  likely.sort(byId);
  uncertain.sort(byId);

  return res.status(200).json({
    ok: true,
    scanned: keys.length,
    counts: {
      NOISE: noise.length,
      LIKELY_CANDIDATE: likely.length,
      UNCERTAIN: uncertain.length,
      broken: broken.length
    },
    // Always return full LIKELY + UNCERTAIN (expect small counts).
    LIKELY_CANDIDATE: likely,
    UNCERTAIN: uncertain,
    // NOISE: sample only, unless ?include_noise_full=true.
    NOISE: includeNoiseFull ? noise : noise.slice(0, 10),
    NOISE_sample_only: !includeNoiseFull,
    broken
  });
}
