// /api/scheduler-scenarios.js
// CRUD for scheduling scenarios. Each scenario is a named snapshot of a draft schedule
// (e.g. "May 11 Plan A"). Stored in Upstash Redis under key prefix `scenario:`.
//
// GET    /api/scheduler-scenarios              → list all scenarios (name + meta only)
// GET    /api/scheduler-scenarios?name=Plan_A  → load one scenario in full
// POST   /api/scheduler-scenarios              → save/overwrite a scenario
//          body: { name, jobs, notes, weekStart }
// DELETE /api/scheduler-scenarios?name=Plan_A  → delete one scenario
//
// Note: scenario names must be URL-safe (letters, numbers, dashes, underscores).

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const KEY_PREFIX = 'scenario:';
const NAME_REGEX = /^[A-Za-z0-9_-]+$/;

function keyFor(name) {
  return `${KEY_PREFIX}${name}`;
}

export default async function handler(req, res) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  try {
    if (req.method === 'GET') {
      const { name } = req.query;
      if (name) {
        if (!NAME_REGEX.test(name)) {
          return res.status(400).json({ error: 'Invalid scenario name' });
        }
        const data = await redis.get(keyFor(name));
        if (!data) return res.status(404).json({ error: 'Scenario not found' });
        return res.status(200).json(data);
      }
      // List mode
      const keys = await redis.keys(`${KEY_PREFIX}*`);
      const scenarios = [];
      for (const k of keys) {
        const data = await redis.get(k);
        if (data && typeof data === 'object') {
          scenarios.push({
            name: k.replace(KEY_PREFIX, ''),
            weekStart: data.weekStart || null,
            savedAt: data.savedAt || null,
            jobCount: Array.isArray(data.jobs) ? data.jobs.length : 0,
            notes: data.notes || '',
          });
        }
      }
      scenarios.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      return res.status(200).json({ scenarios });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { name, jobs, weekStart, notes } = body;

      if (!name || !NAME_REGEX.test(name)) {
        return res.status(400).json({
          error: 'Missing or invalid name. Use letters, numbers, dashes, underscores only.',
        });
      }
      if (!Array.isArray(jobs)) {
        return res.status(400).json({ error: 'jobs must be an array' });
      }

      const record = {
        name,
        weekStart: weekStart || null,
        notes: notes || '',
        jobs,
        savedAt: new Date().toISOString(),
      };

      await redis.set(keyFor(name), record);
      return res.status(200).json({ success: true, scenario: record });
    }

    if (req.method === 'DELETE') {
      const { name } = req.query;
      if (!name || !NAME_REGEX.test(name)) {
        return res.status(400).json({ error: 'Missing or invalid name' });
      }
      const removed = await redis.del(keyFor(name));
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: 'Server error', message: error.message });
  }
}
