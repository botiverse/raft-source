import { DialogSurface, ScrollArea } from "@botiverse/raft-ui";
import type { FormEvent, ReactNode } from "react";

/**
 * The one frame the steps after Create Cindy share (survey, display style,
 * handoff): one fixed size, so the dialog does not change size between them,
 * and smaller than the two setup steps before it, which carry far more
 * content (cindyz, task #247). The body scrolls inside the frame if it ever
 * outgrows it, in a raft-ui ScrollArea; header and footer stay put.
 */
export default function SetupStepFrame({
  eyebrow,
  title,
  hint,
  children,
  footer,
  onSubmit,
  bodyClassName = "",
  flushBody = false,
  testId,
  titleId,
  headerAction,
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  /** Wrap body and footer in a form, so the footer's submit button submits it. */
  onSubmit?: (event: FormEvent) => void;
  /** The body's own layout, on the ScrollArea's content: at least as tall as the
   *  body, so it can centre. A body whose column scrolls itself (a split panel)
   *  adds `h-full` and `overflow-hidden` where it does. */
  bodyClassName?: string;
  /** The body draws its own regions edge to edge (a split panel), so it gets no padding. */
  flushBody?: boolean;
  testId?: string;
  /** The title's id, for a dialog that names itself with aria-labelledby. */
  titleId?: string;
  /** A control at the head's top-right corner (a dialog's close); the title keeps clear of it. */
  headerAction?: ReactNode;
}) {
  const content = (
    <>
      <ScrollArea className="min-h-0 flex-1" contentClassName={`min-h-full ${flushBody ? "" : "px-6 py-6 sm:px-9"} ${bodyClassName}`}>{children}</ScrollArea>
      <footer className="flex shrink-0 flex-col-reverse gap-3 border-t border-line-seam px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-9">
        {footer}
      </footer>
    </>
  );

  return (
    <DialogSurface
      render={<section />}
      className="max-h-[calc(100dvh-2rem)] w-full max-w-[720px] md:h-[min(520px,calc(100dvh-3rem))]"
      data-testid={testId}
    >
      {title ? (
        <header className={`relative shrink-0 border-b border-line-seam px-6 pb-4 pt-6 sm:px-9 ${headerAction ? "pr-14 sm:pr-14" : ""}`}>
          {/* The onboarding step label: Space Mono 12, sentence case. */}
          {eyebrow ? (
            <p className="font-mono text-mono-meta text-foreground-hint">{eyebrow}</p>
          ) : null}
          <h1 id={titleId} className="mt-1 text-title text-foreground">{title}</h1>
          {hint ? <p className="mt-1.5 text-callout text-foreground-muted">{hint}</p> : null}
          {headerAction ? <div className="absolute right-4 top-4">{headerAction}</div> : null}
        </header>
      ) : null}
      {onSubmit ? (
        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          {content}
        </form>
      ) : (
        content
      )}
    </DialogSurface>
  );
}
