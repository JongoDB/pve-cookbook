import { useEffect, useState } from 'react';
import { useApp } from '../state/app';
import { canRun, planCli, runFinished, stepStatus } from '../lib/plan';
import { CopyButton, ErrorBox } from './ui';

const KEY = 'galley.planPane.collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function PlanPane() {
  const { planState, runPlan, clearPlan, clusterName, me } = useApp();
  const { plan, loading, running, error, result } = planState;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [typed, setTyped] = useState('');

  useEffect(() => { setTyped(''); }, [plan?.id]);
  // A new plan always opens the pane: plans must be seen before they run.
  useEffect(() => { if (plan || loading || error) setCollapsed(false); }, [plan, loading, error]);
  useEffect(() => { try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* storage blocked */ } }, [collapsed]);

  if (collapsed) {
    return (
      <aside className="plan plan-collapsed" aria-label="Plan">
        <button type="button" className="icon-btn" aria-label="Expand plan pane" onClick={() => setCollapsed(false)}>⇤</button>
        <span className="plan-rail-label">Plan{plan && !runFinished(result) ? ' ●' : ''}</span>
      </aside>
    );
  }

  const done = runFinished(result);
  // A plan runs at most once: once there is any result (even a still-running async one) Run stays off.
  const runnable = canRun(plan, typed) && !running && !result;
  const allOk = !!result && result.results.length > 0 && result.results.every((r) => stepStatus(r) === 'ok');

  return (
    <aside className="plan" aria-label="Plan">
      <div className="plan-head">
        <span className="eyebrow">Plan{plan ? ` · ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}` : ''}</span>
        <button type="button" className="icon-btn" aria-label="Collapse plan pane" onClick={() => setCollapsed(true)}>⇥</button>
      </div>

      {loading && <div className="muted">Building plan…</div>}
      <ErrorBox message={error} />

      {!plan && !loading && !error && (
        <div className="plan-empty">
          <h2>Nothing planned</h2>
          <p className="muted">
            Every change in galley starts as a plan: the exact API calls and the equivalent CLI, shown here before anything runs.
            Pick a finding, select guests and choose an action, or press <kbd>⌘K</kbd> and type a command like <code>start 120</code>.
          </p>
        </div>
      )}

      {plan && (
        <>
          <h2 className="plan-title">{plan.title}</h2>
          <div className="muted small">{clusterName(plan.clusterId)} · runs as {me.user}</div>
          {plan.summary && <p className="plan-summary">{plan.summary}</p>}
          {plan.destructive && (
            <div className="warn-box" role="note">
              {plan.confirmText ? 'Destructive and irreversible.' : 'Disruptive: guests lose power without a clean shutdown.'}
            </div>
          )}
          <ol className="plan-steps">
            {plan.steps.map((s, i) => {
              const r = result?.results.find((x) => x.step === i);
              const st = r ? stepStatus(r) : null;
              return (
                <li key={i}>
                  <span>{s.description}</span>
                  {r && st === 'running' && <div className="muted" role="status">… running{r.upid ? ` ${r.upid}` : ''}</div>}
                  {r && st === 'ok' && <div className="step-ok">✓ {r.upid ?? 'done'}</div>}
                  {r && st === 'error' && <div className="step-fail">✗ {r.error ?? r.exitstatus ?? 'failed'}</div>}
                  {!r && result && !done && <div className="muted">waiting</div>}
                </li>
              );
            })}
          </ol>
          <pre className="cli" aria-label="Equivalent CLI">{planCli(plan)}</pre>

          {plan.confirmText && !result && (
            <label className="field">
              <span>Type <code>{plan.confirmText}</code> to confirm</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          )}

          {done && (
            <div className={allOk ? 'ok-box' : 'error-box'} role="status">
              {allOk ? 'Plan ran. Recorded in the audit log.' : 'Plan ran with errors. See steps above and the audit log.'}
            </div>
          )}

          <div className="plan-actions">
            <CopyButton text={planCli(plan)} />
            {done
              ? <button type="button" className="btn btn-primary" onClick={clearPlan}>Done</button>
              : (
                <button type="button" className={`btn ${plan.destructive ? 'btn-danger' : 'btn-primary'}`} disabled={!runnable} onClick={() => runPlan(plan.confirmText ? typed : undefined)}>
                  {running ? 'Running…' : 'Run plan'}
                </button>
              )}
          </div>
          {!done && (
            <button type="button" className="link-btn" onClick={clearPlan} disabled={running}
              title={running ? 'The plan is running; wait for it to finish' : undefined}>
              Discard plan
            </button>
          )}
        </>
      )}
    </aside>
  );
}
