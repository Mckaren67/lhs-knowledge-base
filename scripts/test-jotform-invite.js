// scripts/test-jotform-invite.js
//
// Exercises shouldSendJotformInvite against the 5 cases Captain approved:
//   a) Applied + score 78 + no holding                → true
//   b) Applied + score 30 (below 45)                  → false
//   c) Hard Hold + score 90                           → false
//   d) JotForm already sent (comm_log has entry)      → false (idempotency)
//   e) Applied + score 45 boundary                    → true (inclusive)
//
// Run:  node scripts/test-jotform-invite.js

import {
  shouldSendJotformInvite,
  jotformInviteSkipReason
} from '../api/_lib/jotformInvite.js';

const CASES = [
  {
    label: '(a) Applied + score 78 + no holding',
    expected: true,
    candidate: {
      candidate_id: '#100',
      full_name: 'Alex Applied',
      status: 'Applied',
      rubric_type: 'prescreen_triage',
      score_value: 78,
      aria_meta: { holding_reason: null },
      communication_log: []
    }
  },
  {
    label: '(b) Applied + score 30 (below 45)',
    expected: false,
    candidate: {
      candidate_id: '#101',
      full_name: 'Beth Low',
      status: 'Applied',
      rubric_type: 'prescreen_triage',
      score_value: 30,
      aria_meta: { holding_reason: null },
      communication_log: []
    }
  },
  {
    label: '(c) Hard Hold + score 90',
    expected: false,
    candidate: {
      candidate_id: '#102',
      full_name: 'Cal Hold',
      status: 'hard_hold',
      rubric_type: 'prescreen_triage',
      score_value: 90,
      aria_meta: { holding_reason: 'outside service area' },
      communication_log: []
    }
  },
  {
    label: '(d) JotForm already sent (idempotency)',
    expected: false,
    candidate: {
      candidate_id: '#103',
      full_name: 'Dana Done',
      status: 'Applied',
      rubric_type: 'prescreen_triage',
      score_value: 72,
      aria_meta: { holding_reason: null },
      communication_log: [
        {
          timestamp: '2026-04-20T12:00:00-07:00',
          type: 'jotform_invite_sms',
          direction: 'out',
          channel: 'sms',
          status: 'sent'
        }
      ]
    }
  },
  {
    label: '(e) Applied + score 45 boundary (inclusive)',
    expected: true,
    candidate: {
      candidate_id: '#104',
      full_name: 'Edge Case',
      status: 'Applied',
      rubric_type: 'prescreen_triage',
      score_value: 45,
      aria_meta: { holding_reason: null },
      communication_log: []
    }
  }
];

function pad(s, n) { return String(s).padEnd(n); }

let allPassed = true;

console.log('═'.repeat(78));
console.log('  shouldSendJotformInvite — 5-case verification');
console.log('═'.repeat(78));
console.log('');

for (const c of CASES) {
  const result = shouldSendJotformInvite(c.candidate);
  const reason = jotformInviteSkipReason(c.candidate);
  const ok = result === c.expected;
  if (!ok) allPassed = false;

  console.log(`  ${pad(c.label, 56)}`);
  console.log(`    status            ${c.candidate.status}`);
  console.log(`    score_value       ${c.candidate.score_value}`);
  console.log(`    holding_reason    ${c.candidate.aria_meta.holding_reason || '—'}`);
  console.log(`    already_invited   ${c.candidate.communication_log.some(e => e.type?.startsWith('jotform_invite_'))}`);
  console.log(`    expected          ${c.expected}`);
  console.log(`    actual            ${result}`);
  console.log(`    skip_reason       ${reason || '—'}`);
  console.log(`    ${ok ? 'PASS' : 'FAIL'}`);
  console.log('');
}

console.log('═'.repeat(78));
console.log(allPassed ? '  ALL 5 CASES PASS ✓' : '  SOME CASES FAILED ✗');
console.log('═'.repeat(78));

process.exit(allPassed ? 0 : 1);
