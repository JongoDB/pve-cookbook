import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http';
import { defaultLayout, type Layout } from './layout';
import { LayoutPersistence } from './layoutStore';

const custom: Layout = { version: 1, timeframe: 'week', widgets: [{ id: 'q', type: 'quorum', span: 6 }] };

function fakeApi(get: () => Promise<unknown>) {
  const puts: unknown[] = [];
  return {
    puts,
    api: {
      getPref: <T,>() => get() as Promise<T>,
      putPref: async <T,>(_k: string, v: T) => { puts.push(v); },
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LayoutPersistence', () => {
  it('falls back to the default layout on 404 (never saved)', async () => {
    const { api } = fakeApi(() => Promise.reject(new ApiError(404, 'not_found', 'no such preference')));
    const r = await new LayoutPersistence(api).load();
    expect(r).toEqual({ layout: defaultLayout() });
  });

  it('loads a saved layout', async () => {
    const { api } = fakeApi(async () => custom);
    expect((await new LayoutPersistence(api).load()).layout).toEqual(custom);
  });

  it('shows the default with an error when loading fails otherwise', async () => {
    const { api } = fakeApi(() => Promise.reject(new ApiError(502, 'x', 'bad gateway')));
    const r = await new LayoutPersistence(api).load();
    expect(r.layout).toEqual(defaultLayout());
    expect(r.error).toMatch(/bad gateway/);
  });

  it('debounces saves into one PUT with the latest layout', async () => {
    const { api, puts } = fakeApi(async () => custom);
    const p = new LayoutPersistence(api, undefined, 500);
    p.save({ ...custom, timeframe: 'hour' });
    await vi.advanceTimersByTimeAsync(300);
    p.save({ ...custom, timeframe: 'month' });
    await vi.advanceTimersByTimeAsync(300);
    expect(puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(puts).toEqual([{ ...custom, timeframe: 'month' }]);
  });

  it('reports a failed save, and flushes a pending save on dispose', async () => {
    const errs: (string | null)[] = [];
    const api = { getPref: async <T,>() => custom as T, putPref: async () => { throw new Error('offline'); } };
    const p = new LayoutPersistence(api, (e) => errs.push(e), 500);
    p.save(custom);
    p.dispose();
    await vi.runAllTimersAsync();
    expect(errs).toEqual(['Your layout was not saved: offline']);
  });
});
