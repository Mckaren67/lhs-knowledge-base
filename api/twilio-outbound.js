// /api/twilio-outbound — Aria's SMS sender.
//
// All Aria-driven candidate SMS goes through here, always from 604-330-3997.
// Karen's and Michael's personal phones stay personal (v1.3 §9). This endpoint
// is INTERNAL (protected by INTERNAL_SECRET) — candidate-facing features call
// it from other Vercel functions, not from the browser.

import twilio from 'twilio';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const provided =
    req.headers['x-internal-secret'] ||
    (req.body && typeof req.body === 'object' ? req.body.secret : null);
  if (!process.env.INTERNAL_SECRET || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN || !process.env.TWILIO_PHONE) {
    return res.status(503).json({ error: 'Twilio env vars not configured' });
  }

  const { candidate_id, to, body } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: 'to + body required' });

  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  const now = new Date();

  let sendResult;
  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE,
      to
    });
    sendResult = {
      status: 'sent',
      sid: message.sid,
      twilio_status: message.status,
      price: message.price || null
    };
  } catch (err) {
    sendResult = {
      status: 'failed',
      error: err.message,
      code: err.code || null
    };
  }

  if (candidate_id && candidate_id !== 'SYSTEM') {
    const candidate = await redis.get(`recruit:candidate:${candidate_id}`);
    if (candidate) {
      candidate.communication_log = candidate.communication_log || [];
      candidate.communication_log.push({
        timestamp: now.toISOString(),
        channel: 'sms',
        direction: 'out',
        summary: body.length > 160 ? body.slice(0, 157) + '…' : body,
        twilio_sid: sendResult.sid || null,
        twilio_status: sendResult.twilio_status || sendResult.status
      });
      await redis.set(`recruit:candidate:${candidate_id}`, candidate);
    }
  }

  const statusCode = sendResult.status === 'sent' ? 200 : 502;
  return res.status(statusCode).json({ ok: sendResult.status === 'sent', ...sendResult, to });
}
