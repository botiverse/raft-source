import type { ReactNode } from "react";
import { Badge, IconTile, PanelTitle, Status } from "@botiverse/raft-ui";

export type MachineProfileTone = "online" | "busy" | "offline";

/**
 * A computer's profile head under its panel header: the device tile, the
 * name, the one-word status chip (Raft DS StatusChip: soft wash, square
 * pixel; online lime, busy yellow, offline stone), the hostname and the
 * platform in machine type, then any extra lines. One component for every
 * computer page, so Raft Desktop's This device keeps the same head whether
 * or not it is one of the server's computers, and the page does not jump
 * when it is added or disconnected.
 */
export function MachineProfileHead({ icon, name, tone, statusLabel, statusTestId = "machine-connection-status", hostname, platformLine, children }: {
  icon: ReactNode;
  name: string;
  tone: MachineProfileTone;
  statusLabel: string;
  statusTestId?: string;
  hostname: string | null | undefined;
  platformLine: string | null | undefined;
  children?: ReactNode;
}) {
  return (
    // A computer is a thing, not a person: a neutral square tile.
    <div className="flex items-start gap-4 px-(--surface-inset) py-5" data-testid="machine-profile-head">
      <IconTile size="lg">{icon}</IconTile>
      <div className="min-w-0 flex-1 stack-y-1">
        <PanelTitle className="min-w-0">{name}</PanelTitle>
        <div className="flex min-w-0 items-center gap-2">
          <Badge appearance="soft" variant={tone === "online" ? "success" : tone === "busy" ? "busy" : "muted"} className="shrink-0">
            <Status size="md" variant={tone === "online" ? "success" : tone === "busy" ? "primary" : "default"} aria-hidden="true" />
            <span data-testid={statusTestId}>{statusLabel}</span>
          </Badge>
        </div>
        {hostname ? <div className="truncate font-mono text-mono-meta text-foreground-hint">{hostname}</div> : null}
        {/* What the machine reports about itself (OS release, cloud platform), in the same machine type. */}
        {platformLine ? (
          <div className="truncate font-mono text-mono-meta text-foreground-hint" data-testid="machine-detail-platform">{platformLine}</div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
