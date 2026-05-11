# Housecall Pro Integration — Technical Notes

How the scheduler connects to HCP. For future Claude instances and human devs.

---

## Architecture

```
HCP API ↔ lhs-scheduler-proxy (Vercel) ↔ scratchpad (Vercel + Claude) ↔ User
```

- **HCP** is the system of record for schedules, customers, employees.
- **The proxy** (lhs-scheduler-proxy.vercel.app) holds the HCP API key server-side, exposes a CORS-friendly endpoint.
- **The scratchpad** (lhs-knowledge-base.vercel.app/scheduler.html — to be built) pulls from the proxy, renders the calendar, lets Karen edit.

---

## The Proxy

### Repository
- GitHub: `Mckaren67/lhs-scheduler-proxy`
- Vercel project: `lhs-scheduler-proxy`
- Public URL: `https://lhs-scheduler-proxy.vercel.app`

### Environment variables
- `HCP_API_KEY` — set in Production, Preview, Development on Vercel
- Status: Confirmed working as of May 10, 2026

### Endpoint pattern
```
GET https://lhs-scheduler-proxy.vercel.app/api/proxy?endpoint={encoded_HCP_path}
```

### Example: pull jobs for May 11–17
```
curl -s "https://lhs-scheduler-proxy.vercel.app/api/proxy?endpoint=jobs%3Fpage_size%3D200%26scheduled_start_min%3D2026-05-11T00%3A00%3A00Z%26scheduled_start_max%3D2026-05-18T00%3A00%3A00Z" > ~/Downloads/hcp_week.json
```

### Important: HCP returns ALL jobs (incl. canceled/deleted)
- Filter by `job_status == 'scheduled'` for active jobs only.
- The `canceled_at` field may have stale timestamps from years ago — trust `job_status`, not the timestamp.

### Trainee placeholder detection
- Jobs assigned to "Karen M" with a job tag containing "Heidi DeGrow", "Rhythm Sidhu", or "Ladda Bouttavong" mean the tagged person is the real worker.
- Replace "Karen M" with the tagged person in any conflict analysis.

---

## Commit Endpoint (lhs-knowledge-base)

### Location
`https://lhs-knowledge-base.vercel.app/api/commit-file`

### Auth
- POST only
- Header: `x-claude-secret: LHS-Claude-7f3a9c2b8e4d5f1a-NumberOne-Write-2026`
- Server-side uses `GITHUB_PAT` env var to commit to repo.

### Payload
```json
{
  "path": "data/some-file.md",
  "content": "file content as string",
  "message": "commit message"
}
```

### Returns
Success: `{"success": true, "action": "created"|"updated", "commit_url": "..."}`
Failure: `{"error": "...", "details": "..."}`

---

## Vercel Routing (lhs-knowledge-base/vercel.json)

```json
{
  "rewrites": [
    { "source": "/data/(.*)", "destination": "/data/$1" },
    { "source": "/((?!api/|data/).*)", "destination": "/public/$1" }
  ]
}
```

Files in `public/` serve at root. Files in `data/` serve at `/data/`.

---

## Writing Back to HCP (Future)

When we eventually wire up writes:
- Use the proxy with POST/PATCH/PUT.
- Batch all changes into one operation per approval session.
- HCP will auto-notify clients on each change — keep batches tight.
- Build a "dry run" preview before committing.
