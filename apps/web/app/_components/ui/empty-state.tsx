import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border border-dashed border-border rounded-lg p-8 text-center">
      <p className="text-fg font-medium">{title}</p>
      {description ? (
        <p className="text-sm text-fg-muted mt-1">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
