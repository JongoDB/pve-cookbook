import { useCallback, useEffect, useState } from 'react';
import type { Plan } from '../api/types';
import { useApp } from '../state/app';
import { sourceLabel } from '../lib/plan';
import { ago } from '../lib/format';

const REFRESH_MS = 30_000;

/**
 * The user's pending changes (GET /api/plans): drafts by the assistant or agents, and changes
 * opened elsewhere. Refreshed when shown, on audit events, and every 30 s while visible.
 */
export function PendingChanges({ compact = false }: { compact?: boolean }) {
  const { api, lastAudit, planState, showPlan, clusterName } = useApp();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const current = planState.plan?.id;

  const load = useCallback(() => {
    api.plans().then((p) => { setPlans(p); setFailed(false); }, () => setFailed(true));
  }, [api]);

  useEffect(() => { load(); }, [load, lastAudit?.id, lastAudit?.status, current]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const others = (plans ?? []).filter((p) => p.id !== current);
  if (compact && !others.length) return null;
  if (!plans) return failed && !compact ? <p className="explain">Could not load your pending changes.</p> : null;
  if (!others.length) return null;

  const list = (
    <ul className="pending-list">
      {others.map((p) => {
        const src = sourceLabel(p.source);
        return (
          <li key={p.id}>
            <button type="button" className="pending-item" onClick={() => showPlan(p)}>
              <span className="pending-title">{p.title.replace(/^(Assistant|Agent) draft(\s*\([^)]*\))?:\s*/i, '')}</span>
              <span className="pending-meta">
                {src && <span className={`badge ${p.source === 'assistant' ? 'badge-warn' : 'badge-info'}`}>{src}</span>}
                <span>{p.clusterId ? `${clusterName(p.clusterId)}, ` : ''}{ago(p.createdAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  if (compact) {
    return (
      <div className="pending compact">
        <button type="button" className="link-btn small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {others.length} other change{others.length === 1 ? '' : 's'} waiting{open ? '' : ': show'}
        </button>
        {open && list}
      </div>
    );
  }
  return (
    <div className="pending">
      <h2>Waiting for you</h2>
      {list}
    </div>
  );
}
