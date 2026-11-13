import type { HTMLAttributes, ReactNode } from "react";
import { cn, Spinner } from "@botiverse/raft-ui";

/**
 * What a panel or a list shows while its content loads: a conversation, a
 * thread, a profile, the files of a channel, the next page of a list.
 *
 * Raft Design System › Spinner › Size (task #114): a loading indicator
 * matches what it stands in for. In place of a panel's content the spinner is
 * `md` and the line beside it `text-callout` in `foreground-muted`, never a
 * caption in hint grey: until the content arrives, the line is the content,
 * and a tiny grey caption in the middle of an empty panel reads as an empty
 * panel. The spinner is decorative; the line is announced as a status.
 */
export function ContentLoading({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      className={cn("flex items-center justify-center gap-2 text-callout text-foreground-muted", className)}
      {...rest}
    >
      <Spinner size="md" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
