import type { ReactNode } from "react";

export function ConnectedAppDetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <span className="shrink-0 text-footnote text-foreground-muted">{label}</span>
      <div className="min-w-0 text-left text-callout font-semibold text-foreground sm:text-right">{children}</div>
    </div>
  );
}
