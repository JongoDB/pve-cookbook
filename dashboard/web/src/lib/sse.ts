// Server-Sent Events parsing for streams EventSource cannot open (a POST with a JSON body).
// Follows the WHATWG event-stream rules that matter here: lines end in \n, \r\n or \r;
// `event:` names the frame, `data:` lines are joined with \n, a blank line dispatches,
// lines starting with ':' are comments, and one optional space after the colon is dropped.
import type { ChatEvent, Plan, ToolEvent } from '../api/types';

export interface SseFrame { event: string; data: string }

export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private decoder = new TextDecoder();
  /** a \r ended the last chunk: a \n starting the next one belongs to it */
  private pendingCR = false;

  constructor(private onFrame: (f: SseFrame) => void) {}

  /** Feed raw bytes; a multi-byte character split across chunks is kept until complete. */
  pushBytes(chunk: Uint8Array) { this.push(this.decoder.decode(chunk, { stream: true })); }

  push(text: string) {
    if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
    this.pendingCR = false;
    this.buf += text;
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A trailing lone \r may be the first half of \r\n: wait for the next chunk.
      if (m[0] === '\r' && m.index === this.buf.length - 1) {
        this.line(this.buf.slice(0, m.index));
        this.buf = '';
        this.pendingCR = true;
        break;
      }
      this.line(this.buf.slice(0, m.index));
      this.buf = this.buf.slice(m.index + m[0].length);
    }
  }

  /** The stream ended: flush the decoder. An unterminated last frame is dropped, as the spec says. */
  end() {
    const rest = this.decoder.decode();
    if (rest) this.push(rest);
  }

  private line(l: string) {
    if (l === '') {
      if (this.data.length) this.onFrame({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

/** Map one assistant frame to a typed event; unknown or malformed frames are ignored (null). */
export function chatEvent(f: SseFrame): ChatEvent | null {
  let v: unknown;
  try { v = JSON.parse(f.data); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  switch (f.event) {
    case 'text': return typeof o.delta === 'string' ? { type: 'text', delta: o.delta } : null;
    case 'tool': return typeof o.name === 'string' ? { type: 'tool', tool: o as unknown as ToolEvent } : null;
    case 'change': return typeof o.id === 'string' && Array.isArray(o.steps) ? { type: 'change', plan: o as unknown as Plan } : null;
    case 'done': return { type: 'done', conversationId: typeof o.conversationId === 'string' ? o.conversationId : '' };
    case 'error': return { type: 'error', message: typeof o.message === 'string' ? o.message : 'the assistant stopped with an error' };
    default: return null;
  }
}

/** Read a fetch body to the end, emitting assistant events. */
export async function readChatStream(body: ReadableStream<Uint8Array>, onEvent: (e: ChatEvent) => void): Promise<void> {
  const parser = new SseParser((f) => { const e = chatEvent(f); if (e) onEvent(e); });
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.pushBytes(value);
    }
    parser.end();
  } finally {
    reader.releaseLock();
  }
}
