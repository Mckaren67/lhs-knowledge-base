# Claude Code Phase 1 Kickoff Prompt

**Purpose:** Paste the contents of the fenced block below directly into Claude Code on Karen's Mac to begin Phase 1 of the AriaRecruit build.

**When to use:** AFTER the current hiring crisis resolves — i.e., when the three open positions are filled AND Karen or Michael has explicitly said "launch Aria."

**Before pasting, confirm these prerequisites:**

- [ ] The three April/May 2026 cleaner positions are filled
- [ ] `AriaRecruit_Design_v1_3.md` is in the project knowledge / accessible to Claude Code
- [ ] `Resume_Extraction_Implementation.md` is accessible
- [ ] `Cleaning_Simulator_Spec_v1.md` and `cleaning_simulator_prototype.html` are accessible
- [ ] Karen has added karen@ as collaborator on both GitHub repos
- [ ] The DNS registrar for `lifestylehomeservice.com` is known (question #2 in v1.3)
- [ ] A SendGrid account exists OR Karen/Michael are willing to create one during Phase 1
- [ ] Google Workspace admin access is available (to create `careers@` alias)

---

## The prompt (paste everything between the lines into Claude Code)

---

```
You are building Phase 1 of AriaRecruit, a hiring portal for Lifestyle Home Service (LHS).

PRIMARY DESIGN DOCUMENT: AriaRecruit_Design_v1_3.md
Read this file in full before taking any action. It is the source of truth.

SUPPORTING DOCUMENTS:
- Resume_Extraction_Implementation.md — detailed spec for /api/intake-email endpoint
- Cleaning_Simulator_Spec_v1.md — simulator design (Phase 3, not Phase 1)
- cleaning_simulator_prototype.html — simulator prototype (Phase 3, not Phase 1)

STAKEHOLDERS:
- Karen McLaren (karen@lifestylehomeservice.com, 604-800-9630) — business owner, field ops
- Michael Butterfield (michael@lifestylehomeservice.com, 604-618-0336) — builder, systems
- Aria SMS number — 778-200-6517 (existing Twilio)

ARCHITECTURE LOCKED:
- AriaRecruit is a standalone page: lhs-knowledge-base.vercel.app/hiring.html
- Lives inside the EXISTING repo: github.com/Mckaren67/lhs-knowledge-base
- Does NOT extend lhs-scheduler-proxy
- Feeds data UP into The Bridge dashboard at /bridge.html
- Shares Upstash Redis instance: lhs-aria-kb
- Redis keyspace prefix: recruit:*
- Dual-write pattern: every write goes to Redis AND GitHub MD file
- For Redis writes, ALWAYS select Option 2 — write payload to local JSON in /data folder first, then push to Redis
- Push to both repos when pattern established: lhs-knowledge-base (primary), lhs-scheduler-proxy (shared artifacts)

YOUR TASK FOR PHASE 1 — weeks 1-2

Build the foundation. Phase 1 is scoped to v1.3 Section 13 Phase 1 items #1 through #12. Do NOT start Phase 2 work.

Phase 1 deliverables in priority order:

1. CREATE hiring.html page
   - Add to lhs-knowledge-base repo
   - HTML/JS/CSS following the same pattern as bridge.html
   - Placeholder content initially; wire up as subsequent steps complete
   - Verify deploys to lhs-knowledge-base.vercel.app/hiring.html

2. SET UP EMAIL INFRASTRUCTURE
   - Create careers@lifestylehomeservice.com alias in Google Workspace (this requires Karen/Michael action — prompt them with exact steps)
   - Set up SendGrid free account (prompt Karen/Michael to create if not exists)
   - Configure SendGrid Inbound Parse pointing to webhook URL
   - Configure SendGrid Sender Authentication for lifestylehomeservice.com
   - Document exact DNS records needed (MX, SPF, DKIM, DMARC) — prompt Karen/Michael to add at their registrar
   - Configure careers@ auto-forward to SendGrid parse address
   - Document Karen's Gmail filter for Indeed auto-forwarding to careers@
   - Do NOT proceed past this step until DNS has propagated and test inbound email successfully reaches the webhook

3. BUILD VERCEL SERVERLESS FUNCTIONS
   Create these endpoints in the lhs-knowledge-base repo (in /api/ directory):
   - /api/intake-email — SendGrid inbound webhook handler. Follow Resume_Extraction_Implementation.md exactly.
   - /api/send-email — SendGrid outbound wrapper, sends as "LHS Careers <careers@lifestylehomeservice.com>"
   - /api/twilio-inbound — Twilio SMS webhook handler
   - /api/twilio-outbound — Aria SMS send function
   - /api/transcript-ingest — Cowork posts Dialpad/Meet transcripts here (can be stubbed in Phase 1; full logic in Phase 4)

4. REDIS SCHEMA INITIALIZATION
   Initialize these keys with defaults:
   - recruit:settings:hiring_mode = "CASUAL"
   - recruit:settings:summary_times = ["07:00", "11:00", "15:00"]
   - recruit:settings:autonomy_level = {per v1.3 Section 5.2}
   - recruit:counter:candidate_id = 15 (current highest; next assignment returns 17 because #016 is reserved for Sharyn McKay)
   - recruit:placeholder:#016 = {Sharyn McKay placeholder per v1.3 Section 14.1}

5. BUILD KANBAN UI (desktop, read-only in Phase 1)
   - 8 stages per v1.3 Section 4: Applied, Screener, JotForm, Cleaning simulator, Phone screen, Trial, Offer, Hired/Declined
   - Reads from Redis recruit:stage:* sorted sets
   - Display candidate cards with:
     - Candidate ID, name
     - Score in Option 2 format: "34/35 — full rubric — Michael Butterfield"
     - Days in current stage (yellow if >2, red if >5)
     - Last action summary
     - Needs-approval flag if applicable
   - Card click opens full candidate profile view
   - All v1.3 scoring display rules apply — NEVER normalize across scales

6. BUILD HOLDING PATTERNS LANE
   - 6 sub-states per v1.3 Section 5: Hard Hold, Conditional Hold, Pending Return, Waiting on Employer, Reassigned, Expected
   - Visually parallel to Kanban, not inside it
   - Each candidate in a holding lane shows lane reason + exit condition

7. BUILD RED ALERT BANNER
   - Top of hiring.html
   - Red background, pulsing if any active
   - Shows count and click-to-expand list
   - Reads from recruit:redalert:* keys
   - Each alert shows: severity, age, description, resolution action

8. BUILD CANDIDATE PROFILE VIEW
   - All schema fields per v1.3 Section 3.1 visible
   - Per-dimension scores displayed in table
   - Communication log timeline (sms/email/call/meet entries)
   - Flags list
   - Email thread history (reads from recruit:email_thread:{id})
   - Transcript panel (reads from recruit:transcript:{id}:*)
   - Next action prominently displayed

9. BUILD LEGACY CANDIDATE VIEW
   - Parse the 15 existing MD files in docs/projects/candidates/*.md
   - Display them alongside Aria-managed candidates in the Kanban
   - Mark clearly as "Legacy (pre-Aria)" with a badge
   - Do NOT migrate them to Redis — they stay as MD files until hired/declined
   - Per v1.3 Section 12, legacy candidates only migrate to Redis if still active 30 days after go-live

10. IMPLEMENT DUAL-WRITE PATTERN
    - Helper function: writeCandidate(candidate_id, data) that:
      1. Writes to Redis recruit:candidate:{id}
      2. Writes/updates /docs/projects/candidates/{NAME}.md
      3. Appends to recruit:event:{id}:{timestamp}
      4. Commits and pushes to lhs-knowledge-base
    - All other endpoints use this helper for any candidate mutation
    - If any step fails, mark pending and retry

11. IMPLEMENT EXPECTED CANDIDATE PLACEHOLDER PATTERN
    - Function: createPlaceholder(name, source, expected_date, notes, expected_by_deadline_days=14)
    - Stored at recruit:placeholder:{id}
    - Counter increments (ID reserved)
    - When /api/intake-email processes a new application, check placeholders for name match before creating new record
    - If match: merge, activate placeholder as full candidate, keep the reserved ID
    - If placeholder deadline passes: move status to "never_materialized", keep record

12. END-TO-END TEST
    - Michael submits a test Indeed-style application to careers@lifestylehomeservice.com with a sample resume PDF
    - Verify: email arrives at SendGrid → webhook fires → /api/intake-email processes → Claude Opus extracts resume → candidate record written to Redis → MD file created in repo → first SMS sent from 778-200-6517 → first email sent from careers@ → both visible in hiring.html Kanban
    - Total elapsed time target: under 60 seconds
    - Verify dual-write integrity: Redis and MD file match

STOP CONDITIONS (do NOT proceed past these in Phase 1):

- Do NOT build the cleaning simulator (Phase 3)
- Do NOT build the conditional decision engine (Phase 5)
- Do NOT build SMS SJT scenarios (Phase 3)
- Do NOT build daily summary routines (Phase 5)
- Do NOT build Cowork transcript pullers (Phase 4)
- Do NOT implement autonomy matrix enforcement (Phase 5)
- Do NOT start Phase 2 work until Karen and Michael have reviewed Phase 1 end-to-end

OPERATING RULES

- ALWAYS read v1.3 before making architectural decisions
- ALWAYS use the dual-write pattern for any candidate mutation
- ALWAYS display scores in Option 2 format: value/denominator — rubric — interviewer
- NEVER normalize scores across rubrics
- NEVER auto-reject a candidate (conditional logic auto-advances only; rejections need human confirmation — relevant in Phase 5, noted here for consistency)
- NEVER send candidate-facing communication from anywhere other than 778-200-6517 (SMS) or careers@lifestylehomeservice.com (email)
- When prompting Karen or Michael for action, use the "time saved" framing preference, not "technology" framing
- For Redis saves, always Option 2 — local JSON in /data first
- Commit and push to lhs-knowledge-base after every meaningful change
- Use candidate IDs continuing from the counter — current state: max is #015, #016 reserved for Sharyn McKay

COMMUNICATION WITH KAREN AND MICHAEL

When you need human action during Phase 1 (e.g., DNS setup, SendGrid account creation, Google Workspace alias), produce a concise text or email draft ready to send, with exact steps. Do not assume they know technical terminology. Examples:

- For DNS: provide the exact records to add with clear instructions on where to find their domain registrar
- For SendGrid: provide a signup link and the specific settings to configure
- For Google Workspace: exact path through admin panel

Always answer the unasked question: "what does this do for me?" Karen cares about time saved and the pipeline working. Michael cares about clean architecture and dual-write integrity. Calibrate accordingly.

START BY

1. Reading AriaRecruit_Design_v1_3.md in full
2. Reading Resume_Extraction_Implementation.md in full
3. Confirming access to the lhs-knowledge-base repo and Redis credentials
4. Listing prerequisites that require Karen or Michael action (items 2 above, specifically email infrastructure setup)
5. Producing a step-by-step plan for Phase 1 ordered by dependency
6. Asking Karen/Michael to confirm the plan before executing any Step 2 infrastructure work

When Phase 1 is complete, pause. Do not proceed to Phase 2 without explicit approval from Karen or Michael.

End of kickoff prompt.
```

---

## What to expect when Claude Code runs this

Claude Code will:

1. **Read v1.3 and Resume_Extraction_Implementation.md in full** — a few minutes of reading time
2. **List prerequisites requiring human action** — mostly the email infrastructure setup (careers@ alias, SendGrid account, DNS records)
3. **Produce a step-by-step Phase 1 plan** with dependencies mapped
4. **Pause and ask for approval** before executing infrastructure changes
5. **Build the Vercel functions and UI** once approved
6. **Test end-to-end** with a fake Indeed application
7. **Pause before Phase 2** and wait for explicit approval

Total Phase 1 duration: 2 weeks, but most of that is DNS propagation and waiting for Karen/Michael to complete infrastructure setup steps. Actual Claude Code build time is probably 3-5 days spread across the 2 weeks.

## What Karen and Michael need to do during Phase 1

**Within the first 48 hours of Claude Code starting:**

1. Confirm the domain registrar for lifestylehomeservice.com (answers open question #2 in v1.3)
2. Create SendGrid account and share API key with Claude Code (or let Claude Code create it with provided credentials)
3. Create `careers@lifestylehomeservice.com` alias in Google Workspace admin
4. Add DNS records at the registrar per SendGrid's instructions
5. Set up Gmail filter on karen@ to auto-forward Indeed notifications to careers@

**During the 2-week window:**

6. Be available to answer Claude Code questions
7. Review the Phase 1 plan before execution
8. Test the end-to-end flow once it's built
9. Approve Phase 2 transition when Phase 1 is complete

## If Claude Code gets stuck or produces unexpected output

- Point it back at `AriaRecruit_Design_v1_3.md` as the source of truth
- Ask it to explain its reasoning step-by-step
- Remind it of the stop conditions (Phase 2 work is not Phase 1 work)
- If architectural questions come up that v1.3 doesn't answer, pause Claude Code and return to this chat or the other chat for resolution — don't let Claude Code guess at architectural decisions

## Phase 2 kickoff

A separate Phase 2 kickoff prompt will be produced when Phase 1 is complete and approved. Don't try to use this prompt for Phase 2 — it has explicit stop conditions to prevent scope creep.

---

*🖖 Captain, Number One, and Claude Code — synchronized and ready.*
