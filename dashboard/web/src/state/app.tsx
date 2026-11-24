import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/http';
import type { Api, AuditEntry, FeedbackConfig, Fleet, Guest, Me, Plan, PlanRequest, Task } from '../api/types';
import { EMPTY_PLAN, PlanStore, type PlanState } from '../lib/planStore';
import { runFinished } from '../lib/plan';
import { ChatSession } from '../lib/chat';

export type { PlanState } from '../lib/planStore';

export type DrawerTab = 'assistant' | 'changes' | 'activity';
/** App-wide dialogs, opened from the user menu, Help and the command palette. */
export type AppDialog = 'whats-new' | 'feedback' | null;
export interface Crumb { label: string; to?: string }

interface AppCtx {
  api: Api;
  me: Me;
  setMe: (m: Me | null) => void;
  refreshMe: () => Promise<void>;
  fleet: Fleet | null;
  tasks: Task[];
  live: 'live' | 'polling' | 'connecting';
  lastAudit: AuditEntry | null;
  /** audit frames seen this session for changes still running (newest first) */
  runningChanges: AuditEntry[];
  planState: PlanState;
  /** the request behind the current change (to retry it after a cluster login) */
  lastPlanRequest: PlanRequest | null;
  openPlan: (req: PlanRequest) => Promise<void>;
  /** Open a change that already exists (assistant drafts) in Changes, without creating it again. */
  showPlan: (plan: Plan) => void;
  runPlan: (confirm?: string) => Promise<void>;
  clearPlan: () => void;
  /** true while a change waits for the admin (not yet applied, or still running) */
  changePending: boolean;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  drawerTab: DrawerTab;
  drawerFolded: boolean;
  openDrawer: (tab: DrawerTab) => void;
  setDrawerFolded: (v: boolean) => void;
  crumbs: Crumb[];
  setCrumbs: (c: Crumb[]) => void;
  guests: Guest[] | null;
  guestsError: string | null;
  refreshGuests: () => void;
  clusterName: (id: string) => string;
  /** the assistant conversation (lives as long as the session) */
  chat: ChatSession;
  dialog: AppDialog;
  setDialog: (d: AppDialog) => void;
  /** GET /api/feedback; null until loaded (or when it failed: Send feedback stays hidden) */
  feedback: FeedbackConfig | null;
  reloadFeedback: () => void;
}

const Ctx = createContext<AppCtx | null>(null);

export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

const FOLD_KEY = 'galley.drawer.folded';
const TAB_KEY = 'galley.drawer.tab';
function readStore(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function writeStore(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* storage blocked */ }
}

/** The guest list is shared by several views; refetch on fleet ticks at most this often. */
const GUEST_REFRESH_MS = 15_000;
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function AppProvider({ api, me, setMe, children }: { api: Api; me: Me; setMe: (m: Me | null) => void; children: ReactNode }) {
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [live, setLive] = useState<'live' | 'polling' | 'connecting'>('connecting');
  const [lastAudit, setLastAudit] = useState<AuditEntry | null>(null);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [planState, setPlanState] = useState<PlanState>(EMPTY_PLAN);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>(() => {
    const t = readStore(TAB_KEY);
    return t === 'assistant' || t === 'activity' || t === 'changes' ? t : 'changes';
  });
  const [drawerFolded, setFoldedState] = useState<boolean>(() => {
    const v = readStore(FOLD_KEY);
    // Starts folded to a rail; opening a change unfolds it.
    return v === null ? true : v === '1';
  });
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [dialog, setDialog] = useState<AppDialog>(null);
  const [feedback, setFeedback] = useState<FeedbackConfig | null>(null);
  const reloadFeedback = useCallback(() => { api.feedback().then(setFeedback, () => setFeedback(null)); }, [api]);
  useEffect(() => { reloadFeedback(); }, [reloadFeedback]);
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [guestsError, setGuestsError] = useState<string | null>(null);
  const lastReq = useRef<PlanRequest | null>(null);
  const store = useRef<PlanStore | null>(null);
  if (!store.current || store.current.api !== api) store.current = new PlanStore(api, setPlanState);
  const chat = useMemo(() => new ChatSession(api), [api]);
  useEffect(() => () => chat.reset(), [chat]);

  useEffect(() => {
    const plans = store.current;
    let alive = true;
    api.fleet().then((f) => alive && setFleet(f)).catch(() => undefined);
    api.tasks({ limit: 50 }).then((t) => alive && setTasks(t)).catch(() => undefined);
    const stop = api.subscribe({
      fleet: setFleet,
      tasks: setTasks,
      audit: (a) => {
        setLastAudit(a);
        setAudits((xs) => [a, ...xs.filter((x) => x.id !== a.id)].slice(0, 30));
        plans?.onAudit(a);
      },
      mode: setLive,
    });
    return () => { alive = false; stop(); plans?.dispose(); };
  }, [api]);

  // ---- shared guest list ----
  const lastFetch = useRef(0);
  const seq = useRef(0);
  const fetchGuests = useCallback((force: boolean) => {
    if (hidden()) return;
    if (!force && Date.now() - lastFetch.current < GUEST_REFRESH_MS) return;
    lastFetch.current = Date.now();
    const n = ++seq.current;
    api.guests()
      .then((g) => { if (n === seq.current) { setGuests(g); setGuestsError(null); } })
      .catch((e) => { if (n === seq.current) setGuestsError(errMsg(e)); });
  }, [api]);
  useEffect(() => { fetchGuests(true); }, [fetchGuests, lastAudit?.id, lastAudit?.status]);
  useEffect(() => { fetchGuests(false); }, [fetchGuests, fleet?.updatedAt]);
  useEffect(() => {
    const onVis = () => { if (!hidden()) fetchGuests(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [fetchGuests]);
  const refreshGuests = useCallback(() => fetchGuests(true), [fetchGuests]);

  // ---- drawer ----
  const setDrawerFolded = useCallback((v: boolean) => { setFoldedState(v); writeStore(FOLD_KEY, v ? '1' : '0'); }, []);
  const openDrawer = useCallback((tab: DrawerTab) => {
    setDrawerTab(tab); writeStore(TAB_KEY, tab);
    setFoldedState(false); writeStore(FOLD_KEY, '0');
  }, []);

  // Request-counter guarded (see PlanStore): stale createPlan/runPlan responses are dropped.
  // Opening a change always unfolds the drawer to Changes: a change must be seen before it runs.
  const openPlan = useCallback((req: PlanRequest) => {
    lastReq.current = req;
    openDrawer('changes');
    return store.current!.open(req);
  }, [openDrawer]);
  const showPlan = useCallback((plan: Plan) => {
    lastReq.current = null;
    openDrawer('changes');
    store.current!.show(plan);
  }, [openDrawer]);
  const runPlan = useCallback((confirm?: string) => store.current!.run(confirm), []);
  const clearPlan = useCallback(() => { lastReq.current = null; store.current!.clear(); }, []);

  const refreshMe = useCallback(async () => {
    try { setMe(await api.me()); } catch { /* a 401 already went through onUnauthorized */ }
  }, [api, setMe]);

  // Coming back to the tab: re-read Me so lapsed cluster logins (loginExpired) show at once.
  useEffect(() => {
    const onVis = () => { if (!hidden()) void refreshMe(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshMe]);

  const clusterName = useCallback(
    (id: string) => me.clusters.find((c) => c.id === id)?.name ?? fleet?.clusters.find((c) => c.id === id)?.name ?? id,
    [me, fleet],
  );

  const runningChanges = useMemo(() => audits.filter((a) => a.status === 'running'), [audits]);
  const changePending = !!planState.plan && !runFinished(planState.result);

  const value = useMemo<AppCtx>(() => ({
    api, me, setMe, refreshMe, fleet, tasks, live, lastAudit, runningChanges, planState, lastPlanRequest: lastReq.current,
    openPlan, showPlan, runPlan, clearPlan, changePending, paletteOpen, setPaletteOpen,
    drawerTab, drawerFolded, openDrawer, setDrawerFolded, crumbs, setCrumbs, guests, guestsError, refreshGuests, clusterName, chat,
    dialog, setDialog, feedback, reloadFeedback,
  }), [api, me, setMe, refreshMe, fleet, tasks, live, lastAudit, runningChanges, planState, openPlan, showPlan, runPlan, clearPlan, changePending,
    paletteOpen, drawerTab, drawerFolded, openDrawer, setDrawerFolded, crumbs, guests, guestsError, refreshGuests, clusterName, chat,
    dialog, feedback, reloadFeedback]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/** Set the top-bar breadcrumb for the current page. */
export function useCrumbs(crumbs: Crumb[]) {
  const { setCrumbs } = useApp();
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    setCrumbs(JSON.parse(key) as Crumb[]);
  }, [key, setCrumbs]);
  // Clear on unmount (runs before the next page sets its own), so a stale trail never shows.
  useEffect(() => () => setCrumbs([]), [setCrumbs]);
}
