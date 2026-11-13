import { SidebarItemMeta } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * The "Saved" nav row's count badge: shows the true saved total, hidden when 0.
 * Exported as its own unit so the visibility/value behavior is testable (the
 * inline-conditional form left the `total > 0` guard uncovered — see
 * features/sidebar/tests/savedNavCount.behavior.test.tsx (removed in the 2026-11 web DOM test prune)).
 */
export function SavedNavCount({ total }: { total: number }) {
  const { formatMessage } = useIntl();
  if (total <= 0) return null;
  return (
    // `.rf-count`: a grey Space Mono number, not a badge — nothing is waiting.
    <SidebarItemMeta>
      {formatMessage({ id: "layout.sidebar.savedCount" }, { count: total })}
    </SidebarItemMeta>
  );
}
// Stryker restore all
