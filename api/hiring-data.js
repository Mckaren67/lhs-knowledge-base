// /api/hiring-data — single read endpoint feeding hiring.html.
//
// Returns the full portal state: mode, next-id preview, Kanban stages
// with hydrated candidate cards, holding lanes, red alerts, and stats.
// Intentionally one fetch so the UI renders atomically without a waterfall.

import { Redis } from '@upstash/redis';
import { formatScoreOption2 } from './_lib/writeCandidate.js';
import { formatId } from './_lib/createPlaceholder.js';

const redis = Redis.fromEnv();

const STAGES = [
  'Applied', 'Screener', 'JotForm', 'Cleaning simulator',
  'Phone screen', 'Trial', 'Offer', 'Hired/Declined'
];

const HOLDING_LANES = [
  'hard_hold', 'conditional_hold', 'pending_return',
  'waiting_employer', 'reassigned', 'expected'
];

const RUBRIC_HUMAN = {
  full_rubric:        'full rubric',
  phone_screen_only:  'phone screen only',
  expanded_screen:    'expanded screen',
  prescreen_triage:   'prescreen triage',
  partial_assessment: 'partial assessment'
};

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  return Math.floor((new Date(isoB) - new Date(isoA)) / 86400000);
}

function cardFromCandidate(c, now = new Date()) {
  if (!c) return null;
  const daysInStage = daysBetween(c.stage_entered_at, now);
  return {
    candidate_id:        c.candidate_id,
    full_name:           c.full_name,
    score_value:         c.score_value ?? null,
    score_denominator:   c.score_denominator ?? null,
    rubric_type:         c.rubric_type ?? null,
    rubric_type_human:   RUBRIC_HUMAN[c.rubric_type] || null,
    interviewer_name:    c.interviewer_name ?? null,
    score_display:       formatScoreOption2(c),
    status:              c.status ?? null,
    stage_entered_at:    c.stage_entered_at ?? null,
    days_in_stage:       daysInStage,
    next_action:         c.next_action ?? null,
    needs_approval:      c.needs_approval === true,
    flag_count:          Array.isArray(c.flags) ? c.flags.length : 0,
    has_red_alert_flag:  Array.isArray(c.flags) && c.flags.some(f => f && f.severity === 'red_alert'),
    kind:                c.kind || 'candidate'
  };
}

async function getById(id) {
  const candidate = await redis.get(`recruit:candidate:${id}`);
  if (candidate) return candidate;
  const placeholder = await redis.get(`recruit:placeholder:${id}`);
  return placeholder || null;
}

async function readStage(stageName) {
  const ids = await redis.zrange(`recruit:stage:${stageName}`, 0, -1);
  if (!ids || !ids.length) return [];
  const records = await Promise.all(ids.map(getById));
  return records.filter(Boolean).map(r => cardFromCandidate(r));
}

async function readHolding(laneName) {
  const ids = await redis.zrange(`recruit:holding:${laneName}`, 0, -1);
  if (!ids || !ids.length) return [];
  const records = await Promise.all(ids.map(getById));
  return records.filter(Boolean).map(r => cardFromCandidate(r));
}

async function readRedAlerts() {
  let cursor = 0;
  const keys = [];
  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: 'recruit:redalert:*', count: 200 });
    cursor = Number(nextCursor);
    if (batch && batch.length) keys.push(...batch);
  } while (cursor !== 0);

  if (!keys.length) return [];
  const records = await Promise.all(keys.map(k => redis.get(k)));
  return records
    .filter(Boolean)
    .filter(r => !r.resolved_at)
    .sort((a, b) => (new Date(b.created_at || 0) - new Date(a.created_at || 0)));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const [mode, counterRaw, ...stageResults] = await Promise.all([
      redis.get('recruit:settings:hiring_mode'),
      redis.get('recruit:counter:candidate_id'),
      ...STAGES.map(readStage)
    ]);

    const holdingResults = await Promise.all(HOLDING_LANES.map(readHolding));
    const redAlerts = await readRedAlerts();

    const kanban = {};
    STAGES.forEach((name, i) => { kanban[name] = stageResults[i]; });

    const holding = {};
    HOLDING_LANES.forEach((name, i) => { holding[name] = holdingResults[i]; });

    const activeCount  = Object.values(kanban).reduce((n, arr) => n + arr.length, 0);
    const holdingCount = Object.values(holding).reduce((n, arr) => n + arr.length, 0);

    const counter = Number(counterRaw) || 0;

    return res.status(200).json({
      ok: true,
      mode: mode || 'CASUAL',
      counter,
      next_candidate_id: formatId(counter + 1),
      kanban,
      holding,
      red_alerts: redAlerts,
      stats: {
        active: activeCount,
        holding: holdingCount,
        red_alerts: redAlerts.length
      },
      schema_version: 'v1.3',
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not read hiring data', details: err.message });
  }
}
