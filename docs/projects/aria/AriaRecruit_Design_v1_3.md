# AriaRecruit — System Design v1.3

**Author:** Claude (Captain, AriaRecruit chat) with Number One (other chat) and Claude Code (Karen's Mac)
**Date:** Saturday, April 18, 2026 (produced during active hiring crisis, April 19 target)
**Status:** Cleared for Claude Code Phase 1 build after crisis resolution

## Changes from v1.2

- **Architecture corrected** — AriaRecruit is a standalone `hiring.html` page inside the existing `Mckaren67/lhs-knowledge-base` repo, not a new Vercel project. It feeds status up into The Bridge dashboard.
- **Candidate schema** locked in based on real Louise Savoie file structure
- **Scoring policy** — Option 2 confirmed (always display denominator, rubric type, interviewer)
- **Holding patterns lane** added as parallel structure to Kanban
- **Conditional decision engine** specified (Felicia-style "hire if X fails" logic)
- **Red alert tasks** elevated to first-class UI
- **Recruiting intelligence section** added (Walker's-pays-under-the-table as entry #1)
- **Candidate ID continuity** — #001 through #015 exist; #016 reserved for Sharyn McKay; next new = #017
- **Expected candidate** placeholder pattern introduced
- **Dual-write pattern** — every write hits Redis AND GitHub MD file
- **Twilio transition protocol** with Aria-introduction SMS template
- **Weekend operations continuity** — Aria does not interfere with active hiring

## Stack

Claude Opus 4.7 · Claude Code · Claude Cowork · Vercel (existing lhs-knowledge-base) · Upstash Redis (lhs-aria-kb) · Twilio (604-330-3997) · SendGrid (inbound + outbound) · Google Workspace (Gmail, Calendar, Meet, Drive) · Calendly · Indeed · Dialpad · HubSpot (as external system, not a dependency)

---

## 1. Purpose and success criteria

AriaRecruit is a standalone hiring portal page inside the Aria platform, purpose-built for Lifestyle Home Service. It automates approximately 90% of the hiring pipeline for residential cleaners, from Indeed application through trial-period conversion, while keeping Karen and Michael in the loop through a Kanban dashboard, holding-pattern lanes, red alert tasks, and scheduled SMS summaries.

Success criteria:

1. Total management time spent on hiring operations averages **5 minutes per day or less** in normal conditions (post-crisis steady state).
2. Aria handles all candidate communication (SMS, email, scheduling) without human drafting.
3. Every resume lands in Aria within 60 seconds of the candidate applying on Indeed — automated intake pipeline.
4. All candidate-facing email sends from `careers@lifestylehomeservice.com` — professional branding, candidate replies never land in Karen's personal inbox.
5. Every candidate advance or rejection is **explainable** — Karen and Michael can see the score, dimension breakdown, interviewer, and reasoning.
6. Hiring mode switch (`NOT_HIRING` / `CASUAL` / `URGENT`) changes Aria's autonomy, outreach aggressiveness, and notification cadence in one click.
7. Mobile-first candidate surfaces — 98% of candidates are on phones.
8. Every phone screen, Google Meet pre-screen, and Dialpad call produces a structured scorecard in the candidate record automatically.
9. **Weekend operations continuity** — the AriaRecruit build must not interfere with active manual hiring. Three positions are being filled by hand in the current crisis. Aria goes live *after* the crisis resolves.
10. Every write to a candidate record hits both Redis (operational) and the corresponding GitHub MD file (audit trail).

---

## 2. Architecture

### 2.1 Where it lives — corrected

AriaRecruit is NOT a separate Vercel project. It is:

- **A standalone page** — `hiring.html` served from `lhs-knowledge-base.vercel.app/hiring.html`
- **Inside the existing repo** — `github.com/Mckaren67/lhs-knowledge-base`
- **Feeds status up** into The Bridge dashboard at `lhs-knowledge-base.vercel.app/bridge.html`
- **Shares data** with existing Aria infrastructure via Upstash Redis (`lhs-aria-kb`)

This means:
- No new Vercel project to create
- No new domain to configure
- Deploys the same way the existing knowledge base does (push to main → Vercel auto-deploys)
- The Bridge can pick up hiring metrics without cross-project API calls

### 2.2 Component inventory

| Component | Technology | Role |
|---|---|---|
| Hiring portal UI | `hiring.html` — HTML/JS served from lhs-knowledge-base | Kanban board, holding patterns lane, red alerts, candidate profiles, settings |
| The Bridge integration | existing `bridge.html` | Pulls hiring pipeline health counts from Redis, displays alongside other ops metrics |
| Candidate-facing UI | New pages served from same Vercel project | Careers page, cleaning simulator, JotForm embed, booking pages — all mobile-first |
| API layer | Vercel serverless functions in `/api/*` directory of lhs-knowledge-base repo | Webhooks from SendGrid, Twilio, Calendly; REST for UI reads |
| Email intake (inbound) | SendGrid Inbound Parse | Receives `careers@` email, POSTs parsed content + base64 attachments to webhook |
| Email sending (outbound) | SendGrid Send API | All candidate emails from `careers@lifestylehomeservice.com` |
| Brain | Claude Opus 4.7 via Anthropic API | Resume parsing, scoring, SMS/email drafting, transcript summarization, conditional decision evaluation |
| Data store | Upstash Redis (`lhs-aria-kb`, `recruit:*` prefix) | Operational state, hot reads/writes |
| Audit trail | GitHub MD files in `docs/projects/candidates/*.md` | Durable human-readable history; dual-write from Aria |
| File store | Google Drive (`LHS_Recruiting_2026/`) | Resumes, trial photos, offer letters, Meet transcripts |
| Calendar | Google Calendar + Calendly | Meet pre-screens, phone screens, trial shifts |
| Video pre-screen | Google Meet | 15-min recorded, auto-transcribed |
| Voice recording | Dialpad (existing LHS infrastructure) | Phone screens; transcripts flow to HubSpot |
| Messaging | Twilio (604-330-3997) | All Aria-driven candidate SMS |
| Transcript bridge | Claude Cowork on Karen's Mac | Pulls Dialpad/HubSpot + Google Meet transcripts into Redis |
| Background jobs | Claude Code Routines on Anthropic infrastructure | Daily summaries, stale-candidate checks, pipeline health monitoring |

### 2.3 Data model (Redis keys)

All use `recruit:` prefix:

- `recruit:candidate:{candidate_id}` — full candidate JSON (see schema in Section 3)
- `recruit:stage:{stage_name}` — sorted set of candidate IDs in that Kanban stage, scored by entered-at timestamp
- `recruit:holding:{lane_name}` — sorted set of candidate IDs in holding patterns (Hard Hold, Conditional Hold, Waiting on Employer, Reassigned, Pending Return)
- `recruit:event:{candidate_id}:{timestamp}` — audit log entries
- `recruit:redalert:{alert_id}` — active red alert tasks
- `recruit:dependency:{candidate_id}` — conditional decision dependencies
- `recruit:intelligence:{entry_id}` — recruiting intelligence entries (Walker's, etc.)
- `recruit:email_thread:{candidate_id}` — email history, both directions
- `recruit:transcript:{candidate_id}:{source}` — transcript text from Meet or Dialpad
- `recruit:placeholder:{candidate_id}` — expected-but-not-yet-materialized candidates (Sharyn #016)
- `recruit:settings:hiring_mode` — NOT_HIRING / CASUAL / URGENT
- `recruit:settings:summary_times` — array of times in America/Vancouver
- `recruit:settings:autonomy_level` — per-stage autonomy map
- `recruit:daily_summary:{YYYY-MM-DD}` — archived summary text
- `recruit:counter:candidate_id` — monotonic counter for next ID (currently 15; reserved 16; next = 17)

### 2.4 Dual-write pattern

Every write to a candidate record executes in order:

1. **Claude Code builds the payload** (local JSON in `/data` folder per the Aria Redis rule)
2. **Write to Redis** (operational truth)
3. **Update the corresponding MD file** in `docs/projects/candidates/{NAME}.md`
4. **Commit and push to GitHub** (both repos if pattern established: lhs-knowledge-base primary, lhs-scheduler-proxy for shared artifacts)
5. **Log the event** in `recruit:event:{candidate_id}:{timestamp}`

If any step fails, the operation is marked pending and retried. The MD file is the durable audit trail — someone reading the repo in 6 months can reconstruct what Aria did and why.

---

## 3. Candidate schema (locked — based on Louise Savoie file structure)

### 3.1 Fields

Every candidate record in Redis and MD carries these fields:

**Identity:**
- `candidate_id` — string, format `#001` through `#999` (continues from #015; #016 reserved for Sharyn McKay)
- `full_name`
- `phone` — E.164 format preferred
- `phone_confirmed` — boolean
- `email`
- `location_postal_code`
- `location_city` — optional, for clarity
- `source` — "Indeed" / "careers_page" / "referral" / "direct" / "expected"

**Scoring:**
- `score_value` — integer (e.g. 34)
- `score_denominator` — integer (e.g. 35)
- `rubric_type` — enum: "full_rubric" / "phone_screen_only" / "expanded_screen" / "prescreen_triage" / "partial_assessment"
- `per_dimension_scores` — array of `{dimension_name, score?, denominator?, description?}`. Either score OR description can be populated, or both.

**Interview metadata:**
- `interviewer_name` — "Karen McLaren" / "Michael Butterfield" / null
- `interviewer_phone` — 604-800-9630 (Karen) / 604-618-0336 (Michael)
- `interview_date` — ISO date
- `interview_time` — local time string
- `interview_duration_minutes` — integer
- `outcome` — enum: "PASSED" / "FAILED" / "ADVANCING" / "PENDING" / "DECLINED" / "HIRED"

**Qualitative:**
- `key_findings` — array of strings (bullet points)
- `communication_log` — array of `{timestamp, channel, direction, summary}` where channel = "sms"/"email"/"call"/"meet", direction = "in"/"out"
- `flags` — array of `{id, severity, description}` where severity = "red_alert" / "warning" / "note"
- `next_action` — single clear instruction string

**Pipeline state:**
- `status` — current Kanban stage OR holding-lane position
- `stage_entered_at` — ISO timestamp
- `availability_horizon` — enum: "full_time_permanent" / "part_time_permanent" / "seasonal" / "temporary_replacement" / "unknown"
- `availability_details` — free text for specifics (e.g. "Mon/Tue/Thu/Fri 9-3, Wed 9-2")
- `earliest_start_date` — ISO date or null
- `depends_on` — array of candidate IDs this decision depends on, plus required outcome

**Experience flags:**
- `has_cleaning_experience` — boolean (the "flag positive, don't require" rule from Karen's earlier note)
- `cleaning_experience_years` — integer or null
- `cleaning_experience_types` — array like ["residential", "hotel", "commercial", "move_out"]
- `certifications` — array like ["WHMIS", "Food_Safe"]
- `has_vehicle` — boolean
- `has_vehicle_confirmed` — boolean

### 3.2 Example (Louise Savoie after phone screen)

```json
{
  "candidate_id": "#001",
  "full_name": "Louise Savoie",
  "phone": "+16047999623",
  "phone_confirmed": true,
  "email": "[on file]",
  "location_postal_code": "[on file]",
  "source": "Indeed",
  "score_value": 34,
  "score_denominator": 35,
  "rubric_type": "full_rubric",
  "per_dimension_scores": [
    {"dimension_name": "personability", "score": 9, "denominator": 10},
    {"dimension_name": "commitment", "score": 10, "denominator": 10},
    {"dimension_name": "listening", "description": "good listening"}
  ],
  "interviewer_name": "Michael Butterfield",
  "interviewer_phone": "+16046180336",
  "interview_date": "2026-04-18",
  "interview_time": "afternoon",
  "outcome": "ADVANCING",
  "key_findings": [
    "Mature",
    "Customer-service background",
    "Wants full-time",
    "Can start right away",
    "WHMIS certified"
  ],
  "flags": [],
  "next_action": "Trial shift Monday April 20",
  "status": "trial_scheduled",
  "availability_horizon": "full_time_permanent",
  "earliest_start_date": "2026-04-20",
  "has_cleaning_experience": true,
  "certifications": ["WHMIS"]
}
```

### 3.3 Scoring display rule (Option 2 locked)

When Aria displays any score, it ALWAYS renders as:

> `{score_value}/{score_denominator} — {rubric_type_human} — {interviewer_name}`

Examples:
- "34/35 — full rubric — Michael Butterfield"
- "21/25 — phone screen only — Karen McLaren"
- "14/35 — partial assessment — Karen McLaren"

Aria never normalizes across rubrics. Never says "86%". Never ranks across different denominators without displaying them. This is a design rule, not a preference.

---

## 4. The 8-stage funnel

Michael's 7 stages + JotForm + cleaning simulator, sequenced per candidate investment curve:

| # | Stage | Entry trigger | Exit trigger | Typical duration |
|---|---|---|---|---|
| 1 | **Applied** | SendGrid webhook fires on Indeed notification | Knockout questions answered | 0-2 hours |
| 2 | **Screener** | Knockouts received | Resume score + SMS screener complete | 2-24 hours |
| 3 | **JotForm** | Screener passed | JotForm completed | 1-3 days |
| 4 | **Cleaning simulator** | JotForm completed | Simulator scored | 1-3 days |
| 5 | **Phone screen** | Simulator pass/review | Meet OR Dialpad call + transcript | 1-5 days |
| 6 | **Trial** | Phone screen PASSED | Paid 2-hour trial completed with scorecard | 3-7 days |
| 7 | **Offer** | Trial PASSED + Karen approval | Offer letter sent + signed | 1-3 days |
| 8 | **Hired / Declined** | Candidate accepts OR declines at any stage | Terminal | — |

Drop-off between JotForm (5-7 min effort) and simulator (15-20 min effort) is a useful signal: if they completed the form but ghosted the simulator, that tells you something about follow-through.

---

## 5. Holding patterns lane (parallel to Kanban)

Not every candidate flows through the funnel linearly. The portal shows a **parallel lane** (visible alongside the Kanban but separated visually) with these sub-states:

| Holding lane | Entry reason | Exit trigger | Example |
|---|---|---|---|
| **Hard Hold** | Hard knockout that may eventually resolve | Change in candidate circumstance | Nicole Bryson — no vehicle |
| **Conditional Hold** | Advancement depends on other candidates | Dependency resolves | Felicia Wilson — depends on Louise/Haley |
| **Pending Return** | Awaiting candidate input (JotForm, callback) | Input received | Samantha Sylvester — JotForm sent |
| **Waiting on Employer** | Candidate managing current-employer notice | They contact us | Trish Beekman — do NOT follow up |
| **Reassigned** | Wrong role for current position | New role opens | Rachael Szilasy — VA candidate, not cleaner |
| **Expected** | Placeholder for incoming candidate | Resume arrives OR 14-day timeout | Sharyn McKay #016 |

Candidates in the holding lane don't get advancement SMS from Aria. They get **lane-specific treatment**:
- Hard Hold → no contact; flagged for manual reassessment monthly
- Conditional Hold → Aria watches dependencies; auto-advances when conditions met
- Pending Return → Aria sends single reminder after 48 hours, then parks
- Waiting on Employer → Aria is silent (respect the candidate's process)
- Reassigned → moved to alternate role pipeline if one exists
- Expected → placeholder record visible to Karen/Michael; auto-activates on resume arrival

### 5.1 The conditional decision engine

For candidates in Conditional Hold, the `depends_on` field drives Aria's logic:

```json
"depends_on": [
  {"candidate_id": "#001", "required_outcome": "FAILED", "resolves_to": "advance_to_trial"},
  {"candidate_id": "#010", "required_outcome": "FAILED", "resolves_to": "advance_to_trial"}
]
```

When candidate #001 (Louise) gets outcome PASSED instead of FAILED, the dependency is evaluated. If ANY required outcome is not met AND no other dependency resolves positively, Felicia moves to "do not advance." Aria drafts the rejection communication but holds it for Karen's approval before sending (Felicia is a real person who applied; not advancing needs human judgment even when the logic is clear).

The key safeguard: **conditional logic never auto-sends rejection**. It only auto-advances. Rejections always need human confirmation.

---

## 6. Red alert task system

Red alerts are tasks that would silently break the pipeline if ignored. Examples:
- Ester Manigbas — phone number unverified
- Samantha Sylvester — JotForm overdue 72+ hours
- Candidate stuck in "Trial scheduled" stage with trial date in the past
- SendGrid webhook failure detected
- Simulator completion but scoring failed

### 6.1 Surfacing

Red alerts appear in FOUR places simultaneously:
1. **Top banner** on the hiring.html page — red background, count badge
2. **7am daily summary SMS** — "3 red alerts active: Ester phone verify, Samantha JotForm 4 days overdue, SendGrid webhook failed 2x in past hour"
3. **Urgent SMS push** when a new red alert is created
4. **The Bridge dashboard** — hiring pipeline widget shows red alert count

Red alerts have a `{severity, age, description, resolution_action}` structure. They stay visible until resolved OR dismissed with a note.

---

## 7. Recruiting intelligence section

Institutional knowledge that's not tied to a single candidate. Examples:

**Entry #1 — Walker's Cleaning Services pays under the table (2026-04-18):**
- Walker's cleaners seeking legitimate employment (T4, CPP/EI, pay stubs) will be drawn to LHS
- When scoring a new resume mentioning Walker's, Aria adds flag: "Walker's alum — often motivated by above-board employment; high signal per intelligence entry 2026-04-18"
- Source: Dazmyn Lush phone screen, April 18

Structure:
- `entry_id`
- `title`
- `content` (rich text)
- `source` (conversation, observation, external)
- `date_added`
- `relevance` (resume_scoring / interview_question / sourcing / other)
- `active` (boolean — false if outdated)

Aria reads relevant entries when scoring resumes, drafting interview questions, or generating candidate summaries.

---

## 8. Email pipeline (from v1.2, preserved)

All v1.2 Section 3 logic applies unchanged:

- `careers@lifestylehomeservice.com` as public-facing hiring email
- SendGrid handles both inbound and outbound
- Karen's Gmail auto-forwards Indeed notifications to careers@
- careers@ forwards to SendGrid parse address
- Webhook posts parsed email + base64 attachments to `/api/intake-email` endpoint in lhs-knowledge-base Vercel functions
- Claude Opus reads resume PDFs natively as `document` content blocks
- Outbound emails send from `LHS Careers <careers@lifestylehomeservice.com>` with Reply-To threading
- DNS records required (MX, SPF, DKIM, DMARC) — setup ~1 hour plus propagation

See `Resume_Extraction_Implementation.md` for endpoint implementation detail.

### 8.1 Integration with dual-write

When `/api/intake-email` processes a new application:
1. Claude extracts structured data
2. Writes to Redis `recruit:candidate:{new_id}`
3. Creates MD file at `docs/projects/candidates/{NAME_UPPERCASE}.md`
4. Commits and pushes to lhs-knowledge-base
5. Creates Kanban card in stage 1 (Applied)
6. Triggers first SMS via Twilio AND introduction email via SendGrid

---

## 9. Twilio transition protocol

Currently: candidates are texted from Karen's personal phone (604-800-9630) or Michael's (604-618-0336).

Target state: Aria texts from 604-330-3997, Karen and Michael's personal phones stay personal.

### 9.1 For new candidates (post-Aria-launch)

First SMS from Aria:
> Hi {Name} — this is Aria, the scheduling assistant for Karen at Lifestyle Home Service. Thanks for applying! I'd like to ask you 3 quick questions to see if this role is a fit.

Aria is introduced by name. Candidates know they're talking to an assistant, which is legally and ethically correct.

### 9.2 For the 15 existing candidates (transition phase)

Existing candidates have been talking to Karen OR Michael personally. Abrupt handoff to an unnamed bot would damage trust. The transition SMS references the specific human:

If last contact was with Karen:
> Hi {Name} — this is Aria, Karen's new scheduling assistant at Lifestyle Home Service. Karen asked me to help coordinate your next step. {stage-specific message}

If last contact was with Michael:
> Hi {Name} — this is Aria, Michael's new scheduling assistant at Lifestyle Home Service. Michael asked me to help coordinate your next step. {stage-specific message}

The last-contact human stays visible in every communication until the candidate either reaches a terminal stage OR explicitly acknowledges Aria ("thanks Aria", "hi Aria", etc).

### 9.3 Weekend continuity

The 15 existing candidates continue to receive texts from Karen/Michael personal phones through the current crisis. Aria transition happens AFTER Monday trials resolve. Trying to migrate mid-crisis introduces risk and adds no value.

---

## 10. Claude ecosystem integration

### 10.1 Claude Code — builds and runs routines

Claude Code on Karen's Mac is the builder and the Routines host.

**Routines (run on Anthropic infrastructure):**
- Daily summary routine — 6:50am, 10:50am, 2:50pm Pacific
- Stale candidate check — every 4 hours in business hours
- Weekly analytics — Mondays 6am
- Intake pipeline health check — hourly
- Email bounce handler — event-driven from SendGrid webhooks

**Build rules (carry over from Aria):**
- For Redis writes, always select Option 2 — write payload to local JSON in `/data` folder first, then push to Redis
- Never share Redis credentials in conversation
- Push to both repos when pattern requires (lhs-knowledge-base primary, lhs-scheduler-proxy for shared artifacts)

### 10.2 Claude Cowork — desktop automation on Karen's Mac

Cowork's real job: integrations that need a logged-in browser session.

**Cowork tasks:**
1. Dialpad + HubSpot transcript pull — poll HubSpot every 30 min during business hours
2. Google Meet transcript sync — watch `LHS_Recruiting_2026/pre-screens/` folder in Drive
3. Voice-triggered commands — "Cowork, tell Aria we're urgently hiring"
4. Batch candidate operations — silver medalist emails, bulk operations

Cowork does NOT handle email intake (SendGrid) or resume parsing (Claude Opus native).

### 10.3 Claude Projects — knowledge context

Project context includes:
- This design document (v1.3)
- The 15 existing candidate MD files
- HIRING_PROJECT_APRIL2026.md, CANDIDATE_INDEX.md, HIRING_PORTAL_BUILD.md, EMAIL_TEMPLATES_HIRING.md
- Historic hiring outcomes (for scoring calibration over time)
- Recruiting intelligence entries

Injected into every Claude Opus call that needs context.

---

## 11. The Bridge integration

AriaRecruit feeds these into The Bridge dashboard:

- **Pipeline counts** — candidates per stage, updated real-time
- **Red alert count** — current active red alerts
- **Daily intake** — applications received today
- **Time-to-first-SMS** — measured per candidate, averaged
- **Candidates at risk** — stuck in stage, approaching staleness threshold
- **Hiring mode status** — NOT_HIRING / CASUAL / URGENT with effective-date

The Bridge reads from Redis (`recruit:*` keys), same pattern it uses for other ops metrics. No new endpoints required — just Bridge-side code to parse and display.

---

## 12. Weekend operations continuity (critical)

The AriaRecruit build MUST NOT interfere with the active hiring crisis. Specifically:

- **Phase 1 build does not start** until the three current positions are filled (target Friday May 1, 2026)
- **Existing 15 candidates stay in manual process** — MD files continue as source of truth; Karen and Michael text from personal phones; scoring and decisions happen as they do now
- **New candidates during crisis** — also processed manually until Aria goes live
- **Design iteration is fine** — this document and prototypes can be refined in parallel to hiring; they don't touch the live hiring process

**Go-live trigger:** The three positions are filled (Karen Corrie, Louise Savoie, third TBD) AND Karen + Michael have reviewed v1.3 AND one of them explicitly says "launch Aria for the next candidate."

**First Aria candidate:** The next new Indeed application after go-live is Aria's first real candidate. The 15 existing candidates finish their journey in the legacy process and migrate only if they're still active 30 days after go-live.

---

## 13. Build sequence

**Phase 1 — Foundation (weeks 1-2, post-crisis)**

1. Create `hiring.html` page in lhs-knowledge-base repo
2. Set up `careers@lifestylehomeservice.com` alias in Google Workspace
3. SendGrid account: Inbound Parse + Sender Authentication
4. DNS records on lifestylehomeservice.com (MX, SPF, DKIM, DMARC) — wait for propagation
5. Vercel serverless functions:
   - `/api/intake-email` (SendGrid webhook)
   - `/api/send-email` (SendGrid send wrapper)
   - `/api/transcript-ingest` (Cowork posts here)
   - `/api/twilio-inbound` (Twilio webhook)
   - `/api/twilio-outbound` (Aria SMS send)
6. Redis schema with `recruit:*` prefix, initialize settings defaults
7. Kanban UI (desktop) — read-only from Redis
8. Holding patterns lane
9. Red alert banner
10. Candidate profile view (with all schema fields)
11. Migration helper — read existing MD files, surface 15 candidates alongside Aria-managed ones (legacy view)
12. End-to-end test — submit test Indeed application, verify <60s SMS + email, verify dual-write to Redis AND MD file

**Phase 2 — Communication layer (week 3)**

13. Full Twilio integration with transition protocol
14. Calendly integration for Meet + phone screens + trials
15. Email template library (initial drafts from EMAIL_TEMPLATES_HIRING.md, refined by Claude)
16. SMS reply parsing (APPROVE/REJECT/MODE commands)
17. First SMS introduction variants (new vs transition)

**Phase 3 — Assessment engine (week 4)**

18. Cleaning simulator production build (mobile-first, from prototype)
19. JotForm integration
20. SMS SJT scenarios with Claude Opus grading
21. Scorecard aggregation following locked schema

**Phase 4 — Transcript bridges (week 5)**

22. Cowork Google Meet transcript watcher
23. Cowork Dialpad/HubSpot transcript puller
24. `/api/transcript-ingest` processing
25. Claude Opus transcript summarization into per-dimension scores

**Phase 5 — Autonomy and summaries (week 6)**

26. Claude Code Routines for 7am/11am/3pm summaries
27. Red alert detection and notification logic
28. Conditional decision engine
29. Autonomy matrix enforcement by hiring mode
30. Approval-by-SMS flow

**Phase 6 — Polish, analytics, Bridge integration (week 7)**

31. Full candidate profile with email thread + transcript history
32. Aria History / event log view
33. Weekly analytics routine
34. Referral link generator
35. Bridge dashboard integration (hiring pipeline widget)
36. Recruiting intelligence section UI

---

## 14. Candidate ID management

- Current highest ID: **#015** (Justine Davis)
- Reserved: **#016** for Sharyn McKay (resume expected; placeholder record active)
- Next new candidate assignment: **#017**
- Counter: `recruit:counter:candidate_id` in Redis

### 14.1 Expected candidate (placeholder) pattern

When Karen or Michael know a candidate is coming but the resume hasn't arrived:

1. Create placeholder record at `recruit:placeholder:{next_id}`
2. Fields: `candidate_id`, `full_name`, `expected_source`, `expected_date`, `notes`, `expected_by_deadline` (default +14 days)
3. Counter increments — the ID is now reserved
4. When an Indeed application arrives matching the placeholder by name, Aria merges (converts placeholder to full record, preserves ID)
5. If deadline passes without arrival, placeholder moves to "never materialized" status and remains in Redis as a light record (historical)
6. The ID is NEVER reused — unique monotonic counter

---

## 15. Open questions for Karen and Michael

Carried forward from v1.2 + new from v1.3:

1. Trial compensation rate — confirm $23/hr CAD for 2-hour trial?
2. DNS registrar for `lifestylehomeservice.com` — needed for Phase 1 step 4
3. Phone-screen scorecard template — align the new system to the /35 full rubric dimensions used for Louise; need full dimension list
4. Bill Gee (accountant) handoff — auto-email on hire to initiate ROE/payroll setup, or manual?
5. Realistic Job Preview video — existing LHS video to use, or Phase 7 add-on?
6. DocuSign/HelloSign for offer letters — worth adding in Phase 2, or manual for now?
7. LHS cloth colour system — ISSA 4-colour standard OR custom?
8. Realistic time targets per room — confirm simulator ranges (bath 10-18, kitchen 14-24, bedroom 8-16)
9. The Bridge widget layout — should hiring pipeline be its own panel, integrated into an existing panel, or a new Bridge tab?
10. Sharyn McKay — if her resume doesn't arrive within 14 days, what's the default action? (recommend: move to "never materialized" and release ID... just kidding, don't release, keep history)

---

## 16. Success measurement

**30 days post-launch:**
- Time from application to first SMS + email (target: <60 seconds average)
- Karen's daily hiring time (target: <5 min average in steady state)
- Email pipeline uptime (target: 99%+)
- Dual-write integrity — Redis and MD files in sync (target: 100%)
- Red alert median resolution time (target: <4 hours during business hours)

**60 days:**
- Time-to-hire from application to first paid trial (target: <7 days)
- Automated rejection rate without human touch (target: 50%+)
- Mobile simulator completion rate (target: 70%+)
- Transition protocol effectiveness — % of existing-candidate transitions that felt natural (measured via follow-up SMS: "How was the transition to Aria?")

**90 days:**
- Quality-of-hire — 30-day retention of Aria-advanced hires vs historical baseline (15 manual candidates as control group)
- Override rate — how often Karen/Michael disagree with Aria's recommendation
- Simulator-score-to-trial-success correlation
- Conditional decision engine accuracy — % of dependency resolutions that Karen agreed with

---

*End of design v1.3. Cleared for Claude Code Phase 1 build after hiring crisis resolution.*

*🖖 Captain, Number One, and Claude Code — synchronized.*
