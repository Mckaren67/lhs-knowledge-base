// /api/scheduler-current.js
// Read-only endpoint that returns the currently APPROVED schedule.
// This is what Aria (the SMS/voice layer) queries to answer "what's Tuesday look like?"
//
// The approved schedule is stored in Redis under the key `approved-schedule`.
// It points to a scenario name (e.g. "May11_PlanA"). This endpoint reads that
// pointer, then loads the full scenario data.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const APPROVED_KEY = 'approved-schedule';
const SCENARIO_PREFIX = 'scenario:';

export default async function handler(req, res) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  try {
    if (req.method === 'GET') {
      // Return the currently approved schedule
      const pointer = await redis.get(APPROVED_KEY);
      if (!pointer || !pointer.scenarioName) {
        return res.status(200).json({
          approved: false,
          message: 'No schedule has been approved yet.',
        });
      }

      const scenarioKey = `${SCENARIO_PREFIX}${pointer.scenarioName}`;
      const scenario = await redis.get(scenarioKey);
      if (!scenario) {
        return res.status(200).json({
          approved: false,
          message: `Pointer references scenario "${pointer.scenarioName}" but it no longer exists.`,
          pointer,
        });
      }

      return res.status(200).json({
        approved: true,
        approvedAt: pointer.approvedAt,
        approvedBy: pointer.approvedBy || 'Karen',
        scenario,
      });
    }

    if (req.method === 'POST') {
      // Approve a scenario (mark it as the current one)
      const { scenarioName, approvedBy } = req.body || {};
      if (!scenarioName) {
        return res.status(400).json({ error: 'Missing scenarioName' });
      }

      // Verify scenario exists
      const scenarioKey = `${SCENARIO_PREFIX}${scenarioName}`;
      const scenario = await redis.get(scenarioKey);
      if (!scenario) {
        return res.status(404).json({ error: 'Scenario not found' });
      }

      const pointer = {
        scenarioName,
        approvedBy: approvedBy || 'Karen',
        approvedAt: new Date().toISOString(),
      };
      await redis.set(APPROVED_KEY, pointer);

      return res.status(200).json({ success: true, pointer });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: 'Server error', message: error.message });
  }
}
