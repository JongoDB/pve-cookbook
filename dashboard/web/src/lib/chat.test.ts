import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import type { Api, ChatEvent, ChatRequest, Plan } from '../api/types';
import { ChatSession, applyChatEvent, chatErrorMessage, toolLabel } from './chat';

const plan = { id: 'p1', action: 'api.call', title: 'Assistant draft: x', summary: '', clusterId: 'lab', destructive: true, steps: [], createdAt: 0, expiresAt: 1 } as Plan;

describe('applyChatEvent', () => {
  it('joins text deltas, merges tool updates by id, dedupes changes', () => {
    let parts = applyChatEvent([], { type: 'text', delta: 'Hel' });
    parts = applyChatEvent(parts, { type: 'text', delta: 'lo' });
    parts = applyChatEvent(parts, { type: 'tool', tool: { id: 't1', name: 'pve_get', status: 'running', input: { path: '/nodes/pve1/qemu/300/config' } } });
    parts = applyChatEvent(parts, { type: 'tool', tool: { id: 't1', name: 'pve_get', status: 'error', error: '403' } });
    parts = applyChatEvent(parts, { type: 'text', delta: 'after' });
    parts = applyChatEvent(parts, { type: 'change', plan });
    parts = applyChatEvent(parts, { type: 'change', plan });
    expect(parts).toEqual([
      { t: 'text', text: 'Hello' },
      { t: 'tool', tool: { id: 't1', name: 'pve_get', status: 'error', error: '403', input: { path: '/nodes/pve1/qemu/300/config' } } },
      { t: 'text', text: 'after' },
      { t: 'change', plan },
    ]);
  });
});

describe('toolLabel and errors', () => {
  it('describes tool calls in the admin\'s words', () => {
    expect(toolLabel({ id: '1', name: 'pve_get', status: 'ok', input: { path: '/nodes/pve1/qemu/300/config' } })).toBe('Read /nodes/pve1/qemu/300/config');
    expect(toolLabel({ id: '1', name: 'get_metrics', status: 'ok', input: { kind: 'node', id: 'pve1', timeframe: 'hour' } })).toBe('Checked metrics for node pve1, last hour');
    expect(toolLabel({ id: '1', name: 'get_findings', status: 'ok' })).toBe('Checked findings');
    expect(toolLabel({ id: '1', name: 'brand_new_tool', status: 'ok' })).toBe('brand new tool');
  });
  it('turns API errors into next steps', () => {
    expect(chatErrorMessage(new ApiError(409, 'conversation_full', 'x')).message).toMatch(/Start a new one/);
    expect(chatErrorMessage(new ApiError(429, 'rate_limited', 'x', 30)).message).toBe('Too many messages. Wait 30 seconds, then send again.');
    expect(chatErrorMessage(new ApiError(409, 'busy', 'x')).code).toBe('busy');
  });
});

type ChatFn = Api['chat'];
const session = (fn: ChatFn) => new ChatSession({ chat: fn });

describe('ChatSession', () => {
  it('streams an answer and keeps the conversation id for follow-ups', async () => {
    const reqs: ChatRequest[] = [];
    const s = session(async (r, on) => {
      reqs.push(r);
      on({ type: 'text', delta: 'Hi' });
      on({ type: 'change', plan });
      on({ type: 'done', conversationId: 'c1' });
    });
    await s.send('hello');
    await s.send('and then?');
    expect(reqs).toEqual([{ message: 'hello' }, { conversationId: 'c1', message: 'and then?' }]);
    const st = s.get();
    expect(st.busy).toBe(false);
    expect(st.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(st.turns[1]).toMatchObject({ done: true, parts: [{ t: 'text', text: 'Hi' }, { t: 'change', plan }] });
  });

  it('marks the conversation full on conversation_full and refuses to send more', async () => {
    const s = session(async () => { throw new ApiError(409, 'conversation_full', 'too long'); });
    await s.send('x');
    expect(s.get().full).toBe(true);
    expect(s.get().turns[1].error?.code).toBe('conversation_full');
    await s.send('y');
    expect(s.get().turns).toHaveLength(2);
    s.reset();
    expect(s.get()).toMatchObject({ full: false, turns: [], conversationId: null });
  });

  it('an in-stream error event ends the turn with the message', async () => {
    const s = session(async (_r, on) => { on({ type: 'text', delta: 'part' }); on({ type: 'error', message: 'provider timeout' }); });
    await s.send('x');
    expect(s.get().turns[1]).toMatchObject({ done: true, error: { message: 'provider timeout' } });
  });

  it('a stream that ends without done says so', async () => {
    const s = session(async (_r, on) => { on({ type: 'text', delta: 'part' }); });
    await s.send('x');
    expect(s.get().turns[1].error?.message).toMatch(/stopped before it finished/);
  });

  it('Stop aborts the request and marks the turn stopped', async () => {
    let seen: ((e: ChatEvent) => void) | null = null;
    const s = session((_r, on, signal) => new Promise<void>((_res, rej) => {
      seen = on;
      signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const p = s.send('long question');
    seen!({ type: 'text', delta: 'Thinking about' });
    expect(s.get().busy).toBe(true);
    s.stop();
    await p;
    expect(s.get().busy).toBe(false);
    expect(s.get().turns[1]).toMatchObject({ stopped: true, done: true, parts: [{ t: 'text', text: 'Thinking about' }] });
  });

  it('frames from a stream abandoned by New conversation are dropped', async () => {
    let emit: ((e: ChatEvent) => void) | null = null;
    let finish!: () => void;
    const s = session((_r, on) => new Promise<void>((res) => { emit = on; finish = res; }));
    const p = s.send('x');
    s.reset();
    emit!({ type: 'text', delta: 'late' });
    finish();
    await p;
    expect(s.get().turns).toEqual([]);
    expect(s.get().busy).toBe(false);
  });
});
