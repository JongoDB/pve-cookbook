import { request, type APIRequestContext } from '@playwright/test';
import { baseURL, CLUSTER, USERS, type Role } from './env';

/** A logged-in galley session driven over the REST API (cookie + CSRF header). */
export class Session {
  constructor(public ctx: APIRequestContext, public csrf: string, public me: Record<string, unknown>) {}

  static async login(role: Role): Promise<Session> {
    const u = USERS[role];
    const ctx = await request.newContext({ baseURL: baseURL() });
    const res = await ctx.post('/api/login', { data: { clusterId: CLUSTER, username: u.username, realm: u.realm, password: u.password } });
    if (!res.ok()) throw new Error(`login ${role}: ${res.status()} ${await res.text()}`);
    const me = await res.json();
    return new Session(ctx, me.csrf, me);
  }

  async get<T = unknown>(path: string): Promise<T> {
    const r = await this.ctx.get(path);
    if (!r.ok()) throw new Error(`GET ${path}: ${r.status()} ${await r.text()}`);
    return (await r.json()) as T;
  }

  async send(method: 'POST' | 'PUT' | 'DELETE', path: string, data: unknown = {}) {
    return this.ctx.fetch(path, { method, data: JSON.stringify(data), headers: { 'X-Galley-CSRF': this.csrf, 'Content-Type': 'application/json' } });
  }

  /** Mark the newest release notes as seen, so the What's new dialog stays closed. */
  async dismissWhatsNew() {
    const wn = await this.get<{ releases: { version: string }[] }>('/api/whats-new');
    const v = wn.releases[0]?.version;
    if (v) {
      const r = await this.send('PUT', '/api/prefs/whatsnew', v);
      if (r.status() !== 204) throw new Error(`whatsnew pref: ${r.status()}`);
    }
  }

  async dispose() { await this.ctx.dispose(); }
}
