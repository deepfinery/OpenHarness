import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  CornerDownLeft,
  LoaderCircle,
  MessageSquare,
  Play,
  RotateCcw,
  Send,
  Terminal,
  UserRound,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, errorMessage, send, timestamp, type Data } from '../api';
import { Button, Empty, ErrorNotice, IconButton, Status } from './ui';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'];
type Message = { role: 'user' | 'assistant'; content: string };
export function Playground({ data, initialTarget }: { data: Data; initialTarget?: string }) {
  const targets = [
    ...data.agents.map((a) => ({ ...a, type: 'agent' })),
    ...data.workflows.map((w) => ({ ...w, type: 'workflow' })),
  ];
  const [target, setTarget] = useState(
    initialTarget || (targets[0] ? `${targets[0].type}:${targets[0].id}` : ''),
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [input, setInput] = useState('');
  const [run, setRun] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target && targets[0]) setTarget(`${targets[0].type}:${targets[0].id}`);
  }, [data, target]);
  const current = targets.find((t) => `${t.type}:${t.id}` === target);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, busy]);
  useEffect(() => {
    if (!run?.id || terminal.includes(run.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api(`/runs/${run.id}`);
        if (stopped) return;
        setRun(next);
        if (terminal.includes(next.status)) {
          setBusy(false);
          if (next.status === 'succeeded')
            setMessages((m) => [...m, { role: 'assistant', content: next.output }]);
          else setError(next.error ?? `Run ${next.status}`);
        } else timer = setTimeout(poll, 1200);
      } catch (e) {
        if (!stopped) {
          setError(errorMessage(e));
          timer = setTimeout(poll, 4000);
        }
      }
    }
    timer = setTimeout(poll, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [run?.id]);
  async function submit() {
    if (!input.trim() || busy || !current) return;
    setBusy(true);
    setError('');
    const text = input.trim();
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    try {
      const r = await send('/chat', {
        [current.type === 'agent' ? 'agentId' : 'workflowId']: current.id,
        message: text,
        conversationId,
      });
      setConversationId(r.conversationId);
      setRun(r);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      setInput(text);
      setMessages((m) => m.slice(0, -1));
    }
  }
  return (
    <div className="playground">
      <div className="playground-main">
        <div className="playground-toolbar">
          <div>
            <span className="eyebrow">PLAYGROUND</span>
            <select
              aria-label="Playground agent or workflow"
              value={target}
              disabled={busy}
              onChange={(e) => {
                setTarget(e.target.value);
                setMessages([]);
                setConversationId(undefined);
                setRun(null);
                setError('');
              }}
            >
              <option value="" disabled>
                Choose an agent or workflow
              </option>
              {targets.map((t) => (
                <option key={`${t.type}:${t.id}`} value={`${t.type}:${t.id}`}>
                  {t.name} · {t.type}
                </option>
              ))}
            </select>
          </div>
          <IconButton
            title="New conversation"
            disabled={busy}
            onClick={() => {
              setMessages([]);
              setConversationId(undefined);
              setRun(null);
              setError('');
            }}
          >
            <RotateCcw size={18} />
          </IconButton>
        </div>
        <div className="chat-scroll">
          {!messages.length ? (
            <div className="chat-welcome">
              <div className="welcome-orbit">
                <Bot size={34} />
                <span className="orbit-point one" />
                <span className="orbit-point two" />
              </div>
              <div className="eyebrow">A SPACE TO EXPERIMENT</div>
              <h2>{current ? `Meet ${current.name}.` : 'Put your agents to work.'}</h2>
              <p>
                {current
                  ? 'Ask a question, give it a task, and follow each step as it works.'
                  : 'Create an agent or workflow, then start a conversation here.'}
              </p>
              {current && (
                <div className="suggestions">
                  {['What can you help me with?', 'Summarize the knowledge available to you.'].map((s) => (
                    <button key={s} onClick={() => setInput(s)}>
                      {s}
                      <CornerDownLeft size={14} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((m, index) => (
              <div className={`chat-message ${m.role}`} key={index}>
                <div className="message-avatar">
                  {m.role === 'user' ? <UserRound size={17} /> : <Bot size={18} />}
                </div>
                <div className="message-body">
                  <strong>{m.role === 'user' ? 'You' : (current?.name ?? 'Agent')}</strong>
                  <Markdown text={m.content} />
                </div>
              </div>
            ))
          )}
          {busy && (
            <div className="chat-message assistant">
              <div className="message-avatar">
                <Bot size={18} />
              </div>
              <div className="message-body">
                <strong>{current?.name}</strong>
                <div className="thinking">
                  <span />
                  <span />
                  <span />
                  <small>
                    {run?.status === 'queued' ? 'Waiting for the runner' : 'Working on your request'}
                  </small>
                </div>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>
        <div className="chat-compose">
          <ErrorNotice error={error} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <textarea
              aria-label="Message your agent"
              placeholder={current ? `Message ${current.name}…` : 'Choose an agent to begin…'}
              value={input}
              disabled={!current || busy}
              rows={2}
              maxLength={32000}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            {busy ? (
              <IconButton
                title="Cancel run"
                onClick={() => void send(`/runs/${run.id}/cancel`).catch((e) => setError(errorMessage(e)))}
                disabled={!run?.id}
              >
                <CircleStop size={21} />
              </IconButton>
            ) : (
              <button className="send-button" disabled={!input.trim() || !current} aria-label="Send message">
                <Send size={18} />
              </button>
            )}
          </form>
          <small>
            Enter to send · Shift + Enter for a new line · Runs use your configured model provider
          </small>
        </div>
      </div>
      <aside className="trace-panel">
        <div className="trace-heading">
          <Terminal size={17} />
          <h3>Execution trace</h3>
          {run && <Status status={run.status} />}
        </div>
        {run ? (
          <>
            <div className="trace-meta">
              <small>RUN ID</small>
              <code>{run.id}</code>
              <span>{timestamp(run.createdAt)}</span>
            </div>
            <Trace events={run.events ?? []} />
            {run.error && <ErrorNotice error={run.error} />}
          </>
        ) : (
          <div className="trace-placeholder">
            <div className="trace-line" />
            <div className="trace-line" />
            <div className="trace-line" />
            <p>Your agent’s steps, model calls, tools, and knowledge sources will appear here.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
export function Trace({ events }: { events: any[] }) {
  return (
    <div className="trace-list">
      {events.map((event, index) => (
        <details className={`trace-event ${event.type}`} key={`${index}:${event.at}`}>
          <summary>
            <span className="trace-dot">
              {event.type.endsWith('completed') ? <Check size={10} /> : <span />}
            </span>
            <span>
              <strong>{event.message}</strong>
              <small>
                {event.type.replaceAll('_', ' ')}
                {event.nodeId ? ` · ${event.nodeId}` : ''}
              </small>
            </span>
            <time>
              {new Date(event.at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </time>
          </summary>
          {event.data && <pre>{JSON.stringify(event.data, null, 2)}</pre>}
        </details>
      ))}
    </div>
  );
}
export function EmbedChat({ id }: { id: string }) {
  const [token] = useState(() => decodeURIComponent(location.hash.slice(1)));
  const [name, setName] = useState('Agent');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const embedFetch = (path: string, options: RequestInit = {}) =>
    api(`/embed/${id}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Embed ${token}` },
    });
  useEffect(() => {
    void embedFetch('')
      .then((e) => setName(e.name))
      .catch((e) => setError(errorMessage(e)));
    return () => controller.current?.abort();
  }, []);
  async function submit() {
    if (!input.trim() || busy) return;
    const text = input;
    setInput('');
    setBusy(true);
    setError('');
    const history = messages.slice(-10);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    const c = new AbortController();
    controller.current = c;
    try {
      const run = await embedFetch('/runs', {
        method: 'POST',
        body: JSON.stringify({ input: text, history }),
        signal: c.signal,
      });
      while (!c.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const next = await embedFetch(`/runs/${run.id}`, { signal: c.signal });
        if (terminal.includes(next.status)) {
          if (next.status !== 'succeeded') throw new Error(next.error ?? `Run ${next.status}`);
          setMessages((m) => [...m, { role: 'assistant', content: next.output }]);
          break;
        }
      }
    } catch (e) {
      if (!c.signal.aborted) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="embed-chat">
      <header>
        <div className="brand-mark">
          <GitBranchIcon />
        </div>
        <div>
          <strong>{name}</strong>
          <small>Powered by Agentic</small>
        </div>
      </header>
      <div className="embed-messages">
        {!messages.length && (
          <Empty
            icon={<MessageSquare size={26} />}
            title={`Talk to ${name}`}
            text="Start a conversation below."
          />
        )}
        {messages.map((m, i) => (
          <div className={`embed-bubble ${m.role}`} key={i}>
            <Markdown text={m.content} />
          </div>
        ))}
        {busy && <p className="muted">Working…</p>}
      </div>
      <div className="embed-composer">
        <ErrorNotice error={error} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            aria-label="Embed message"
            placeholder="Type a message…"
            maxLength={8000}
            value={input}
            disabled={busy || !token}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button aria-label="Send embed message" disabled={busy || !input.trim()}>
            <Send size={17} />
          </Button>
        </form>
      </div>
    </div>
  );
}
function GitBranchIcon() {
  return <Bot size={20} />;
}
