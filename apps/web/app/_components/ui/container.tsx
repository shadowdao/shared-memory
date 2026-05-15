import type { HTMLAttributes } from "react";

export function Container({
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`max-w-5xl mx-auto px-4 sm:px-6 ${className}`} {...rest} />
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg tracking-tight">{title}</h1>
        {description ? (
          <p className="text-sm text-fg-muted mt-1">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
