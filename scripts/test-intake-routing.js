// scripts/test-intake-routing.js
//
// Exercises the pure intake helpers against the 4 scenarios Captain approved:
//   a) V2R + 100% travel + 3 yrs cleaning      → Applied, score ~85
//   b) V2S + 100% travel + 5 yrs cleaning      → Hard Hold "outside service area" + auto-reply
//   c) V2R + 50% travel + 2 yrs                → Hard Hold "travel willingness under 75%"
//   d) V3A + claimed "yes in Chilliwack"       → Hard Hold + inconsistency + red alert
//
// Run:  node scripts/test-intake-routing.js

import { computeRoute, scoreBreakdown } from '../api/_lib/intake-helpers.js';

const CASES = [
  {
    label: '(a) V2R + 100% travel + 3 yrs cleaning',
    expected_status: 'Applied',
    expected_send_auto_reply: false,
    expected_inconsistency: false,
    expected_score_range: [80, 100],
    extracted: {
      full_name: 'Alex Test',
      email: 'alex@test.com',
      phone: '+16045550101',
      location_city: 'Chilliwack',
      location_postal_code: 'V2R 1A1',
      pretrained_bonus: false,
      pretrained_type: 'none',
      pretrained_years: 0,
      transferable_signals: ['customer_facing', 'reliability'],
      red_flags: [],
      communication_quality: 4,
      transportation_ok: true,
      distance_minutes_from_chilliwack: 15,
      years_experience: 3,
      interview_availability: 'weekday mornings',
      location_in_chilliwack_claim: true,
      travel_willingness_pct: 100,
      experience_keyword_match: true
    }
  },
  {
    label: '(b) V2S + 100% travel + 5 yrs cleaning',
    expected_status: 'hard_hold',
    expected_holding_reason: 'outside service area',
    expected_send_auto_reply: true,
    expected_inconsistency: false,
    extracted: {
      full_name: 'Bart Test',
      email: 'bart@test.com',
      phone: '+16045550202',
      location_city: 'Abbotsford',
      location_postal_code: 'V2S 3K2',
      pretrained_bonus: true,
      pretrained_type: 'residential',
      pretrained_years: 5,
      transferable_signals: ['detail_oriented', 'customer_facing', 'reliability'],
      red_flags: [],
      communication_quality: 4,
      transportation_ok: true,
      distance_minutes_from_chilliwack: 35,
      years_experience: 5,
      interview_availability: 'afternoons',
      location_in_chilliwack_claim: false,
      travel_willingness_pct: 100,
      experience_keyword_match: true
    }
  },
  {
    label: '(c) V2R + 50% travel + 2 yrs',
    expected_status: 'hard_hold',
    expected_holding_reason: 'travel willingness under 75%',
    expected_send_auto_reply: false,
    expected_inconsistency: false,
    extracted: {
      full_name: 'Cass Test',
      email: 'cass@test.com',
      phone: '+16045550303',
      location_city: 'Chilliwack',
      location_postal_code: 'V2R 5A3',
      pretrained_bonus: false,
      pretrained_type: 'none',
      pretrained_years: 0,
      transferable_signals: ['customer_facing'],
      red_flags: [],
      communication_quality: 3,
      transportation_ok: true,
      distance_minutes_from_chilliwack: 18,
      years_experience: 2,
      interview_availability: 'weekends',
      location_in_chilliwack_claim: true,
      travel_willingness_pct: 50,
      experience_keyword_match: false
    }
  },
  {
    label: '(d) V3A + claimed "yes in Chilliwack"',
    expected_status: 'hard_hold',
    expected_holding_reason: 'outside service area',
    expected_send_auto_reply: false,
    expected_inconsistency: true,
    extracted: {
      full_name: 'Dee Test',
      email: 'dee@test.com',
      phone: '+16045550404',
      location_city: 'Chilliwack (claimed)',
      location_postal_code: 'V3A 8K8',
      pretrained_bonus: false,
      pretrained_type: 'none',
      pretrained_years: 0,
      transferable_signals: ['customer_facing', 'reliability'],
      red_flags: [],
      communication_quality: 4,
      transportation_ok: true,
      distance_minutes_from_chilliwack: null,
      years_experience: 4,
      interview_availability: 'any time',
      location_in_chilliwack_claim: true,
      travel_willingness_pct: 100,
      experience_keyword_match: true
    }
  }
];

function pad(s, n) { return String(s).padEnd(n); }
function yn(b) { return b === true ? 'YES' : b === false ? 'no' : '—'; }
function checkMark(ok) { return ok ? 'PASS' : 'FAIL'; }

let allPassed = true;

for (const c of CASES) {
  const route = computeRoute(c.extracted);
  const score = scoreBreakdown(c.extracted);

  console.log('─'.repeat(78));
  console.log(c.label);
  console.log('─'.repeat(78));

  console.log('  Input:');
  console.log(`    postal_code                  ${c.extracted.location_postal_code}`);
  console.log(`    location_in_chilliwack_claim ${yn(c.extracted.location_in_chilliwack_claim)}`);
  console.log(`    travel_willingness_pct       ${c.extracted.travel_willingness_pct}%`);
  console.log(`    years_experience             ${c.extracted.years_experience}`);
  console.log(`    experience_keyword_match     ${yn(c.extracted.experience_keyword_match)}`);
  console.log(`    pretrained_bonus             ${yn(c.extracted.pretrained_bonus)}`);

  console.log('  Route:');
  console.log(`    status                       ${route.status}`);
  console.log(`    lane                         ${route.lane || '—'}`);
  console.log(`    holding_reason               ${route.holding_reason || '—'}`);
  console.log(`    in_service_area              ${yn(route.in_service_area)}`);
  console.log(`    inconsistency_flag           ${yn(route.inconsistency_flag)}`);
  console.log(`    send_location_auto_reply     ${yn(route.send_location_auto_reply)}`);
  console.log(`    fsa                          ${route.fsa}`);

  console.log(`  Score: ${score.score}/100`);
  for (const d of score.dimensions) {
    const sign = d.score > 0 ? '+' : d.score < 0 ? '' : ' ';
    console.log(`    ${pad(d.dimension_name, 28)} ${sign}${pad(d.score, 4)}   ${d.description}`);
  }

  // Assertions
  const checks = [];
  checks.push(['status', route.status === c.expected_status]);
  if (c.expected_holding_reason !== undefined) {
    checks.push(['holding_reason', route.holding_reason === c.expected_holding_reason]);
  }
  checks.push(['send_auto_reply', route.send_location_auto_reply === c.expected_send_auto_reply]);
  checks.push(['inconsistency_flag', route.inconsistency_flag === c.expected_inconsistency]);
  if (c.expected_score_range) {
    const [lo, hi] = c.expected_score_range;
    checks.push([`score in [${lo},${hi}]`, score.score >= lo && score.score <= hi]);
  }

  console.log('  Expectations:');
  for (const [name, ok] of checks) {
    if (!ok) allPassed = false;
    console.log(`    ${pad(name, 28)} ${checkMark(ok)}`);
  }
  console.log('');
}

console.log('═'.repeat(78));
console.log(allPassed ? '  ALL 4 CASES PASS ✓' : '  SOME CASES FAILED ✗');
console.log('═'.repeat(78));

process.exit(allPassed ? 0 : 1);
