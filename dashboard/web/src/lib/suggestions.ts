// Suggested replies: the assistant ends each answer with
//   <suggestions>
//   - First follow-up
//   - Second follow-up
//   </suggestions>
// The block is never shown as text; its items become buttons under the last answer.
// Also the starter questions shown in an empty conversation, by page.

export const MAX_SUGGESTIONS = 4;
export const MAX_SUGGESTION_CHARS = 120;

const OPEN = '<suggestions';
const OPEN_RE = /<suggestions\b/i;
const CLOSE_RE = /<\/suggestions\s*>/i;

export interface SplitReply {
  /** the answer without the suggestions block (or a partial opening tag while streaming) */
  text: string;
  /** follow-ups, at most MAX_SUGGESTIONS, each at most MAX_SUGGESTION_CHARS */
  suggestions: string[];
}

/**
 * Split an answer's text into what to show and its suggested replies. While `streaming`, a
 * partial opening tag at the very end (`<`, `<sugg`) is hidden too, so the raw tag never flashes.
 * Tolerates a missing closing tag, extra whitespace, and `-`, `*`, `•` or `1.` bullets.
 */
export function splitSuggestions(raw: string, streaming = false): SplitReply {
  const m = OPEN_RE.exec(raw);
  if (!m) {
    if (streaming) {
      const lt = raw.lastIndexOf('<');
      if (lt >= 0 && OPEN.startsWith(raw.slice(lt).toLowerCase())) return { text: raw.slice(0, lt).trimEnd(), suggestions: [] };
    }
    return { text: raw, suggestions: [] };
  }
  const text = raw.slice(0, m.index).trimEnd();
  let block = raw.slice(m.index + m[0].length);
  const gt = block.indexOf('>');
  // "<suggestions" with no ">" yet: nothing to read
  if (gt < 0 || block.slice(0, gt).includes('\n')) return { text, suggestions: [] };
  block = block.slice(gt + 1);
  const close = CLOSE_RE.exec(block);
  if (close) block = block.slice(0, close.index);
  else if (streaming) {
    // the last line may still be arriving
    const nl = block.lastIndexOf('\n');
    block = nl >= 0 ? block.slice(0, nl) : '';
  }
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const line of block.split('\n')) {
    const item = line.trim().replace(/^(?:[-*•]|\d+[.)])(?:\s+|$)/, '').replace(/^["“](.*)["”]$/, '$1').trim();
    if (!item || item.startsWith('<') || item.length > MAX_SUGGESTION_CHARS) continue;
    const k = item.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    suggestions.push(item);
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return { text, suggestions };
}

/** Starter questions for an empty conversation, for the page the user is on. */
export function startersFor(pathname: string, guestName?: string): string[] {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return ['What needs my attention?', 'Which guests use the most CPU?', 'What failed in the last day?'];
  if (/^\/guests\/[^/]+\/\d+$/.test(p)) {
    const g = guestName || 'this guest';
    return [`Why is ${g} slow?`, `Snapshot ${g}`, `How do I add a disk to ${g}?`];
  }
  if (p.startsWith('/hardware')) return ['Which GPUs can I pass through?', 'How do PCI mappings work?'];
  if (p.startsWith('/protection')) return ["Which guests aren't backed up?", 'When did the last backups run?'];
  if (p.startsWith('/create')) return ['Help me create an LLM server', 'Which node has room for a new VM?'];
  return ['What needs my attention?', 'How do changes work?'];
}
