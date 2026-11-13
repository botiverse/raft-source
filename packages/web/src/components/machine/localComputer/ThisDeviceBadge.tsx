import { Badge } from "@botiverse/raft-ui";
import { cn } from "@botiverse/raft-ui/cn";
import { useIntl } from "react-intl";

/**
 * "This device" beside the name of the computer Raft Desktop runs on, in
 * every list of computers (the sidebar's rail, the Computers page's list and
 * cards). The list is one list with this device first, marked by this label,
 * as device lists usually are (Find My's "This Mac", Google's current device),
 * not a group of its own under a heading: one computer does not need a
 * section, and a section that appears only once the bridge has answered
 * moved the whole list.
 */
export function ThisDeviceBadge({ className, testId }: { className?: string; testId?: string }) {
  const { formatMessage } = useIntl();
  return (
    <Badge appearance="soft" variant="muted" className={cn("shrink-0", className)} data-testid={testId ?? "this-device-badge"}>
      {formatMessage({ id: "computerHost.list.thisDevice" })}
    </Badge>
  );
}
