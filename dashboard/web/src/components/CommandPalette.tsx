import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Guest } from '../api/types';
import { ACTION_LABEL } from '../lib/actions';
import { parseCommand } from '../lib/commands';
import { rank } from '../lib/fuzzy';
import { errMsg, useApp } from '../state/app';
import { PAGES } from './Layout';

interface Item { key: string; label: string; hint: string; run: () => void }

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { api, fleet, openPlan, clusterName } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [guests, setGuests] = useState<Guest[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    input.current?.focus();
    let alive = true;
    api.guests().then((g) => alive && setGuests(g)).catch((e) => alive && setLoadErr(errMsg(e)));
    return () => {
      alive = false;
      (restoreFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [api]);

  const nodesByCluster = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const c of fleet?.clusters ?? []) m[c.id] = c.nodes.map((n) => n.name);
    return m;
  }, [fleet]);

  const parsed = useMemo(() => parseCommand(q, guests, nodesByCluster), [q, guests, nodesByCluster]);

  const items: Item[] = useMemo(() => {
    const go = (to: string) => () => { nav(to); onClose(); };
    if (parsed.kind === 'command') {
      const g = parsed.guest;
      return [{
        key: 'cmd',
        label: `${ACTION_LABEL[parsed.action]} ${g.name} (${g.vmid})${parsed.params.target ? ` → ${parsed.params.target}` : ''}`,
        hint: `${clusterName(g.clusterId)} · plan`,
        run: () => {
          void openPlan({
            action: parsed.action,
            clusterId: g.clusterId,
            params: { targets: [{ vmid: g.vmid, node: g.node, type: g.type }], ...parsed.params },
          });
          onClose();
        },
      }];
    }
    if (!q.trim()) {
      return PAGES.filter((p) => p.mvp).map((p) => ({ key: `p:${p.to}`, label: p.label, hint: 'page', run: go(p.to) }));
    }
    const pageItems = rank(q, PAGES.filter((p) => p.mvp), (p) => p.label, 3)
      .map((p) => ({ key: `p:${p.to}`, label: p.label, hint: 'page', run: go(p.to) }));
    const guestItems = rank(q, guests.filter((g) => !g.template), (g) => `${g.name} ${g.vmid}`, 6)
      .map((g) => ({
        key: `g:${g.clusterId}:${g.vmid}`,
        label: `${g.name} (${g.vmid})`,
        hint: `${g.type === 'qemu' ? 'VM' : 'CT'} · ${g.status} · ${clusterName(g.clusterId)}/${g.node}`,
        run: go(`/guests?q=${encodeURIComponent(g.name)}`),
      }));
    const nodes = (fleet?.clusters ?? []).flatMap((c) => c.nodes.map((n) => ({ c, n })));
    const nodeItems = rank(q, nodes, (x) => x.n.name, 3)
      .map(({ c, n }) => ({ key: `n:${c.id}:${n.name}`, label: n.name, hint: `node · ${c.name}`, run: go(`/guests?cluster=${encodeURIComponent(c.id)}&q=`) }));
    return [...guestItems, ...nodeItems, ...pageItems];
  }, [parsed, q, guests, fleet, nav, onClose, openPlan, clusterName]);

  useEffect(() => { setSel(0); }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <label className="sr-only" htmlFor="palette-input">Search or run a command</label>
        <input
          id="palette-input"
          ref={input}
          className="palette-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="web01 · start 120 · migrate web01 pve2 · snapshot 120 pre-upgrade"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[sel] ? `pi-${items[sel].key}` : undefined}
        />
        {parsed.kind === 'command' && (
          <div className="palette-plan mono">
            <div className="eyebrow">Plan preview · {ACTION_LABEL[parsed.action].toLowerCase()} · ↵ opens it in the plan pane</div>
            <div className="palette-cli">{parsed.preview}</div>
          </div>
        )}
        {parsed.kind === 'error' && <div className="palette-err" role="status">{parsed.message}</div>}
        {loadErr && <div className="palette-err" role="status">Could not load guests: {loadErr}</div>}
        <ul id="palette-list" className="palette-list" role="listbox" aria-label="Results">
          {items.map((it, i) => (
            <li
              key={it.key}
              id={`pi-${it.key}`}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? 'sel' : ''}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => { e.preventDefault(); it.run(); }}
            >
              <span>{it.label}</span><span className="muted small">{it.hint}</span>
            </li>
          ))}
          {items.length === 0 && parsed.kind === 'none' && <li className="muted palette-none">No matches</li>}
        </ul>
        <div className="palette-foot muted small"><span>↵ run · ↑↓ move · esc close</span><span>start · shutdown · stop · reboot · migrate · snapshot · destroy</span></div>
      </div>
    </div>
  );
}
