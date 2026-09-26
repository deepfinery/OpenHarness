import { useEffect, useState } from 'react';
import { api, errorMessage, send, timestamp } from '../api';
import { Button, ErrorNotice } from './ui';
import type { HumanRequest } from '../../../../packages/core/src/human.js';

type RequestView = Omit<HumanRequest, 'createdAt' | 'expiresAt'> & { createdAt: string; expiresAt: string };
function RequestCard({ request, refresh }: { request: RequestView; refresh: () => void }) {
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState('');
  const [args, setArgs] = useState(JSON.stringify(request.arguments ?? {}, null, 2));
  const [trace, setTrace] = useState<{ message: string; at: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function decide(decision: 'answer' | 'approve' | 'deny') {
    setBusy(true);
    setError('');
    try {
      await send(`/inbox/${request._id}/decision`, {
        decision,
        ...(decision === 'answer' || (request.kind === 'review' && decision === 'approve' && answer)
          ? { answer }
          : {}),
        ...(request.kind === 'approval' && decision === 'approve' ? { arguments: JSON.parse(args) } : {}),
        ...(feedback ? { feedback } : {}),
      });
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="human-request" aria-label="Human input request">
      <h3>{request.kind === 'question' ? 'Your input is needed' : 'Review before continuing'}</h3>
      <p className="human-prompt">{request.prompt}</p>
      <small>
        Run {request.runId} · Expires {timestamp(request.expiresAt)}
      </small>
      {request.tool && (
        <p>
          <code>{request.tool}</code>
        </p>
      )}
      {request.kind === 'approval' ? (
        <label>
          Tool arguments
          <textarea
            aria-label="Approval arguments"
            rows={6}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </label>
      ) : (
        <label>
          {request.kind === 'review' ? 'Edited result (optional)' : 'Answer'}
          <textarea
            aria-label="Human answer"
            rows={3}
            maxLength={32000}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
      )}
      <label>
        Feedback (optional)
        <input
          aria-label="Decision feedback"
          maxLength={4000}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </label>
      <details
        onToggle={(e) => {
          if (e.currentTarget.open)
            void api(`/runs/${request.runId}`)
              .then((r) => setTrace((r.events ?? []).slice(-12)))
              .catch((err) => setError(errorMessage(err)));
        }}
      >
        <summary>Execution context</summary>
        {trace.map((event, index) => (
          <p key={index}>
            <small>{timestamp(event.at)}</small> {event.message}
          </p>
        ))}
      </details>
      <ErrorNotice error={error} />
      <div className="form-actions">
        <Button
          disabled={busy || (request.kind === 'question' && !answer.trim())}
          onClick={() => void decide(request.kind === 'question' ? 'answer' : 'approve')}
        >
          {request.kind === 'question' ? 'Send answer' : 'Approve'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void decide('deny')}>
          Deny
        </Button>
      </div>
    </article>
  );
}
export function HumanInbox({ runId }: { runId?: string }) {
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [error, setError] = useState('');
  async function refresh() {
    try {
      const result = await api(
        `/inbox${runId ? `?runId=${encodeURIComponent(runId)}` : location.pathname === '/inbox' ? location.search : ''}`,
      );
      setRequests(result.requests);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [runId]);
  return (
    <section className="human-inbox">
      {!runId && (
        <>
          <h1>
            Inbox <small>({requests.length})</small>
          </h1>
          <p>
            Questions and actions awaiting your decision. Approvals authorize an action; its execution trace
            records the outcome.
          </p>
        </>
      )}
      <ErrorNotice error={error} />
      {requests.map((request) => (
        <RequestCard key={request._id} request={request} refresh={() => void refresh()} />
      ))}
      {!runId && !requests.length && <p>No pending requests.</p>}
    </section>
  );
}
