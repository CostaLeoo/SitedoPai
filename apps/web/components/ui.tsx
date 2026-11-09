'use client';
import { ButtonHTMLAttributes, ReactNode, useId } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-ink disabled:bg-gray-400',
  secondary: 'bg-surface text-ink border-2 border-ink hover:bg-gray-100 disabled:text-gray-500 disabled:border-gray-400',
  danger: 'bg-danger text-white hover:bg-red-900 disabled:bg-gray-400',
  ghost: 'text-brand-ink underline underline-offset-4 hover:bg-gray-100',
};

/** Botão grande para uso com luva e em pé: mínimo 52 px de altura. */
export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`min-h-[52px] rounded-lg px-5 text-[1.0625rem] font-semibold disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

export function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  hint?: string;
  error?: string;
  multiline?: boolean;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
}) {
  const id = useId();
  const describedBy = [props.hint && `${id}-hint`, props.error && `${id}-err`].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    value: props.value,
    disabled: props.disabled,
    required: props.required,
    'aria-invalid': props.error ? true : undefined,
    'aria-describedby': describedBy,
    onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
    onBlur: props.onBlur,
    className: `w-full rounded-lg border-2 bg-surface px-3 py-3 text-[1.0625rem] ${props.error ? 'border-danger' : 'border-line'} disabled:bg-gray-100`,
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">
        {props.label}
        {props.required && <span className="text-danger"> *</span>}
      </label>
      {props.hint && <p id={`${id}-hint`} className="text-sm text-muted">{props.hint}</p>}
      {props.multiline ? <textarea rows={3} {...common} /> : <input type={props.type ?? 'text'} inputMode={props.inputMode} autoComplete={props.autoComplete} {...common} />}
      {props.error && <p id={`${id}-err`} className="text-sm font-semibold text-danger">{props.error}</p>}
    </div>
  );
}

export function Select(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">
        {props.label}
        {props.required && <span className="text-danger"> *</span>}
      </label>
      <select
        id={id}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="min-h-[52px] w-full rounded-lg border-2 border-line bg-surface px-3 text-[1.0625rem]"
      >
        <option value="">{props.placeholder ?? 'Selecione'}</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

type Tone = 'info' | 'ok' | 'warn' | 'danger';
const tones: Record<Tone, string> = {
  info: 'bg-info-bg border-info text-info',
  ok: 'bg-ok-bg border-ok text-ok',
  warn: 'bg-warn-bg border-warn text-warn',
  danger: 'bg-danger-bg border-danger text-danger',
};

export function Banner({ tone = 'info', title, children, role }: { tone?: Tone; title?: string; children?: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <div role={role ?? (tone === 'danger' ? 'alert' : 'status')} className={`rounded-lg border-l-4 px-4 py-3 ${tones[tone]}`}>
      {title && <p className="font-bold">{title}</p>}
      {children && <div className="text-[1rem]">{children}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl bg-surface p-4 shadow-sm ring-1 ring-line ${className}`}>{children}</section>;
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho',
  IN_REVIEW: 'Em revisão',
  RETURNED: 'Devolvida para correção',
  APPROVED: 'Aprovada',
  CANCELLED: 'Cancelada',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'APPROVED' ? 'bg-ok-bg text-ok' : status === 'CANCELLED' ? 'bg-gray-200 text-ink' : status === 'RETURNED' ? 'bg-warn-bg text-warn' : 'bg-info-bg text-info';
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-bold ${tone}`}>{STATUS_LABEL[status] ?? status}</span>;
}
