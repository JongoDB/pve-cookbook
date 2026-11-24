// The assistant conversation, kept outside React: it survives drawer tab switches and folding,
// and keeps streaming while the admin reviews a draft in Changes.
import { ApiError } from '../api/http';
import type { Api, ChatEvent, Plan, ToolEvent } from '../api/types';
import { GALLEY_ACTION_LABEL } from './plan';

export type ChatPart = { t: 'text'; text: string } | { t: 'tool'; tool: ToolEvent } | { t: 'change'; plan: Plan };

export interface ChatTurn {
  id: number;
  role: 'user' | 'assistant';
  /** user turns */
  text?: string;
  /** assistant turns, in arrival order */
  parts: ChatPart[];
  error?: { message: string; code?: string };
  /** stream finished (done, error or stopped) */
  done: boolean;
  stopped?: boolean;
}

export interface ChatState {
  conversationId: string | null;
  turns: ChatTurn[];
  busy: boolean;
  /** the server said this conversation is full: only "New conversation" helps */
  full: boolean;
}

export const EMPTY_CHAT: ChatState = { conversationId: null, turns: [], busy: false, full: false };

/** Fold one stream frame into an assistant turn's parts. Text deltas join the last text part; tool updates merge by id. */
export function applyChatEvent(parts: ChatPart[], e: ChatEvent): ChatPart[] {
  switch (e.type) {
    case 'text': {
      const last = parts[parts.length - 1];
      if (last?.t === 'text') return [...parts.slice(0, -1), { t: 'text', text: last.text + e.delta }];
      return [...parts, { t: 'text', text: e.delta }];
    }
    case 'tool': {
      const i = parts.findIndex((p) => p.t === 'tool' && p.tool.id === e.tool.id);
      if (i < 0) return [...parts, { t: 'tool', tool: e.tool }];
      const prev = (parts[i] as { t: 'tool'; tool: ToolEvent }).tool;
      const merged: ToolEvent = { ...prev, ...e.tool, input: e.tool.input ?? prev.input };
      return parts.map((p, j) => (j === i ? { t: 'tool', tool: merged } : p));
    }
    case 'change':
      return parts.some((p) => p.t === 'change' && p.plan.id === e.plan.id) ? parts : [...parts, { t: 'change', plan: e.plan }];
    default:
      return parts;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One activity line per tool call, in the admin's words. */
export function toolLabel(t: ToolEvent): string {
  const i = t.input ?? {};
  switch (t.name) {
    case 'pve_get': return str(i.path) ? `Read ${str(i.path)}` : 'Read from the PVE API';
    case 'get_metrics': return `Checked metrics${str(i.kind) ? ` for ${str(i.kind)}${str(i.id) ? ` ${str(i.id)}` : ''}` : ''}${str(i.timeframe) ? `, last ${str(i.timeframe)}` : ''}`;
    case 'list_resources': return `Listed ${str(i.kind) && str(i.kind) !== 'all' ? str(i.kind) : 'resources'}${str(i.query) ? ` matching "${str(i.query)}"` : ''}`;
    case 'get_findings': return 'Checked findings';
    case 'list_tasks': return 'Read the task log';
    case 'api_schema': return str(i.path) ? `Looked up ${str(i.path)} in the API schema` : 'Looked up the API schema';
    case 'propose_change': return `Drafted a change${str(i.title) ? `: ${str(i.title)}` : ''}`;
    case 'propose_action': {
      const what = str(i.title) || GALLEY_ACTION_LABEL[str(i.action)] || str(i.action);
      return `Drafted a change${what ? `: ${what}` : ''}`;
    }
    case 'search_docs': return str(i.query) ? `Searched the docs for “${str(i.query)}”` : 'Searched the docs';
    case 'read_doc': return `Read help: ${str(i.slug) || 'a page'}`;
    case 'propose_host_command': return `Drafted a command for ${str(i.node) || 'a node'}`;
    default: return t.name.replace(/_/g, ' ');
  }
}

/** What to tell the admin when a message could not be sent or the stream failed. */
export function chatErrorMessage(e: unknown): { message: string; code?: string } {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'conversation_full': return { code: e.code, message: 'This conversation is full. Start a new one to keep going.' };
      case 'conversation_not_found': return { code: e.code, message: 'This conversation ended on the server (it expired or galley restarted). Start a new one.' };
      case 'assistant_disabled': return { code: e.code, message: 'The assistant was turned off. A galley admin can set it up again in Settings.' };
      case 'busy': return { code: e.code, message: 'The assistant is still answering in this conversation. Wait for it, or stop it first.' };
      case 'rate_limited': return { code: e.code, message: `Too many messages. Wait ${e.retryAfter ? `${e.retryAfter} seconds` : 'a minute'}, then send again.` };
      case 'assistant_misconfigured': return { code: e.code, message: `The assistant is not configured correctly: ${e.message}. A galley admin can fix it in Settings.` };
      default:
        if (e.status === 429) return { code: 'rate_limited', message: 'Too many messages. Wait a minute, then send again.' };
        return { code: e.code, message: `The assistant could not answer: ${e.message}` };
    }
  }
  return { message: `The assistant could not answer: ${e instanceof Error ? e.message : String(e)}` };
}

const isAbort = (e: unknown) => (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';

export class ChatSession {
  private state: ChatState = EMPTY_CHAT;
  private listeners = new Set<() => void>();
  private ctrl: AbortController | null = null;
  private seq = 0;
  /** bumps on reset: frames of a superseded stream are dropped */
  private gen = 0;

  constructor(private api: Pick<Api, 'chat'>) {}

  get = (): ChatState => this.state;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  private set(s: ChatState) { this.state = s; for (const l of this.listeners) l(); }

  private patchTurn(id: number, fn: (t: ChatTurn) => ChatTurn) {
    this.set({ ...this.state, turns: this.state.turns.map((t) => (t.id === id ? fn(t) : t)) });
  }

  async send(message: string): Promise<void> {
    const text = message.trim();
    if (!text || this.state.busy || this.state.full) return;
    const gen = this.gen;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const user: ChatTurn = { id: ++this.seq, role: 'user', text, parts: [], done: true };
    const reply: ChatTurn = { id: ++this.seq, role: 'assistant', parts: [], done: false };
    this.set({ ...this.state, busy: true, turns: [...this.state.turns, user, reply] });
    let ended = false;
    try {
      await this.api.chat({ ...(this.state.conversationId ? { conversationId: this.state.conversationId } : {}), message: text }, (e) => {
        if (gen !== this.gen) return;
        if (e.type === 'done') {
          ended = true;
          this.set({ ...this.state, conversationId: e.conversationId || this.state.conversationId });
          this.patchTurn(reply.id, (t) => ({ ...t, done: true }));
        } else if (e.type === 'error') {
          ended = true;
          const full = /too long|start a new one/i.test(e.message);
          this.set({ ...this.state, full: this.state.full || full });
          this.patchTurn(reply.id, (t) => ({ ...t, done: true, error: { message: e.message, ...(full ? { code: 'conversation_full' } : {}) } }));
        } else {
          this.patchTurn(reply.id, (t) => ({ ...t, parts: applyChatEvent(t.parts, e) }));
        }
      }, ctrl.signal);
      if (gen === this.gen && !ended) {
        this.patchTurn(reply.id, (t) => ({ ...t, done: true, error: { message: 'The answer stopped before it finished (the connection closed). Send the message again to retry.' } }));
      }
    } catch (e) {
      if (gen !== this.gen) return;
      if (isAbort(e)) {
        this.patchTurn(reply.id, (t) => ({ ...t, done: true, stopped: true }));
      } else {
        const err = chatErrorMessage(e);
        const reset = err.code === 'conversation_not_found';
        this.set({ ...this.state, full: this.state.full || err.code === 'conversation_full', conversationId: reset ? null : this.state.conversationId });
        this.patchTurn(reply.id, (t) => ({ ...t, done: true, error: err }));
      }
    } finally {
      if (gen === this.gen) {
        this.ctrl = null;
        this.set({ ...this.state, busy: false });
      }
    }
  }

  /** Abort the running answer (the fetch is cancelled; the server stops at its next write). */
  stop() { this.ctrl?.abort(); }

  /** Start over. The old conversation simply expires on the server. */
  reset() {
    this.gen++;
    this.ctrl?.abort();
    this.ctrl = null;
    this.set(EMPTY_CHAT);
  }
}
