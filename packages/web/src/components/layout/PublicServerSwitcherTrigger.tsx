import type { ComponentProps } from "react";
import { AppRailItem } from "@botiverse/raft-ui";

// The public rail's workspace block: a rail item filled by the workspace
// avatar. It opens the switcher for a signed-in visitor and asks an anonymous
// one to sign in, so it renders both as a PopoverTrigger and on its own.
export function PublicServerSwitcherTrigger(props: ComponentProps<typeof AppRailItem>) {
  return (
    <AppRailItem
      {...props}
      className="group size-(--rail-item) overflow-hidden p-0 md:[@media(max-height:600px)]:size-9"
      data-testid="public-server-switcher-trigger"
    />
  );
}
