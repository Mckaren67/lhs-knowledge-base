// Pure helper — decides whether a candidate should receive the JotForm invite.
//
// Called by both /api/send-jotform-invite (the single-candidate endpoint) and
// /api/send-jotform-invite-sweep (the 2-minute cron). No Redis/network imports
// so test scripts can load this module directly.

export const JOTFORM_INVITE_LOG_TYPES = new Set([
  'jotform_invite_sms',
  'jotform_invite_email'
]);

export const MIN_SCORE_FOR_JOTFORM_INVITE = 45;

// Spec §1. Returns true iff the candidate should be invited now.
export function shouldSendJotformInvite(candidate) {
  if (!candidate) return false;
  if (candidate.status !== 'Applied') return false;
  if (candidate.rubric_type !== 'prescreen_triage') return false;
  if (typeof candidate.score_value !== 'number' || candidate.score_value < MIN_SCORE_FOR_JOTFORM_INVITE) return false;
  if (candidate.aria_meta?.holding_reason) return false;
  if (alreadyInvited(candidate)) return false;
  return true;
}

// Observability companion — returns the first failing condition or null.
// Not part of the public boolean contract; used by the sweep's log output.
export function jotformInviteSkipReason(candidate) {
  if (!candidate) return 'no_candidate';
  if (candidate.status !== 'Applied') return `wrong_status:${candidate.status}`;
  if (candidate.rubric_type !== 'prescreen_triage') return `wrong_rubric:${candidate.rubric_type}`;
  if (typeof candidate.score_value !== 'number') return 'score_missing';
  if (candidate.score_value < MIN_SCORE_FOR_JOTFORM_INVITE) return `score_below_${MIN_SCORE_FOR_JOTFORM_INVITE}`;
  if (candidate.aria_meta?.holding_reason) return `holding:${candidate.aria_meta.holding_reason}`;
  if (alreadyInvited(candidate)) return 'already_invited';
  return null;
}

function alreadyInvited(candidate) {
  const log = candidate.communication_log;
  if (!Array.isArray(log)) return false;
  return log.some(entry => entry && JOTFORM_INVITE_LOG_TYPES.has(entry.type));
}
