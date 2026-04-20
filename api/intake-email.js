// /api/intake-email — SendGrid Inbound Parse webhook for candidate applications.
//
// Flow (per v1.3 §8 + kickoff item 3):
//   1. Parse multipart/form-data from SendGrid (fields + attachments)
//   2. Log raw intake to recruit:intake_log:{id} (30-day retention) — nothing is lost
//   3. Claude Opus reads any PDF/DOCX resume as a document block + extracts to JSON
//      (resume fields + the 4 Indeed screener answers + experience_keyword_match)
//   4. computeRoute: postal-code FSA gate + travel-willingness gate +
//      location_in_chilliwack_claim consistency check
//   5. scoreBreakdown: 0–100 prescreen_triage score with dimension-level detail
//   6. Check placeholders for name match — merge into reserved ID if matched
//      else INCR recruit:counter:candidate_id → new #NNN
//   7. buildCandidateRecord: translate extraction + route + score into v1.3 §3.1
//   8. writeCandidate (dual-write: Redis + atomic git commit of MD + JSON)
//   9. Holding-lane fixup: if route.lane === 'hard_hold', zadd recruit:holding:hard_hold
//      and zrem the orphan recruit:stage:hard_hold that writeCandidate creates.
//  10. If inconsistency_flag: write recruit:redalert:* for Karen to review.
//  11. Auto-reply routing:
//      - Applied: first_contact email + first SMS (from 778-200-6517)
//      - Hard Hold, location-based, no inconsistency: send location_decline email
//      - Hard Hold, travel-based OR inconsistency: no candidate outreach; Karen decides
//
// Never auto-rejects. Rejection communication requires human confirmation; the
// location_decline auto-reply is only for the "outside service area" lane which
// Karen has pre-approved as an automatic decline.

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import formidable from 'formidable';
import fs from 'node:fs/promises';

import { writeCandidate } from './_lib/writeCandidate.js';
import { createPlaceholder, findPlaceholderByName, formatId } from './_lib/createPlaceholder.js';
import { computeRoute, scoreBreakdown, firstNameFrom } from './_lib/intake-helpers.js';

const redis = Redis.fromEnv();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const config = { api: { bodyParser: false } };

// Re-export pure helpers so test scripts can `import { ... } from './intake-email.js'`
// if they choose. Primary import path remains ./_lib/intake-helpers.js.
export { computeRoute, scoreBreakdown, firstNameFrom };

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

  "years_experience": number or null,
  "interview_availability": "string or null",
  "location_in_chilliwack_claim": true/false/null,
  "travel_willingness_pct": 25 | 50 | 75 | 100 | null,
  "experience_keyword_match": true/false,

  "summary": "2-sentence human-readable summary",
  "strengths": ["specific strength 1", "specific strength 2"],
  "concerns": ["specific concern 1 or empty array"]
}

IMPORTANT — Indeed screener questions:
Indeed applications include 4 screener questions whose answers arrive in the email body.
They may appear as "Q:" / "A:" pairs, bulleted lists, or prose. Extract them robustly:
  1. Years of cleaning / service / hospitality experience → years_experience (integer)
  2. Interview availability → interview_availability (free text, concise)
  3. "Located in Chilliwack?" → location_in_chilliwack_claim (true/false/null)
  4. Travel-willingness percentage → travel_willingness_pct (25, 50, 75, or 100)

Also set experience_keyword_match = true if the resume or application text mentions
any of: cleaning, service, hospitality, hotel, restaurant. Otherwise false.

If a screener answer is absent or ambiguous, return null for that specific field — do
not guess. years_experience with a range like "3-5 years" should be parsed as the lower
bound (3). location_in_chilliwack_claim should be null if the candidate was never asked
or answered ambiguously; false if they explicitly said no; true if they explicitly said yes.`;

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

function buildCandidateRecord({ reservedId, extracted, from, scoreInfo, route, stageEnteredAt }) {
  const flags = (extracted.red_flags || []).map((rf, i) => ({
    id: `extract_${i}_${rf}`,
    severity: 'warning',
    description: rf.replace(/_/g, ' ')
  }));

  if (route.inconsistency_flag) {
    flags.push({
      id: 'location_claim_inconsistency',
      severity: 'warning',
      description: `Candidate claimed Chilliwack but postal FSA ${route.fsa || '(missing)'} is outside the service area.`
    });
  }

  const autonomyLane =
    scoreInfo.score >= 85 ? 'fast_track'
    : scoreInfo.score >= 65 ? 'standard'
    : scoreInfo.score >= 45 ? 'review_required'
    : 'hold';

  const nextAction = route.status === 'hard_hold'
    ? (route.holding_reason === 'outside service area'
        ? (route.inconsistency_flag
            ? 'Inconsistency — Karen to review location before any outreach.'
            : 'Auto-declined (outside service area).')
        : 'Karen to review travel-willingness constraint.')
    : autonomyLane === 'hold'
      ? 'Karen to review before any outreach.'
      : autonomyLane === 'review_required'
        ? 'Flagged for Karen review before phone-screen booking.'
        : 'Aria to send first SMS + intro email.';

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
    next_action: nextAction,

    status: route.status,  // "Applied" OR "hard_hold"
    stage_entered_at: stageEnteredAt,
    availability_horizon: 'unknown',
    availability_details: extracted.interview_availability || null,
    earliest_start_date: null,
    depends_on: [],

    has_cleaning_experience: !!extracted.pretrained_bonus,
    cleaning_experience_years: extracted.pretrained_years || null,
    cleaning_experience_types: extracted.pretrained_type && extracted.pretrained_type !== 'none' ? [extracted.pretrained_type] : [],
    certifications: [],
    has_vehicle: extracted.transportation_ok === true,
    has_vehicle_confirmed: false,

    // Indeed screener captures
    years_experience: extracted.years_experience ?? null,
    interview_availability: extracted.interview_availability ?? null,
    location_in_chilliwack_claim: extracted.location_in_chilliwack_claim ?? null,
    travel_willingness_pct: extracted.travel_willingness_pct ?? null,
    in_service_area: route.in_service_area,
    location_inconsistency_flag: route.inconsistency_flag,

    needs_approval: route.status === 'hard_hold' || autonomyLane === 'hold' || autonomyLane === 'review_required',

    aria_meta: {
      autonomy_lane: autonomyLane,
      summary: extracted.summary || null,
      concerns: extracted.concerns || [],
      holding_reason: route.holding_reason || null,
      postal_fsa: route.fsa || null
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

async function appendCommLog(candidateId, entry) {
  const rec = await redis.get(`recruit:candidate:${candidateId}`);
  if (!rec) return;
  rec.communication_log = rec.communication_log || [];
  rec.communication_log.push(entry);
  await redis.set(`recruit:candidate:${candidateId}`, rec);
}

async function writeRedAlert({ id, severity, type, description, resolution_action, candidate_id }) {
  const now = new Date();
  const key = `recruit:redalert:${id}_${now.getTime()}`;
  await redis.set(key, {
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
    const html    = fields.html || '';

    const resumeFile = pickResumeFile(files);

    // Preserve raw body to intake_log BEFORE Claude processing, so that:
    //   - Gmail/SMTP verification emails are recoverable (their codes live
    //     in the raw text, but the extraction prompt discards them)
    //   - Any intake that later fails can be replayed or manually parsed
    //   - Debugging doesn't require re-fetching from SendGrid Activity
    // Truncated to 32 KB per field to avoid unbounded Redis entries.
    const RAW_LIMIT = 32 * 1024;
    await redis.set(`recruit:intake_log:${intakeId}`, {
      timestamp: new Date().toISOString(),
      received_at: startTime,
      status: 'received_raw_captured',
      raw_from: String(from).slice(0, 2048),
      raw_subject: String(subject).slice(0, 2048),
      raw_text: String(text).slice(0, RAW_LIMIT),
      raw_html: String(html).slice(0, RAW_LIMIT),
      resume_attached: !!resumeFile,
      resume_filename: resumeFile?.originalFilename || resumeFile?.newFilename || null
    }, { ex: 60 * 60 * 24 * 30 });
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
      transportation_ok: null,
      years_experience: null,
      interview_availability: null,
      location_in_chilliwack_claim: null,
      travel_willingness_pct: null,
      experience_keyword_match: false
    };

    const route = computeRoute(extracted);
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
      route,
      stageEnteredAt: now.toISOString()
    });

    const writeResult = await writeCandidate({ candidate, eventType: 'application_received' });

    // Holding-lane fixup: writeCandidate zadds to recruit:stage:{status}, which
    // for hard-hold candidates creates an orphan zset. Move them to the proper
    // holding-lane zset that the UI reads.
    if (route.lane === 'hard_hold') {
      await redis.zadd('recruit:holding:hard_hold', { score: now.getTime(), member: reservedId });
      await redis.zrem('recruit:stage:hard_hold', reservedId);
    }

    // Red alert when the candidate's self-reported location conflicts with postal.
    if (route.inconsistency_flag) {
      await writeRedAlert({
        id: `inconsistency_${reservedId}`,
        severity: 'red_alert',
        type: 'location_claim_inconsistency',
        candidate_id: reservedId,
        description: `${candidate.full_name} (${reservedId}) claimed Chilliwack but postal FSA is ${route.fsa} (outside service area). Human review needed before auto-decline.`,
        resolution_action: 'Open profile, verify postal code with candidate, and decide hard-hold keep vs advance to Applied.'
      });
    }

    const firstName = firstNameFrom(candidate.full_name);

    // Candidate-facing outreach routing.
    let smsResult = null;
    let emailResult = null;
    let locationDeclineResult = null;

    if (route.send_location_auto_reply) {
      // Location-based hard hold, no inconsistency: polite auto-decline.
      locationDeclineResult = await callInternalEndpoint('/api/send-email', {
        candidate_id: reservedId,
        template: 'location_decline',
        data: { firstName }
      });
      await appendCommLog(reservedId, {
        timestamp: new Date().toISOString(),
        channel: 'email',
        direction: 'out',
        type: 'auto_reply_location_decline',
        summary: 'Auto-reply: outside service area (polite decline sent).'
      });
    } else if (route.status === 'Applied') {
      // Normal first-contact outreach.
      if (candidate.phone) {
        smsResult = await callInternalEndpoint('/api/twilio-outbound', {
          candidate_id: reservedId,
          to: candidate.phone,
          body: candidate.has_cleaning_experience
            ? `Hi ${firstName}, this is Aria — Karen's scheduling assistant at Lifestyle Home Service. Thanks for applying! I saw your cleaning background and wanted to reach out quickly. I've got 3 quick questions to see if this role is a fit. Reply when you have a minute.`
            : `Hi ${firstName}, this is Aria — Karen's scheduling assistant at Lifestyle Home Service. Thanks for applying! I've got 3 quick questions to see if this role is a fit. Reply when you have a minute.`
        });
      }
      if (candidate.email) {
        emailResult = await callInternalEndpoint('/api/send-email', {
          candidate_id: reservedId,
          template: 'first_contact',
          data: { firstName, pretrained: candidate.has_cleaning_experience }
        });
      }
    }
    // else: travel hard hold OR location hard hold with inconsistency →
    // no candidate outreach. Karen reviews the holding lane / red alert.

    await redis.set(`recruit:intake_log:${intakeId}`, {
      timestamp: new Date().toISOString(),
      received_at: startTime,
      status: 'processed',
      candidate_id: reservedId,
      score: scoreInfo.score,
      route,
      autonomy_lane: candidate.aria_meta.autonomy_lane,
      write_result: writeResult.git,
      sms_status: smsResult?.status,
      email_status: emailResult?.status,
      location_decline_status: locationDeclineResult?.status,
      processing_ms: Date.now() - startTime
    }, { ex: 60 * 60 * 24 * 30 });

    return res.status(200).json({
      ok: true,
      candidate_id: reservedId,
      score: scoreInfo.score,
      status: route.status,
      holding_reason: route.holding_reason,
      inconsistency_flag: route.inconsistency_flag,
      autonomy_lane: candidate.aria_meta.autonomy_lane,
      dual_write: writeResult,
      sms: smsResult,
      email: emailResult,
      location_decline: locationDeclineResult,
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
