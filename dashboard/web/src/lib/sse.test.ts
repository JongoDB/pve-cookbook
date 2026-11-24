import { describe, expect, it } from 'vitest';
import { SseParser, chatEvent, readChatStream, type SseFrame } from './sse';
import type { ChatEvent } from '../api/types';

const collect = () => {
  const frames: SseFrame[] = [];
  return { frames, p: new SseParser((f) => frames.push(f)) };
};

const STREAM = 'event: text\ndata: {"delta":"Hel"}\n\nevent: text\ndata: {"delta":"lo"}\n\n: keep-alive\n\nevent: done\ndata: {"conversationId":"c1"}\n\n';

describe('SseParser (SSE over a POST response)', () => {
  it('parses frames regardless of where chunks split', () => {
    const whole = collect();
    whole.p.push(STREAM);
    expect(whole.frames.map((f) => f.event)).toEqual(['text', 'text', 'done']);
    // every possible split point, and one character at a time
    for (let i = 1; i < STREAM.length; i++) {
      const c = collect();
      c.p.push(STREAM.slice(0, i));
      c.p.push(STREAM.slice(i));
      expect(c.frames).toEqual(whole.frames);
    }
    const one = collect();
    for (const ch of STREAM) one.p.push(ch);
    expect(one.frames).toEqual(whole.frames);
  });

  it('handles CRLF and lone CR line endings, also split between chunks', () => {
    const c = collect();
    c.p.push('event: text\r');
    c.p.push('\ndata: {"delta":"a"}\r\n\r');
    c.p.push('\nevent: done\rdata: {}\r\r');
    expect(c.frames).toEqual([{ event: 'text', data: '{"delta":"a"}' }, { event: 'done', data: '{}' }]);
  });

  it('joins multi-line data, ignores comments and drops an unterminated last frame', () => {
    const c = collect();
    c.p.push(':comment\ndata: line1\ndata:line2\n\nevent: text\ndata: {"delta":"cut');
    c.p.end();
    expect(c.frames).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('keeps multi-byte characters intact when bytes split inside them', () => {
    const bytes = new TextEncoder().encode('event: text\ndata: {"delta":"grüße 🚀"}\n\n');
    const c = collect();
    for (const b of bytes) c.p.pushBytes(new Uint8Array([b]));
    c.p.end();
    expect(JSON.parse(c.frames[0].data).delta).toBe('grüße 🚀');
  });
});

describe('chatEvent', () => {
  it('maps assistant frames and ignores malformed ones', () => {
    expect(chatEvent({ event: 'text', data: '{"delta":"x"}' })).toEqual({ type: 'text', delta: 'x' });
    expect(chatEvent({ event: 'tool', data: '{"id":"t","name":"pve_get","status":"ok"}' })).toMatchObject({ type: 'tool', tool: { name: 'pve_get', status: 'ok' } });
    expect(chatEvent({ event: 'change', data: '{"id":"p1","steps":[]}' })).toMatchObject({ type: 'change', plan: { id: 'p1' } });
    expect(chatEvent({ event: 'error', data: '{"message":"boom"}' })).toEqual({ type: 'error', message: 'boom' });
    expect(chatEvent({ event: 'text', data: 'not json' })).toBeNull();
    expect(chatEvent({ event: 'change', data: '{"id":"p1"}' })).toBeNull();
    expect(chatEvent({ event: 'surprise', data: '{}' })).toBeNull();
  });

  it('reads a whole fetch body stream', async () => {
    const enc = new TextEncoder().encode(STREAM);
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) { for (let i = 0; i < enc.length; i += 7) ctrl.enqueue(enc.slice(i, i + 7)); ctrl.close(); },
    });
    const got: ChatEvent[] = [];
    await readChatStream(body, (e) => got.push(e));
    expect(got).toEqual([{ type: 'text', delta: 'Hel' }, { type: 'text', delta: 'lo' }, { type: 'done', conversationId: 'c1' }]);
  });
});
