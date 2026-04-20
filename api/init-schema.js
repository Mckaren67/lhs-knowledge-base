// One-shot schema initialization for AriaRecruit Phase 1.
//
// Idempotent: only writes keys that are missing. Safe to call more than once.
// Protected by INTERNAL_SECRET — POST with header `x-internal-secret: <value>`
// or JSON body `{ secret: "..." }`.
//
// Initializes, per v1.3 §2.3 and kickoff item 4:
//   recruit:settings:hiring_mode          = "CASUAL"
//   recruit:settings:summary_times        = ["07:00", "11:00", "15:00"] (America/Vancouver)
//   recruit:settings:autonomy_level       = phase-1 stub; refined in Phase 5
//   recruit:counter:candidate_id          = 15 (#015 Justine Davis was the last assigned)
// Then calls createPlaceholder for Sharyn McKay #016, which advances counter to 16.

import { Redis } from '@upstash/redis';
import { createPlaceholder, findPlaceholderByName, formatId } from './_lib/createPlaceholder.js';

const redis = Redis.fromEnv();

const DEFAULT_AUTONOMY = {
  _note: 'Phase 1 stub. Autonomy matrix enforcement is Phase 5 (see v1.3 §13 Phase 5 #29).',
  CASUAL: {
    applied_to_screener:        'auto',
    screener_to_jotform:        'auto',
    jotform_to_simulator:       'auto',
    simulator_to_phone_screen:  'review_required',
    phone_screen_to_trial:      'human_approval',
    trial_to_offer:             'human_approval',
    offer_to_hired_declined:    'human_approval'
  },
  URGENT: {
    applied_to_screener:        'auto',
    screener_to_jotform:        'auto',
    jotform_to_simulator:       'auto',
    simulator_to_phone_screen:  'auto',
    phone_screen_to_trial:      'review_required',
    trial_to_offer:             'human_approval',
    offer_to_hired_declined:    'human_approval'
  },
  NOT_HIRING: {
    applied_to_screener:        'review_required',
    screener_to_jotform:        'review_required',
    jotform_to_simulator:       'human_approval',
    simulator_to_phone_screen:  'human_approval',
    phone_screen_to_trial:      'human_approval',
    trial_to_offer:             'human_approval',
    offer_to_hired_declined:    'human_approval'
  }
};

const SHARYN_SEED = {
  name: 'Sharyn McKay',
  source: 'expected',
  expected_date: '2026-04-19',
  notes: 'Resume received; low priority; populate full record when time permits',
  expected_by_deadline_days: 14
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const provided =
    req.headers['x-internal-secret'] ||
    (req.body && typeof req.body === 'object' ? req.body.secret : null);

  if (!process.env.INTERNAL_SECRET || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const written = [];
  const skipped = [];

  async function ensure(key, value) {
    const current = await redis.get(key);
    if (current == null) {
      await redis.set(key, value);
      written.push(key);
    } else {
      skipped.push(key);
    }
  }

  await ensure('recruit:settings:hiring_mode', 'CASUAL');
  await ensure('recruit:settings:summary_times', ['07:00', '11:00', '15:00']);
  await ensure('recruit:settings:autonomy_level', DEFAULT_AUTONOMY);

  const existingCounter = await redis.get('recruit:counter:candidate_id');
  if (existingCounter == null) {
    await redis.set('recruit:counter:candidate_id', 15);
    written.push('recruit:counter:candidate_id');
  } else {
    skipped.push('recruit:counter:candidate_id');
  }

  let sharynResult;
  const existingSharyn = await findPlaceholderByName(SHARYN_SEED.name);
  if (existingSharyn) {
    sharynResult = { status: 'already_exists', placeholder: existingSharyn };
  } else {
    const counterBefore = Number(await redis.get('recruit:counter:candidate_id'));
    if (counterBefore !== 15) {
      sharynResult = {
        status: 'skipped',
        reason: `Counter is at ${counterBefore}, expected 15 before Sharyn seed. Manual reconciliation needed.`
      };
    } else {
      const created = await createPlaceholder(SHARYN_SEED);
      sharynResult = { status: 'created', placeholder: created };
    }
  }

  const finalCounter = Number(await redis.get('recruit:counter:candidate_id'));

  return res.status(200).json({
    ok: true,
    written,
    skipped,
    sharyn: sharynResult,
    counter_now: finalCounter,
    next_candidate_id: formatId(finalCounter + 1)
  });
}
