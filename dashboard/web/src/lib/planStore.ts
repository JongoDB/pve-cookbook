import type { Api, AuditEntry, Plan, PlanRequest, RunResult } from '../api/types';
import { mergeAudit, runFinished } from './plan';

export interface PlanState {
  plan: Plan | null;
  loading: boolean;
  /** true from pressing Run until the run (including async steps) has finished */
  running: boolean;
  error: string | null;
  /** API error code of `error`, e.g. "cluster_login_required" */
  errorCode?: string;
  result: RunResult | null;
}

export const EMPTY_PLAN: PlanState = { plan: null, loading: false, running: false, error: null, result: null };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How often, and for how long, to poll the audit log for an async run when no SSE frame arrives. */
const AUDIT_POLL_MS = 3000;
const AUDIT_POLL_MAX_MS = 15 * 60_000;

/**
 * The plan pane's state machine, kept free of React so it can be tested.
 *
 * Every plan request and every clear bumps a counter; a createPlan or runPlan response that
 * arrives after the counter moved on (another plan was opened, or this one was discarded) is
 * dropped, so a stale run result can never land on a newer plan.
 */
export class PlanStore {
  private state: PlanState = EMPTY_PLAN;
  private req = 0;
  /** recent audit frames by id: an SSE frame can beat the 202 response */
  private audits = new Map<string, AuditEntry>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly api: Pick<Api, 'createPlan' | 'runPlan' | 'audit'> & Partial<Pick<Api, 'discardPlan'>>,
    private onChange: (s: PlanState) => void,
  ) {}

  get(): PlanState { return this.state; }

  private set(s: PlanState) { this.state = s; this.onChange(s); }

  async open(r: PlanRequest): Promise<void> {
    const n = ++this.req;
    this.stopPoll();
    this.set({ ...EMPTY_PLAN, loading: true });
    try {
      const plan = await this.api.createPlan(r);
      if (n === this.req) this.set({ ...EMPTY_PLAN, plan });
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (n === this.req) this.set({ ...EMPTY_PLAN, error: errMsg(e), ...(typeof code === 'string' ? { errorCode: code } : {}) });
    }
  }

  async run(confirm?: string): Promise<void> {
    const plan = this.state.plan;
    if (!plan || this.state.running || this.state.result) return;
    const n = this.req;
    const current = () => n === this.req && this.state.plan?.id === plan.id;
    this.set({ ...this.state, running: true, error: null });
    try {
      let result = await this.api.runPlan(plan.id, confirm);
      if (!current()) return;
      const early = this.audits.get(result.auditId);
      if (early) result = mergeAudit(result, early, plan.steps.length);
      this.set({ ...this.state, running: !runFinished(result), result });
      if (!runFinished(result)) this.schedulePoll(n, result.auditId, Date.now());
    } catch (e) {
      if (current()) this.set({ ...this.state, running: false, error: errMsg(e) });
    }
  }

  /** Feed every `event: audit` frame here. */
  onAudit(a: AuditEntry): void {
    this.audits.set(a.id, a);
    if (this.audits.size > 50) this.audits.delete(this.audits.keys().next().value as string);
    const { plan, result } = this.state;
    if (!plan || !result || result.auditId !== a.id) return;
    const merged = mergeAudit(result, a, plan.steps.length);
    const finished = runFinished(merged);
    if (finished) this.stopPoll();
    this.set({ ...this.state, result: merged, running: !finished });
  }

  clear(): void {
    const { plan, result } = this.state;
    // Tell the server a pending change was discarded (best effort; it also expires on its own).
    if (plan && !result && this.api.discardPlan) this.api.discardPlan(plan.id).catch(() => undefined);
    this.req++;
    this.stopPoll();
    this.set(EMPTY_PLAN);
  }

  dispose(): void { this.req++; this.stopPoll(); }

  private stopPoll() { if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; } }

  /** Fallback for async runs when SSE is down: look the run up in the audit log. */
  private schedulePoll(n: number, auditId: string, since: number) {
    this.stopPoll();
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (n !== this.req || this.state.result?.auditId !== auditId || runFinished(this.state.result)) return;
      if (Date.now() - since > AUDIT_POLL_MAX_MS) {
        this.set({ ...this.state, running: false, error: 'Still running after 15 minutes. Check Activity and the audit log for progress.' });
        return;
      }
      try {
        const a = (await this.api.audit(50)).find((x) => x.id === auditId);
        if (a) this.onAudit(a);
      } catch { /* retry on the next tick */ }
      if (n === this.req && this.state.result?.auditId === auditId && !runFinished(this.state.result)) {
        this.schedulePoll(n, auditId, since);
      }
    }, AUDIT_POLL_MS);
  }
}
