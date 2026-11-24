import type {
  SetupInfo,
  AddClusterRequest, AgentToken, CreateAgentTokenRequest, CreatedAgentToken, Api, AssistantSettings, AssistantSettingsUpdate, AssistantStatus, AuditEntry, ChatEvent, ChatRequest,
  Cluster, ClusterLoginRequest, ConsoleRequest, ConsoleTicket, EventHandlers, Fleet, Guest, GuestFilter, HostScan, HostsInfo,
  Doc, DocSummary, LoginRequest, Me, MetricQuery, MetricSeries, Plan, PlanRequest, Probe, Realm, RunResult, SchemaPathEntry, SchemaPathInfo, Task,
  UpdateClusterRequest,
} from './types';
import { readChatStream } from '../lib/sse';

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

/** The ApiError for a non-2xx answer and its (possibly empty) JSON body. */
function errorFrom(res: Response, data: unknown): ApiError {
  const e = (data ?? {}) as { error?: string; code?: string; retryAfter?: number };
  let retry = typeof e.retryAfter === 'number' ? e.retryAfter : undefined;
  if (retry === undefined) {
    const h = Number(res.headers?.get?.('Retry-After'));
    if (Number.isFinite(h) && h > 0) retry = h;
  }
  return new ApiError(res.status, e.code ?? (res.status === 429 ? 'rate_limited' : 'http_error'), e.error ?? `${res.status} ${res.statusText}`, retry);
}

const enc = encodeURIComponent;

const setupHeader = (t?: string): Record<string, string> => (t ? { 'X-Galley-Setup-Token': t } : {});

/** Reconnect delay for the event stream after `attempt` consecutive failures: 1 s doubling to 30 s. */
export const sseBackoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));

/**
 * Talks to the galley backend. Mutations carry X-Galley-CSRF from /api/me or /api/login and
 * always a JSON body with Content-Type: application/json ("{}" when there is nothing to send).
 * A 401 with code "unauthenticated" (the galley session ended) is reported once, centrally, through onUnauthorized.
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
    if (res.status === 204) return undefined as T;
    let data: unknown = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    // Only an ended galley session logs the user out. Other 401s (wrong password,
    // second factor required) are answers about credentials.
    if (res.status === 401 && !opts.noUnauthorized && (data as { code?: string } | null)?.code === 'unauthenticated') {
      this.csrf = '';
      this.unauthorized?.();
    }
    if (!res.ok) throw errorFrom(res, data);
    return data as T;
  }

  private keepCsrf(me: Me): Me { this.csrf = me.csrf; return me; }

  health() { return this.req<{ ok: boolean; version?: string; status?: string }>('GET', '/health'); }
  setup() { return this.req<SetupInfo>('GET', '/setup'); }
  async realms(clusterId: string) {
    const r = await this.req<Realm[] | null>('GET', `/realms${qs({ cluster: clusterId })}`, undefined, { noUnauthorized: true });
    return Array.isArray(r) ? r : [];
  }
  probe(endpoints: string[], setupToken?: string) {
    return this.req<{ endpoints: Probe[] }>('POST', '/clusters/probe', { endpoints }, { headers: setupHeader(setupToken) });
  }
  addCluster(r: AddClusterRequest, setupToken?: string) {
    return this.req<Cluster>('POST', '/clusters', r, { headers: setupHeader(setupToken) });
  }
  clusters() { return this.req<Cluster[]>('GET', '/clusters'); }
  updateCluster(id: string, r: UpdateClusterRequest) { return this.req<Cluster>('PUT', `/clusters/${encodeURIComponent(id)}`, r); }
  removeCluster(id: string) { return this.req<void>('DELETE', `/clusters/${encodeURIComponent(id)}`); }
  async login(r: LoginRequest) { return this.keepCsrf(await this.req<Me>('POST', '/login', r, { noUnauthorized: true })); }
  openidLogin(clusterId: string, realm: string) {
    return this.req<{ authUrl: string }>('POST', '/login/openid', { clusterId, realm }, { noUnauthorized: true });
  }
  async clusterLogin(id: string, r: ClusterLoginRequest) {
    // A 401 here means wrong credentials for that cluster, not that the galley session ended.
    return this.keepCsrf(await this.req<Me>('POST', `/clusters/${encodeURIComponent(id)}/login`, r, { noUnauthorized: true }));
  }
  async logout() { await this.req<void>('POST', '/logout'); this.csrf = ''; }
  async me() { return this.keepCsrf(await this.req<Me>('GET', '/me')); }
  getPref<T>(key: string) { return this.req<T>('GET', `/prefs/${encodeURIComponent(key)}`); }
  async putPref<T>(key: string, value: T) { await this.req<void>('PUT', `/prefs/${encodeURIComponent(key)}`, value); }
  fleet() { return this.req<Fleet>('GET', '/fleet'); }
  guests(f: GuestFilter = {}) { return this.req<Guest[]>('GET', `/guests${qs({ ...f })}`); }
  tasks(f: { cluster?: string; limit?: number } = {}) { return this.req<Task[]>('GET', `/tasks${qs({ ...f })}`); }
  targets(clusterId: string, node: string) {
    return this.req<string[]>('GET', `/nodes/${encodeURIComponent(clusterId)}/${encodeURIComponent(node)}/targets`);
  }
  async metrics(q: MetricQuery) {
    // A failed query answers 400 with the MetricSeries body (error set): return it as data.
    try {
      return await this.req<MetricSeries>('GET', `/metrics${qs({ cluster: q.cluster, kind: q.kind, id: q.id, timeframe: q.timeframe, cf: q.cf })}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) return { query: q, t: [], series: {}, error: e.message };
      throw e;
    }
  }
  metricsBatch(queries: MetricQuery[]) { return this.req<MetricSeries[]>('POST', '/metrics', { queries }); }
  async pve<T>(clusterId: string, path: string, query: Record<string, string | number | undefined> = {}) {
    const p = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    // Unlike other filters, an empty value is meaningful to PVE (pci-class-blacklist= lists every class).
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.set(k, String(v));
    const q = u.toString();
    const r = await this.req<{ data: T }>('GET', `/clusters/${encodeURIComponent(clusterId)}/pve/${p}${q ? `?${q}` : ''}`);
    return r.data;
  }
  createPlan(r: PlanRequest) { return this.req<Plan>('POST', '/plans', r); }
  async plans() { return (await this.req<Plan[] | null>('GET', '/plans')) ?? []; }
  async runPlan(id: string, confirm?: string): Promise<RunResult> {
    const r = await this.req<Partial<RunResult> & { auditId: string }>('POST', `/plans/${encodeURIComponent(id)}/run`, confirm ? { confirm } : {});
    return { ...r, results: Array.isArray(r.results) ? r.results : [] };
  }
  discardPlan(id: string) { return this.req<void>('DELETE', `/plans/${encodeURIComponent(id)}`); }
  audit(limit = 100) { return this.req<AuditEntry[]>('GET', `/audit${qs({ limit })}`); }

  assistantStatus() { return this.req<AssistantStatus>('GET', '/assistant'); }
  assistantSettings() { return this.req<AssistantSettings>('GET', '/settings/assistant'); }
  async putAssistantSettings(s: AssistantSettingsUpdate) { await this.req<void>('PUT', '/settings/assistant', s); }

  /** SSE over POST: EventSource cannot send a body, so read the response stream ourselves. */
  async chat(r: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...(this.csrf ? { 'X-Galley-CSRF': this.csrf } : {}) },
      credentials: 'same-origin',
      body: JSON.stringify(r),
      signal,
    });
    if (!res.ok) {
      let data: unknown = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (res.status === 401 && (data as { code?: string } | null)?.code === 'unauthenticated') { this.csrf = ''; this.unauthorized?.(); }
      throw errorFrom(res, data);
    }
    if (!res.body) throw new ApiError(502, 'no_stream', 'the assistant answered without a stream');
    await readChatStream(res.body, onEvent);
  }

  schemaPaths(clusterId: string) { return this.req<SchemaPathEntry[]>('GET', `/clusters/${enc(clusterId)}/schema`); }
  schema(clusterId: string, path: string) { return this.req<SchemaPathInfo>('GET', `/clusters/${enc(clusterId)}/schema${qs({ path })}`); }
  hosts(clusterId: string) { return this.req<HostsInfo>('GET', `/clusters/${enc(clusterId)}/hosts`); }
  scanHost(clusterId: string, node: string) { return this.req<HostScan>('POST', `/clusters/${enc(clusterId)}/hosts/${enc(node)}/scan`); }
  async pinHost(clusterId: string, node: string, fingerprint: string) {
    await this.req<void>('PUT', `/clusters/${enc(clusterId)}/hosts/${enc(node)}`, { fingerprint });
  }
  async unpinHost(clusterId: string, node: string) { await this.req<void>('DELETE', `/clusters/${enc(clusterId)}/hosts/${enc(node)}`); }
  async agentTokens() { return (await this.req<AgentToken[] | null>('GET', '/agent-tokens')) ?? []; }
  createAgentToken(r: CreateAgentTokenRequest) { return this.req<CreatedAgentToken>('POST', '/agent-tokens', r); }
  deleteAgentToken(id: string) { return this.req<void>('DELETE', `/agent-tokens/${enc(id)}`); }
  docs() { return this.req<DocSummary[]>('GET', '/docs'); }
  doc(slug: string) { return this.req<Doc>('GET', `/docs/${enc(slug)}`); }
  openConsole(clusterId: string, r: ConsoleRequest) { return this.req<ConsoleTicket>('POST', `/clusters/${enc(clusterId)}/console`, r); }

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
