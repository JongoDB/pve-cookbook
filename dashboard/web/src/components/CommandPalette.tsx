import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Guest } from '../api/types';
import { ACTION_LABEL } from '../lib/actions';
import { parseCommand } from '../lib/commands';
import { rank } from '../lib/fuzzy';
import { useApp } from '../state/app';
import { PAGES, visiblePage } from './Layout';

interface Item { key: string; label: string; hint: string; run: () => void }

const storagePath = (clusterId: string, id: string, node: string, shared: boolean) =>
  `/storage/${encodeURIComponent(clusterId)}/${encodeURIComponent(shared ? id : `${id}@${node}`)}`;

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { fleet, openPlan, clusterName, guests: shared, guestsError, me, openDrawer, chat } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const guests: Guest[] = useMemo(() => shared ?? [], [shared]);
  const loadErr = shared ? null : guestsError;
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    restoreFocus.current = document.activeElement;
    input.current?.focus();
    return () => { (restoreFocus.current as HTMLElement | null)?.focus?.(); };
  }, []);

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
        label: `${ACTION_LABEL[parsed.action]} ${g.name} (${g.vmid})${parsed.params.target ? ` to ${parsed.params.target}` : ''}`,
        hint: `Opens a change on ${clusterName(g.clusterId)}`,
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
      return PAGES.filter((p) => visiblePage(p, me)).map((p) => ({ key: `p:${p.to}`, label: p.label, hint: 'Page', run: go(p.to) }));
    }
    const pageItems = rank(q, PAGES.filter((p) => visiblePage(p, me)), (p) => p.label, 3)
      .map((p) => ({ key: `p:${p.to}`, label: p.label, hint: 'Page', run: go(p.to) }));
    const guestItems = rank(q, guests.filter((g) => !g.template), (g) => `${g.name} ${g.vmid}`, 6)
      .map((g) => ({
        key: `g:${g.clusterId}:${g.vmid}`,
        label: `${g.name} (${g.vmid})`,
        hint: `${g.type === 'qemu' ? 'VM' : 'Container'}, ${g.status}, on ${clusterName(g.clusterId)}/${g.node}`,
        run: go(`/guests/${encodeURIComponent(g.clusterId)}/${g.vmid}`),
      }));
    const nodes = (fleet?.clusters ?? []).flatMap((c) => c.nodes.map((n) => ({ c, n })));
    const nodeItems = rank(q, nodes, (x) => x.n.name, 3)
      .map(({ c, n }) => ({ key: `n:${c.id}:${n.name}`, label: n.name, hint: `Node on ${c.name}, ${n.online ? 'online' : 'offline'}`, run: go(`/nodes/${encodeURIComponent(c.id)}/${encodeURIComponent(n.name)}`) }));
    const seen = new Set<string>();
    const stores = (fleet?.clusters ?? []).flatMap((c) => c.storage.map((s) => ({ c, s }))).filter(({ c, s }) => {
      const k = `${c.id}/${s.shared ? s.id : `${s.id}@${s.node}`}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const storeItems = rank(q, stores, (x) => `${x.s.id} ${x.s.shared ? '' : x.s.node}`, 3)
      .map(({ c, s }) => ({
        key: `s:${c.id}:${s.id}:${s.shared ? '' : s.node}`, label: s.shared ? s.id : `${s.id} on ${s.node}`,
        hint: `Storage on ${c.name}, ${s.type}`, run: go(storagePath(c.id, s.id, s.node, s.shared)),
      }));
    // Anything that reads like a question goes to the assistant (it answers in the drawer).
    const ask = { key: 'ask', label: `Ask the assistant: ${q.trim()}`, hint: 'Assistant', run: () => { openDrawer('assistant'); void chat.send(q); onClose(); } };
    const question = /\?\s*$|^(why|what|how|which|is|are|can|does|do|when|where|show|list|explain)\b/i.test(q.trim()) || q.trim().split(/\s+/).length > 3;
    const found = [...guestItems, ...nodeItems, ...storeItems, ...pageItems];
    return question ? [ask, ...found] : [...found, ask];
  }, [parsed, q, guests, fleet, nav, onClose, openPlan, clusterName, me, openDrawer, chat]);

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
        <label className="sr-only" htmlFor="palette-input">Ask, search or run a command</label>
        <input
          id="palette-input"
          ref={input}
          className="palette-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search guests, nodes and storage, or type start 120"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[sel] ? `pi-${items[sel].key}` : undefined}
        />
        {parsed.kind === 'command' && (
          <div className="palette-preview">
            <div className="muted small">Preview. Press Enter to open it in Changes, where you review and apply it.</div>
            <pre className="cli">{parsed.preview}</pre>
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
              <span>{it.label}</span><span className="hint">{it.hint}</span>
            </li>
          ))}
          {items.length === 0 && parsed.kind === 'none' && <li className="muted" role="presentation">No guest, node, storage or page matches. Try a VMID or a command such as start 120.</li>}
        </ul>
        <div className="palette-foot"><span>Enter to open, arrow keys to move, Esc to close</span><span>Commands: start, shutdown, stop, reboot, migrate, snapshot, destroy</span></div>
      </div>
    </div>
  );
}
