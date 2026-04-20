// writeCandidate — dual-write helper per v1.3 §2.4 / kickoff item 10.
//
// Writes a candidate record to three durable stores in order:
//   1. Redis recruit:candidate:{id}            (operational truth)
//   2. Redis recruit:stage:{status} (zadd)      (kanban placement)
//   3. Redis recruit:event:{id}:{timestamp}     (audit stream)
//   4. Git:  docs/projects/candidates/{NAME}.md (human audit trail)
//   5. Git:  data/candidates/{id}.json          (machine audit trail)
//
// Steps 4+5 land in a single atomic commit via the GitHub Git Data API.
// If the git commit fails, Redis has already absorbed the change and a
// recruit:pending_git:{id}:{ts} key is set for later retry. Redis is the
// operational truth; git is the durable audit trail.
//
// Required env vars:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN — via Redis.fromEnv
//   GITHUB_TOKEN          — fine-grained PAT with contents:write on Mckaren67/lhs-knowledge-base
//
// Optional env vars:
//   GITHUB_COMMIT_BRANCH  — overrides target branch (defaults to VERCEL_GIT_COMMIT_REF or 'main')
//   GITHUB_OWNER, GITHUB_REPO — overrides (defaults locked to Mckaren67/lhs-knowledge-base)

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Mckaren67';
const GITHUB_REPO  = process.env.GITHUB_REPO  || 'lhs-knowledge-base';
const GITHUB_API   = 'https://api.github.com';

function defaultBranch() {
  return process.env.GITHUB_COMMIT_BRANCH
      || process.env.VERCEL_GIT_COMMIT_REF
      || 'main';
}

const RUBRIC_HUMAN = {
  full_rubric:        'full rubric',
  phone_screen_only:  'phone screen only',
  expanded_screen:    'expanded screen',
  prescreen_triage:   'prescreen triage',
  partial_assessment: 'partial assessment'
};

export function formatScoreOption2(c) {
  if (c == null || c.score_value == null || c.score_denominator == null) return null;
  const rubric = RUBRIC_HUMAN[c.rubric_type] || c.rubric_type || 'unscored';
  const interviewer = c.interviewer_name || 'unknown';
  return `${c.score_value}/${c.score_denominator} — ${rubric} — ${interviewer}`;
}

export function filenameFromName(name) {
  return String(name || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'UNKNOWN';
}

export async function writeCandidate({ candidate, eventType = 'update', branch = defaultBranch() }) {
  if (!candidate || !candidate.candidate_id) {
    throw new Error('writeCandidate: candidate.candidate_id is required');
  }

  const id = candidate.candidate_id;
  const name = candidate.full_name || 'Unknown';
  const now = new Date();
  const ts = now.toISOString();
  const status = candidate.status || 'Applied';

  const enriched = { ...candidate, last_updated: ts };

  await redis.set(`recruit:candidate:${id}`, enriched);
  await redis.zadd(`recruit:stage:${status}`, { score: now.getTime(), member: id });

  const eventKey = `recruit:event:${id}:${now.getTime()}`;
  await redis.set(eventKey, {
    timestamp: ts,
    candidate_id: id,
    event_type: eventType,
    status,
    score_display: formatScoreOption2(enriched)
  });

  const mdPath   = `docs/projects/candidates/${filenameFromName(name)}.md`;
  const jsonPath = `data/candidates/${id.replace('#', '')}.json`;

  let gitResult;
  try {
    const commit = await commitFilesAtomic({
      branch,
      message: `AriaRecruit: ${eventType} ${id} (${name})`,
      files: [
        { path: mdPath,   content: renderCandidateMarkdown(enriched) },
        { path: jsonPath, content: JSON.stringify(enriched, null, 2) + '\n' }
      ]
    });
    gitResult = { status: 'committed', sha: commit.sha, branch };
  } catch (err) {
    await redis.set(`recruit:pending_git:${id}:${now.getTime()}`, {
      candidate_id: id,
      event_type: eventType,
      error: err.message,
      files: [mdPath, jsonPath],
      attempted_at: ts
    });
    gitResult = { status: 'pending', error: err.message };
  }

  return { ok: true, candidate_id: id, redis: 'written', git: gitResult };
}

function renderCandidateMarkdown(c) {
  const lines = [];
  lines.push(`# ${c.full_name || 'Unknown'}`);
  lines.push('');
  lines.push(`**Candidate ID:** ${c.candidate_id}`);
  if (c.status)           lines.push(`**Status:** ${c.status}`);
  const scoreLine = formatScoreOption2(c);
  if (scoreLine)          lines.push(`**Score:** ${scoreLine}`);
  if (c.source)           lines.push(`**Source:** ${c.source}`);
  if (c.phone)            lines.push(`**Phone:** ${c.phone}${c.phone_confirmed ? ' — confirmed' : ''}`);
  if (c.email)            lines.push(`**Email:** ${c.email}`);
  if (c.location_postal_code || c.location_city) {
    lines.push(`**Location:** ${[c.location_city, c.location_postal_code].filter(Boolean).join(' · ')}`);
  }
  if (c.availability_horizon)  lines.push(`**Availability:** ${c.availability_horizon}${c.availability_details ? ' — ' + c.availability_details : ''}`);
  if (c.earliest_start_date)   lines.push(`**Earliest start:** ${c.earliest_start_date}`);
  if (c.last_updated)          lines.push(`**Last updated:** ${c.last_updated}`);
  lines.push('');

  if (Array.isArray(c.per_dimension_scores) && c.per_dimension_scores.length) {
    lines.push('---');
    lines.push('');
    lines.push('## Scores');
    lines.push('');
    lines.push('| Dimension | Score | Notes |');
    lines.push('|---|---|---|');
    for (const d of c.per_dimension_scores) {
      const score = (d.score != null && d.denominator != null) ? `${d.score} / ${d.denominator}` : '—';
      lines.push(`| ${d.dimension_name || '—'} | ${score} | ${d.description || ''} |`);
    }
    lines.push('');
  }

  if (Array.isArray(c.key_findings) && c.key_findings.length) {
    lines.push('---');
    lines.push('');
    lines.push('## Key findings');
    lines.push('');
    for (const f of c.key_findings) lines.push(`- ${f}`);
    lines.push('');
  }

  if (Array.isArray(c.flags) && c.flags.length) {
    lines.push('---');
    lines.push('');
    lines.push('## Flags');
    lines.push('');
    for (const f of c.flags) {
      const sev = (f.severity || 'note').toUpperCase();
      lines.push(`- **${sev}** — ${f.description || f.id || ''}`);
    }
    lines.push('');
  }

  if (Array.isArray(c.communication_log) && c.communication_log.length) {
    lines.push('---');
    lines.push('');
    lines.push('## Communication log');
    lines.push('');
    lines.push('| Timestamp | Channel | Direction | Summary |');
    lines.push('|---|---|---|---|');
    for (const e of c.communication_log) {
      lines.push(`| ${e.timestamp || '—'} | ${e.channel || '—'} | ${e.direction || '—'} | ${(e.summary || '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  if (c.next_action) {
    lines.push('---');
    lines.push('');
    lines.push('## Next action');
    lines.push('');
    lines.push(c.next_action);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*Generated by AriaRecruit ${c.last_updated || ''}. See \`CANDIDATE_INDEX.md\` for pool context.*`);
  lines.push('');
  return lines.join('\n');
}

// --- GitHub Git Data API: atomic multi-file commit -----------------------------------

async function ghFetch(url, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var not set');
  const res = await fetch(`${GITHUB_API}${url}`, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AriaRecruit/1.0',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${init.method || 'GET'} ${url} → ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

async function commitFilesAtomic({ branch, message, files }) {
  const ref = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${branch}`);
  const parentSha = ref.object.sha;

  const parentCommit = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${parentSha}`);
  const baseTreeSha = parentCommit.tree.sha;

  const tree = files.map(f => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    content: f.content
  }));

  const newTree = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree })
  });

  const newCommit = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] })
  });

  await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha })
  });

  return newCommit;
}
