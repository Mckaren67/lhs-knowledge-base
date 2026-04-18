# /data — Local JSON snapshots (Redis stand-in)

This folder holds JSON snapshots of dashboard / Aria state. Each file is one Redis key written verbatim to disk.

## Convention

- **Filename = Redis key.** Example: `data/aria_session_april17_2026_friday.json` ↔ Redis key `aria_session_april17_2026_friday`.
- **One JSON object per file.** Top-level should be the value you'd `SET` into Redis.
- **Date / day-of-week explicit.** Always include `dayOfWeek` and ISO `date` fields to prevent the Saturday/Friday class of bugs.

## Sync to Redis

```bash
# Upstash REST example — set one key from a file
curl -X POST "$UPSTASH_REDIS_URL/set/aria_session_april17_2026_friday" \
  -H "Authorization: Bearer $UPSTASH_REDIS_TOKEN" \
  --data-binary @data/aria_session_april17_2026_friday.json
```

```bash
# Vercel KV REST example
curl -X POST "$KV_REST_API_URL/set/aria_session_april17_2026_friday" \
  -H "Authorization: Bearer $KV_REST_API_TOKEN" \
  --data-binary @data/aria_session_april17_2026_friday.json
```

## Files in this folder

- `aria_session_april17_2026_friday.json` — corrected session state for Friday April 17 2026 (also mirrored at `docs/aria_session_april17_2026_friday.json`)
- `bridge_state_friday_april17_2026.json` — snapshot of dashboard runtime state (candidates, alerts, comm logs) for restore / debug

## When to write a new snapshot

- After any correction pass (date fix, candidate decision, role fill)
- End of day, automatically (planned)
- Before a destructive operation (e.g., bulk decline)
