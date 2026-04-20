# AriaRecruit Phase 1 — Infrastructure Setup

**For:** Karen (using Karen's credentials throughout — Michael works through the same accounts)
**Estimated time:** 60–90 minutes of clicking + up to 48h of waiting for DNS
**What this unlocks:** The full Aria pipeline — Indeed application → 60-second SMS + email → candidate card on the hiring portal.

Work top to bottom. Some steps have wait times baked in; you can move on to the next step while waiting.

---

## Before you start — what's already true

✓ The code is deployed. Preview URL is in your Vercel dashboard under the `aria-phase1` branch.
✓ Upstash Redis is already connected (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`).
✓ `INTERNAL_SECRET` is already set.
✓ Bridge dashboard is live at production.
✓ Aria itself is **not** live for new candidates. Existing 15 candidates stay manual per v1.3 §12.

---

## Step 1 — Add `careers@lifestylehomeservice.com` alias in Google Workspace

**Why:** Every candidate-facing email needs to come from `careers@`, not from your personal inbox. This also keeps candidate replies out of your personal email.

**Time:** 3 minutes.

1. Go to **admin.google.com** (sign in with your super admin account).
2. Left sidebar → **Directory** → **Users**.
3. Click your own user (`karen@lifestylehomeservice.com`).
4. Scroll to **User details** → click **Email aliases** (or the "+ ALTERNATE EMAIL" button).
5. Add `careers@lifestylehomeservice.com`. Save.
6. Wait 1–2 minutes for the alias to propagate inside Google Workspace.

**How to know it worked:** From an external email account, send a test message to `careers@lifestylehomeservice.com`. It should land in Karen's inbox within seconds.

---

## Step 2 — Confirm SendGrid account + generate API key

**Why:** SendGrid is how we both receive candidate emails (Inbound Parse) and send from `careers@` (Outbound Send). Without it, the pipeline has no eyes or mouth.

**Time:** 5 minutes if the account exists; 10 minutes if you need to sign up.

### 2a. Confirm with Michael whether the account already exists

Check with Michael. If **yes**, have him share the login and skip to 2c.

### 2b. If no account exists — sign up

1. Go to **signup.sendgrid.com**.
2. Use a shared operations email (not Karen's personal), e.g. `michael@lifestylehomeservice.com` or create an `ops@` alias in Workspace.
3. **Plan:** start with the **Free** plan — 100 emails/day is plenty for Phase 1 + early live. You can upgrade later.
4. Verify your signup email.
5. Complete the profile questionnaire (choose "Transactional" for use case).

### 2c. Generate an API key

1. In SendGrid → **Settings** → **API Keys**.
2. Click **Create API Key**.
3. **Name:** `AriaRecruit Vercel`.
4. **Permissions:** choose **Full Access**. (You can tighten this later once the system is running; for now full access avoids hunting for the right scope.)
5. Click **Create & View**. **Copy the key immediately** — SendGrid only shows it once.
6. Save it somewhere safe for Step 4 (pasting into Vercel).

---

## Step 3 — Add missing Vercel environment variables

**Why:** These are the passwords and phone numbers that every serverless function needs to do its job. Without them, the code runs but can't reach Twilio, Claude, or GitHub.

**Time:** 10 minutes.

1. Go to **vercel.com** → Your team → project `lhs-knowledge-base`.
2. Click **Settings** (top-right) → **Environment Variables** (left sidebar).
3. For **each** variable below, click **Add New**, enter the name and value exactly as shown, and **check all three environments (Production, Preview, Development)** so preview URLs work too:

| Name | Value | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | your existing Claude API key | console.anthropic.com → API Keys (create a new one if you don't have one handy; name it "AriaRecruit") |
| `TWILIO_SID` | your Twilio Account SID | twilio.com/console — "Account SID" on the dashboard home |
| `TWILIO_TOKEN` | your Twilio Auth Token | same dashboard, "Auth Token" (click to reveal) |
| `TWILIO_PHONE` | `+17782006517` | v1.3-locked (Aria's number) |
| `KAREN_PHONE` | `+16048009630` | your mobile, for urgent alerts |
| `MICHAEL_PHONE` | `+16046180336` | Michael's mobile, for urgent alerts |
| `SENDGRID_API_KEY` | the key you copied in Step 2c | SendGrid |
| `GITHUB_TOKEN` | see Step 3a below | GitHub — new fine-grained PAT |

### 3a. Create the GitHub token

**Why:** The dual-write pattern commits every candidate change to the repo for a durable audit trail. Since Vercel's filesystem is read-only, the function uses the GitHub API to commit. It needs a token.

1. Go to **github.com/settings/personal-access-tokens/new** (make sure you're signed in as Karen — `Mckaren67`).
2. **Token name:** `AriaRecruit writeCandidate`.
3. **Expiration:** 1 year (or your preference; we'll renew on schedule).
4. **Repository access:** choose **Only select repositories** → pick `Mckaren67/lhs-knowledge-base`. **Do not** give it access to all your repos.
5. **Permissions** → **Repository permissions** → find **Contents** → set to **Read and write**.
6. Leave all other permissions on their defaults (No access).
7. **Generate token** at the bottom. **Copy it immediately** — same as SendGrid, shown once.
8. Paste into Vercel as `GITHUB_TOKEN` (Step 3).

**How to know Step 3 worked:** In Vercel → Environment Variables, you should see the 8 new variables listed. No test yet; the values are used when functions run.

---

## Step 4 — Set up SendGrid Sender Authentication (for outbound `careers@` email)

**Why:** This is what makes candidate emails arrive from `careers@lifestylehomeservice.com` rather than some random SendGrid address. Without it, emails go to spam or get rejected.

**Time:** 10 minutes in SendGrid + ~30 minutes waiting for DNS (can happen in parallel with other steps).

1. SendGrid → **Settings** → **Sender Authentication**.
2. Under **Domain Authentication**, click **Get Started** (or **Authenticate Your Domain**).
3. **DNS Host:** choose **Other Host (Not Listed)** (Nexcess isn't in their dropdown).
4. **Domain:** `lifestylehomeservice.com`.
5. **Advanced settings:** leave defaults. Click **Next**.
6. SendGrid shows you **3 CNAME records** to add. Each row has a **Host** (left column) and a **Value** (right column). They look roughly like:
   - `s1._domainkey.lifestylehomeservice.com` → `s1.domainkey.u12345.wl.sendgrid.net`
   - `s2._domainkey.lifestylehomeservice.com` → `s2.domainkey.u12345.wl.sendgrid.net`
   - `em1234.lifestylehomeservice.com` → `u12345.wl.sendgrid.net`
7. **Leave this page open** — you'll need these values in Step 6.

---

## Step 5 — Set up SendGrid Inbound Parse (for receiving candidate emails)

**Why:** This is how Indeed applications, candidate replies, and cover letters get into Aria. SendGrid receives mail sent to a subdomain we register here, then POSTs the parsed content (fields + attachments) to `/api/intake-email`.

**Time:** 10 minutes.

1. SendGrid → **Settings** → **Inbound Parse**.
2. Click **Add Host & URL**.
3. **Receiving Domain / Subdomain:**
   - **Subdomain:** `parse`
   - **Domain:** `lifestylehomeservice.com`
   - This means SendGrid will receive mail addressed to `anything@parse.lifestylehomeservice.com`.
4. **Destination URL:** your Vercel deploy URL + `/api/intake-email`. For the `aria-phase1` preview: `https://lhs-knowledge-base-git-aria-phase1-<team-slug>.vercel.app/api/intake-email`. For production once merged: `https://lhs-knowledge-base.vercel.app/api/intake-email`. Find the exact preview URL in Vercel → Deployments → aria-phase1.
5. **Check** the "POST the raw, full MIME message" box if present — **actually, leave it unchecked**. Default parsed mode is what the code expects.
6. **Check** "Spam check" and "Send via SendGrid Inbound Parse" (the default).
7. Click **Add**.
8. SendGrid shows you the MX record you need to add at Nexcess:
   - **Host:** `parse.lifestylehomeservice.com`
   - **Value:** `mx.sendgrid.net`
   - **Priority:** `10`
9. **Leave this page open** — record these values for Step 6.

---

## Step 6 — Add DNS records at Nexcess

**Why:** Without these DNS records, SendGrid can't send as `careers@` (mail goes to spam) and can't receive at `parse.lifestylehomeservice.com` (mail bounces). DNS is the address book of the internet — we're telling it "SendGrid is allowed to speak for this domain."

**Time:** 15 minutes to paste in + up to 48 hours of propagation (usually <4h).

1. Go to **portal.nexcess.net** and sign in.
2. Navigate to **Domains** → find `lifestylehomeservice.com` → click into its DNS management (sometimes labeled "DNS Zone Editor" or "Manage DNS").
3. You'll add **7 records total**. Take them one at a time. Leave any existing Google Workspace MX records on the root domain alone — we're only adding new ones.

### Records to add

| # | Type | Host | Value | Priority / TTL |
|---|---|---|---|---|
| 1 | MX | `parse` | `mx.sendgrid.net` | Priority **10**, TTL default |
| 2 | CNAME | (from SendGrid Step 4, row 1 — the `s1._domainkey` one) | (matching value from SendGrid) | TTL default |
| 3 | CNAME | (from SendGrid Step 4, row 2 — `s2._domainkey`) | (matching value) | TTL default |
| 4 | CNAME | (from SendGrid Step 4, row 3 — the `em1234` one) | (matching value) | TTL default |
| 5 | TXT | `@` (or blank, meaning root domain) | `v=spf1 include:sendgrid.net include:_spf.google.com ~all` | TTL default |
| 6 | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:karen@lifestylehomeservice.com;` | TTL default |
| 7 | (nothing extra; Google Workspace MX stays as-is) | — | — | — |

**Notes:**
- **Row 5 (SPF):** if you already have an SPF record at `@`, you need to **edit** it to include `include:sendgrid.net` rather than add a second one. Two SPF records break email for the whole domain.
- **Row 6 (DMARC):** if one already exists at `_dmarc`, you can skip this row — or update its `rua=` to include Karen's email. DMARC `p=none` is "monitor mode"; we tighten this later.
- **Hostnames** at Nexcess: some registrars want the full name (`parse.lifestylehomeservice.com`), others want just the prefix (`parse`). Nexcess typically wants just the prefix. If one format is rejected, try the other.

4. Save each record as you add it.
5. Back in SendGrid → the Sender Authentication page from Step 4 → click **Verify**. It may say "Verifying DNS records" for a few minutes.
6. Back in SendGrid → Inbound Parse page from Step 5 → it will show as "Active" once the MX record propagates (may take 30 min to 4 hours).

**How to know Step 6 worked:**
- SendGrid Sender Authentication shows a green checkmark on all 3 CNAMEs.
- SendGrid Inbound Parse shows the parse hostname as active.
- From a terminal (or dnschecker.org): `dig MX parse.lifestylehomeservice.com` should return `mx.sendgrid.net`.
- A test email sent from `careers@lifestylehomeservice.com` via SendGrid's Email API playground arrives and is **not** marked as "via sendgrid.net" in the recipient's inbox.

If DNS isn't propagating after 4 hours, you can continue to Step 7 but the end-to-end test (Step 9) won't work until it does.

---

## Step 7 — Gmail auto-forward filter for Indeed + candidate email

**Why:** Indeed sends application notifications to your personal Gmail (`karen@`). This step forwards them to `careers@`, which in turn forwards to SendGrid Inbound Parse, which triggers the pipeline. It also ensures candidate replies don't clutter your inbox.

**Time:** 10 minutes.

### 7a. Set Gmail forward from karen@ to SendGrid's parse subdomain

1. In Karen's Gmail → **Settings** (gear icon, top right) → **See all settings** → **Forwarding and POP/IMAP** tab.
2. Click **Add a forwarding address**.
3. Enter a destination address: `careers@parse.lifestylehomeservice.com` (or any local part — SendGrid's parse doesn't care about what's before the `@`; it processes all mail to that subdomain).
4. Gmail sends a **verification email** to that address. Since the address forwards into SendGrid → our webhook, the verification email will hit `/api/intake-email`.
5. **To find the verification code:** go to **SendGrid → Activity** (in the left sidebar). The latest entry should be the Gmail verification. Click it to see the body, which contains a confirmation code and a confirmation link. Copy the code.
6. Back in Gmail → paste the code into the verification prompt. Click **Verify**.
7. Gmail now shows the address as a valid forward destination — but forwarding is **not yet enabled** (we do that via filter, not the blanket "forward all mail" toggle).

### 7b. Create a Gmail filter for Indeed

**Why:** We only want Indeed-application emails forwarded, not your personal mail.

1. In Karen's Gmail → **Settings** → **Filters and Blocked Addresses** → **Create a new filter**.
2. In **From:** enter `no-reply@indeed.com OR applicant@indeed.com OR @indeed.com`.
3. Click **Create filter**.
4. Check:
   - ☑ **Forward it to:** `careers@parse.lifestylehomeservice.com`
   - ☑ **Skip the Inbox** (so Indeed emails don't clutter Karen's inbox)
   - ☑ **Apply the label:** (optional — e.g. "Aria/Indeed-forwarded" for audit trail)
   - ☑ **Mark as read**
   - ☐ Do **not** delete — keep a copy for audit.
5. Click **Create filter**.

### 7c. Create a second forward for candidate replies to careers@

When SendGrid receives candidate email to `careers@` via the alias (Step 1), it goes to Karen's Gmail inbox. We need those routed to SendGrid too.

1. Karen's Gmail → **Settings** → **Filters and Blocked Addresses** → **Create a new filter**.
2. **To:** `careers@lifestylehomeservice.com`.
3. **Create filter**.
4. Check:
   - ☑ **Forward it to:** `careers@parse.lifestylehomeservice.com`
   - ☑ **Skip the Inbox**
   - ☑ **Delete it** (the only time we recommend delete — SendGrid already captured it; leaving it doubles storage)
5. **Create filter**.

**How to know Step 7 worked:** Send yourself (from Gmail) an email to `careers@lifestylehomeservice.com`. It should disappear from your inbox within 10 seconds. Check SendGrid → Activity to see it land in the webhook.

---

## Step 8 — Initialize the Redis schema

**Why:** The hiring portal expects certain Redis keys to exist (hiring mode, counter, Sharyn's placeholder). This one-shot call writes the defaults.

**Time:** 30 seconds.

1. Open a terminal on your Mac.
2. Find your `INTERNAL_SECRET` in Vercel → Environment Variables (click the eye icon to reveal).
3. Find your preview deploy URL in Vercel → Deployments → aria-phase1 (looks like `https://lhs-knowledge-base-git-aria-phase1-<team>.vercel.app`).
4. Run:

```bash
curl -X POST "https://lhs-knowledge-base-git-aria-phase1-<team>.vercel.app/api/init-schema" \
  -H "x-internal-secret: YOUR_INTERNAL_SECRET_VALUE"
```

Replace `<team>` with your actual team slug and `YOUR_INTERNAL_SECRET_VALUE` with the value.

You should see a JSON response like:

```json
{
  "ok": true,
  "written": ["recruit:settings:hiring_mode", "recruit:settings:summary_times", "recruit:settings:autonomy_level", "recruit:counter:candidate_id"],
  "skipped": [],
  "sharyn": { "status": "created", "placeholder": { "candidate_id": "#016", ... } },
  "counter_now": 16,
  "next_candidate_id": "#017"
}
```

**This endpoint is idempotent** — calling it again does nothing harmful; it just reports what's already set.

**How to know Step 8 worked:**
- Response shows `"ok": true`.
- `counter_now` is 16 and `next_candidate_id` is `#017`.
- Refresh the preview URL's `/hiring.html` — the Holding Patterns tab should now show `#016 Sharyn McKay` in the Expected lane.

---

## Step 9 — End-to-end test

**Why:** Prove that the full pipeline works before we go live for real candidates.

**Time:** 10 minutes + whatever Claude + SendGrid + Twilio need (target: total elapsed <60s).

1. Michael (or you, whichever is easier) composes a test email with:
   - **To:** `careers@lifestylehomeservice.com`
   - **Subject:** `Test application — Residential House Cleaner — Michael Test`
   - **Body:** A short "Hi, I'd like to apply, please see attached resume" message.
   - **Attachment:** A sample resume PDF (Michael's own resume is fine, or any test PDF with a fake candidate name — use a clearly fake name like "Test Applicant" so it's easy to find and delete later).
2. Send the email.
3. Within about 60 seconds:
   - A new candidate card appears in the **Applied** column of the hiring portal Kanban (refresh if needed).
   - The test applicant's phone (whatever phone number is in the resume) receives an SMS **from 778-200-6517** (Aria's number). If you used a real phone number on Michael's real resume, this will land on his actual phone — so use a fake phone number or accept that it'll text Michael.
   - The test applicant's email receives an intro email **from `LHS Careers <careers@lifestylehomeservice.com>`**.
4. On the Kanban card, verify:
   - The **score** renders as `NN/100 — prescreen triage — Aria (automated)`.
   - Click the card → drawer opens with summary.
5. Go to GitHub → `Mckaren67/lhs-knowledge-base` → branch `aria-phase1` → check the latest commit. You should see a commit titled something like `AriaRecruit: application_received #017 (Test Applicant)` with changes to:
   - `docs/projects/candidates/TEST_APPLICANT.md`
   - `data/candidates/017.json`
6. Delete the test candidate after verification:

```bash
# Delete Redis state only (keeps the git commit trail)
curl -X POST "https://<preview>/api/admin-delete" \
  -H "x-internal-secret: YOUR_INTERNAL_SECRET_VALUE" \
  -H "Content-Type: application/json" \
  -d '{"candidate_id": "#017"}'

# Or — delete Redis AND remove the MD/JSON files from the repo
curl -X POST "https://<preview>/api/admin-delete" \
  -H "x-internal-secret: YOUR_INTERNAL_SECRET_VALUE" \
  -H "Content-Type: application/json" \
  -d '{"candidate_id": "#017", "delete_git_files": true}'
```

The response tells you exactly what was deleted from Redis and, if requested, which git files were removed (with their commit SHAs).

**If Step 9 succeeds:** Phase 1 is cleared for review. Karen + Michael review the preview URL, then approve the aria-phase1 → main merge, then approve Phase 2 kickoff.

**If Step 9 partially succeeds (e.g., candidate appears but no SMS):** check Vercel → Functions → `intake-email` → Logs for the error. Common ones: missing Twilio credentials, Twilio account not verified for the test number (trial accounts only send to verified numbers), SendGrid not yet DNS-verified.

---

## Summary checklist

- [ ] Step 1 — `careers@` alias created
- [ ] Step 2 — SendGrid account confirmed + API key generated
- [ ] Step 3 — 8 Vercel env vars added (all three environments)
- [ ] Step 3a — `GITHUB_TOKEN` fine-grained PAT created with contents:write on `Mckaren67/lhs-knowledge-base`
- [ ] Step 4 — SendGrid Sender Authentication configured; 3 CNAMEs recorded
- [ ] Step 5 — SendGrid Inbound Parse configured; MX destination recorded
- [ ] Step 6 — DNS records added at Nexcess (7 rows); SendGrid shows green checkmarks
- [ ] Step 7 — Gmail forward configured; Indeed filter + careers@ filter created
- [ ] Step 8 — `/api/init-schema` called; counter at 16, Sharyn placeholder visible
- [ ] Step 9 — End-to-end test passes; candidate card, SMS, email, GitHub commit all verified

---

## Troubleshooting

**"DNS isn't verifying in SendGrid."**
Wait longer — some registrars take up to 24 hours. Check `dig s1._domainkey.lifestylehomeservice.com CNAME` from a terminal to see if it's resolving. If resolving but SendGrid still red, click "Verify" again in SendGrid.

**"Gmail verification email never arrives."**
The verification email is being processed by SendGrid Inbound Parse. Go to SendGrid → Activity → look at the most recent parse event → the email body has the verification code/link. Copy and paste into Gmail.

**"Twilio rejects my test number."**
Trial Twilio accounts only send to verified phone numbers. Either (a) upgrade the Twilio account, or (b) verify the test number in Twilio → Phone Numbers → Verified Caller IDs.

**"`/api/init-schema` returns 401 Unauthorized."**
Your `INTERNAL_SECRET` in the curl header doesn't match the Vercel env var. Double-check both (no trailing whitespace, exact value).

**"Candidate card appears but Option 2 score is missing."**
Claude extraction likely failed parse-to-JSON. Check Vercel logs for `/api/intake-email`. Look for `red_flags: ['parse_error_manual_review']` in the candidate record — that means Claude returned something that wasn't valid JSON.

**"GitHub commit from writeCandidate fails."**
`GITHUB_TOKEN` is missing, expired, or lacks `contents:write` on the right repo. The candidate will still appear in Redis (operational truth), and a `recruit:pending_git:{id}:{ts}` key will log the retry queue. Once the token is fixed, we can implement a retry sweep in Phase 5.

---

*End of Phase 1 infrastructure setup. Questions? Ask Claude Code — I'll debug with you step-by-step.*
