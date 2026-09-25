import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type ReactElement,
} from 'react';
import { AlertCircle, ArrowUpRight, Check, LoaderCircle, Plus, X } from 'lucide-react';
export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function IconButton({ title, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="icon-button" title={title} aria-label={title} {...props}>
      {children}
    </button>
  );
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const isControl =
    isValidElement(children) &&
    typeof children.type === 'string' &&
    ['input', 'select', 'textarea'].includes(children.type);
  return (
    <div className="field">
      <label htmlFor={isControl ? id : undefined}>{label}</label>
      <div>{isControl ? cloneElement(children as ReactElement<{ id?: string }>, { id }) : children}</div>
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <div className="notice error" role="alert">
      <AlertCircle size={16} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status}`}>
      <i />
      {status.replaceAll('_', ' ')}
    </span>
  );
}
export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow?: string;
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {text && <p>{text}</p>}
      </div>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const focus = () => ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const all = ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]',
        );
        if (!all?.length) return;
        const first = all[0],
          last = all[all.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', listener);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', listener);
      document.body.style.overflow = old;
      before?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-title">
          <h2>{title}</h2>
          <IconButton title="Close dialog" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
export function SaveForm({
  children,
  onSave,
  onCancel,
  label = 'Save changes',
}: {
  children: ReactNode;
  onSave: () => Promise<void>;
  onCancel: () => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="form-content">
        {children}
        <ErrorNotice error={error} />
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {label}
        </Button>
      </div>
    </form>
  );
}
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt('Copy this value:', value);
        }
      }}
    >
      {copied ? <Check size={14} /> : <ArrowUpRight size={14} />} {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
