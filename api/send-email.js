// /api/send-email — SendGrid outbound wrapper.
//
// All candidate-facing email goes through here. Always sent from
// "LHS Careers <careers@lifestylehomeservice.com>" per v1.3 §8 and the
// success criterion that candidates never land in Karen's personal inbox.
//
// Usage patterns:
//   1. Template send:  { candidate_id, template: "first_contact", data: { firstName, pretrained } }
//   2. Custom send:    { candidate_id, subject, body, to? }
//
// Every send appends to recruit:email_thread:{candidate_id}.
// Protected by INTERNAL_SECRET when called from another Vercel function
// (CALLER_SECRET) or by skipping auth when called internally (same invocation
// doesn't re-auth; only external callers need the secret).

import sgMail from '@sendgrid/mail';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const FROM_EMAIL = 'careers@lifestylehomeservice.com';
const FROM_NAME  = 'LHS Careers';

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const TEMPLATES = {
  first_contact: {
    subject: (d) => `Thanks for applying to Lifestyle Home Service — ${d.firstName || 'there'}`,
    body: (d) => {
      const opening = d.pretrained
        ? `Hi ${d.firstName || 'there'},\n\nThanks for your application to Lifestyle Home Service. Your cleaning background caught our eye — we'd like to move quickly to see if this is a fit.`
        : `Hi ${d.firstName || 'there'},\n\nThanks for your application to Lifestyle Home Service. We're looking for reliable, trainable folks to join our team — experience is a bonus, not a requirement.`;
      return `${opening}

Our scheduling assistant Aria will be in touch by text shortly with three quick questions. If you'd rather reply by email, that's fine too.

A few things to know up front:
- Role: Residential House Cleaner, based in Chilliwack, BC
- Trial day is paid ($23/hr CAD, 2 hours)
- We provide a full in-house training program
- You'll need a reliable vehicle for travel between homes

If you'd like to read more about the role or the team, reply to this email and we'll send a realistic job preview.

Talk soon,
The Lifestyle Home Service hiring team`;
    }
  },

  location_decline: {
    subject: () => 'Thank you for applying to Lifestyle Home Service',
    body: (d) => `Hi ${d.firstName || 'there'},

Thank you for your interest in Lifestyle Home Service. Unfortunately, our service area is currently limited to Chilliwack, Sardis, Rosedale, and Cultus Lake, and your location falls outside that radius.

We wish you all the best in your job search.

— The LHS Team`
  }
};

async function requireAuth(req) {
  const provided =
    req.headers['x-internal-secret'] ||
    (req.body && typeof req.body === 'object' ? req.body.secret : null);
  return provided && provided === process.env.INTERNAL_SECRET;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!(await requireAuth(req))) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.SENDGRID_API_KEY) {
    return res.status(503).json({ error: 'SENDGRID_API_KEY not configured' });
  }

  const { candidate_id, template, data, to, subject, body } = req.body || {};

  if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });

  let finalSubject, finalBody, finalTo = to;

  if (template) {
    const tmpl = TEMPLATES[template];
    if (!tmpl) return res.status(400).json({ error: `Unknown template: ${template}` });
    finalSubject = tmpl.subject(data || {});
    finalBody = tmpl.body(data || {});
  } else if (subject && body) {
    finalSubject = subject;
    finalBody = body;
  } else {
    return res.status(400).json({ error: 'Either template or (subject+body) required' });
  }

  if (!finalTo) {
    const candidate = (await redis.get(`recruit:candidate:${candidate_id}`))
                   || (await redis.get(`recruit:placeholder:${candidate_id}`));
    finalTo = candidate?.email;
  }
  if (!finalTo) return res.status(400).json({ error: 'No destination email (to) resolved' });

  const now = new Date();
  const msg = {
    to: finalTo,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    replyTo: FROM_EMAIL,
    subject: finalSubject,
    text: finalBody,
    customArgs: { candidate_id, template: template || 'custom' }
  };

  let sendResult;
  try {
    const [response] = await sgMail.send(msg);
    sendResult = {
      status: 'sent',
      status_code: response.statusCode,
      message_id: response.headers['x-message-id'] || null
    };
  } catch (err) {
    sendResult = {
      status: 'failed',
      error: err.message,
      code: err.code || null
    };
  }

  const threadKey = `recruit:email_thread:${candidate_id}`;
  const existing = (await redis.get(threadKey)) || { candidate_id, messages: [] };
  existing.messages.push({
    direction: 'out',
    timestamp: now.toISOString(),
    to: finalTo,
    subject: finalSubject,
    template: template || 'custom',
    ...sendResult
  });
  await redis.set(threadKey, existing);

  const statusCode = sendResult.status === 'sent' ? 200 : 502;
  return res.status(statusCode).json({ ok: sendResult.status === 'sent', ...sendResult, to: finalTo });
}
