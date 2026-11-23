import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import type { BannerDensity } from "../ui/Banner";

/**
 * What connecting a computer lets agents do there, said before the person
 * connects one (task #475): the Raft DS info Banner, part of the step rather
 * than news, so it does not announce itself. One component for every place a
 * computer is connected: Add Computer's choice or command, and above
 * onboarding's connect step (Add This Mac, the command, Raft Desktop). Not
 * when bringing back a computer that was already connected.
 */
export function ComputerAccessNotice({ className, density = "md" }: { className?: string; density?: BannerDensity }) {
  const { formatMessage } = useIntl();
  return (
    <Banner intent="info" density={density} live={false} withIcon className={className} data-testid="computer-access-notice">
      {formatMessage({ id: "machine.add.accessNotice" })}
    </Banner>
  );
}
