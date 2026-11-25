import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/http';
import type { Api, AuditEntry, Fleet, Me, PlanRequest, Task } from '../api/types';
import { EMPTY_PLAN, PlanStore, type PlanState } from '../lib/planStore';

export type { PlanState } from '../lib/planStore';

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
  const store = useRef<PlanStore | null>(null);
  if (!store.current || store.current.api !== api) store.current = new PlanStore(api, setPlanState);

  useEffect(() => {
    const plans = store.current;
    let alive = true;
    api.fleet().then((f) => alive && setFleet(f)).catch(() => undefined);
    api.tasks({ limit: 50 }).then((t) => alive && setTasks(t)).catch(() => undefined);
    const stop = api.subscribe({
      fleet: setFleet,
      tasks: setTasks,
      audit: (a) => { setLastAudit(a); plans?.onAudit(a); },
      mode: setLive,
    });
    return () => { alive = false; stop(); plans?.dispose(); };
  }, [api]);

  // Request-counter guarded (see PlanStore): stale createPlan/runPlan responses are dropped.
  const openPlan = useCallback((req: PlanRequest) => store.current!.open(req), []);
  const runPlan = useCallback((confirm?: string) => store.current!.run(confirm), []);
  const clearPlan = useCallback(() => store.current!.clear(), []);

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
