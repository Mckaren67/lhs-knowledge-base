// /api/admin-delete — test-cleanup endpoint.
//
// Removes all Redis keys associated with a given candidate_id. Use for
// Phase 1 end-to-end test cleanup or, later, for hard-deletes that
// shouldn't leave an audit artifact.
//
// Optionally deletes the candidate's MD + JSON files from the repo via the
// GitHub API (`delete_git_files: true`). If false/omitted, the MD/JSON stay
// in git (recommended when you want the historical commit trail).
//
// INTERNAL_SECRET gated.

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

function filenameFromName(name) {
  return String(name || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'UNKNOWN';
}

async function scanDelete(pattern) {
  let cursor = 0;
  const deleted = [];
  do {
    const [next, keys] = await redis.scan(cursor, { match: pattern, count: 200 });
    cursor = Number(next);
    if (keys && keys.length) {
      await redis.del(...keys);
      deleted.push(...keys);
    }
  } while (cursor !== 0);
  return deleted;
}

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
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`GitHub ${init.method || 'GET'} ${url} → ${res.status}: ${body.slice(0, 400)}`);
  }
  return { status: res.status, body: res.ok ? await res.json() : null };
}

async function deleteRepoFile(path, branch, message) {
  const meta = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${branch}`);
  if (meta.status === 404 || !meta.body) return { path, status: 'not_found' };
  const sha = meta.body.sha;
  const del = await ghFetch(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch })
  });
  return { path, status: 'deleted', commit_sha: del.body?.commit?.sha || null };
}

const STAGE_KEYS = [
  'Applied', 'Screener', 'JotForm', 'Cleaning simulator',
  'Phone screen', 'Trial', 'Offer', 'Hired/Declined'
];
const HOLDING_KEYS = [
  'hard_hold', 'conditional_hold', 'pending_return',
  'waiting_employer', 'reassigned', 'expected'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const provided =
    req.headers['x-internal-secret'] ||
    (req.body && typeof req.body === 'object' ? req.body.secret : null);
  if (!process.env.INTERNAL_SECRET || provided !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { candidate_id, delete_git_files = false, branch = defaultBranch() } = req.body || {};
  if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });

  const record = (await redis.get(`recruit:candidate:${candidate_id}`))
              || (await redis.get(`recruit:placeholder:${candidate_id}`));
  const name = record?.full_name || 'Unknown';

  const directKeys = [
    `recruit:candidate:${candidate_id}`,
    `recruit:placeholder:${candidate_id}`,
    `recruit:email_thread:${candidate_id}`,
    `recruit:dependency:${candidate_id}`
  ];
  for (const k of directKeys) await redis.del(k);

  for (const stage of STAGE_KEYS)   await redis.zrem(`recruit:stage:${stage}`, candidate_id);
  for (const lane of HOLDING_KEYS)  await redis.zrem(`recruit:holding:${lane}`, candidate_id);

  const scannedPatterns = [
    `recruit:event:${candidate_id}:*`,
    `recruit:transcript:${candidate_id}:*`,
    `recruit:pending_git:${candidate_id}:*`
  ];
  const scanned = {};
  for (const p of scannedPatterns) scanned[p] = await scanDelete(p);

  let git = { skipped: true };
  if (delete_git_files) {
    if (!process.env.GITHUB_TOKEN) {
      git = { skipped: true, reason: 'GITHUB_TOKEN not set' };
    } else {
      try {
        const numericId = String(candidate_id).replace('#', '');
        const mdResult   = await deleteRepoFile(`docs/projects/candidates/${filenameFromName(name)}.md`, branch, `AriaRecruit: admin-delete ${candidate_id} (${name})`);
        const jsonResult = await deleteRepoFile(`data/candidates/${numericId}.json`, branch, `AriaRecruit: admin-delete ${candidate_id} (${name})`);
        git = { md: mdResult, json: jsonResult };
      } catch (err) {
        git = { error: err.message };
      }
    }
  }

  return res.status(200).json({
    ok: true,
    candidate_id,
    full_name: name,
    redis: {
      direct_keys_deleted: directKeys,
      stage_zrems: STAGE_KEYS.length,
      holding_zrems: HOLDING_KEYS.length,
      scanned
    },
    git
  });
}
