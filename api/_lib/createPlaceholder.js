// createPlaceholder — expected-candidate placeholder pattern per v1.3 §14.1.
//
// Atomically increments recruit:counter:candidate_id, formats the new id
// as #NNN, and writes a light placeholder record at recruit:placeholder:{id}.
// The ID is never reused — the counter is monotonic. If the placeholder
// deadline passes without a matching application, the placeholder moves
// to status "never_materialized" but the ID stays reserved.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export function formatId(n) {
  return '#' + String(n).padStart(3, '0');
}

export async function createPlaceholder({
  name,
  source = 'expected',
  expected_date,
  notes = '',
  expected_by_deadline_days = 14
}) {
  if (!name) throw new Error('createPlaceholder: name is required');

  const nextN = await redis.incr('recruit:counter:candidate_id');
  const candidate_id = formatId(nextN);

  const now = new Date();
  const deadlineDate = new Date(now.getTime() + expected_by_deadline_days * 24 * 60 * 60 * 1000);

  const record = {
    candidate_id,
    full_name: name,
    source,
    expected_date: expected_date || now.toISOString().slice(0, 10),
    notes,
    expected_by_deadline: deadlineDate.toISOString().slice(0, 10),
    status: 'expected',
    created_at: now.toISOString(),
    kind: 'placeholder'
  };

  await redis.set(`recruit:placeholder:${candidate_id}`, record);
  await redis.zadd('recruit:holding:expected', { score: now.getTime(), member: candidate_id });

  return record;
}

// Find a placeholder by fuzzy name match. Used by /api/intake-email when
// a new application arrives — if the applicant's name matches a placeholder,
// we merge (preserve the reserved ID) rather than creating a new record.
export async function findPlaceholderByName(name) {
  if (!name) return null;
  const ids = await redis.zrange('recruit:holding:expected', 0, -1);
  const normalized = normalizeName(name);
  for (const id of ids) {
    const rec = await redis.get(`recruit:placeholder:${id}`);
    if (rec && normalizeName(rec.full_name) === normalized) return rec;
  }
  return null;
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
