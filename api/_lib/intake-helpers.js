// Pure helpers for /api/intake-email. No Redis / Anthropic / Vercel imports
// so they can be exercised from a local test script under scripts/.

export const IN_SERVICE_FSAS = new Set(['V2P', 'V2R', 'V4Z']);

export const EXPERIENCE_KEYWORDS = ['cleaning', 'service', 'hospitality', 'hotel', 'restaurant'];

export function firstNameFrom(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  return parts[0] || 'there';
}

export function fsaOf(postalCode) {
  return String(postalCode || '').replace(/\s+/g, '').toUpperCase().slice(0, 3);
}

// computeRoute — reads screener + postal fields out of the extraction result
// and decides what stage / holding lane the candidate belongs in.
//
// Precedence:
//   1. Out-of-service-area → hard_hold "outside service area" (+ auto-reply
//      unless inconsistency_flag fires, in which case human reviews first).
//   2. Travel willingness < 75% → hard_hold "travel willingness under 75%"
//      (no auto-reply; human decides).
//   3. Otherwise → stage "Applied" (years_experience < 1 is a scoring penalty,
//      not a knockout).
export function computeRoute(extracted) {
  const fsa = fsaOf(extracted.location_postal_code);
  const in_service_area = fsa.length === 3 && IN_SERVICE_FSAS.has(fsa);

  const claim = extracted.location_in_chilliwack_claim;
  const inconsistency_flag = claim === true && in_service_area === false;

  const travel = extracted.travel_willingness_pct;

  if (!in_service_area) {
    return {
      status: 'hard_hold',
      lane: 'hard_hold',
      holding_reason: 'outside service area',
      in_service_area,
      inconsistency_flag,
      fsa,
      send_location_auto_reply: !inconsistency_flag,
      skip_candidate_outreach: true
    };
  }

  if (travel != null && travel < 75) {
    return {
      status: 'hard_hold',
      lane: 'hard_hold',
      holding_reason: 'travel willingness under 75%',
      in_service_area,
      inconsistency_flag: false,
      fsa,
      send_location_auto_reply: false,
      skip_candidate_outreach: true
    };
  }

  return {
    status: 'Applied',
    lane: null,
    holding_reason: null,
    in_service_area,
    inconsistency_flag: false,
    fsa,
    send_location_auto_reply: false,
    skip_candidate_outreach: false
  };
}

// scoreBreakdown — 0–100 prescreen_triage score per dimension. Existing rules
// from Resume_Extraction_Implementation.md plus the 4 Indeed-screener additions.
export function scoreBreakdown(extracted) {
  const dims = [];
  let total = 50;

  dims.push({
    dimension_name: 'trainable_baseline',
    score: 50, denominator: 50,
    description: 'LHS hires trainable people; this is the default floor.'
  });

  if (extracted.pretrained_bonus) {
    total += 20;
    dims.push({
      dimension_name: 'prior_cleaning_experience',
      score: 20, denominator: 20,
      description: `${extracted.pretrained_type || 'unspecified'} · ${extracted.pretrained_years || 0} yr(s)`
    });
  } else {
    dims.push({
      dimension_name: 'prior_cleaning_experience',
      score: 0, denominator: 20,
      description: 'No prior cleaning experience — trainable baseline still applies.'
    });
  }

  const signals = extracted.transferable_signals || [];
  if (signals.length >= 3) {
    total += 15;
    dims.push({
      dimension_name: 'transferable_signals',
      score: 15, denominator: 15,
      description: signals.join(', ')
    });
  } else {
    dims.push({
      dimension_name: 'transferable_signals',
      score: 0, denominator: 15,
      description: signals.length ? `Only ${signals.length} signal(s): ${signals.join(', ')}` : 'No strong transferable signals detected.'
    });
  }

  const comm = extracted.communication_quality || 3;
  if (comm >= 4) {
    total += 10;
    dims.push({ dimension_name: 'communication_quality', score: 10, denominator: 10, description: `Rated ${comm}/5` });
  } else if (comm <= 2) {
    total -= 10;
    dims.push({ dimension_name: 'communication_quality', score: -10, denominator: 10, description: `Rated ${comm}/5 — weak` });
  } else {
    dims.push({ dimension_name: 'communication_quality', score: 0, denominator: 10, description: `Rated ${comm}/5` });
  }

  if (extracted.transportation_ok === true) {
    total += 10;
    dims.push({ dimension_name: 'transportation', score: 10, denominator: 10, description: 'Vehicle or transportation confirmed' });
  } else if (extracted.transportation_ok === false) {
    total -= 5;
    dims.push({ dimension_name: 'transportation', score: -5, denominator: 10, description: 'No transportation — soft knockout; confirm' });
  } else {
    dims.push({ dimension_name: 'transportation', score: 0, denominator: 10, description: 'Transportation unclear' });
  }

  const dist = extracted.distance_minutes_from_chilliwack;
  if (dist != null && dist < 30) {
    total += 5;
    dims.push({ dimension_name: 'proximity', score: 5, denominator: 5, description: `${dist} min from Chilliwack — local` });
  } else if (dist != null && dist > 45) {
    total -= 10;
    dims.push({ dimension_name: 'proximity', score: -10, denominator: 5, description: `${dist} min from Chilliwack — distant` });
  } else {
    dims.push({ dimension_name: 'proximity', score: 0, denominator: 5, description: dist != null ? `${dist} min from Chilliwack` : 'Distance unknown' });
  }

  const reds = extracted.red_flags || [];
  if (reds.length) {
    total -= 25;
    dims.push({ dimension_name: 'red_flags', score: -25, denominator: 0, description: reds.join(', ') });
  } else {
    dims.push({ dimension_name: 'red_flags', score: 0, denominator: 0, description: 'None detected' });
  }

  // --- Indeed-screener additions ----------------------------------------------

  if (extracted.experience_keyword_match === true) {
    total += 5;
    dims.push({
      dimension_name: 'experience_keyword_match',
      score: 5, denominator: 5,
      description: 'Resume/application mentions cleaning, service, hospitality, hotel, or restaurant.'
    });
  } else {
    dims.push({
      dimension_name: 'experience_keyword_match',
      score: 0, denominator: 5,
      description: 'No domain-keyword match in experience.'
    });
  }

  const yrs = extracted.years_experience;
  if (typeof yrs === 'number' && yrs >= 2) {
    total += 3;
    dims.push({
      dimension_name: 'years_experience_bonus',
      score: 3, denominator: 3,
      description: `${yrs} years of stated experience (≥2).`
    });
  } else if (typeof yrs === 'number' && yrs < 1) {
    total -= 10;
    dims.push({
      dimension_name: 'years_experience_bonus',
      score: -10, denominator: 3,
      description: `${yrs} years of stated experience (<1) — trainable but flagged.`
    });
  } else {
    dims.push({
      dimension_name: 'years_experience_bonus',
      score: 0, denominator: 3,
      description: typeof yrs === 'number' ? `${yrs} years of stated experience.` : 'Years of experience not reported.'
    });
  }

  if (extracted.travel_willingness_pct === 100) {
    total += 5;
    dims.push({
      dimension_name: 'travel_willingness',
      score: 5, denominator: 5,
      description: '100% travel willingness.'
    });
  } else {
    dims.push({
      dimension_name: 'travel_willingness',
      score: 0, denominator: 5,
      description: extracted.travel_willingness_pct != null
        ? `${extracted.travel_willingness_pct}% travel willingness.`
        : 'Travel willingness not reported.'
    });
  }

  const final = Math.max(0, Math.min(100, total));
  return { score: final, dimensions: dims };
}
