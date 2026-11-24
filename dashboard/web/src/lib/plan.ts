import type { Plan } from '../api/types';

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
