import { HumanInbox } from './HumanInbox';
import { displayAnswer } from '../../../../packages/core/src/finalAnswer.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ImagePlus,
  X,
  Activity,
  Bot,
  Check,
  CircleStop,
  Clock3,
  CornerDownLeft,
  History,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Send,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserRound,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, errorMessage, send, timestamp, type Data, type Entity } from '../api';
import { Button, Empty, ErrorNotice, IconButton, Modal, Status } from './ui';
import { TaskMemory } from './TaskMemory';

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
type Message = { role: 'user' | 'assistant'; content: string; attachments?: string[]; runId?: string };
type Conversation = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  activeRunId?: string;
};

/**
 * Follows a run through server-sent events, falling back to polling when the stream is unavailable.
 * Calls `onRun` with every change until the run reaches a terminal state.
 */
/** Thumbs up or down on an answer; a thumbs down asks what should change. Learning workflows turn it into a lesson. */
function FeedbackBar({ runId }: { runId: string }) {
  const [given, setGiven] = useState<'up' | 'down' | null>(null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState('');
  const [problem, setProblem] = useState('');
  async function rate(rating: 'up' | 'down', note?: string) {
    setProblem('');
    try {
      await send(`/runs/${runId}/feedback`, { rating, ...(note ? { comment: note } : {}) });
      setGiven(rating);
      setAsking(false);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }
  if (given)
    return (
      <div className="feedback-bar given">{given === 'up' ? 'Marked as helpful' : 'Feedback saved'}</div>
    );
  return (
    <div className="feedback-bar">
      <button type="button" className="icon-button" aria-label="Good answer" onClick={() => void rate('up')}>
        <ThumbsUp size={14} />
      </button>
      <button type="button" className="icon-button" aria-label="Bad answer" onClick={() => setAsking(true)}>
        <ThumbsDown size={14} />
      </button>
      {asking && (
        <form
          className="feedback-form"
          onSubmit={(e) => {
            e.preventDefault();
            void rate('down', comment.trim() || undefined);
          }}
        >
          <input
            aria-label="What should change"
            placeholder="What should the agent do differently?"
            value={comment}
            maxLength={2000}
            onChange={(e) => setComment(e.target.value)}
          />
          <button type="submit" className="text-button">
            Send
          </button>
        </form>
      )}
      {problem && <small className="feedback-error">{problem}</small>}
    </div>
  );
}
export function followRun(runId: string, onRun: (run: any) => void, onError: (message: string) => void) {
  let stopped = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const accept = (next: any) => {
    if (stopped) return;
    onRun(next);
    if (terminal.includes(next.status)) stop();
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    clearTimeout(timer);
    try {
      accept(await api(`/runs/${runId}`));
    } catch (e) {
      if (!stopped) onError(errorMessage(e));
    } finally {
      polling = false;
      // Also acts as a watchdog for streams silently disconnected by sleeping tabs or proxies.
      if (!stopped) timer = setTimeout(poll, source ? 10000 : 1500);
    }
  };
  const resume = () => {
    if (document.visibilityState !== 'hidden') void poll();
  };
  function stop() {
    stopped = true;
    source?.close();
    clearTimeout(timer);
    window.removeEventListener('online', resume);
    window.removeEventListener('focus', resume);
    document.removeEventListener('visibilitychange', resume);
  }
  if (typeof EventSource === 'function') {
    source = new EventSource(`/api/runs/${runId}/stream`);
    source.addEventListener('run', (event) => {
      try {
        accept(JSON.parse((event as MessageEvent).data));
      } catch {
        void poll();
      }
    });
    source.onerror = () => {
      source?.close();
      source = null;
      void poll();
    };
  }
  window.addEventListener('online', resume);
  window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', resume);
  void poll();
  return stop;
}

/** Workflows are the unit of work; saved agents only appear for workspaces that still have them. */
export const playgroundTargets = (data: Data) => [
  ...data.workflows.map((w) => ({ ...w, type: 'workflow' })),
  ...data.agents.map((a) => ({ ...a, type: 'agent' })),
];
export function Playground({
  data,
  target,
  onTargetChange,
  storageScope,
  actionsContainer,
}: {
  data: Data;
  storageScope: string;
  actionsContainer: HTMLElement | null;
  /** `workflow:<id>` or `agent:<id>`; the selector lives in the app's top bar. */
  target: string;
  onTargetChange: (target: string) => void;
}) {
  const storageKey = `playground:${storageScope}:${target}`;
  const generation = useRef(0);
  const mounted = useRef(true);
  const targets = playgroundTargets(data);
  // Machines are tools of the workflow: the ones its cards attach, named in the welcome text.
  const machines = (() => {
    const [type, id] = target.split(':');
    const workflow =
      type === 'workflow'
        ? (data.workflows.find((w) => w.id === id) as
            { resources?: { type: string; connectionId?: string }[] } | undefined)
        : undefined;
    const ids = new Set((workflow?.resources ?? []).map((r) => r.connectionId));
    return data.machines.filter((m) => m.connectionId && ids.has(m.connectionId));
  })();
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 900;
  const [showTrace, setShowTrace] = useState(!narrow);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<{ id: string; filename: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [run, setRun] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<'trace' | 'history' | 'memory'>('trace');
  const [historyRuns, setHistoryRuns] = useState<any[]>([]);
  const [inspected, setInspected] = useState<any>(null);
  const [activityRunId, setActivityRunId] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const stopFollowing = useRef<() => void>(() => {});
  const current = targets.find((t) => `${t.type}:${t.id}` === target);
  const targetKey = current ? (current.type === 'agent' ? 'agentId' : 'workflowId') : undefined;

  useEffect(() => {
    if (!current && targets[0]) onTargetChange(`${targets[0].type}:${targets[0].id}`);
  }, [data, target]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, busy, run?.partial]);
  useEffect(
    () => () => {
      mounted.current = false;
      generation.current++;
      stopFollowing.current();
    },
    [],
  );
  function remember(id: string | undefined) {
    try {
      sessionStorage.setItem(storageKey, id ?? 'new');
    } catch {
      /* Storage can be disabled. */
    }
  }

  async function loadConversations() {
    if (!current || !targetKey) return setConversations([]);
    try {
      setConversations(await api(`/conversations?${targetKey}=${current.id}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function loadHistory() {
    if (!current) return setHistoryRuns([]);
    try {
      const runs: any[] = await api('/runs');
      setHistoryRuns(runs.filter((r) => r[targetKey!] === current.id).slice(0, 30));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    const version = generation.current;
    if (current && targetKey)
      void api<Conversation[]>(`/conversations?${targetKey}=${current.id}`)
        .then((items) => {
          if (version !== generation.current) return;
          setConversations(items);
          setRestoring(false);
          let saved: string | null = null;
          try {
            saved = sessionStorage.getItem(storageKey);
          } catch {}
          const selected =
            items.find((c) => c.id === saved) ??
            (saved === 'new' ? undefined : (items.find((c) => c.activeRunId) ?? items[0]));
          if (selected) void openConversation(selected.id);
        })
        .catch((e) => {
          if (version === generation.current) {
            setError(errorMessage(e));
            setRestoring(false);
          }
        });
    void loadHistory();
  }, [target, current?.id]);
  useEffect(() => {
    if (panel === 'history') {
      void loadHistory();
      void loadConversations();
    }
  }, [panel, run?.status]);

  function reset() {
    setAttachments([]);
    setDragging(false);
    setActivityRunId(undefined);
    setRestoring(false);
    generation.current++;
    remember(undefined);
    stopFollowing.current();
    setMessages([]);
    setConversationId(undefined);
    setRun(null);
    setInspected(null);
    setError('');
    setBusy(false);
  }
  function follow(runId: string) {
    stopFollowing.current();
    setBusy(true);
    const version = generation.current;
    stopFollowing.current = followRun(
      runId,
      (next) => {
        if (version !== generation.current) return;
        setError('');
        setRun(next);
        if (terminal.includes(next.status)) {
          setBusy(false);
          if (next.output !== undefined)
            setMessages((m) =>
              m.some((message) => message.role === 'assistant' && message.runId === next.id)
                ? m
                : [...m, { role: 'assistant', content: next.output ?? '', runId: next.id }],
            );
          if (next.status !== 'succeeded') setError(next.error ?? `Run ${next.status}`);
          void loadConversations();
        }
      },
      (message) => setError(message),
    );
  }
  async function openConversation(id: string) {
    setRestoring(false);
    reset();
    remember(id);
    setBusy(true);
    const version = generation.current;
    try {
      const c = await api(`/conversations/${id}`);
      if (version !== generation.current) return;
      setConversationId(id);
      setMessages(c.messages);
      if (c.activeRunId) {
        follow(c.activeRunId);
      } else {
        setBusy(false);
        const lastRun = c.lastRunId ?? [...c.messages].reverse().find((m: Message) => m.runId)?.runId;
        if (lastRun) {
          const last = await api(`/runs/${lastRun}`);
          if (version === generation.current) {
            setRun(last);
            if (last.status !== 'succeeded') setError(last.error ?? `Run ${last.status}`);
          }
        }
      }
    } catch (e) {
      if (version === generation.current) {
        setError(errorMessage(e));
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const restoreAccepted = (event: Event) => {
      const detail = (event as CustomEvent<{ storageKey: string; id: string }>).detail;
      if (detail.storageKey === storageKey) void openConversation(detail.id);
    };
    window.addEventListener('playground-conversation', restoreAccepted);
    return () => window.removeEventListener('playground-conversation', restoreAccepted);
  }, [storageKey]);
  async function uploadImages(files: File[]) {
    if (!files.length || busy || restoring || !current || uploadingRef.current) return;
    if (attachments.length + files.length > 4) {
      setError('Attach up to four images per message.');
      return;
    }
    if (
      files.some(
        (f) => !['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > 10 * 1024 * 1024,
      )
    ) {
      setError('Choose PNG, JPEG or WebP images, up to 10 MB each.');
      return;
    }
    const version = generation.current;
    uploadingRef.current = true;
    setUploading(true);
    setError('');
    try {
      for (const file of files) {
        const body = new FormData();
        body.append('file', file);
        const uploaded = await api<{ id: string; filename: string }>('/images', { method: 'POST', body });
        if (version !== generation.current) return;
        setAttachments((previous) => [...previous, uploaded]);
      }
    } catch (e) {
      if (version === generation.current) setError(errorMessage(e));
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  }
  async function submit() {
    if ((!input.trim() && !attachments.length) || uploadingRef.current || busy || restoring || !current)
      return;
    setBusy(true);
    setError('');
    setInspected(null);
    setPanel('trace');
    const version = generation.current;
    remember(conversationId);
    const text = input.trim() || 'Describe the attached images.';
    const sentImages = attachments;
    const imageIds = sentImages.map((a) => a.id);
    setAttachments([]);
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text, attachments: imageIds }]);
    try {
      const r = await send('/chat', {
        [current.type === 'agent' ? 'agentId' : 'workflowId']: current.id,
        message: text,
        attachments: imageIds,
        conversationId,
        // Machines come from the workflow's own cards; this also clears one an older conversation remembered.
        deviceId: null,
      });
      // A late response can recover a page reopened before the server accepted the job.
      if (!mounted.current) {
        try {
          if (sessionStorage.getItem(storageKey) !== (conversationId ?? 'new')) return;
        } catch {}
        remember(r.conversationId);
        window.dispatchEvent(
          new CustomEvent('playground-conversation', { detail: { storageKey, id: r.conversationId } }),
        );
        return;
      }
      if (version !== generation.current) {
        void loadConversations();
        return;
      }
      remember(r.conversationId);
      setConversationId(r.conversationId);
      setRun({ id: r.id, status: r.status, events: [] });
      follow(r.id);
      void loadConversations();
    } catch (e) {
      if (version !== generation.current) return;
      setError(errorMessage(e));
      setBusy(false);
      setInput(text);
      setAttachments(sentImages);
      setMessages((m) => m.slice(0, -1));
    }
  }
  const streaming = busy && typeof run?.partial === 'string' && run.partial.length > 0;
  const activity = [...(run?.events ?? [])].reverse().find((e: any) => e.type === 'agent_activity_started');
  const shown = inspected ?? run;
  return (
    <div className={`playground chat-playground ${showTrace ? '' : 'trace-hidden'}`}>
      {actionsContainer &&
        createPortal(
          <Button variant="secondary" className="topbar-action" aria-label="New conversation" onClick={reset}>
            <Plus size={15} />
            <span>New conversation</span>
          </Button>,
          actionsContainer,
        )}
      <div
        className={`playground-main ${dragging ? 'image-dragging' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void uploadImages(Array.from(e.dataTransfer.files));
        }}
      >
        {dragging && <div className="image-drop-hint">Drop images to attach</div>}
        <div className="playground-float">
          <span className="grow" />
          <IconButton
            title={showTrace ? 'Hide trace panel' : 'Show trace panel'}
            onClick={() => setShowTrace(!showTrace)}
          >
            <Terminal size={17} />
          </IconButton>
        </div>
        <div className="chat-scroll">
          {!messages.length && !busy ? (
            <div className="chat-welcome">
              <div className="welcome-orbit">
                <Bot size={34} />
                <span className="orbit-point one" />
                <span className="orbit-point two" />
              </div>
              <h2>{current ? current.name : 'No harness selected'}</h2>
              <p>
                {current
                  ? machines.length
                    ? `Operating ${machines.map((m) => `${m.name} (${m.platform}${m.online ? '' : ', offline'})`).join(', ')}. Every command shows up in the trace.`
                    : 'Send a message. Every step shows up in the trace.'
                  : 'Create a harness first.'}
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
            <>
              <div className="chat-divider">
                <span>{conversationId ? 'Conversation' : 'Today'}</span>
              </div>
              {messages.map((m, index) => (
                <div className={`chat-message ${m.role}`} key={index}>
                  <div className="message-avatar">
                    {m.role === 'user' ? <UserRound size={17} /> : <Bot size={18} />}
                  </div>
                  <div className="message-body">
                    <strong>{m.role === 'user' ? 'You' : (current?.name ?? 'Agent')}</strong>
                    {m.attachments?.length ? (
                      <div className="chat-images">
                        {m.attachments.map((id) => (
                          <a key={id} href={`/api/images/${id}`} target="_blank" rel="noopener noreferrer">
                            <img src={`/api/images/${id}`} alt="Attached image" />
                          </a>
                        ))}
                      </div>
                    ) : null}
                    <Markdown text={m.role === 'assistant' ? displayAnswer(m.content) : m.content} />
                    {m.role === 'assistant' && m.runId && <FeedbackBar runId={m.runId} />}
                    {m.role === 'assistant' && m.runId && (
                      <button className="text-button" onClick={() => setActivityRunId(m.runId)}>
                        View activity
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
          {busy && (
            <div className="chat-message assistant">
              <div className="message-avatar">
                <Bot size={18} />
              </div>
              <div className="message-body">
                <strong>{current?.name}</strong>
                {streaming ? (
                  <div className="streaming">
                    <Markdown text={run.partial} />
                    <span className="caret" />
                  </div>
                ) : (
                  <div className="activity-status">
                    <div className="thinking" role="status">
                      <span />
                      <span />
                      <span />
                      <small>
                        {run?.status === 'queued'
                          ? 'Waiting for a runner'
                          : activity
                            ? `Working on your request · ${activity.data.label}`
                            : run?.events?.length
                              ? run.events[run.events.length - 1].message
                              : 'Working on your request'}
                      </small>
                    </div>
                    {run?.id && (
                      <button className="text-button" onClick={() => setActivityRunId(run.id)}>
                        View activity
                      </button>
                    )}
                  </div>
                )}
                {streaming && run?.id && (
                  <button className="text-button" onClick={() => setActivityRunId(run.id)}>
                    View activity
                  </button>
                )}
              </div>
            </div>
          )}
          {run?.status === 'waiting_for_human' && <HumanInbox runId={run.id} />}
          {!busy && run && !run.output && terminal.includes(run.status) && (
            <button className="text-button" onClick={() => setActivityRunId(run.id)}>
              View activity
            </button>
          )}
          <div ref={bottom} />
        </div>
        <div className="chat-compose">
          <div className="chat-images pending-images">
            {attachments.map((a) => (
              <div key={a.id}>
                <img src={`/api/images/${a.id}`} alt={a.filename} />
                <button
                  type="button"
                  aria-label={`Remove ${a.filename}`}
                  onClick={() => setAttachments((prev) => prev.filter((i) => i.id !== a.id))}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          {uploading && <small role="status">Uploading images…</small>}
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            aria-label="Upload images"
            onChange={(e) => {
              void uploadImages(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <ErrorNotice error={error} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <IconButton
              title="Attach images"
              disabled={!current || busy || restoring || uploading || attachments.length >= 4}
              onClick={() => imageInput.current?.click()}
            >
              <ImagePlus size={20} />
            </IconButton>
            <textarea
              aria-label="Message your agent"
              placeholder={current ? `Message ${current.name}…` : 'Choose a harness…'}
              value={input}
              disabled={!current || busy || restoring}
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
              <button
                className="send-button"
                disabled={(!input.trim() && !attachments.length) || !current || restoring || uploading}
                aria-label="Send message"
              >
                <Send size={18} />
              </button>
            )}
          </form>
          <small>Drop images or attach · Enter to send · Shift + Enter for a new line</small>
        </div>
      </div>
      <aside className="trace-panel">
        <IconButton className="trace-close" title="Close trace panel" onClick={() => setShowTrace(false)}>
          <PanelLeftClose size={16} />
        </IconButton>
        <div className="panel-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={panel === 'trace'}
            className={panel === 'trace' ? 'active' : ''}
            onClick={() => setPanel('trace')}
          >
            <Terminal size={15} />
            Trace
          </button>
          <button
            role="tab"
            aria-selected={panel === 'history'}
            className={panel === 'history' ? 'active' : ''}
            onClick={() => setPanel('history')}
          >
            <History size={15} />
            History
          </button>
          <button
            role="tab"
            aria-selected={panel === 'memory'}
            className={panel === 'memory' ? 'active' : ''}
            onClick={() => setPanel('memory')}
          >
            Memory
          </button>
        </div>
        {panel === 'memory' ? (
          <TaskMemory key={shown?.id} runId={shown?.id} />
        ) : panel === 'trace' ? (
          shown ? (
            <>
              <div className="trace-meta">
                <small>Run</small>
                <code>{shown.id}</code>
                <button className="text-button" onClick={() => setActivityRunId(shown.id)}>
                  View activity
                </button>
                <span>
                  {timestamp(shown.createdAt)} {shown.status && <Status status={shown.status} />}
                </span>
                {inspected && (
                  <button className="text-button" onClick={() => setInspected(null)}>
                    Back to the live run
                  </button>
                )}
              </div>
              {inspected?.output && (
                <details className="trace-output" open>
                  <summary>Output</summary>
                  <Markdown text={displayAnswer(inspected.output)} />
                </details>
              )}
              <Trace events={shown.events ?? []} />
              {shown.error && <ErrorNotice error={shown.error} />}
            </>
          ) : (
            <div className="trace-placeholder">
              <div className="trace-line" />
              <div className="trace-line" />
              <div className="trace-line" />
              <p>
                Model turns, tool calls, retrieved passages and step results appear here as the run works.
              </p>
            </div>
          )
        ) : (
          <div className="history-list">
            {!conversations.length && !historyRuns.length && (
              <Empty
                icon={<Activity size={22} />}
                title="No runs yet"
                text={`Runs of ${current?.name ?? 'this target'} from every trigger show up here.`}
              />
            )}
            {conversations.map((c) => (
              <div className="history-conversation" key={c.id}>
                <button
                  className={`history-item ${c.id === conversationId ? 'active' : ''}`}
                  onClick={() => {
                    void openConversation(c.id);
                    setPanel('trace');
                    if (narrow) setShowTrace(false);
                  }}
                >
                  <span className="history-item-top">
                    <MessageSquare size={15} />
                    <small>{timestamp(c.updatedAt)}</small>
                  </span>
                  <strong>{c.title}</strong>
                  <small>
                    {c.messageCount} messages{c.activeRunId ? ' · running' : ''}
                  </small>
                </button>
                <IconButton
                  title="Delete conversation"
                  onClick={() => {
                    if (!confirm('Delete this conversation? Its run history stays in Executions.')) return;
                    void api(`/conversations/${c.id}`, { method: 'DELETE' })
                      .then(() => {
                        if (c.id === conversationId) reset();
                        return loadConversations();
                      })
                      .catch((e) => setError(errorMessage(e)));
                  }}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
            {historyRuns
              .filter((r) => !r.conversationId)
              .map((r) => (
                <button
                  className={`history-item ${inspected?.id === r.id ? 'active' : ''}`}
                  key={r.id}
                  onClick={() => {
                    void api(`/runs/${r.id}`)
                      .then((full) => {
                        setInspected(full);
                        setPanel('trace');
                      })
                      .catch((e) => setError(errorMessage(e)));
                  }}
                >
                  <span className="history-item-top">
                    <Status status={r.status} />
                    <small>
                      <Clock3 size={11} />
                      {timestamp(r.createdAt)}
                    </small>
                  </span>
                  <strong>{r.input}</strong>
                  <small>
                    {r.trigger ?? 'studio'}
                    {r.resumeCount ? ` · resumed ${r.resumeCount}×` : ''}
                  </small>
                </button>
              ))}
          </div>
        )}
      </aside>
      {activityRunId && (
        <ActivityHistory
          key={activityRunId}
          runId={activityRunId}
          onClose={() => setActivityRunId(undefined)}
        />
      )}
    </div>
  );
}
function ActivityHistory({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [run, setRun] = useState<any>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const pendingContent = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [history, current] = await Promise.all([api(`/runs/${runId}/activity`), api(`/runs/${runId}`)]);
        if (stopped) return;
        setEntries(history.entries);
        setRun(current);
        setLoading(false);
        setError('');
        if (!terminal.includes(current.status)) timer = setTimeout(refresh, 1000);
      } catch (e) {
        if (!stopped) {
          setError(errorMessage(e));
          setLoading(false);
        }
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);
  useEffect(() => {
    for (const entry of entries) {
      if (
        !opened[entry.id] ||
        entry.status !== 'completed' ||
        contents[entry.id] !== undefined ||
        pendingContent.current.has(entry.id)
      )
        continue;
      pendingContent.current.add(entry.id);
      void api(`/runs/${runId}/activity/${entry.id}`)
        .then((result) => {
          if (mounted.current) setContents((previous) => ({ ...previous, [entry.id]: result.content ?? '' }));
        })
        .catch((e) => {
          if (mounted.current) setError(errorMessage(e));
        })
        .finally(() => pendingContent.current.delete(entry.id));
    }
  }, [entries, opened, contents, runId]);
  return (
    <Modal title="Agent activity" wide onClose={onClose}>
      <div className="activity-history">
        <p>Drafts, reviewer feedback and revisions stay here. The chat shows the final answer.</p>
        {loading && <p role="status">Loading activity…</p>}
        <ErrorNotice error={error} />
        {entries.map((entry) => (
          <details
            key={entry.id}
            className="activity-stage"
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setOpened((previous) =>
                previous[entry.id] === open ? previous : { ...previous, [entry.id]: open },
              );
            }}
          >
            <summary>
              <strong>{entry.label}</strong>
              <span>
                {entry.agent} · {entry.model}
              </span>
              <time dateTime={entry.startedAt}>{timestamp(entry.startedAt)}</time>
              <small>
                {entry.status === 'completed'
                  ? 'Completed'
                  : terminal.includes(run?.status)
                    ? 'Incomplete'
                    : run?.status === 'waiting_for_human'
                      ? 'Waiting for input'
                      : 'In progress'}
              </small>
            </summary>
            {entry.status === 'completed' ? (
              contents[entry.id] !== undefined ? (
                <Markdown text={contents[entry.id]} />
              ) : (
                <p>Loading saved text…</p>
              )
            ) : (
              <p>This stage has not finished. Completed text will remain available here.</p>
            )}
          </details>
        ))}
        {!!run?.events?.length && (
          <details className="activity-events">
            <summary>Execution events</summary>
            <Trace events={run.events} />
          </details>
        )}
        {!loading && !entries.length && !run?.events?.length && <p>No activity recorded yet.</p>}
      </div>
    </Modal>
  );
}
export function Trace({ events }: { events: any[] }) {
  return (
    <div className="trace-list">
      {events.map((event, index) => (
        <details className={`trace-event ${event.type}`} key={`${index}:${event.at}`}>
          <summary>
            <span className="trace-dot">
              {event.type.endsWith('completed') || event.type === 'email_sent' ? (
                <Check size={9} />
              ) : (
                <span />
              )}
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
          if (next.output !== undefined)
            setMessages((m) => [...m, { role: 'assistant', content: next.output }]);
          if (next.status !== 'succeeded') throw new Error(next.error ?? `Run ${next.status}`);
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
          <Bot size={20} />
        </div>
        <div>
          <strong>{name}</strong>
          <small>Powered by OpenHarness</small>
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
            <Markdown text={m.role === 'assistant' ? displayAnswer(m.content) : m.content} />
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
