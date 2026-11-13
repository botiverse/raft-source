import { IconTile } from "@botiverse/raft-ui";
import type { ReactNode } from "react";

export function AgentChatInlineEmpty({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="px-(--surface-inset) pb-4">
      <div className="flex items-center gap-3">
        <IconTile size="sm">{icon}</IconTile>
        <div className="min-w-0">
          <div className="text-callout font-semibold text-foreground-muted">{title}</div>
          <div className="text-caption text-foreground-hint">{description}</div>
        </div>
      </div>
    </div>
  );
}
