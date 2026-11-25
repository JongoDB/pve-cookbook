import type { AuditEntry, Plan, RunResult, StepResult, StepStatus } from '../api/types';

/**
 * Whether the Run button may be pressed.
 * Plans with a confirmText (e.g. destroy) require the operator to type it exactly.
 * Expired plans never run (the server enforces this too).
 */
export function canRun(plan: Plan | null, typed: string, now = Date.now() / 1000): boolean {
  if (!plan) return false;
  if (plan.expiresAt && now >= plan.expiresAt) return false;
  if (plan.confirmText) return typed === plan.confirmText;
  return true;
}

export const planCli = (plan: Plan) => plan.steps.map((s) => s.cli).join('\n');

/** A step result's outcome across the sync (ok only) and async (status) shapes. */
export const stepStatus = (r: StepResult): StepStatus => r.status ?? (r.ok ? 'ok' : 'error');

/** True once a run has finished: sync results, or an async run whose audit says done. */
export const runFinished = (r: RunResult | null): boolean => !!r && r.status !== 'running';

/**
 * Fold an `event: audit` frame (or a polled audit entry) for this run into the RunResult.
 * Without an explicit status the run counts as done once every step reported a final state.
 */
export function mergeAudit(r: RunResult, a: AuditEntry, stepCount: number): RunResult {
  if (a.id !== r.auditId) return r;
  const results = a.results ?? [];
  const finished = results.length >= stepCount && results.every((x) => stepStatus(x) !== 'running');
  return { ...r, results, status: a.status ?? (finished ? 'done' : 'running') };
}
