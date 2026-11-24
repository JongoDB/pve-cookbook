import { describe, expect, it } from 'vitest';
import { defaultLayout, layoutReducer, nextSpan, sanitizeLayout, type Layout } from './layout';

const ids = (l: Layout) => l.widgets.map((w) => w.id);
const base = (): Layout => ({
  version: 1, timeframe: 'day',
  widgets: [{ id: 'a', type: 'quorum', span: 3 }, { id: 'b', type: 'ceph', span: 3 }, { id: 'c', type: 'storage', span: 6 }],
});

describe('layoutReducer', () => {
  it('adds a widget from the catalog with its default span', () => {
    const l = layoutReducer(base(), { type: 'add', widget: 'tasks', id: 't' });
    expect(l.widgets.at(-1)).toEqual({ id: 't', type: 'tasks', span: 6 });
  });
  it('does not add a second copy of a single-instance widget', () => {
    const s = base();
    expect(layoutReducer(s, { type: 'add', widget: 'quorum' })).toBe(s);
  });
  it('allows several metric charts, each with its own config', () => {
    let l = layoutReducer(base(), { type: 'add', widget: 'metric', id: 'm1' });
    l = layoutReducer(l, { type: 'add', widget: 'metric', id: 'm2' });
    expect(l.widgets.filter((w) => w.type === 'metric').map((w) => w.config?.metric)).toEqual(['cpu', 'cpu']);
  });
  it('removes a widget', () => {
    expect(ids(layoutReducer(base(), { type: 'remove', id: 'b' }))).toEqual(['a', 'c']);
  });
  it('moves to an index and clamps', () => {
    expect(ids(layoutReducer(base(), { type: 'move', id: 'c', to: 0 }))).toEqual(['c', 'a', 'b']);
    expect(ids(layoutReducer(base(), { type: 'move', id: 'a', to: 99 }))).toEqual(['b', 'c', 'a']);
  });
  it('moves earlier / later by one, staying put at the edges', () => {
    expect(ids(layoutReducer(base(), { type: 'moveBy', id: 'b', delta: -1 }))).toEqual(['b', 'a', 'c']);
    expect(ids(layoutReducer(base(), { type: 'moveBy', id: 'b', delta: 1 }))).toEqual(['a', 'c', 'b']);
    const s = base();
    expect(layoutReducer(s, { type: 'moveBy', id: 'a', delta: -1 })).toBe(s);
  });
  it('cycles spans 3 → 4 → 6 → 8 → 12 → 3', () => {
    expect([3, 4, 6, 8, 12].map((s) => nextSpan(s as 3))).toEqual([4, 6, 8, 12, 3]);
    expect(layoutReducer(base(), { type: 'resize', id: 'c' }).widgets[2].span).toBe(8);
  });
  it('resets to the default widgets but keeps the time range', () => {
    const l = layoutReducer({ ...base(), timeframe: 'week' }, { type: 'reset' });
    expect(ids(l)).toEqual(ids(defaultLayout()));
    expect(l.timeframe).toBe('week');
  });
  it('sets the time range', () => {
    expect(layoutReducer(base(), { type: 'timeframe', timeframe: 'hour' }).timeframe).toBe('hour');
  });
});

describe('sanitizeLayout', () => {
  it('drops unknown widgets and duplicates, fixes bad spans and configs', () => {
    const l = sanitizeLayout({
      version: 1, timeframe: 'decade',
      widgets: [
        { id: 'a', type: 'quorum', span: 5 }, { id: 'a', type: 'ceph', span: 3 }, { id: 'x', type: 'gpus', span: 3 },
        { id: 'm', type: 'metric', span: 8, config: { kind: 'bogus', ids: ['pve1', 3], metric: 'nope' } },
      ],
    })!;
    expect(l.timeframe).toBe('day');
    expect(l.widgets).toEqual([
      { id: 'a', type: 'quorum', span: 3 },
      { id: 'm', type: 'metric', span: 8, config: { kind: 'node', cluster: '', ids: ['pve1'], metric: 'cpu' } },
    ]);
  });
  it('rejects other shapes', () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout({ version: 2, widgets: [] })).toBeNull();
  });
});
