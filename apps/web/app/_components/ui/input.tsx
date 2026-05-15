import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

const field =
  "block w-full rounded-md bg-surface-1 border border-border " +
  "text-fg placeholder:text-fg-subtle " +
  "focus:border-accent-400 focus:outline-none " +
  "disabled:opacity-50 transition-colors";

export function Input({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${field} h-9 px-3 text-sm ${className}`} {...rest} />;
}

export function Textarea({
  className = "",
  rows = 6,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={rows}
      className={`${field} py-2 px-3 text-sm leading-relaxed font-mono ${className}`}
      {...rest}
    />
  );
}

export function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="block">
      <span className="text-sm font-medium text-fg">{children}</span>
      {hint ? <span className="ml-2 text-xs text-fg-subtle">{hint}</span> : null}
    </label>
  );
}
