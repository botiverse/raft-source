import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@botiverse/raft-ui";

import type { ArtifactDashboardItem } from "./artifactDashboardItems";
import { ArtifactNewSticker } from "./ArtifactNewSticker";
import { foldNews } from "./artifactSettled";

/**
 * The home page's two groups' heads (#334), the same in the grid, the table and a phone's rows: "Working (N)" over
 * the top group, as the fold's words but with no chevron (nothing to fold), and "Other (N)", raft-ui's ghost Button
 * as the comment list's "Resolved (N)", folding the rest at the end. While folded, the fold's own pink sticker says
 * everything new inside it, so a mention is never hidden by folding.
 */
export function ArtifactWorkingHead({ count }: { count: number }) {
  const { formatMessage } = useIntl();
  return (
    <h2 className="m-0 flex min-h-8 items-center px-3 text-callout font-semibold text-foreground-muted" data-testid="artifacts-group-working">
      {formatMessage({ id: "artifacts.dashboard.group.working" }, { count })}
    </h2>
  );
}

export function ArtifactOtherHead({ items, open, onToggle, controls }: {
  items: readonly ArtifactDashboardItem[];
  open: boolean;
  onToggle: () => void;
  /** The folded rows' element, while open. */
  controls: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <h2 className="m-0 flex min-w-0 items-center gap-1.5">
      <Button
        variant="ghost"
        size="md"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? controls : undefined}
        className="text-foreground-muted"
        data-testid="artifacts-group-other"
      >
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        {formatMessage({ id: "artifacts.dashboard.group.other" }, { count: items.length })}
      </Button>
      {open ? null : <ArtifactNewSticker news={foldNews(items)} />}
    </h2>
  );
}
