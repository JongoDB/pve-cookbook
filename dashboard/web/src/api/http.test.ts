import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, HttpApi, sseBackoff } from './http';

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('HttpApi', () => {
  it('reports a 401 from any API call to the onUnauthorized callback', async () => {
    stubFetch(401, { error: 'session expired', code: 'unauthenticated' });
    const api = new HttpApi();
    const cb = vi.fn();
    api.onUnauthorized(cb);
    await expect(api.fleet()).rejects.toMatchObject({ status: 401 });
    await expect(api.runPlan('p1')).rejects.toBeInstanceOf(ApiError);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does not treat a failed login (401) as an ended session', async () => {
    stubFetch(401, { error: 'authentication failure', code: 'auth_failed' });
    const api = new HttpApi();
    const cb = vi.fn();
    api.onUnauthorized(cb);
    await expect(api.login({ clusterId: 'c', username: 'u', realm: 'pam', password: 'x' })).rejects.toMatchObject({ code: 'auth_failed' });
    await expect(api.clusterLogin('c', { username: 'u', realm: 'pam', password: 'x' })).rejects.toMatchObject({ status: 401 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not end the session on a 401 that is not "unauthenticated"', async () => {
    stubFetch(401, { error: 'second factor required', code: 'otp_required' });
    const api = new HttpApi();
    const cb = vi.fn();
    api.onUnauthorized(cb);
    await expect(api.fleet()).rejects.toMatchObject({ status: 401 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not call a cleared callback, nor on other errors', async () => {
    stubFetch(500, { error: 'boom', code: 'internal' });
    const api = new HttpApi();
    const cb = vi.fn();
    api.onUnauthorized(cb);
    await expect(api.fleet()).rejects.toMatchObject({ status: 500 });
    stubFetch(401, {});
    api.onUnauthorized(null);
    await expect(api.fleet()).rejects.toMatchObject({ status: 401 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('sends Content-Type: application/json and a JSON body on every mutation', async () => {
    const calls = stubFetch(204);
    const api = new HttpApi();
    await api.logout();
    await api.removeCluster('c1');
    stubFetch(200, { auditId: 'a1', results: [] });
    await api.runPlan('p1');
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(c.init.body).toBe('{}');
    }
    const get = stubFetch(200, []);
    await api.guests();
    expect((get[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(get[0].init.body).toBeUndefined();
  });

  it('sends the setup code header on probe and add during setup', async () => {
    const calls = stubFetch(200, { endpoints: [] });
    const api = new HttpApi();
    await api.probe(['192.0.2.1'], 'code-1');
    await api.probe(['192.0.2.1']);
    expect((calls[0].init.headers as Record<string, string>)['X-Galley-Setup-Token']).toBe('code-1');
    expect((calls[1].init.headers as Record<string, string>)['X-Galley-Setup-Token']).toBeUndefined();
  });

  it('carries retryAfter from a 429 body or Retry-After header', async () => {
    stubFetch(429, { error: 'too many', code: 'rate_limited', retryAfter: 42 });
    const api = new HttpApi();
    await expect(api.login({ clusterId: 'c', username: 'u', realm: 'pam', password: 'x' })).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 42 });
    stubFetch(429, { error: 'too many', code: 'rate_limited' }, { 'Retry-After': '7' });
    await expect(api.login({ clusterId: 'c', username: 'u', realm: 'pam', password: 'x' })).rejects.toMatchObject({ retryAfter: 7 });
  });

  it('normalises the async 202 run shape', async () => {
    stubFetch(202, { auditId: 'a9', status: 'running' });
    expect(await new HttpApi().runPlan('p1')).toEqual({ auditId: 'a9', status: 'running', results: [] });
  });

  it('backs the event stream off from 1 s to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(sseBackoff)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
