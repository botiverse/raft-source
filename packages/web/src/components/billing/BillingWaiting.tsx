import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Spinner } from "@botiverse/raft-ui";

/** Raft DS Spinner: show it only once a wait passes a second. */
const SPINNER_DELAY_MS = 1_000;

/**
 * The right half of a billing dialog while Stripe has the payment: Upgrade to
 * Pro and Add seats show the same status (cindyz, 2026-10-27), so it lives
 * here once. A title, a sentence, and what to do next (a link back to
 * Stripe's page). `failed` (a declined card) reads as an error, not a wait:
 * a danger icon and title instead of the spinner (Kirby).
 */
export default function BillingWaiting({
  title,
  body,
  failed = false,
  testId,
  children,
}: {
  title: string;
  body: string;
  failed?: boolean;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-3 px-8 py-6 text-center" data-testid={testId}>
      {failed ? <TriangleAlert size={24} className="text-danger-strong" aria-hidden="true" /> : <DelayedSpinner label={title} />}
      <p className={`text-subhead font-bold ${failed ? "text-danger-strong" : "text-foreground"}`}>{title}</p>
      <p className="max-w-xs text-callout text-foreground-muted">{body}</p>
      {children}
    </div>
  );
}

function DelayedSpinner({ label }: { label: string }) {
  const [shown, setShown] = useState(false);
  // A timer because the DS times the spinner from when the wait began, not from anything rendered.
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return shown ? <Spinner size="md" aria-label={label} /> : <span className="size-3.5" aria-hidden="true" />;
}
