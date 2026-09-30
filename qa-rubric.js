/**
 * The TAC Ticket QA rubric — the ONE definition of it.
 *
 * The server validates and scores every review against this, and the browser
 * renders its form from GET /api/qa/rubric rather than carrying a second copy.
 * Two copies of a rubric drift, and a form that offered N/A where the server
 * refuses it (or the reverse) would fail in exactly the quiet way CLAUDE.md
 * keeps warning about.
 *
 * Source: TAC_Ticket_QA_Rubric.md, supplied by the business 24 Sep 2026.
 * If the rubric changes, bump RUBRIC_VERSION: every stored review records the
 * version it was scored under, so later reporting can tell old scores from new.
 */
const RUBRIC_VERSION = '2026-09-24';

// `na` is the N/A rule as written, or null where N/A is not allowed.
const CRITERIA = [
  { id: 1, section: 'Triage', name: 'Categorisation, priority & impact',
    na: 'A different agent categorised the ticket',
    meets: 'Category, priority and impact all correct for the real situation',
    partial: 'Minor misclassification, no effect on handling',
    miss: 'Wrong priority or impact that delayed response or hid an outage' },
  { id: 2, section: 'Triage', name: 'Reproduction evidence',
    na: null,
    meets: 'Specific examples captured (timestamps, from/to numbers, call IDs, device/model)',
    partial: 'Vague examples',
    miss: 'None requested or recorded' },
  { id: 3, section: 'Technical investigation', name: 'Logical isolation',
    na: 'The diagnosis was correct without troubleshooting',
    meets: 'Systematically narrows the fault domain: customer LAN/firewall vs platform vs carrier',
    partial: 'Partial isolation, skips steps',
    miss: 'No isolation, or escalated without narrowing' },
  { id: 4, section: 'Technical investigation', name: 'Technical accuracy',
    na: 'The diagnosis cannot be verified',
    meets: 'Diagnosis and statements correct',
    partial: 'Minor inaccuracies with no impact',
    miss: 'Incorrect diagnosis or wrong information given' },
  { id: 5, section: 'Internal documentation', name: 'Handover-ready notes',
    na: null,
    meets: "Another engineer could pick it up cold: what's known, what's been tried, next steps, and the reasoning behind the diagnosis (a one-line pattern match counts)",
    partial: 'Readable but missing steps, findings or reasoning',
    miss: 'Notes absent or unusable' },
  { id: 6, section: 'Internal documentation', name: 'Knowledge linkage',
    na: null,
    meets: 'Links the relevant KB/Confluence article, or flags a missing or outdated one',
    partial: 'Links something loosely relevant',
    miss: 'Nothing, when a relevant article exists' },
  { id: 7, section: 'Customer communication', name: 'Clarity & accuracy',
    na: null,
    meets: "Plain, correct, pitched to the customer's technical level",
    partial: 'Understandable but jargon-heavy or wordy',
    miss: 'Confusing or misleading' },
  { id: 8, section: 'Customer communication', name: 'Expectation setting',
    na: 'The ticket was closed on first touch',
    meets: 'Every update states the next action and when the next update will come, and those commitments are kept',
    partial: 'Next steps stated, no timeframe, or commitments occasionally missed',
    miss: 'Customer left not knowing what happens next' },
  { id: 9, section: 'Customer communication', name: 'Tone & ownership',
    na: null,
    meets: 'Professional, owns the issue, no blame-shifting',
    partial: 'Neutral or flat',
    miss: 'Dismissive or unprofessional' },
  { id: 10, section: 'Customer communication', name: 'Confidence',
    na: null,
    meets: "Communicates the diagnosis and plan with assurance; where something is still uncertain, frames the next step decisively (\"we'll confirm this with a trace\") rather than hedging",
    partial: 'Correct content, but tentative or over-qualified',
    miss: "Wishy-washy, visibly unsure, or undermines the customer's trust in the fix" },
  { id: 11, section: 'Process & closure', name: 'Escalation handling',
    na: 'Escalation was not required',
    meets: 'Right time, right party (vendor/carrier/L3), complete evidence pack',
    partial: 'Late, or thin pack',
    miss: "Should have escalated and didn't, or escalated with no evidence" },
  { id: 12, section: 'Process & closure', name: 'Closure quality',
    na: null,
    meets: 'Root cause or resolution stated, customer confirmation sought, correct closure code',
    partial: 'Resolved but closure note thin',
    miss: 'Closed without resolution or confirmation' },
];

const CRITICAL_FAILS = [
  "Security or privacy breach, such as sharing credentials or exposing another customer's data",
  'Wrong information or action that caused customer impact, such as a bad config change or a misrouted number',
  'A P1 or outage-indicating ticket not escalated or flagged',
  'Closing a ticket while the issue was knowingly unresolved',
];

const CRITERION_BY_ID = new Map(CRITERIA.map(c => [c.id, c]));

/**
 * score % = (sum of scores ÷ 2) ÷ number of applicable criteria × 100
 *
 * `scores` maps criterion id -> 0 | 1 | 2 | null, where null is N/A. Returns
 * null when nothing is applicable (rule 6: all N/A produces no score) — never
 * 0% and never NaN. Rounded to one decimal place for storage; the rubric's own
 * worked example (17 over 10 applicable) gives exactly 85.
 */
function computeScore(scores) {
  let sum = 0, applicable = 0;
  for (const c of CRITERIA) {
    const v = scores[c.id];
    if (v === null || v === undefined) continue;
    sum += v; applicable++;
  }
  if (!applicable) return { pct: null, applicable: 0, sum: 0 };
  return { pct: Math.round((sum / 2) / applicable * 1000) / 10, applicable, sum };
}

module.exports = { RUBRIC_VERSION, CRITERIA, CRITICAL_FAILS, CRITERION_BY_ID, computeScore };
