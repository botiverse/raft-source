import { Card, Skeleton } from "@botiverse/raft-ui";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { ContentLoading } from "../../components/ui/ContentLoading";

/** raft-design Feedback: a skeleton shows only once the wait passes 1 second. */
const LOGIN_LOOKUP_SKELETON_DELAY_MS = 1000;

/**
 * The setup page's card while the App is looked up. Until the lookup answers,
 * the page can't tell a server-mode App (the Server picker) from an
 * account-mode one (no Server to choose), so it draws neither: it draws the
 * head both cards start with (title, the App's name, a sentence, the App's
 * details) in skeleton, as Settings › Billing's PlanBillingLoadingSection
 * draws its section's shape. Its height is that content's, from the first
 * paint: never the side card's (the page grid would stretch it to the FAQ,
 * ~450px), and no jump when the skeleton shows.
 *
 * The skeleton and the "Loading…" line show only once the wait passes 1
 * second (raft-design Feedback, "Empty, loading and failed"); until then they
 * hold their place unseen, so a fast lookup goes straight to the right card.
 * The line (role="status") is there from the start for assistive tech. The
 * page marks the region that stays (`main`) aria-busy, not this card.
 */
export function LoginLookupLoadingCard({ delay = LOGIN_LOOKUP_SKELETON_DELAY_MS }: { delay?: number }) {
  const { formatMessage } = useIntl();
  const [shown, setShown] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) return;
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return (
    <Card render={<section />} className="self-start p-4 sm:p-6" data-testid="login-lookup-loading">
      {/* opacity, not visibility or display: the status line stays readable to assistive tech and the space stays held. */}
      <div className={shown ? undefined : "opacity-0"} data-testid="login-lookup-skeleton" data-shown={shown}>
        <ContentLoading className="mb-5 justify-start" data-testid="login-lookup-status">
          {formatMessage({ id: "common.loading" })}
        </ContentLoading>
        <div className="stack-y-3">
          <Skeleton variant="line" className="h-6 w-3/4" />
          <Skeleton variant="line" className="h-10 w-1/2" />
          <Skeleton variant="line" className="w-full" />
          <Skeleton variant="line" className="w-2/3" />
          <Skeleton variant="block" className="mt-5 h-16 w-full" />
        </div>
      </div>
    </Card>
  );
}
