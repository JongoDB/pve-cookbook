import type {
  SetupInfo,
  AddClusterRequest, Api, AuditEntry, Cluster, ClusterLoginRequest, EventHandlers, Fleet, Guest,
  GuestFilter, LoginRequest, Me, Plan, PlanRequest, Probe, RunResult, Task,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Talks to the galley backend. Mutations carry X-Galley-CSRF from /api/me or /api/login. */
export class HttpApi implements Api {
  private csrf = '';

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrf) headers['X-Galley-CSRF'] = this.csrf;
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    let data: unknown = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; code?: string };
      throw new ApiError(res.status, e.code ?? 'http_error', e.error ?? `${res.status} ${res.statusText}`);
    }
    return data as T;
  }

  private keepCsrf(me: Me): Me { this.csrf = me.csrf; return me; }

  health() { return this.req<{ ok: boolean; version: string }>('GET', '/health'); }
  setup() { return this.req<SetupInfo>('GET', '/setup'); }
  probe(endpoints: string[]) { return this.req<{ endpoints: Probe[] }>('POST', '/clusters/probe', { endpoints }); }
  addCluster(r: AddClusterRequest) { return this.req<Cluster>('POST', '/clusters', r); }
  clusters() { return this.req<Cluster[]>('GET', '/clusters'); }
  removeCluster(id: string) { return this.req<void>('DELETE', `/clusters/${encodeURIComponent(id)}`); }
  async login(r: LoginRequest) { return this.keepCsrf(await this.req<Me>('POST', '/login', r)); }
  async clusterLogin(id: string, r: ClusterLoginRequest) {
    return this.keepCsrf(await this.req<Me>('POST', `/clusters/${encodeURIComponent(id)}/login`, r));
  }
  async logout() { await this.req<void>('POST', '/logout'); this.csrf = ''; }
  async me() { return this.keepCsrf(await this.req<Me>('GET', '/me')); }
  fleet() { return this.req<Fleet>('GET', '/fleet'); }
  guests(f: GuestFilter = {}) { return this.req<Guest[]>('GET', `/guests${qs({ ...f })}`); }
  tasks(f: { cluster?: string; limit?: number } = {}) { return this.req<Task[]>('GET', `/tasks${qs({ ...f })}`); }
  targets(clusterId: string, node: string) {
    return this.req<string[]>('GET', `/nodes/${encodeURIComponent(clusterId)}/${encodeURIComponent(node)}/targets`);
  }
  createPlan(r: PlanRequest) { return this.req<Plan>('POST', '/plans', r); }
  runPlan(id: string, confirm?: string) {
    return this.req<RunResult>('POST', `/plans/${encodeURIComponent(id)}/run`, confirm ? { confirm } : {});
  }
  audit(limit = 100) { return this.req<AuditEntry[]>('GET', `/audit${qs({ limit })}`); }

  /** SSE with automatic fallback to 5 s polling when the stream is unavailable. */
  subscribe(h: EventHandlers): () => void {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const poll = async () => {
      try {
        const [f, t] = await Promise.all([this.fleet(), this.tasks({ limit: 50 })]);
        h.fleet?.(f); h.tasks?.(t);
      } catch { /* next tick retries */ }
    };
    const startPolling = () => {
      if (timer || closed) return;
      h.mode?.('polling');
      void poll();
      timer = setInterval(poll, 5000);
    };
    const parse = <T,>(fn?: (v: T) => void) => (ev: MessageEvent) => {
      try { fn?.(JSON.parse(ev.data) as T); } catch { /* ignore malformed frame */ }
    };

    try {
      es = new EventSource('/api/events', { withCredentials: true });
      es.addEventListener('open', () => {
        if (timer) { clearInterval(timer); timer = null; }
        h.mode?.('live');
      });
      es.addEventListener('fleet', parse<Fleet>(h.fleet));
      es.addEventListener('tasks', parse<Task[]>(h.tasks));
      es.addEventListener('audit', parse<AuditEntry>(h.audit));
      es.addEventListener('error', () => startPolling());
    } catch {
      startPolling();
    }
    return () => {
      closed = true;
      es?.close();
      if (timer) clearInterval(timer);
    };
  }
}
