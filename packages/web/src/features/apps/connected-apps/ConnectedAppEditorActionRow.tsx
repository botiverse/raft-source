import type { ReactNode } from "react";

/**
 * An action inside an editor section (share link, publish request, client
 * secret, delete): what it does on the left, its button on the right, and
 * whatever it reveals (the share URL) underneath. Plain rows in the section,
 * not cards inside a card.
 */
export function ConnectedAppEditorActionRow({
  title,
  description,
  action,
  children,
  testId,
}: {
  title: ReactNode;
  description: ReactNode;
  /** Omitted when the row's controls live in its children (the share-link form). */
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-3 [&+&]:mt-1" data-testid={testId}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-subhead font-semibold text-foreground">{title}</div>
          <div className="mt-0.5 text-footnote text-foreground-muted">{description}</div>
        </div>
        {action != null ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}
