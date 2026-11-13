import { ArrowUpRight } from "lucide-react";
import type { LucideProps } from "lucide-react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { cn } from "@botiverse/raft-ui";

/** A link that leaves Raft opens in a new tab with `target="_blank"
 *  rel="noopener noreferrer"` (written out at each anchor, so the
 *  jsx-no-target-blank lint can see it), and ends in ↗ (raft-design
 *  navigation.md "Links that leave Raft").
 *
 *  Where a control that leaves Raft goes: a new tab (docs, pricing, an app's
 *  homepage) or Stripe in the same tab (checkout, the billing portal). */
export type LeavingRaftDestination = "newTab" | "stripe";

/** The sr-only text read after the control's label. */
export function useLeavingRaftLabel(destination: LeavingRaftDestination = "newTab"): string {
  const { formatMessage } = useIntl();
  return formatMessage({ id: destination === "stripe" ? "common.goesToStripe" : "common.opensInNewTab" });
}

/** An accessible name for a link that leaves Raft in a new tab: its visible
 *  label, then "(opens in a new tab)". Use where the anchor carries an
 *  `aria-label` (which hides the mark's own sr-only text from a screen
 *  reader). */
export function opensInNewTabAriaLabel(formatMessage: IntlShape["formatMessage"], label: string): string {
  return `${label} ${formatMessage({ id: "common.opensInNewTab" })}`;
}

/** The ↗ at the end of a Button, a menu item or a sidebar row that leaves
 *  Raft: Lucide's ArrowUpRight (never ExternalLink), in the place of the
 *  trailing icon, with an sr-only label after it. In a Button pass
 *  `data-icon="inline-end"` so it takes the button's trailing-icon place and
 *  size. TextLinks use raft-ui's `TextLinkExternalIcon` instead. */
export default function LeavingRaftMark({
  destination = "newTab",
  className,
  ...iconProps
}: Omit<LucideProps, "ref" | "aria-hidden"> & {
  destination?: LeavingRaftDestination;
  "data-icon"?: "inline-end";
}) {
  const label = useLeavingRaftLabel(destination);
  return (
    <>
      <ArrowUpRight {...iconProps} aria-hidden="true" focusable="false" className={cn("shrink-0", className)} />
      {/* The space keeps the label a separate word after the control's text
          in the accessible name; the controls this sits in are flex rows, so
          it takes no room on screen. */}
      {" "}
      <span className="sr-only">{label}</span>
    </>
  );
}
