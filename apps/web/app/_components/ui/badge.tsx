import type { HTMLAttributes } from "react";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-3 text-fg-muted",
  accent: "bg-accent-500/15 text-accent-300",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = "neutral", className = "", ...rest }: BadgeProps) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm " +
        "text-[11px] font-medium leading-none whitespace-nowrap " +
        `${tones[tone]} ${className}`
      }
      {...rest}
    />
  );
}
