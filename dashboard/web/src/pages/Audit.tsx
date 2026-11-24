import { useState } from 'react';
import { useApp, useCrumbs } from '../state/app';
import { useAsync } from '../lib/hooks';
import { clock } from '../lib/format';
import { stepStatus } from '../lib/plan';
import { ApiErrorView } from '../components/ClusterLogin';
import { CopyButton, Empty } from '../components/ui';
import { auditBadge } from './overview/Widgets';
import { StepOutput } from '../components/Drawer';
import { HelpLink } from '../components/HelpLink';

export function Audit() {
  useCrumbs([{ label: 'Audit log' }]);
  const { api, lastAudit, clusterName } = useApp();
  const { data: entries, error, reload } = useAsync(() => api.audit(100), `audit|${lastAudit?.id}|${lastAudit?.status}|${lastAudit?.results.length}`);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Audit log</h1><HelpLink />
        <div className="sub">Changes, logins and cluster edits, with the exact commands. Copy any entry to repeat it from a shell.</div>
      </div>
      {error ? <ApiErrorView error={error} what="the audit log" onRetry={reload} /> : null}
      <section className="panel" aria-label="Audit entries">
        {entries === null ? <div className="muted panel-body" role="status">Loading the audit log</div> : entries.length === 0 ? (
          <Empty title="No entries yet">Applied changes, logins and cluster edits appear here.</Empty>
        ) : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th scope="col">Result</th><th scope="col">When</th><th scope="col">Change</th><th scope="col">Cluster</th><th scope="col">Ran as</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead>
            <tbody>
              {entries.map((a) => {
                const isOpen = open === a.id;
                return [
                  <tr key={a.id} className={isOpen ? 'selected' : ''}>
                    <td>{auditBadge(a)}</td>
                    <td className="nowrap text-2">{clock(a.at)}</td>
                    <td className="strong">{a.title}<div className="ws mono" style={{ fontWeight: 400 }}>{a.action}</div></td>
                    <td className="text-2">{clusterName(a.clusterId)}</td>
                    <td className="text-2">{a.actorUser ?? a.user}{a.actorUser && a.actorUser !== a.user ? <div className="ws">session {a.user}</div> : null}</td>
                    <td className="right">
                      <button type="button" className="btn btn-sm" aria-expanded={isOpen} aria-controls={`audit-${a.id}`} onClick={() => setOpen(isOpen ? null : a.id)}>
                        {isOpen ? 'Hide details' : 'Details'}
                      </button>
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${a.id}-d`} id={`audit-${a.id}`}>
                      <td colSpan={6} style={{ background: 'var(--bg)' }}>
                        <div className="form-stack" style={{ gap: 10 }}>
                          {a.cli.length > 0 ? <pre className="cli">{a.cli.join('\n')}</pre> : <span className="muted">No commands recorded for this entry.</span>}
                          {a.results.length > 0 && (
                            <ol className="change-steps">
                              {a.results.map((r) => {
                                const st = stepStatus(r);
                                return (
                                  <li key={r.step}>
                                    {a.cli[r.step] ? <span className="mono">{a.cli[r.step]}</span> : `Step ${r.step + 1}`}
                                    <span className={`st ${st === 'ok' ? 'ok' : st === 'error' ? 'err' : 'run'}`}>
                                      {st === 'ok' ? `Done${r.upid ? `, task ${r.upid}` : ''}` : st === 'running' ? 'Running' : st === 'unknown' ? `Unknown: ${r.error ?? 'check the PVE task log'}` : `Failed: ${r.error ?? r.exitstatus ?? 'no reason given'}`}
                                    </span>
                                    {r.output ? <StepOutput text={r.output} /> : null}
                                  </li>
                                );
                              })}
                            </ol>
                          )}
                          {a.cli.length > 0 && <div><CopyButton text={a.cli.join('\n')} /></div>}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
