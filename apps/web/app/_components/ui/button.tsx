import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium " +
  "transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
  "whitespace-nowrap select-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-500 text-white hover:bg-accent-400 active:bg-accent-600",
  secondary:
    "bg-surface-2 text-fg border border-border hover:border-border-strong hover:bg-surface-3",
  ghost:
    "bg-transparent text-fg hover:bg-surface-2",
  danger:
    "bg-transparent text-danger border border-border hover:bg-danger/10 hover:border-danger/60",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px]",
  md: "h-9 px-3.5 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    />
  );
}
