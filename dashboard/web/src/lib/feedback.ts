// Send feedback: a pre-filled GitHub "new issue" link. galley sends nothing itself; the user
// reviews the text on GitHub and submits it from their own account.

export type FeedbackKind = 'bug' | 'idea' | 'question';

export const FEEDBACK_KINDS: { id: FeedbackKind; label: string; ghLabel: string; heading: string }[] = [
  { id: 'bug', label: 'Bug', ghLabel: 'bug', heading: 'What happened' },
  { id: 'idea', label: 'Idea', ghLabel: 'enhancement', heading: "What you'd like" },
  { id: 'question', label: 'Question', ghLabel: 'question', heading: 'Your question' },
];

export interface FeedbackDetails { version: string; path: string; userAgent: string }

export interface FeedbackDraft {
  kind: FeedbackKind;
  title: string;
  text: string;
  /** galley version, page path and browser; omitted when the user unticks the box */
  details?: FeedbackDetails;
}

/** Longest URL we hand to the browser; GitHub rejects much longer ones. */
export const MAX_URL = 7000;
const TRUNCATED = '\n\n_(Shortened to fit in a link. Add the rest on GitHub.)_';

export function issueBody(d: FeedbackDraft, text = d.text): string {
  const k = FEEDBACK_KINDS.find((x) => x.id === d.kind) ?? FEEDBACK_KINDS[0];
  const parts = [`### ${k.heading}\n${text.trim() || '_No description._'}`];
  if (d.details) {
    parts.push(`### Details\n- galley ${d.details.version || 'unknown'}\n- page: ${d.details.path}\n- browser: ${d.details.userAgent}`);
  }
  parts.push("_Sent from galley's feedback dialog._");
  return parts.join('\n\n');
}

function url(repo: string, title: string, body: string, label: string) {
  return `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body, labels: label }).toString()}`;
}

/**
 * The new-issue URL for a draft, at most MAX_URL characters: a long description is cut, with a
 * note that it was shortened. `truncated` says whether that happened.
 */
export function issueUrl(repo: string, d: FeedbackDraft): { url: string; truncated: boolean } {
  const k = FEEDBACK_KINDS.find((x) => x.id === d.kind) ?? FEEDBACK_KINDS[0];
  const title = d.title.trim().slice(0, 200);
  const full = url(repo, title, issueBody(d), k.ghLabel);
  if (full.length <= MAX_URL) return { url: full, truncated: false };
  // Binary search for the longest prefix of the description that fits.
  const text = d.text.trim();
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (url(repo, title, issueBody(d, text.slice(0, mid) + TRUNCATED), k.ghLabel).length <= MAX_URL) lo = mid;
    else hi = mid - 1;
  }
  return { url: url(repo, title, issueBody(d, text.slice(0, lo).trimEnd() + TRUNCATED), k.ghLabel), truncated: true };
}
