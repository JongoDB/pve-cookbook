/**
 * Small subsequence scorer: every query character must appear in order.
 * Rewards prefix and consecutive matches. Returns -1 when there is no match.
 */
export function score(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 300 - idx - t.length / 10;
  let ti = 0, s = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    s += 5 + run * 3 - Math.min(found - ti, 5);
    ti = found + 1;
  }
  return s;
}

export function rank<T>(query: string, items: T[], text: (t: T) => string, limit = 8): T[] {
  return items
    .map((it) => ({ it, s: score(query, text(it)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.it);
}
