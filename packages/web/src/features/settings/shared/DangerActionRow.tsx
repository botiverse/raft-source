import { Button, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle } from "@botiverse/raft-ui";
import type { ReactNode } from "react";

/**
 * A danger zone action: a settings row in a ListRowGroup of its own (DS Forms ›
 * A setting's row; cindyz, #proj-raft-ui:#220): title, consequence, and the
 * button at the row's end, under the text where the row is under 32rem of its
 * own width. `danger` (red) for what can't be undone, such as Delete Server;
 * `warning` for Leave Server.
 */
export function DangerActionRow({
  id,
  title,
  description,
  actionLabel,
  actionIcon,
  actionVariant = "danger",
  onAction,
  testId,
  actionTestId,
}: {
  id?: string;
  title: string;
  description: string;
  actionLabel: string;
  actionIcon?: ReactNode;
  actionVariant?: "danger" | "warning";
  onAction: () => void;
  testId: string;
  actionTestId?: string;
}) {
  return (
    <ListRowGroup id={id} data-testid={testId} className="@container">
      <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
        <ListRowBody>
          <ListRowTitle>{title}</ListRowTitle>
          <ListRowDescription wrap>{description}</ListRowDescription>
        </ListRowBody>
        <div className="shrink-0 @max-lg:basis-full">
          <Button
            type="button"
            size="md"
            variant={actionVariant}
            onClick={onAction}
            data-testid={actionTestId}
          >
            {actionIcon}
            {actionLabel}
          </Button>
        </div>
      </ListRow>
    </ListRowGroup>
  );
}
