// /api/send-jotform-invite — send the JotForm invite to one Applied candidate.
//
// Fires both SMS (from 778-200-6517) and email (from careers@) in parallel,
// each with 3-attempt exponential backoff. On double-success the candidate
// transitions Applied → JotForm (zrem + writeCandidate). Partial failures stay
// Applied and add a flag. Double-failure writes a red alert for Karen.
//
// Called by the 2-minute sweep cron OR manually via INTERNAL_SECRET curl.
// Idempotent: shouldSendJotformInvite() rejects candidates that already have
// a jotform_invite_* entry in communication_log.

import { Redis } from '@upstash/redis';

import { writeCandidate } from './_lib/writeCandidate.js';
import { shouldSendJotformInvite, jotformInviteSkipReason } from './_lib/jotformInvite.js';
import { firstNameFrom } from './_lib/intake-helpers.js';

const redis = Redis.fromEnv();

const JOTFORM_URL = process.env.JOTFORM_URL || 'https://form.jotform.com/251412920037245';
const TWILIO_PHONE = process.env.TWILIO_PHONE || '+17782006517';
const FROM_EMAIL = 'careers@lifestylehomeservice.com';

function smsBody(firstName) {
  return `Hi ${firstName}, thanks for applying to Lifestyle Home Service! Please fill out this short form so we can learn more about you: ${JOTFORM_URL}
Once complete, we'll reach out to set up a quick call. — The LHS Team`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Runs `fn` up to 3 times with 1s/2s/4s delays between attempts.
// Returns `{ ok: true, result }` or `{ ok: false, error, attempts }`.
async function withBackoff(fn, label) {
  const delays = [0, 1000, 2000, 4000]; // attempt indices 1..3 use delays[1..3]
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (delays[attempt - 1] > 0) await sleep(delays[attempt - 1]);
    try {
      const result = await fn();
      if (result && result.ok !== false && result.status !== 'failed') {
        return { ok: true, result, attempts: attempt };
      }
      lastError = result?.error || result?.body?.error || `non-ok result from ${label}`;
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError, attempts: 3 };
}

async function callInternal(path, payload) {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SECRET || ''
    },
    body: JSON.stringify(payload)
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, ok: r.ok && body?.ok !== false };
}

function logEntry({ type, channel, from, to, status, body }) {
  return {
    timestamp: new Date().toISOString(),
    type,
    direction: 'out',
    channel,
    from,
    to,
    template_key: 'jotform_invite',
    status,
    message_preview: String(body || '').slice(0, 120)
  };
}

async function writeRedAlert({ id, severity, type, description, resolution_action, candidate_id }) {
  const now = new Date();
  await redis.set(`recruit:redalert:${id}_${now.getTime()}`, {
    id,
    severity,
    type,
    description,
    resolution_action,
    candidate_id,
    created_at: now.toISOString(),
    resolved_at: null
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const provided = req.headers['x-internal-secret']
    || (req.body && typeof req.body === 'object' ? req.body.secret : null);
  if (!process.env.INTERNAL_SECRET || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { candidate_id } = req.body || {};
  if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });

  const candidate = await redis.get(`recruit:candidate:${candidate_id}`);
  if (!candidate) return res.status(404).json({ error: 'candidate not found', candidate_id });

  if (!shouldSendJotformInvite(candidate)) {
    return res.status(200).json({
      ok: false,
      skipped: true,
      reason: jotformInviteSkipReason(candidate),
      candidate_id
    });
  }

  const firstName = firstNameFrom(candidate.full_name);
  const sms = smsBody(firstName);

  const smsSendable = !!candidate.phone;
  const emailSendable = !!candidate.email;

  if (!smsSendable && !emailSendable) {
    return res.status(400).json({
      ok: false,
      error: 'no_phone_or_email',
      candidate_id
    });
  }

  // Fire both channels in parallel. Each one gets its own backoff.
  const [smsResult, emailResult] = await Promise.all([
    smsSendable
      ? withBackoff(() => callInternal('/api/twilio-outbound', {
          candidate_id,
          to: candidate.phone,
          body: sms
        }), 'twilio-outbound')
      : Promise.resolve({ ok: false, error: 'no_phone', attempts: 0, skipped: true }),

    emailSendable
      ? withBackoff(() => callInternal('/api/send-email', {
          candidate_id,
          template: 'jotform_invite',
          data: { firstName, jotformUrl: JOTFORM_URL }
        }), 'send-email')
      : Promise.resolve({ ok: false, error: 'no_email', attempts: 0, skipped: true })
  ]);

  const smsOk = smsResult.ok === true;
  const emailOk = emailResult.ok === true;

  // Re-fetch the candidate in case something else has mutated it during backoff.
  const current = await redis.get(`recruit:candidate:${candidate_id}`) || candidate;
  current.communication_log = current.communication_log || [];
  current.flags = current.flags || [];

  if (smsSendable) {
    current.communication_log.push(logEntry({
      type: 'jotform_invite_sms',
      channel: 'sms',
      from: TWILIO_PHONE,
      to: candidate.phone,
      status: smsOk ? 'sent' : 'failed',
      body: sms
    }));
  }
  if (emailSendable) {
    current.communication_log.push(logEntry({
      type: 'jotform_invite_email',
      channel: 'email',
      from: FROM_EMAIL,
      to: candidate.email,
      status: emailOk ? 'sent' : 'failed',
      body: `Next steps — LHS application → ${JOTFORM_URL}`
    }));
  }

  // Flags for partial failures.
  if (smsSendable && !smsOk) {
    current.flags.push({
      id: 'jotform_invite_sms_failed',
      severity: 'warning',
      description: `SMS send to ${candidate.phone} failed after 3 attempts: ${smsResult.error || 'unknown'}`
    });
  }
  if (emailSendable && !emailOk) {
    current.flags.push({
      id: 'jotform_invite_email_failed',
      severity: 'warning',
      description: `Email send to ${candidate.email} failed after 3 attempts: ${emailResult.error || 'unknown'}`
    });
  }

  const bothSent = smsOk && emailOk;
  const bothFailed = !smsOk && !emailOk;

  if (bothSent) {
    // Status transition Applied → JotForm.
    await redis.zrem('recruit:stage:Applied', candidate_id);
    current.status = 'JotForm';
    current.stage_entered_at = new Date().toISOString();
    current.next_action = 'Awaiting JotForm completion; reminder at 48h if still pending.';
    await writeCandidate({ candidate: current, eventType: 'jotform_invite_sent' });
  } else {
    // Partial or total failure — persist log + flags without transitioning stage.
    await redis.set(`recruit:candidate:${candidate_id}`, current);
  }

  if (bothFailed) {
    await writeRedAlert({
      id: `jotform_invite_both_failed_${candidate_id}`,
      severity: 'red_alert',
      type: 'jotform_invite_both_failed',
      description: `Both SMS and email to ${current.full_name} (${candidate_id}) failed. SMS: ${smsResult.error || 'n/a'}. Email: ${emailResult.error || 'n/a'}.`,
      resolution_action: 'Check Twilio + SendGrid status; contact candidate manually or retry via /api/send-jotform-invite.',
      candidate_id
    });
  }

  return res.status(200).json({
    ok: bothSent,
    candidate_id,
    sms: { ok: smsOk, attempts: smsResult.attempts, error: smsResult.error || null },
    email: { ok: emailOk, attempts: emailResult.attempts, error: emailResult.error || null },
    transitioned_to_jotform: bothSent,
    red_alert_raised: bothFailed
  });
}
