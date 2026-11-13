import type { ComponentType, SVGProps } from "react";
import { CHANNEL_KIND_ICON_SIZE, ChannelIcon } from "./channelKindIcon";

const channelIconComponents = new Map<string, ComponentType<SVGProps<SVGSVGElement>>>();

/**
 * ChannelIcon as an icon component, for a chip that takes one (raft-ui's
 * width/height props, e.g. ReferenceChip): one stable component per channel
 * id; null draws the #.
 */
export function channelIconComponent(channelId: string | null): ComponentType<SVGProps<SVGSVGElement>> {
  const key = channelId ?? "";
  let component = channelIconComponents.get(key);
  if (!component) {
    component = function ChannelIconForChip({ width, className }: SVGProps<SVGSVGElement>) {
      return <ChannelIcon channelId={channelId} size={typeof width === "number" ? width : CHANNEL_KIND_ICON_SIZE} className={className} />;
    };
    channelIconComponents.set(key, component);
  }
  return component;
}
