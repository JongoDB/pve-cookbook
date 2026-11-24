import { describe, expect, it } from 'vitest';
import type { Api, AuditEntry, Plan, RunResult } from '../api/types';
import { PlanStore, type PlanState } from './planStore';

const plan = (id: string, steps = 1): Plan => ({
  id, action: 'guest.start', title: `Start ${id}`, summary: '', clusterId: 'lab', destructive: false,
  steps: Array.from({ length: steps }, (_, i) => ({ description: `s${i}`, method: 'POST', path: '/x', body: {}, cli: `qm start ${i}` })),
  createdAt: 0, expiresAt: 4_000_000_000,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function fakeApi() {
  const runs: { id: string; d: ReturnType<typeof deferred<RunResult>> }[] = [];
  const api: Pick<Api, 'createPlan' | 'runPlan' | 'audit'> = {
    createPlan: async (r) => plan(String(r.params.id), Number(r.params.steps ?? 1)),
    runPlan: (id) => { const d = deferred<RunResult>(); runs.push({ id, d }); return d.promise; },
    audit: async () => [],
  };
  return { api, runs };
}

const entry = (id: string, results: AuditEntry['results'], status?: 'running' | 'done'): AuditEntry => ({
  id, at: 0, user: 'u', clusterId: 'lab', action: 'guest.start', title: '', cli: [], ok: false, results, ...(status ? { status } : {}),
});

describe('PlanStore (stale-run guard)', () => {
  it('drops a run result that arrives after a different plan was opened', async () => {
    const { api, runs } = fakeApi();
    let last: PlanState | null = null;
    const s = new PlanStore(api, (x) => { last = x; });
    await s.open({ action: 'guest.start', clusterId: 'lab', params: { id: 'A' } });
    const running = s.run();
    expect(s.get().running).toBe(true);
    await s.open({ action: 'guest.start', clusterId: 'lab', params: { id: 'B' } });
    runs[0].d.resolve({ auditId: 'audit-A', results: [{ step: 0, ok: true }] });
    await running;
    expect(s.get().plan?.id).toBe('B');
    expect(s.get().result).toBeNull();
    expect(s.get().running).toBe(false);
    expect(last).toBe(s.get());
  });

  it('drops a run result after the plan was discarded', async () => {
    const { api, runs } = fakeApi();
    const s = new PlanStore(api, () => undefined);
    await s.open({ action: 'guest.start', clusterId: 'lab', params: { id: 'A' } });
    const running = s.run();
    s.clear();
    runs[0].d.resolve({ auditId: 'x', results: [{ step: 0, ok: false, error: 'boom' }] });
    await running;
    expect(s.get()).toMatchObject({ plan: null, result: null, error: null });
  });

  it('applies a sync (200) result to the plan that ran, and refuses to run it twice', async () => {
    const { api, runs } = fakeApi();
    const s = new PlanStore(api, () => undefined);
    await s.open({ action: 'guest.start', clusterId: 'lab', params: { id: 'A' } });
    const p = s.run();
    void s.run(); // double click while running: ignored
    runs[0].d.resolve({ auditId: 'a', results: [{ step: 0, ok: true, upid: 'UPID:1' }] });
    await p;
    expect(runs).toHaveLength(1);
    expect(s.get()).toMatchObject({ running: false, result: { auditId: 'a' } });
    await s.run();
    expect(runs).toHaveLength(1);
  });

  it('tracks an async (202) run through matching audit events only', async () => {
    const { api, runs } = fakeApi();
    const s = new PlanStore(api, () => undefined);
    await s.open({ action: 'guest.start', clusterId: 'lab', params: { id: 'A', steps: 2 } });
    const p = s.run();
    // a frame can beat the 202 response
    s.onAudit(entry('a1', [{ step: 0, ok: false, status: 'running' }], 'running'));
    runs[0].d.resolve({ auditId: 'a1', status: 'running', results: [] });
    await p;
    expect(s.get().running).toBe(true);
    expect(s.get().result?.results[0].status).toBe('running');
    s.onAudit(entry('other', [{ step: 0, ok: true, status: 'ok' }, { step: 1, ok: true, status: 'ok' }], 'done'));
    expect(s.get().running).toBe(true);
    s.onAudit(entry('a1', [{ step: 0, ok: true, status: 'ok' }, { step: 1, ok: false, status: 'error', exitstatus: 'exit code 1' }]));
    expect(s.get().running).toBe(false);
    expect(s.get().result).toMatchObject({ status: 'done', results: [{ status: 'ok' }, { status: 'error' }] });
    s.dispose();
  });
});
