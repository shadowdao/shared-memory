import type { HTMLAttributes } from "react";

export function Card({
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg bg-surface-1 border border-border overflow-hidden ${className}`}
      {...rest}
    />
  );
}

export function CardBody({
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 ${className}`} {...rest} />;
}

export function CardHeader({
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`px-4 py-3 border-b border-border bg-surface-2 ${className}`}
      {...rest}
    />
  );
}
