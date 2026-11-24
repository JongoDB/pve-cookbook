import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/http';
import type { Api, AuditEntry, Fleet, Me, Plan, PlanRequest, RunResult, Task } from '../api/types';

export interface PlanState {
  plan: Plan | null;
  loading: boolean;
  running: boolean;
  error: string | null;
  result: RunResult | null;
}

const EMPTY_PLAN: PlanState = { plan: null, loading: false, running: false, error: null, result: null };

interface AppCtx {
  api: Api;
  me: Me;
  setMe: (m: Me | null) => void;
  fleet: Fleet | null;
  tasks: Task[];
  live: 'live' | 'polling' | 'connecting';
  lastAudit: AuditEntry | null;
  planState: PlanState;
  openPlan: (req: PlanRequest) => Promise<void>;
  runPlan: (confirm?: string) => Promise<void>;
  clearPlan: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  clusterName: (id: string) => string;
}

const Ctx = createContext<AppCtx | null>(null);

export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function AppProvider({ api, me, setMe, children }: { api: Api; me: Me; setMe: (m: Me | null) => void; children: ReactNode }) {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [live, setLive] = useState<'live' | 'polling' | 'connecting'>('connecting');
  const [lastAudit, setLastAudit] = useState<AuditEntry | null>(null);
  const [planState, setPlanState] = useState<PlanState>(EMPTY_PLAN);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const planReq = useRef(0);

  useEffect(() => {
    let alive = true;
    api.fleet().then((f) => alive && setFleet(f)).catch(() => undefined);
    api.tasks({ limit: 50 }).then((t) => alive && setTasks(t)).catch(() => undefined);
    const stop = api.subscribe({ fleet: setFleet, tasks: setTasks, audit: setLastAudit, mode: setLive });
    return () => { alive = false; stop(); };
  }, [api]);

  const openPlan = useCallback(async (req: PlanRequest) => {
    const n = ++planReq.current;
    setPlanState({ ...EMPTY_PLAN, loading: true });
    try {
      const plan = await api.createPlan(req);
      if (n === planReq.current) setPlanState({ ...EMPTY_PLAN, plan });
    } catch (e) {
      if (n === planReq.current) setPlanState({ ...EMPTY_PLAN, error: errMsg(e) });
    }
  }, [api]);

  const runPlan = useCallback(async (confirm?: string) => {
    const plan = planState.plan;
    if (!plan) return;
    setPlanState((s) => ({ ...s, running: true, error: null }));
    try {
      const result = await api.runPlan(plan.id, confirm);
      setPlanState((s) => ({ ...s, running: false, result }));
    } catch (e) {
      setPlanState((s) => ({ ...s, running: false, error: errMsg(e) }));
    }
  }, [api, planState.plan]);

  const clearPlan = useCallback(() => { planReq.current++; setPlanState(EMPTY_PLAN); }, []);

  const clusterName = useCallback(
    (id: string) => me.clusters.find((c) => c.id === id)?.name ?? fleet?.clusters.find((c) => c.id === id)?.name ?? id,
    [me, fleet],
  );

  const value = useMemo<AppCtx>(() => ({
    api, me, setMe, fleet, tasks, live, lastAudit, planState, openPlan, runPlan, clearPlan, paletteOpen, setPaletteOpen, clusterName,
  }), [api, me, setMe, fleet, tasks, live, lastAudit, planState, openPlan, runPlan, clearPlan, paletteOpen, clusterName]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
