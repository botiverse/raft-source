import { Spinner } from "@botiverse/raft-ui";

/** A panel's wait with no layout to hold (DS overview › Waiting; raft-ui
 *  Spinner › Size): the md pixel spinner centred where the content will be,
 *  beside a callout line in the muted tier that says what is loading. The
 *  spinner carries the accessible name, so the line is not read twice. */
export function PanelLoading({
  label,
  className = "flex flex-1",
  testId,
}: {
  label: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={`${className} items-center justify-center gap-2 text-callout text-foreground-muted`}
      data-testid={testId}
    >
      <Spinner size="md" aria-label={label} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
