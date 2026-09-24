import type { ReactNode } from "react";

export default function MobileBottomBarStack({
  showLiveActivity,
  liveActivity,
  tabBar,
}: {
  showLiveActivity: boolean;
  liveActivity: ReactNode;
  tabBar: ReactNode;
}) {
  return (
    <>
      {showLiveActivity ? (
        <div className="md:hidden shrink-0" data-testid="mobile-live-activity-slot">
          {liveActivity}
        </div>
      ) : null}
      {tabBar}
    </>
  );
}
