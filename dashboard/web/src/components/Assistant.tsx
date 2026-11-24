import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import type { Plan, ToolEvent } from '../api/types';
import { useApp } from '../state/app';
import { useAsync } from '../lib/hooks';
import { toolLabel, type ChatTurn } from '../lib/chat';
import { planCli } from '../lib/plan';
import { ApiErrorView } from './ClusterLogin';
import { Markdown } from './Markdown';

const EXAMPLES = [
  'What needs my attention right now?',
  'Attach the second A2 GPU to llm-vllm',
  'What failed in the last hour, and why?',
];

export function AssistantPanel() {
  const { api, me, chat } = useApp();
  const status = useAsync(() => api.assistantStatus(), 'assistant-status');
  const state = useSyncExternalStore(chat.subscribe, chat.get);
  const disabledByServer = state.turns.some((t) => t.error?.code === 'assistant_disabled');
  useEffect(() => { if (disabledByServer) status.reload(); }, [disabledByServer, status]);

  if (status.error) return <ApiErrorView error={status.error} what="the assistant status" onRetry={status.reload} />;
  if (!status.data) return <div className="muted" role="status">Loading the assistant</div>;
  if (!status.data.enabled) {
    return (
      <div className="assistant-empty">
        <h2>Assistant</h2>
        <p className="text-2">The assistant is not set up yet. A galley admin can connect a model provider in Settings.</p>
        <p className="explain">When it is connected, it reads with your permissions and anything it proposes waits for you in Changes.</p>
        {me.galleyAdmin && <p><Link className="btn btn-sm" to="/settings">Set up the assistant</Link></p>}
      </div>
    );
  }
  return <Chat notice={status.data.dataNotice} model={status.data.model} />;
}

function Chat({ notice, model }: { notice: string; model: string }) {
  const { chat } = useApp();
  const state = useSyncExternalStore(chat.subscribe, chat.get);
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  // Follow the answer while it streams, unless the admin scrolled up to read.
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state]);

  const send = (text = draft) => {
    if (!text.trim() || state.busy || state.full) return;
    stick.current = true;
    void chat.send(text);
    setDraft('');
  };

  const newConversation = () => { chat.reset(); setDraft(''); input.current?.focus(); };

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="muted small">{model}</span>
        <button type="button" className="btn btn-sm" onClick={newConversation} disabled={!state.turns.length}>New conversation</button>
      </div>
      <div className="chat-log" ref={list} aria-live="polite" aria-busy={state.busy}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        <p className="chat-notice">{notice} It reads with your PVE permissions and can only draft changes; you review and apply them in Changes.</p>
        {state.turns.length === 0 && (
          <div className="chat-examples">
            <span className="muted small">Try</span>
            {EXAMPLES.map((x) => <button key={x} type="button" className="chip-btn" onClick={() => send(x)}>{x}</button>)}
          </div>
        )}
        {state.turns.map((t) => (t.role === 'user'
          ? <div key={t.id} className="msg msg-user"><span className="sr-only">You: </span>{t.text}</div>
          : <AssistantTurn key={t.id} turn={t} />))}
      </div>
      {state.full ? (
        <div className="notice notice-info chat-full"><div className="grow">This conversation is full.</div><button type="button" className="btn btn-sm btn-primary" onClick={newConversation}>New conversation</button></div>
      ) : (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label className="sr-only" htmlFor="chat-input">Message the assistant</label>
          <textarea
            id="chat-input" ref={input} rows={2} value={draft} placeholder="Message the assistant"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
          />
          {state.busy
            ? <button type="button" className="btn" onClick={() => chat.stop()}>Stop</button>
            : <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>Send</button>}
        </form>
      )}
      <p className="explain composer-hint">Enter sends, Shift+Enter adds a line.</p>
    </div>
  );
}

function AssistantTurn({ turn }: { turn: ChatTurn }) {
  const empty = turn.parts.length === 0;
  return (
    <div className="msg msg-assistant">
      <span className="sr-only">Assistant: </span>
      {turn.parts.map((p, i) => {
        if (p.t === 'text') return <Markdown key={i} text={p.text} />;
        if (p.t === 'tool') return <ToolLine key={p.tool.id || i} tool={p.tool} />;
        return <ChangeCard key={p.plan.id} plan={p.plan} />;
      })}
      {!turn.done && empty && <div className="muted small" role="status">Thinking</div>}
      {turn.stopped && <div className="muted small">Stopped.</div>}
      {turn.error && <div className="notice notice-error small" role="alert"><div className="grow">{turn.error.message}</div></div>}
    </div>
  );
}

function ToolLine({ tool }: { tool: ToolEvent }) {
  const label = toolLabel(tool);
  return (
    <div className={`tool-line tool-${tool.status}`}>
      <span className="tool-dot" aria-hidden="true" />
      <span className="grow">
        {label}
        <span className="sr-only">{tool.status === 'running' ? ', running' : tool.status === 'error' ? ', failed' : ', done'}</span>
        {tool.status === 'error' && tool.error && <span className="tool-err">{tool.error}</span>}
      </span>
    </div>
  );
}

function ChangeCard({ plan }: { plan: Plan }) {
  const { showPlan, planState, clusterName, me } = useApp();
  const title = plan.title.replace(/^Assistant draft:\s*/i, '');
  const open = planState.plan?.id === plan.id;
  return (
    <div className="chat-change">
      <div className="chat-change-head">
        <div className="chat-change-label">Assistant draft</div>
        <div className="strong">{title}</div>
        <div className="chat-change-sub">{clusterName(plan.clusterId)}, {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}. Runs as you, {me.user}, once you apply it.</div>
        {plan.summary && <p className="chat-change-sub" style={{ marginTop: 6 }}>{plan.summary}</p>}
      </div>
      <pre className="chat-change-cli" aria-label="Commands this draft would run">{planCli(plan)}</pre>
      <div className="chat-change-foot">
        <button type="button" className="btn btn-sm btn-apply" onClick={() => showPlan(plan)}>{open ? 'Open in Changes' : 'Review in Changes'}</button>
        <span className="chat-change-sub">You confirm it there by typing <code>{plan.confirmText ?? 'the confirmation'}</code>.</span>
      </div>
    </div>
  );
}
