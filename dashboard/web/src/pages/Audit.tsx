import { useEffect, useState } from 'react';
import type { AuditEntry } from '../api/types';
import { errMsg, useApp } from '../state/app';
import { CopyButton, Empty, ErrorBox } from '../components/ui';
import { clock } from '../lib/format';
import { stepStatus } from '../lib/plan';

export function Audit() {
  const { api, lastAudit, clusterName } = useApp();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.audit(100).then((a) => alive && setEntries(a)).catch((e) => alive && setErr(errMsg(e)));
    return () => { alive = false; };
  }, [api, lastAudit?.id, lastAudit?.status, lastAudit?.results.length]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="muted">Every plan galley ran, who ran it, and the exact commands — copy any entry to reproduce it from a shell.</div>
        </div>
      </div>
      <ErrorBox message={err} />
      <section className="panel" aria-label="Audit entries">
        {entries === null ? <div className="muted pad">Loading…</div> : entries.length === 0 ? (
          <Empty title="No actions yet">Runs appear here as soon as a plan executes.</Empty>
        ) : (
          <ul className="audit">
            {entries.map((a) => {
              const isOpen = open === a.id;
              return (
                <li key={a.id}>
                  <button type="button" className="audit-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)}>
                    {a.status === 'running'
                      ? <span className="level level-warn">RUN</span>
                      : <span className={`level ${a.ok ? 'level-ok' : 'level-crit'}`}>{a.ok ? 'OK' : 'FAIL'}</span>}
                    <span className="mono small muted">{clock(a.at)}</span>
                    <span className="strong audit-title">{a.title}</span>
                    <span className="muted">{clusterName(a.clusterId)}</span>
                    <span className="muted">{a.user}</span>
                    <span aria-hidden="true" className="muted">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  {isOpen && (
                    <div className="audit-detail">
                      <pre className="cli">{a.cli.join('\n')}</pre>
                      <ul className="results">
                        {a.results.map((r) => (
                          <li key={r.step} className={stepStatus(r) === 'ok' ? 'step-ok' : stepStatus(r) === 'running' ? 'muted' : 'step-fail'}>
                            step {r.step + 1}: {stepStatus(r) === 'ok' ? `✓ ${r.upid ?? 'done'}` : stepStatus(r) === 'running' ? `… running${r.upid ? ` ${r.upid}` : ''}` : `✗ ${r.error ?? r.exitstatus ?? 'failed'}`}
                          </li>
                        ))}
                      </ul>
                      <CopyButton text={a.cli.join('\n')} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
