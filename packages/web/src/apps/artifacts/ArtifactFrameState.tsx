import type { ReactNode } from "react";

import EmptyState from "../../components/ui/EmptyState";

/**
 * A state ArtifactFrame shows in place of the page: icon, title, and the line under it where the title alone
 * doesn't say what's happening. Those lines are back after #proj-workspace:#250 because they tell people what's
 * happening (xxchan, Kirby): why it can't open (it doesn't exist or no access, no longer any access, the browser
 * won't frame it) or, on a passing failure (rate limited, the content briefly unavailable), "Try again later."
 */
export function FrameState({ testId, icon, title, description, action }: { testId: string; icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6" data-testid={testId}>
      <EmptyState icon={icon} title={title} description={description} action={action} />
    </div>
  );
}
