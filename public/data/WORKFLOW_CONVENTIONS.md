# Workflow Conventions

How LHS operates day-to-day. Critical for the scheduler to respect existing patterns
rather than fight them.

---

## HCP Conventions

### Trainee placement under Karen M's name
- New trainees are placed in the HCP schedule under **Karen M's name**, with the trainee's actual name in the **job tag** field.
- **Why:** If the trainee doesn't work out, removing them cleanly is easier than reassigning a real cleaner's record.
- **HCP tag spellings:**
  - Heidi → tagged "Heidi DeGrow"
  - Rytham → tagged "Rhythm Sidhu"
  - Lada (contractor) → tagged "Ladda Bouttavong"
- **Implication for scheduler:** When reading HCP data, any job assigned to Karen M needs investigation. The job tag, if present, identifies who is actually working.

### Off-books contractors
- Lada works as paid contractor and is intentionally NOT entered in HCP.
- Her jobs appear under Karen M's name with tag "Ladda Bouttavong".
- The scheduler should not flag these as "Karen M overscheduled" automatically.

### HCP is master, scratchpad is draft
- All schedule editing happens in HCP at the end of the planning process.
- The scratchpad is a thinking and approval tool, not a parallel schedule.
- HCP auto-notifies clients on every change. We approve once, push once, to minimize client-facing churn.
- **When scratchpad and HCP disagree, HCP wins.**

---

## Pairing Conventions

### Trainees are paid working hands during try-out
- Heidi and Rytham work alongside experienced cleaners as additional crew.
- They are NOT observers (with one exception — Alissa post-mat-leave can be observer-only).
- Their pay starts on Day 1 of try-out.

### Trainee pairings need experienced LEADS
- Approved leads so far: Nicole D, Alissa D, Anna F.
- NOT approved: Karen C (too new), Margret W (too new), trainees themselves.
- Karen confirms or denies new pairings as cases arise.

### 30-minute travel buffer between jobs
- Global rule: cleaners need 30 minutes between jobs at different addresses.
- Exceptions may exist for jobs at the same property complex.
- See `cleaner-availability.json` → `global_rules` → `travel_buffer_minutes`.

---

## Stat Holiday Handling

- **Policy:** TBD with Karen. Default assumption: residential cancels, commercial may keep.
- **Pending stat:** Mon May 18, 2026 (Victoria Day). 16 jobs currently scheduled — needs Karen's policy call.

---

## Client Communication

### HCP auto-notifies on schedule change
- Any modification to a job in HCP triggers a customer notification.
- This is WHY we need the scratchpad — to draft and approve before committing.

### Phone vs. text vs. email per client
- Some clients are flagged `no_emails`, `call_only`, `notify_via_text`.
- See `client-frequency.json` flags field per client.

---

## Onboarding / Offboarding

### Employee offboarding SOP
1. Record last day in knowledge base
2. Email Bill Gee (accountant) for Record of Employment
3. Remote logout from HCP
4. Set archived employee temporary password: `48200Briteside!`
5. Archive employee profile in HCP
6. Remove from active roster
7. Reassign their clients

### Trainee try-out evaluation
- **Pay status:** Paid from Day 1 of try-out.
- **Decision point:** TBD — Karen evaluates after some trial period.
