// /api/twilio-inbound — Twilio webhook for incoming SMS.
//
// Phase 1: log the message, match to a candidate if we can find one by phone,
// append to communication_log. No automated reply. Command parsing
// (APPROVE/REJECT/MODE) and conversational response is Phase 2+.

import twilio from 'twilio';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const config = { api: { bodyParser: true } };

function normalizePhone(p) {
  return String(p || '').replace(/[^\d]/g, '').replace(/^1(\d{10})$/, '$1');
}

async function findCandidateByPhone(phone) {
  const target = normalizePhone(phone);
  if (!target) return null;

  let cursor = 0;
  do {
    const [next, keys] = await redis.scan(cursor, { match: 'recruit:candidate:*', count: 200 });
    cursor = Number(next);
    for (const k of keys || []) {
      const c = await redis.get(k);
      if (c?.phone && normalizePhone(c.phone) === target) return c;
    }
  } while (cursor !== 0);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { From, Body, MessageSid, NumMedia } = req.body || {};
  const now = new Date();

  const key = `recruit:inbound_sms:${MessageSid || now.getTime()}`;
  await redis.set(key, {
    timestamp: now.toISOString(),
    from: From,
    body: Body,
    message_sid: MessageSid,
    num_media: Number(NumMedia) || 0,
    processed: false
  }, { ex: 60 * 60 * 24 * 90 });

  const candidate = await findCandidateByPhone(From);
  if (candidate) {
    candidate.communication_log = candidate.communication_log || [];
    candidate.communication_log.push({
      timestamp: now.toISOString(),
      channel: 'sms',
      direction: 'in',
      summary: (Body || '').length > 200 ? Body.slice(0, 197) + '…' : (Body || '(empty)'),
      twilio_sid: MessageSid
    });
    if (!candidate.phone_confirmed) candidate.phone_confirmed = true;
    await redis.set(`recruit:candidate:${candidate.candidate_id}`, candidate);

    await redis.set(key, {
      timestamp: now.toISOString(),
      from: From,
      body: Body,
      message_sid: MessageSid,
      num_media: Number(NumMedia) || 0,
      matched_candidate_id: candidate.candidate_id,
      processed: true
    }, { ex: 60 * 60 * 24 * 90 });
  }

  const tw = new twilio.twiml.MessagingResponse();
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(tw.toString());
}
