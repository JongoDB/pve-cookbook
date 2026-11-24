import type {
  SetupInfo,
  AddClusterRequest, Api, AuditEntry, Cluster, ClusterLoginRequest, EventHandlers, Fleet, Guest,
  GuestFilter, LoginRequest, Me, Plan, PlanRequest, Probe, RunResult, Task,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
    super(message);
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Request options for HttpApi.req. */
interface ReqOpts {
  /** a 401 here is a credential failure, not an ended session (login endpoints) */
  noUnauthorized?: boolean;
  headers?: Record<string, string>;
}

const setupHeader = (t?: string): Record<string, string> => (t ? { 'X-Galley-Setup-Token': t } : {});

/** Reconnect delay for the event stream after `attempt` consecutive failures: 1 s doubling to 30 s. */
export const sseBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));

/**
 * Talks to the galley backend. Mutations carry X-Galley-CSRF from /api/me or /api/login and
 * always a JSON body with Content-Type: application/json ("{}" when there is nothing to send).
 * Any 401 outside the login calls is reported once, centrally, through onUnauthorized.
 */
export class HttpApi implements Api {
  private csrf = '';
  private unauthorized: (() => void) | null = null;

  onUnauthorized(fn: (() => void) | null) { this.unauthorized = fn; }

  private async req<T>(method: string, path: string, body?: unknown, opts: ReqOpts = {}): Promise<T> {
    const mutating = method !== 'GET' && method !== 'HEAD';
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (mutating) headers['Content-Type'] = 'application/json';
    if (mutating && this.csrf) headers['X-Galley-CSRF'] = this.csrf;
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: mutating ? JSON.stringify(body ?? {}) : undefined,
    });
    if (res.status === 401 && !opts.noUnauthorized) {
      this.csrf = '';
      this.unauthorized?.();
    }
    if (res.status === 204) return undefined as T;
    let data: unknown = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; code?: string; retryAfter?: number };
      let retry = typeof e.retryAfter === 'number' ? e.retryAfter : undefined;
      if (retry === undefined) {
        const h = Number(res.headers?.get?.('Retry-After'));
        if (Number.isFinite(h) && h > 0) retry = h;
      }
      throw new ApiError(res.status, e.code ?? 'http_error', e.error ?? `${res.status} ${res.statusText}`, retry);
    }
    return data as T;
  }

  private keepCsrf(me: Me): Me { this.csrf = me.csrf; return me; }

  health() { return this.req<{ ok: boolean; version: string }>('GET', '/health'); }
  setup() { return this.req<SetupInfo>('GET', '/setup'); }
  probe(endpoints: string[], setupToken?: string) {
    return this.req<{ endpoints: Probe[] }>('POST', '/clusters/probe', { endpoints }, { headers: setupHeader(setupToken) });
  }
  addCluster(r: AddClusterRequest, setupToken?: string) {
    return this.req<Cluster>('POST', '/clusters', r, { headers: setupHeader(setupToken) });
  }
  clusters() { return this.req<Cluster[]>('GET', '/clusters'); }
  removeCluster(id: string) { return this.req<void>('DELETE', `/clusters/${encodeURIComponent(id)}`); }
  async login(r: LoginRequest) { return this.keepCsrf(await this.req<Me>('POST', '/login', r, { noUnauthorized: true })); }
  async clusterLogin(id: string, r: ClusterLoginRequest) {
    // A 401 here means wrong credentials for that cluster, not that the galley session ended.
    return this.keepCsrf(await this.req<Me>('POST', `/clusters/${encodeURIComponent(id)}/login`, r, { noUnauthorized: true }));
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
  async runPlan(id: string, confirm?: string): Promise<RunResult> {
    const r = await this.req<Partial<RunResult> & { auditId: string }>('POST', `/plans/${encodeURIComponent(id)}/run`, confirm ? { confirm } : {});
    return { ...r, results: Array.isArray(r.results) ? r.results : [] };
  }
  audit(limit = 100) { return this.req<AuditEntry[]>('GET', `/audit${qs({ limit })}`); }

  /**
   * SSE with honest status reporting. While the stream is down the fleet/tasks are polled every
   * 5 s and the stream is retried with backoff (1 s doubling to 30 s). On a stream error the
   * session is probed with GET /api/me: a 401 there (or from a poll) goes through
   * onUnauthorized and stops everything.
   */
  subscribe(h: EventHandlers): () => void {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    const stopAll = () => {
      closed = true;
      es?.close(); es = null;
      if (timer) { clearInterval(timer); timer = null; }
      if (retry) { clearTimeout(retry); retry = null; }
    };
    const is401 = (e: unknown) => e instanceof ApiError && e.status === 401;

    const poll = async () => {
      if (closed) return;
      try {
        const [f, t] = await Promise.all([this.fleet(), this.tasks({ limit: 50 })]);
        if (!closed) { h.fleet?.(f); h.tasks?.(t); }
      } catch (e) {
        if (is401(e)) stopAll(); // onUnauthorized already fired in req()
        /* other errors: next tick retries */
      }
    };
    const startPolling = () => {
      if (closed) return;
      h.mode?.('polling');
      if (timer) return;
      void poll();
      timer = setInterval(poll, 5000);
    };
    const stopPolling = () => { if (timer) { clearInterval(timer); timer = null; } };
    const parse = <T,>(fn?: (v: T) => void) => (ev: MessageEvent) => {
      if (closed) return;
      try { fn?.(JSON.parse(ev.data) as T); } catch { /* ignore malformed frame */ }
    };

    const connect = () => {
      retry = null;
      if (closed) return;
      if (typeof EventSource === 'undefined') { startPolling(); return; }
      try {
        es = new EventSource('/api/events', { withCredentials: true });
      } catch {
        startPolling(); scheduleReconnect(); return;
      }
      es.addEventListener('open', () => {
        attempt = 0;
        stopPolling();
        if (!closed) h.mode?.('live');
      });
      es.addEventListener('fleet', parse<Fleet>(h.fleet));
      es.addEventListener('tasks', parse<Task[]>(h.tasks));
      es.addEventListener('audit', parse<AuditEntry>(h.audit));
      es.addEventListener('error', onError);
    };
    const scheduleReconnect = () => {
      if (closed || retry) return;
      retry = setTimeout(connect, sseBackoff(attempt));
      attempt++;
    };
    const onError = () => {
      // Take over from EventSource's own retry loop so a dead session cannot spin forever.
      es?.close(); es = null;
      if (closed) return;
      startPolling();
      this.me().then(
        () => scheduleReconnect(),
        (e) => { if (is401(e)) stopAll(); else scheduleReconnect(); },
      );
    };

    connect();
    return stopAll;
  }
}
