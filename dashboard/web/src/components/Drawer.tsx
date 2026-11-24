import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, type DrawerTab } from '../state/app';
import type { Plan } from '../api/types';
import { canRun, planCli, runFinished, stepStatus } from '../lib/plan';
import { ago } from '../lib/format';
import { ClusterLoginForm } from './ClusterLogin';
import { IconActivity, IconAssistant, IconChanges, IconFold } from './Icons';
import { CopyButton } from './ui';
import { AssistantPanel } from './Assistant';

const TABS: { id: DrawerTab; label: string; icon: () => JSX.Element }[] = [
  { id: 'assistant', label: 'Assistant', icon: IconAssistant },
  { id: 'changes', label: 'Changes', icon: IconChanges },
  { id: 'activity', label: 'Activity', icon: IconActivity },
];

export const EXPLAIN_CHANGES = 'Nothing in galley touches a cluster until you apply it here. Each change shows the exact commands it runs, as you.';

export function Drawer() {
  const { drawerTab, drawerFolded, openDrawer, setDrawerFolded, changePending, tasks, runningChanges } = useApp();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const running = tasks.filter((t) => !t.endtime).length + runningChanges.length;

  // Escape folds the overlay drawer on narrow screens.
  useEffect(() => {
    if (drawerFolded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && window.innerWidth < 1100 && !document.querySelector('.palette-backdrop')) setDrawerFolded(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerFolded, setDrawerFolded]);

  if (drawerFolded) {
    return (
      <aside className="rail" aria-label="Drawer">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => openDrawer(t.id)} title={t.label}
            aria-label={`Open ${t.label}${t.id === 'changes' && changePending ? ', 1 change waiting' : t.id === 'activity' && running ? `, ${running} running` : ''}`}>
            <t.icon />
            {t.id === 'changes' && changePending && <span className="dot-badge" aria-hidden="true">1</span>}
          </button>
        ))}
      </aside>
    );
  }

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = TABS[(i + d + TABS.length) % TABS.length];
    openDrawer(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <aside className="drawer" aria-label="Drawer">
      <div className="drawer-tabs" role="tablist" aria-label="Drawer">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[t.id] = el; }}
            type="button"
            role="tab"
            id={`dtab-${t.id}`}
            aria-selected={drawerTab === t.id}
            aria-controls={`dpanel-${t.id}`}
            tabIndex={drawerTab === t.id ? 0 : -1}
            onClick={() => openDrawer(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
            {t.id === 'changes' && changePending && <span className="count-badge"><span className="sr-only">waiting: </span>1</span>}
          </button>
        ))}
        <button type="button" className="icon-btn fold" aria-label="Fold the drawer" onClick={() => setDrawerFolded(true)}><IconFold /></button>
      </div>
      <div className="drawer-body" role="tabpanel" id={`dpanel-${drawerTab}`} aria-labelledby={`dtab-${drawerTab}`}>
        {drawerTab === 'assistant' && <AssistantPanel />}
        {drawerTab === 'changes' && <ChangesPanel />}
        {drawerTab === 'activity' && <ActivityPanel />}
      </div>
    </aside>
  );
}

/** Why this change needs care, in the admin's terms. */
function destructiveNote(plan: Plan): string {
  if (plan.source === 'assistant') return 'Drafted by the assistant from what it read in the cluster. Check every command before you confirm it.';
  if (plan.action === 'host.exec') return 'Runs as root on the node, outside PVE\'s permission checks. Check the command before you confirm it.';
  if (plan.action === 'api.call') return 'This deletes settings or data, or interrupts service. Check every command before you confirm it.';
  return plan.confirmText ? 'This cannot be undone.' : 'Guests lose power without a clean shutdown.';
}

export function ChangesPanel() {
  const { planState, runPlan, clearPlan, clusterName, me, lastPlanRequest, openPlan } = useApp();
  const { plan, loading, running, error, errorCode, result } = planState;
  const [typed, setTyped] = useState('');
  const title = useRef<HTMLDivElement>(null);

  useEffect(() => { setTyped(''); }, [plan?.id]);
  // Move focus to a newly opened change so keyboard users land on it.
  useEffect(() => { if (plan) title.current?.focus(); }, [plan?.id, plan]);

  const done = runFinished(result);
  const runnable = canRun(plan, typed) && !running && !result;
  const allOk = !!result && result.results.length > 0 && result.results.every((r) => stepStatus(r) === 'ok');

  if (loading) return <div className="muted" role="status">Preparing the change</div>;

  if (error && !plan) {
    const req = lastPlanRequest;
    if (errorCode === 'cluster_login_required' && req) {
      return (
        <div className="change">
          <div className="change-title">Log in to {clusterName(req.clusterId)}</div>
          <ClusterLoginForm clusterId={req.clusterId} onDone={() => void openPlan(req)} compact />
          <button type="button" className="btn" onClick={clearPlan}>Discard</button>
        </div>
      );
    }
    return (
      <div className="change">
        <div className="notice notice-error" role="alert"><div className="grow">Could not prepare the change: {error}</div></div>
        <div className="change-actions">
          <button type="button" className="btn" onClick={clearPlan}>Discard</button>
          {req && <button type="button" className="btn btn-primary" onClick={() => void openPlan(req)}>Try again</button>}
        </div>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="change">
        <div className="change-title">No change waiting</div>
        <p className="explain">{EXPLAIN_CHANGES}</p>
        <p className="explain">
          Start one from a finding with a fix, a guest&apos;s actions, or <kbd>⌘K</kbd> with a command such as <code>start 120</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="change" aria-busy={running}>
      <div>
        <div className="change-title" tabIndex={-1} ref={title}>{plan.title}</div>
        <div className="change-sub">{plan.source === 'assistant' && <span className="badge badge-warn" style={{ marginRight: 8 }}>Assistant draft</span>}{clusterName(plan.clusterId)}, runs as you ({me.user})</div>
      </div>
      {plan.summary && <p className="change-summary">{plan.summary}</p>}
      {plan.destructive && (
        <div className="notice notice-warn" role="note">
          <div className="grow">{destructiveNote(plan)}</div>
        </div>
      )}
      <ol className="change-steps">
        {plan.steps.map((s, i) => {
          const r = result?.results.find((x) => x.step === i);
          const st = r ? stepStatus(r) : null;
          return (
            <li key={i}>
              {s.description}
              {r && st === 'running' && <span className="st run" role="status">Running{r.upid ? `, task ${r.upid}` : ''}</span>}
              {r && st === 'ok' && <span className="st ok">Done{r.exitstatus && r.exitstatus !== 'OK' ? `: ${r.exitstatus}` : ''}</span>}
              {r && st === 'error' && <span className="st err">Failed: {r.error ?? r.exitstatus ?? 'no reason given'}</span>}
              {r && st === 'unknown' && <span className="st wait">Unknown: galley stopped following this task. Check the PVE task log.</span>}
              {!r && result && !done && <span className="st wait">Waiting for the previous step</span>}
              {r?.output ? <StepOutput text={r.output} /> : null}
            </li>
          );
        })}
      </ol>
      <pre className="cli" aria-label="Commands this change runs">{planCli(plan)}</pre>
      <div className="row-actions"><CopyButton text={planCli(plan)} /></div>

      {plan.confirmText && !result && (
        <label className="field">
          <span className="label">Type <code>{plan.confirmText}</code> to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      )}

      {done && (
        <div className={`notice ${allOk ? 'notice-ok' : 'notice-error'}`} role="status">
          <div className="grow">{allOk ? 'Change applied. It is in the audit log.' : 'The change stopped at a failed step. Nothing after it ran. See the steps above and the audit log.'}</div>
        </div>
      )}
      {error && <div className="notice notice-error" role="alert"><div className="grow">{error}</div></div>}

      <div className="change-actions">
        {done ? (
          <>
            <Link className="btn" to="/audit">Open audit log</Link>
            <button type="button" className="btn btn-primary" onClick={clearPlan}>Close</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-lg" onClick={clearPlan} disabled={running}
              title={running ? 'The change is running; wait for it to finish' : undefined}>Discard</button>
            <button type="button" className={`btn btn-lg ${plan.destructive ? 'btn-danger' : 'btn-apply'}`} disabled={!runnable}
              onClick={() => runPlan(plan.confirmText ? typed : undefined)}>
              {running ? 'Applying' : 'Apply change'}
            </button>
          </>
        )}
      </div>
      <p className="explain">{EXPLAIN_CHANGES}</p>
    </div>
  );
}

/** Command output of a host step (host.exec), scrollable, with copy. */
export function StepOutput({ text }: { text: string }) {
  return (
    <div className="step-output">
      <pre className="cli output" tabIndex={0} aria-label="Command output">{text}</pre>
      <div className="row-actions"><CopyButton text={text} label="Copy output" /></div>
    </div>
  );
}

function ActivityPanel() {
  const { tasks, runningChanges, clusterName } = useApp();
  const live = tasks.filter((t) => !t.endtime);
  const recent = tasks.filter((t) => t.endtime).slice(0, 8);
  return (
    <>
      <div>
        <h2>Running</h2>
        {live.length === 0 && runningChanges.length === 0 ? <p className="explain">Nothing is running.</p> : (
          <ul className="activity-list">
            {runningChanges.map((a) => (
              <li key={a.id}><span className="badge badge-info">Change</span><span className="grow">{a.title}<div className="ws">{clusterName(a.clusterId)}, step {Math.min(a.results.length, a.cli.length) || 1} of {a.cli.length}</div></span></li>
            ))}
            {live.map((t) => (
              <li key={t.upid}><span className="badge badge-info">Task</span><span className="grow">{t.type}{t.id ? ` ${t.id}` : ''}<div className="ws">{clusterName(t.clusterId)}/{t.node}, {t.user}, started {ago(t.starttime)}</div></span></li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h2>Finished</h2>
        {recent.length === 0 ? <p className="explain">No finished tasks yet.</p> : (
          <ul className="activity-list">
            {recent.map((t) => {
              const ok = t.status === 'OK';
              const warn = /^WARNINGS/.test(t.status ?? '');
              return (
                <li key={t.upid}>
                  <span className={`badge ${ok ? 'badge-ok' : warn ? 'badge-warn' : 'badge-crit'}`}>{ok ? 'OK' : warn ? 'Warnings' : 'Failed'}</span>
                  <span className="grow">{t.type}{t.id ? ` ${t.id}` : ''}<div className="ws">{clusterName(t.clusterId)}/{t.node}, {ago(t.endtime!)}</div></span>
                </li>
              );
            })}
          </ul>
        )}
        <p style={{ marginTop: 10 }}><Link to="/activity">All activity</Link></p>
      </div>
    </>
  );
}
