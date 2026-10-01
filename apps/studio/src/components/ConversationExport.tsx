import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Download, Printer, Settings2 } from 'lucide-react';
import { displayAnswer } from '../../../../packages/core/src/finalAnswer.js';
import { Button, IconButton } from './ui';
import { Markdown } from './Markdown';
import './conversationExport.css';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  attachments?: string[];
  runId?: string;
};

const messageText = (message: ChatMessage) =>
  message.role === 'assistant' ? displayAnswer(message.content) : message.content;

function messageMarkdown(message: ChatMessage) {
  return [
    messageText(message),
    ...(message.attachments ?? []).map(
      (id) =>
        `![Attached image](${new URL(`/api/images/${encodeURIComponent(id)}`, window.location.origin).href})`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function CopyButton({
  text,
  contentRef,
  label,
  disabled = false,
  compact = false,
}: {
  text: string;
  contentRef: RefObject<HTMLElement | null>;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [status, setStatus] = useState('');
  useEffect(() => {
    setStatus('');
  }, [text]);
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);
  async function copy() {
    try {
      // Rich editors receive rendered Markdown; plain text editors receive Markdown source.
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined' && contentRef.current) {
        const content = contentRef.current.cloneNode(true) as HTMLElement;
        content.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
          img.src = img.src;
        });
        content.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
          a.href = a.href;
        });
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/plain': new Blob([text], { type: 'text/plain' }),
              'text/html': new Blob([content.innerHTML], { type: 'text/html' }),
            }),
          ]);
        } catch {
          await navigator.clipboard.writeText(text);
        }
      } else {
        await navigator.clipboard.writeText(text);
      }
      setStatus('Copied');
    } catch {
      setStatus('Copy unavailable. Select the text to copy, or download Markdown.');
    }
  }
  return (
    <span className={`conversation-copy ${compact ? 'compact-copy' : ''}`}>
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        onClick={() => void copy()}
        aria-label={label}
        className={compact ? 'header-export-button' : ''}
        title={status || label}
      >
        {status === 'Copied' ? <Check size={14} /> : <Copy size={14} />}
        {!compact && (status === 'Copied' ? 'Copied' : label)}
      </Button>
      <span className="copy-status" role="status">
        {status}
      </span>
    </span>
  );
}

function MessageContent({ message }: { message: ChatMessage }) {
  return (
    <>
      {message.attachments?.length ? (
        <div className="chat-images">
          {message.attachments.map((id) => (
            <a
              key={id}
              href={`/api/images/${encodeURIComponent(id)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img src={`/api/images/${encodeURIComponent(id)}`} alt="Attached image" />
            </a>
          ))}
        </div>
      ) : null}
      <Markdown text={messageText(message)} />
    </>
  );
}

export function CopyableMessage({ message }: { message: ChatMessage }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref}>
        <MessageContent message={message} />
      </div>
      <CopyButton text={messageMarkdown(message)} contentRef={ref} label="Copy message" />
    </>
  );
}

export function ConversationExport({
  messages,
  title,
  agentName,
  busy,
}: {
  messages: ChatMessage[];
  title: string;
  agentName: string;
  busy: boolean;
}) {
  const transcript = useRef<HTMLElement>(null);
  const optionsId = useId();
  const [orientation, setOrientation] = useState('portrait');
  const markdown =
    [
      `# ${title.replace(/\s+/g, ' ')}`,
      ...messages.map(
        (message) =>
          `## ${message.role === 'user' ? 'You' : agentName.replace(/\s+/g, ' ')}\n\n${messageMarkdown(message)}`,
      ),
    ].join('\n\n') + '\n';
  const disabled = !messages.length || busy;
  function download() {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 80) || 'conversation'}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <div
        className="conversation-export"
        role="group"
        aria-label="Conversation export"
        title={busy ? 'Export is available when the response finishes.' : undefined}
      >
        <CopyButton
          text={markdown}
          contentRef={transcript}
          label="Copy conversation"
          disabled={disabled}
          compact
        />
        <IconButton
          className="icon-button header-export-button"
          title="Download Markdown"
          onClick={download}
          disabled={disabled}
        >
          <Download size={16} />
        </IconButton>
        <IconButton
          className="icon-button header-export-button"
          onClick={() => window.print()}
          disabled={disabled}
          title="Print / Save as PDF"
        >
          <Printer size={16} />
        </IconButton>
        <IconButton
          className="icon-button header-export-button"
          title="Print options"
          popoverTarget={optionsId}
        >
          <Settings2 size={16} />
        </IconButton>
        <div id={optionsId} popover="auto" className="print-options" role="dialog" aria-label="Print options">
          <label>
            Page layout
            <select
              aria-label="Print page layout"
              value={orientation}
              onChange={(event) => setOrientation(event.target.value)}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape (wide tables)</option>
            </select>
          </label>
          <small>Choose landscape for wide tables, then print or save as PDF.</small>
        </div>
      </div>
      {messages.length > 0 &&
        createPortal(
          <article className="playground-print" data-orientation={orientation} ref={transcript}>
            <h1>{title}</h1>
            <p className="transcript-subtitle">{agentName} · Playground conversation</p>
            {busy && <p>Conversation in progress — completed messages only.</p>}
            {messages.map((message, index) => (
              <section className="transcript-message" key={index}>
                <h2>{message.role === 'user' ? 'You' : agentName}</h2>
                <MessageContent message={message} />
              </section>
            ))}
          </article>,
          document.body,
        )}
    </>
  );
}
