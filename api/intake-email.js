// /api/intake-email — SendGrid Inbound Parse webhook for candidate applications.
//
// Flow (per v1.3 §8 + kickoff item 3):
//   1. Parse multipart/form-data from SendGrid (fields + attachments)
//   2. Log raw intake to recruit:intake_log:{id} (30-day retention) — nothing is lost
//   3. Claude Opus reads any PDF/DOCX resume as a document block + extracts to JSON
//   4. Compute 0-100 score via the extraction-doc formula
//   5. Check placeholders for name match — merge into reserved ID if matched
//      else INCR recruit:counter:candidate_id → new #NNN
//   6. Translate extraction output into v1.3 §3.1 candidate schema
//      - score_value / score_denominator=100 / rubric_type=prescreen_triage
//      - interviewer_name="Aria (automated)" / per_dimension_scores
//      - status="Applied"
//   7. writeCandidate (dual-write: Redis + atomic git commit of MD + JSON)
//   8. Fire first SMS from 604-330-3997 (via /api/twilio-outbound, INTERNAL_SECRET-gated)
//   9. Fire first email from careers@ (via /api/send-email)
//
// Never auto-rejects. Borderline/hold candidates get a holding email but
// still live in the funnel at status="Applied" with needs_approval=true.

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import formidable from 'formidable';
import fs from 'node:fs/promises';

import { writeCandidate } from './_lib/writeCandidate.js';
import { createPlaceholder, findPlaceholderByName, formatId } from './_lib/createPlaceholder.js';

const redis = Redis.fromEnv();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const config = { api: { bodyParser: false } };

const LHS_SYSTEM_PROMPT = `You are analyzing a job application for Lifestyle Home Service, a residential cleaning company in Chilliwack, BC.

LHS has a strong in-house training program (Cleaning Tech Boot Camp, 9 modules). They hire TRAINABLE people, not just experienced cleaners. Your job is to identify candidates who will succeed after training, and flag those who come pre-trained as a bonus.

Score the candidate based on:
- Likelihood to show up reliably
- Ability to follow a detailed process
- Comfort with customer-facing respectful communication
- Physical stamina capacity
- Tenure patterns (will they stay?)

Prior cleaning experience is a BONUS, not a requirement. Don't penalize candidates who lack it.

Return ONLY a JSON object with this exact structure, no preamble:

{
  "full_name": "full name",
  "email": "email@address.com",
  "phone": "+1-604-555-0000 or null",
  "location_city": "Chilliwack or null",
  "location_postal_code": "V2P 1A1 or null",
  "pretrained_bonus": true/false,
  "pretrained_type": "residential|hotel|healthcare|commercial|none",
  "pretrained_years": number,
  "transferable_signals": ["detail_oriented", "customer_facing", "physical_stamina", "reliability"],
  "red_flags": ["short_tenures", "unexplained_gaps", "resume_inconsistencies", "no_transportation", "criminal_history_mention"],
  "communication_quality": 1-5,
  "transportation_ok": true/false/null,
  "distance_minutes_from_chilliwack": number or null,
  "summary": "2-sentence human-readable summary",
  "strengths": ["specific strength 1", "specific strength 2"],
  "concerns": ["specific concern 1 or empty array"]
}`;

function scoreBreakdown(extracted) {
  const dims = [];
  let total = 50;

  dims.push({
    dimension_name: 'trainable_baseline',
    score: 50, denominator: 50,
    description: 'LHS hires trainable people; this is the default floor.'
  });

  if (extracted.pretrained_bonus) {
    total += 20;
    dims.push({
      dimension_name: 'prior_cleaning_experience',
      score: 20, denominator: 20,
      description: `${extracted.pretrained_type || 'unspecified'} · ${extracted.pretrained_years || 0} yr(s)`
    });
  } else {
    dims.push({
      dimension_name: 'prior_cleaning_experience',
      score: 0, denominator: 20,
      description: 'No prior cleaning experience — trainable baseline still applies.'
    });
  }

  const signals = extracted.transferable_signals || [];
  if (signals.length >= 3) {
    total += 15;
    dims.push({
      dimension_name: 'transferable_signals',
      score: 15, denominator: 15,
      description: signals.join(', ')
    });
  } else {
    dims.push({
      dimension_name: 'transferable_signals',
      score: 0, denominator: 15,
      description: signals.length ? `Only ${signals.length} signal(s): ${signals.join(', ')}` : 'No strong transferable signals detected.'
    });
  }

  const comm = extracted.communication_quality || 3;
  if (comm >= 4) {
    total += 10;
    dims.push({ dimension_name: 'communication_quality', score: 10, denominator: 10, description: `Rated ${comm}/5` });
  } else if (comm <= 2) {
    total -= 10;
    dims.push({ dimension_name: 'communication_quality', score: -10, denominator: 10, description: `Rated ${comm}/5 — weak` });
  } else {
    dims.push({ dimension_name: 'communication_quality', score: 0, denominator: 10, description: `Rated ${comm}/5` });
  }

  if (extracted.transportation_ok === true) {
    total += 10;
    dims.push({ dimension_name: 'transportation', score: 10, denominator: 10, description: 'Vehicle or transportation confirmed' });
  } else if (extracted.transportation_ok === false) {
    total -= 5;
    dims.push({ dimension_name: 'transportation', score: -5, denominator: 10, description: 'No transportation — soft knockout; confirm' });
  } else {
    dims.push({ dimension_name: 'transportation', score: 0, denominator: 10, description: 'Transportation unclear' });
  }

  const dist = extracted.distance_minutes_from_chilliwack;
  if (dist != null && dist < 30) {
    total += 5;
    dims.push({ dimension_name: 'proximity', score: 5, denominator: 5, description: `${dist} min from Chilliwack — local` });
  } else if (dist != null && dist > 45) {
    total -= 10;
    dims.push({ dimension_name: 'proximity', score: -10, denominator: 5, description: `${dist} min from Chilliwack — distant` });
  } else {
    dims.push({ dimension_name: 'proximity', score: 0, denominator: 5, description: dist != null ? `${dist} min from Chilliwack` : 'Distance unknown' });
  }

  const reds = extracted.red_flags || [];
  if (reds.length) {
    total -= 25;
    dims.push({ dimension_name: 'red_flags', score: -25, denominator: 0, description: reds.join(', ') });
  } else {
    dims.push({ dimension_name: 'red_flags', score: 0, denominator: 0, description: 'None detected' });
  }

  const final = Math.max(0, Math.min(100, total));
  return { score: final, dimensions: dims };
}

function detectSource(from, subject) {
  const s = `${from || ''} ${subject || ''}`.toLowerCase();
  if (s.includes('indeed'))   return 'Indeed';
  if (s.includes('linkedin')) return 'direct';
  if (s.includes('referral')) return 'referral';
  return 'direct';
}

async function parseMultipart(req) {
  const form = formidable({ multiples: true, maxFileSize: 25 * 1024 * 1024, keepExtensions: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      const flat = {};
      for (const [k, v] of Object.entries(fields)) flat[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
      resolve({ fields: flat, files });
    });
  });
}

function pickResumeFile(files) {
  const all = [];
  for (const val of Object.values(files || {})) {
    if (Array.isArray(val)) all.push(...val);
    else if (val) all.push(val);
  }
  return all.find(f => {
    const name = (f.originalFilename || f.newFilename || '').toLowerCase();
    return name.endsWith('.pdf') || name.endsWith('.docx') || name.endsWith('.doc');
  }) || null;
}

function mediaTypeFor(name) {
  name = name.toLowerCase();
  if (name.endsWith('.pdf'))  return 'application/pdf';
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (name.endsWith('.doc'))  return 'application/msword';
  return 'application/octet-stream';
}

function parseClaudeJson(text) {
  const cleaned = String(text || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

function buildCandidateRecord({ reservedId, extracted, from, scoreInfo, stageEnteredAt }) {
  const flags = (extracted.red_flags || []).map((rf, i) => ({
    id: `extract_${i}_${rf}`,
    severity: (rf === 'criminal_history_mention' || rf === 'resume_inconsistencies') ? 'warning' : 'warning',
    description: rf.replace(/_/g, ' ')
  }));

  const lane =
    scoreInfo.score >= 85 ? 'fast_track'
    : scoreInfo.score >= 65 ? 'standard'
    : scoreInfo.score >= 45 ? 'review_required'
    : 'hold';

  return {
    candidate_id: reservedId,
    full_name: extracted.full_name || 'Unknown',
    phone: extracted.phone || null,
    phone_confirmed: false,
    email: extracted.email || from || null,
    location_postal_code: extracted.location_postal_code || null,
    location_city: extracted.location_city || null,
    source: detectSource(from, extracted.summary),

    score_value: scoreInfo.score,
    score_denominator: 100,
    rubric_type: 'prescreen_triage',
    per_dimension_scores: scoreInfo.dimensions,

    interviewer_name: 'Aria (automated)',
    interviewer_phone: null,
    interview_date: null,
    interview_time: null,
    interview_duration_minutes: null,
    outcome: 'PENDING',

    key_findings: extracted.strengths || [],
    communication_log: [],
    flags,
    next_action: lane === 'hold'
      ? 'Karen to review before any outreach.'
      : lane === 'review_required'
        ? 'Flagged for Karen review before phone-screen booking.'
        : 'Aria to send first SMS + intro email.',

    status: 'Applied',
    stage_entered_at: stageEnteredAt,
    availability_horizon: 'unknown',
    availability_details: null,
    earliest_start_date: null,
    depends_on: [],

    has_cleaning_experience: !!extracted.pretrained_bonus,
    cleaning_experience_years: extracted.pretrained_years || null,
    cleaning_experience_types: extracted.pretrained_type && extracted.pretrained_type !== 'none' ? [extracted.pretrained_type] : [],
    certifications: [],
    has_vehicle: extracted.transportation_ok === true,
    has_vehicle_confirmed: false,

    needs_approval: lane === 'hold' || lane === 'review_required',

    aria_meta: {
      autonomy_lane: lane,
      summary: extracted.summary || null,
      concerns: extracted.concerns || []
    }
  };
}

async function callInternalEndpoint(path, payload) {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
  try {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_SECRET || ''
      },
      body: JSON.stringify(payload)
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (err) {
    return { status: 0, body: { error: err.message } };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const startTime = Date.now();
  const intakeId = `intake_${startTime}_${Math.random().toString(36).slice(2, 8)}`;

  await redis.set(`recruit:intake_log:${intakeId}`, {
    timestamp: new Date().toISOString(),
    received_at: startTime,
    status: 'received'
  }, { ex: 60 * 60 * 24 * 30 });

  try {
    const { fields, files } = await parseMultipart(req);
    const from    = fields.from || fields.sender || '';
    const subject = fields.subject || '';
    const text    = fields.text || fields.plain || '';

    const resumeFile = pickResumeFile(files);
    const contentBlocks = [];

    if (resumeFile) {
      const buf = await fs.readFile(resumeFile.filepath);
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: mediaTypeFor(resumeFile.originalFilename || resumeFile.newFilename || 'resume.pdf'),
          data: buf.toString('base64')
        }
      });
    }

    contentBlocks.push({
      type: 'text',
      text: `Extract candidate data from this job application.

Email From: ${from}
Subject: ${subject}
Body:
${text || '(no body text)'}

${resumeFile ? 'A resume is attached above.' : 'No resume attached — extract what you can from the email only.'}

Return the JSON object as specified in the system prompt. No markdown, no explanation, just the JSON.`
    });

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2000,
      system: LHS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    const textOut = response.content.find(b => b.type === 'text')?.text || '';
    const extracted = parseClaudeJson(textOut) || {
      full_name: 'Unknown',
      email: from || null,
      phone: null,
      red_flags: ['parse_error_manual_review'],
      communication_quality: 3,
      transferable_signals: [],
      pretrained_bonus: false,
      transportation_ok: null
    };

    const scoreInfo = scoreBreakdown(extracted);

    const existingPlaceholder = await findPlaceholderByName(extracted.full_name);
    let reservedId;
    if (existingPlaceholder) {
      reservedId = existingPlaceholder.candidate_id;
      await redis.del(`recruit:placeholder:${reservedId}`);
      await redis.zrem('recruit:holding:expected', reservedId);
    } else {
      const nextN = await redis.incr('recruit:counter:candidate_id');
      reservedId = formatId(nextN);
    }

    const now = new Date();
    const candidate = buildCandidateRecord({
      reservedId,
      extracted,
      from,
      scoreInfo,
      stageEnteredAt: now.toISOString()
    });

    const writeResult = await writeCandidate({ candidate, eventType: 'application_received' });

    const firstName = (candidate.full_name || '').split(' ')[0] || 'there';
    let smsResult = null;
    if (candidate.phone && candidate.aria_meta.autonomy_lane !== 'hold') {
      smsResult = await callInternalEndpoint('/api/twilio-outbound', {
        candidate_id: candidate.candidate_id,
        to: candidate.phone,
        body: candidate.has_cleaning_experience
          ? `Hi ${firstName}, this is Aria — Karen's scheduling assistant at Lifestyle Home Service. Thanks for applying! I saw your cleaning background and wanted to reach out quickly. I've got 3 quick questions to see if this role is a fit. Reply when you have a minute.`
          : `Hi ${firstName}, this is Aria — Karen's scheduling assistant at Lifestyle Home Service. Thanks for applying! I've got 3 quick questions to see if this role is a fit. Reply when you have a minute.`
      });
    }

    let emailResult = null;
    if (candidate.email) {
      emailResult = await callInternalEndpoint('/api/send-email', {
        candidate_id: candidate.candidate_id,
        template: 'first_contact',
        data: { firstName, pretrained: candidate.has_cleaning_experience }
      });
    }

    await redis.set(`recruit:intake_log:${intakeId}`, {
      timestamp: new Date().toISOString(),
      received_at: startTime,
      status: 'processed',
      candidate_id: candidate.candidate_id,
      score: scoreInfo.score,
      autonomy_lane: candidate.aria_meta.autonomy_lane,
      write_result: writeResult.git,
      sms_status: smsResult?.status,
      email_status: emailResult?.status,
      processing_ms: Date.now() - startTime
    }, { ex: 60 * 60 * 24 * 30 });

    return res.status(200).json({
      ok: true,
      candidate_id: candidate.candidate_id,
      score: scoreInfo.score,
      autonomy_lane: candidate.aria_meta.autonomy_lane,
      dual_write: writeResult,
      sms: smsResult,
      email: emailResult,
      processing_ms: Date.now() - startTime
    });

  } catch (err) {
    await redis.set(`recruit:intake_log:${intakeId}`, {
      timestamp: new Date().toISOString(),
      received_at: startTime,
      status: 'error',
      error: err.message,
      stack: err.stack?.slice(0, 2000) || null,
      processing_ms: Date.now() - startTime
    }, { ex: 60 * 60 * 24 * 30 });

    await alertTeam(`Intake failed: ${err.message}`);
    return res.status(500).json({ error: err.message, intake_id: intakeId });
  }
}

async function alertTeam(message) {
  try {
    await callInternalEndpoint('/api/twilio-outbound', {
      candidate_id: 'SYSTEM',
      to: process.env.KAREN_PHONE,
      body: `⚠ AriaRecruit alert: ${message}`
    });
    await callInternalEndpoint('/api/twilio-outbound', {
      candidate_id: 'SYSTEM',
      to: process.env.MICHAEL_PHONE,
      body: `⚠ AriaRecruit alert: ${message}`
    });
  } catch (_) { /* best-effort */ }
}
