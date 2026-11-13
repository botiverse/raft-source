/**
 * One row of Delete Account's list (v7): a thing of the person's, as it is now
 * (a name, a line under it), an arrow, and what becomes of it (a sentence, and
 * anything the row needs under that: a line, a control, optional actions).
 * Four columns on a wider screen; on a phone the arrow and the outcome go
 * under the name. Hand-rolled on the DS tokens: raft-ui's ListRow truncates
 * its title and has no "now → after" columns or slot for a control under a
 * wrapped sentence.
 */
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

export type AccountDeletionRowTone = "default" | "todo" | "done";

const ICON_TONE: Record<AccountDeletionRowTone, string> = {
  default: "text-foreground-muted",
  todo: "text-attention-strong",
  done: "text-success-strong",
};

export function AccountDeletionChecklistRow({ icon, tone = "default", name, detail, outcome, children, testId }: {
  icon: ReactNode;
  /** `todo`: it holds up the deletion; `done`: it did, and is handled. */
  tone?: AccountDeletionRowTone;
  /** What it is now. */
  name: ReactNode;
  /** A line under the name. */
  detail?: ReactNode;
  /** What becomes of it. */
  outcome: ReactNode;
  /** Under the outcome: a line, a control, optional actions. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <li
      className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-line-hairline px-4 py-3.5 first:border-t-0 sm:grid-cols-[20px_minmax(0,5fr)_16px_minmax(0,7fr)] sm:gap-y-0"
      data-testid={testId}
      data-tone={tone === "default" ? undefined : tone}
      data-done={tone === "done" || undefined}
    >
      <span aria-hidden className={`flex size-5 items-start pt-0.5 [&_svg]:size-4 ${ICON_TONE[tone]}`}>{icon}</span>
      <div className="min-w-0 wrap-break-word">
        <div className="text-body font-semibold text-foreground">{name}</div>
        {detail ? <div className="text-callout text-foreground-muted">{detail}</div> : null}
      </div>
      <span aria-hidden className="flex justify-center pt-1 text-foreground-hint [&_svg]:size-4 sm:justify-start">
        <ArrowRight />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 wrap-break-word">
        <div className="text-body text-foreground">{outcome}</div>
        {children}
      </div>
    </li>
  );
}

/** A line under a row's outcome. */
export function AccountDeletionRowNote({ children }: { children: ReactNode }) {
  return <p className="m-0 text-callout text-foreground-muted">{children}</p>;
}
