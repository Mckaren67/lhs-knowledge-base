# Resume Extraction Implementation — LHS-Tuned

**Companion to:** `AriaRecruit_Design_v1_2.md`
**Purpose:** Exact code and prompt logic for `/api/intake-email` endpoint
**Philosophy:** Cleaning experience is a bonus flag, not a requirement. LHS training pipeline handles the rest.

---

## 1. The scoring philosophy (locked)

**Trainable baseline is the default.** Most candidates won't have cleaning experience and that's fine. LHS has a strong training program and the Cleaning Tech Boot Camp already ingested into Aria's knowledge base. The goal of resume scoring is to find people who:

- Are likely to show up reliably (attendance history)
- Can follow a detailed process (previous detail-oriented work)
- Can communicate respectfully with clients (customer-facing experience)
- Can handle a physical job (stamina-work history)
- Won't disappear in 3 weeks (job-tenure patterns)

Cleaning experience is layered on top as a bonus — "this person is pre-trained" — but its absence is never a disqualifier.

## 2. The five resume questions Claude answers

For every resume, Claude extracts:

**Q1: Prior cleaning experience (bonus flag)**
- Residential cleaning, hotel housekeeping, healthcare cleaning, commercial janitorial
- If present, note the type and years
- Labeled internally as `pretrained_bonus: true` with `pretrained_type` and `pretrained_years`

**Q2: Transferable signals (positive indicators)**
- Detail-oriented work (inventory, QA, inspection, food prep)
- Customer-facing experience (retail, hospitality, caregiving, food service)
- Physical stamina work (warehouse, landscaping, construction, nursing assistant)
- Reliability markers (long tenure at previous roles, promotions, "punctual" or "dependable" mentions)

**Q3: Red flags (concerns to surface)**
- Pattern of jobs under 6 months each (3+ in a row)
- Unexplained gaps of 12+ months
- Resume inconsistencies (date overlaps, contradicting claims)
- No mention of transportation when role requires driving between homes
- Criminal history mentions (Karen decides — Aria surfaces but doesn't judge)

**Q4: Communication quality (proxy signal)**
- Resume formatting and coherence
- Spelling and grammar
- Cover letter presence and quality
- Rated 1-5

**Q5: Transportation reliability**
- Has a vehicle mentioned, or transportation addressed
- Lives in or near Chilliwack area
- Distance calculation from Chilliwack if address is included

## 3. The initial score calculation

Score out of 100, calculated as:

```
base_score = 50

# Positive adjustments
+ 20 if pretrained_bonus == true
+ 15 for strong transferable signals (3+ of the categories in Q2)
+ 10 for strong communication quality (4-5)
+ 10 for strong transportation signal
+ 5 for local address (<30 min from Chilliwack)

# Negative adjustments
- 25 for any hard red flag (Q3 items)
- 10 for weak communication quality (1-2)
- 10 for distance >45 min from Chilliwack
- 5 for no transportation signal

Cap at 100, floor at 0.
```

Autonomy lanes based on score:

- **85-100:** Fast-track. Auto-advance + flag to Karen as "top prospect — consider skipping trainee status if simulator confirms"
- **65-84:** Standard trainable baseline. Auto-advance to screening, no special handling
- **45-64:** Borderline. Auto-advance but flag for Karen's review before phone-screen booking
- **0-44 or hard red flag:** Hold. Aria sends polite holding email; Karen reviews next business day

## 4. The complete Vercel endpoint code

```javascript
// /api/intake-email.js (Vercel serverless function)
// Handles SendGrid inbound parse webhook
// Extracts candidate data from email + resume attachment using Claude Opus
// Writes to Redis, creates Kanban card, triggers first SMS

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import twilio from 'twilio';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redis = Redis.fromEnv();
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

export const config = {
  api: { bodyParser: { sizeLimit: '25mb' } } // resumes can be big
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const startTime = Date.now();
  
  try {
    const { to, from, subject, text, html, attachments: attachmentsJson } = req.body;
    
    // Log raw intake BEFORE any processing (so nothing is ever lost)
    const intakeId = `intake_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    await redis.set(`recruit:intake_log:${intakeId}`, {
      timestamp: new Date().toISOString(),
      from, to, subject,
      received_at: startTime,
      status: 'received'
    }, { ex: 60 * 60 * 24 * 30 }); // 30 day retention
    
    // Parse attachments from SendGrid (comes as JSON string)
    const attachments = attachmentsJson ? JSON.parse(attachmentsJson) : [];
    const resumeAttachment = attachments.find(a =>
      a.filename?.toLowerCase().endsWith('.pdf') ||
      a.filename?.toLowerCase().endsWith('.docx') ||
      a.filename?.toLowerCase().endsWith('.doc')
    );
    
    // Build Claude message content
    const contentBlocks = [];
    
    // Add resume as document block if present (Claude reads PDFs natively)
    if (resumeAttachment) {
      const mediaType = resumeAttachment.filename.endsWith('.pdf')
        ? 'application/pdf'
        : resumeAttachment.filename.endsWith('.docx')
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/msword';
      
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: resumeAttachment.content // SendGrid provides base64 already
        }
      });
    }
    
    // Add extraction prompt
    contentBlocks.push({
      type: 'text',
      text: buildExtractionPrompt({ from, subject, text, hasResume: !!resumeAttachment })
    });
    
    // Call Claude Opus
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2000,
      messages: [{ role: 'user', content: contentBlocks }],
      system: LHS_SYSTEM_PROMPT
    });
    
    // Parse Claude's structured response
    const extractedText = response.content[0].text;
    const extracted = parseClaudeResponse(extractedText);
    
    // Calculate initial score using the formula
    const score = calculateScore(extracted);
    
    // Create candidate record
    const candidateId = `cand_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const candidate = {
      candidate_id: candidateId,
      created_at: new Date().toISOString(),
      source: detectSource(from, subject),
      name: extracted.name || 'Unknown',
      email: extracted.email || from,
      phone: extracted.phone || null,
      location: extracted.location || null,
      resume_url: null, // will be set when we upload to Drive
      
      // Scoring
      initial_score: score,
      score_breakdown: extracted,
      autonomy_lane: score >= 85 ? 'fast_track'
                   : score >= 65 ? 'standard'
                   : score >= 45 ? 'review_required'
                   : 'hold',
      
      // Extracted flags
      pretrained_bonus: extracted.pretrained_bonus || false,
      pretrained_type: extracted.pretrained_type || null,
      pretrained_years: extracted.pretrained_years || 0,
      transferable_signals: extracted.transferable_signals || [],
      red_flags: extracted.red_flags || [],
      communication_quality: extracted.communication_quality || 3,
      transportation_ok: extracted.transportation_ok || null,
      
      // Pipeline state
      stage: 'new_application',
      needs_review: score < 65 || (extracted.red_flags?.length > 0),
      
      // Processing meta
      processing_time_ms: Date.now() - startTime,
      intake_id: intakeId
    };
    
    // Write to Redis
    await redis.set(`recruit:candidate:${candidateId}`, candidate);
    await redis.zadd('recruit:stage:new_application', {
      score: Date.now(),
      member: candidateId
    });
    
    // Event log
    await redis.set(`recruit:event:${candidateId}:${Date.now()}`, {
      type: 'application_received',
      details: { score, autonomy_lane: candidate.autonomy_lane, source: candidate.source }
    });
    
    // Trigger first SMS (if phone present) and first email
    if (candidate.phone) {
      await sendFirstSMS(candidate);
    }
    if (candidate.email) {
      await sendFirstEmail(candidate);
    }
    
    // Mark intake as processed
    await redis.set(`recruit:intake_log:${intakeId}`, {
      ...(await redis.get(`recruit:intake_log:${intakeId}`)),
      status: 'processed',
      candidate_id: candidateId,
      processing_time_ms: Date.now() - startTime
    }, { ex: 60 * 60 * 24 * 30 });
    
    return res.status(200).json({ ok: true, candidate_id: candidateId, score });
    
  } catch (error) {
    console.error('Intake error:', error);
    // Don't lose the email even on error — it's already logged in recruit:intake_log
    // Send urgent push to Karen + Michael
    await sendUrgentAlert(`Email intake failed: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
}

// --- LHS-tuned system prompt ---
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
  "name": "full name",
  "email": "email@address.com",
  "phone": "+1-604-555-0000 or null",
  "location": "city, region or null",
  
  "pretrained_bonus": true/false,
  "pretrained_type": "residential|hotel|healthcare|commercial|none",
  "pretrained_years": number,
  
  "transferable_signals": ["detail_oriented", "customer_facing", "physical_stamina", "reliability"],
  
  "red_flags": ["short_tenures", "unexplained_gaps", "resume_inconsistencies", "no_transportation"],
  
  "communication_quality": 1-5,
  "transportation_ok": true/false/null,
  "distance_minutes_from_chilliwack": number or null,
  
  "summary": "2-sentence human-readable summary",
  "strengths": ["specific strength 1", "specific strength 2"],
  "concerns": ["specific concern 1 or empty array"]
}`;

function buildExtractionPrompt({ from, subject, text, hasResume }) {
  return `Extract candidate data from this job application.

Email From: ${from}
Subject: ${subject}
Body:
${text || '(no body text)'}

${hasResume 
  ? 'A resume is attached above. Extract information from both the email and the resume.' 
  : 'No resume attached — extract what you can from the email only.'
}

Return the JSON object as specified in the system prompt. No markdown, no explanation, just the JSON.`;
}

function parseClaudeResponse(text) {
  // Claude sometimes wraps in ```json ... ```; strip it
  const cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('JSON parse failed:', cleaned.substring(0, 200));
    // Return minimal safe default
    return {
      name: 'Unknown',
      email: null,
      phone: null,
      pretrained_bonus: false,
      transferable_signals: [],
      red_flags: ['parse_error_manual_review'],
      communication_quality: 3
    };
  }
}

function calculateScore(extracted) {
  let score = 50;
  
  // Positive
  if (extracted.pretrained_bonus) score += 20;
  if ((extracted.transferable_signals?.length || 0) >= 3) score += 15;
  if (extracted.communication_quality >= 4) score += 10;
  if (extracted.transportation_ok) score += 10;
  if (extracted.distance_minutes_from_chilliwack && 
      extracted.distance_minutes_from_chilliwack < 30) score += 5;
  
  // Negative
  if (extracted.red_flags?.length > 0) score -= 25;
  if (extracted.communication_quality <= 2) score -= 10;
  if (extracted.distance_minutes_from_chilliwack && 
      extracted.distance_minutes_from_chilliwack > 45) score -= 10;
  if (extracted.transportation_ok === false) score -= 5;
  
  return Math.max(0, Math.min(100, score));
}

function detectSource(from, subject) {
  const lower = `${from} ${subject}`.toLowerCase();
  if (lower.includes('indeed')) return 'indeed';
  if (lower.includes('linkedin')) return 'linkedin';
  if (lower.includes('referral')) return 'referral';
  return 'direct';
}

async function sendFirstSMS(candidate) {
  const greeting = candidate.pretrained_bonus
    ? `Hi ${candidate.name.split(' ')[0]}, this is Aria from Lifestyle Home Service. Thanks for applying — I saw your cleaning background and wanted to reach out quickly. I have 3 quick questions to see if this is a fit. Reply when you have a minute.`
    : `Hi ${candidate.name.split(' ')[0]}, this is Aria from Lifestyle Home Service. Thanks for applying! I have 3 quick questions to see if this role is a fit for you. Reply when you have a minute.`;
  
  await twilioClient.messages.create({
    body: greeting,
    from: process.env.TWILIO_PHONE, // 604-330-3997
    to: candidate.phone
  });
}

async function sendFirstEmail(candidate) {
  // Calls the separate /api/send-email endpoint that uses SendGrid
  await fetch(`${process.env.VERCEL_URL}/api/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate_id: candidate.candidate_id,
      template: 'first_contact',
      data: { firstName: candidate.name.split(' ')[0], pretrained: candidate.pretrained_bonus }
    })
  });
}

async function sendUrgentAlert(message) {
  // Both Karen and Michael get an urgent SMS
  for (const phone of [process.env.KAREN_PHONE, process.env.MICHAEL_PHONE]) {
    await twilioClient.messages.create({
      body: `⚠ AriaRecruit alert: ${message}`,
      from: process.env.TWILIO_PHONE,
      to: phone
    });
  }
}
```

## 5. Three candidate scenarios walked through

**Scenario A: Sarah — former hotel housekeeper, 4 years**

Resume mentions Marriott housekeeping 2020-2024, consistent employment, lives in Chilliwack, has own vehicle. Cover letter is clean and well-written.

Claude extracts:
- `pretrained_bonus: true, pretrained_type: "hotel", pretrained_years: 4`
- `transferable_signals: ["detail_oriented", "customer_facing", "reliability"]`
- `red_flags: []`
- `communication_quality: 5`
- `transportation_ok: true`

Score: 50 + 20 (pretrained) + 15 (3 signals) + 10 (comm) + 10 (transport) + 5 (local) = **100**

Lane: Fast-track. First SMS acknowledges her cleaning background. Flagged to Karen: "top prospect — consider skipping trainee status if simulator confirms."

---

**Scenario B: Jake — caregiver background, no cleaning experience**

Resume: 2 years as a caregiver at a senior home, 1 year retail before that. Lives in Chilliwack, no car mentioned but gives a Chilliwack address. Resume is short but clear.

Claude extracts:
- `pretrained_bonus: false`
- `transferable_signals: ["detail_oriented", "customer_facing", "physical_stamina", "reliability"]`
- `red_flags: []`
- `communication_quality: 4`
- `transportation_ok: null`

Score: 50 + 0 + 15 (4 signals qualifies) + 10 (comm) + 0 (transport unclear) + 5 (local) = **80**

Lane: Standard trainable baseline. First SMS is generic-friendly. No special flag, enters standard flow. This is exactly the kind of candidate the old v1 design would have under-scored — v1.2 gets this right.

---

**Scenario C: Mike — three jobs in 18 months, currently unemployed**

Resume shows 3 jobs in the last 18 months, each 4-6 months, all warehouse or fast food. Gap of 4 months. Address listed as Abbotsford (45 min from Chilliwack). Resume has several typos.

Claude extracts:
- `pretrained_bonus: false`
- `transferable_signals: ["physical_stamina"]`
- `red_flags: ["short_tenures"]`
- `communication_quality: 2`
- `transportation_ok: null`
- `distance_minutes_from_chilliwack: 45`

Score: 50 + 0 + 0 (only 1 signal) + 0 + 0 + 0 - 25 (red flag) - 10 (weak comm) - 10 (distance) - 5 (transport unclear) = **0**

Lane: Hold. Aria sends a polite "we're reviewing your application, we'll be in touch within 2 business days" email. Karen sees him in the morning summary with the concerns listed. Karen can override Aria's hold and advance him if she wants to give him a chance — her call, not Aria's.

## 6. What Michael should test before going live

Before flipping the pipeline on for real Indeed traffic:

1. Send three test applications to `careers@lifestylehomeservice.com` — one that matches Scenario A, one Scenario B, one Scenario C
2. Verify the score matches expectations
3. Verify the first SMS fires correctly and mentions cleaning background only for pre-trained candidates
4. Verify the hold scenario does NOT auto-advance or send pushy follow-ups
5. Check the Kanban card shows the extracted data clearly

If all three scenarios behave correctly, Aria is calibrated to LHS's actual hiring philosophy.

## 7. How the scoring evolves over time

The initial scoring formula is a starting point based on research and Michael's stated philosophy. Over the first 90 days post-launch, Aria should learn from actual outcomes:

- Track which candidates advanced to trial and succeeded
- Compare their initial scores to their trial outcomes
- Flag score components that don't correlate with success ("turns out communication quality doesn't predict outcomes as much as expected")
- Weekly analytics summary includes calibration data for Karen and Michael to review

Over time, Claude can help re-tune the formula. After enough data points (~30 hires), the scoring can be rebuilt from actual LHS outcomes rather than industry research assumptions.

---

*End of resume extraction implementation. This is the logic Claude Code should implement in Phase 1.*
