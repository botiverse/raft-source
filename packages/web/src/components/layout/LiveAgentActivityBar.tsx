import { useEffect, useLayoutEffect } from "react";
import { useIntl } from "react-intl";
import { LIVE_AGENT_ACTIVITY_VISIBLE_MS } from "../../utils/liveAgentActivity";
import type { LiveAgentActivityItem } from "../../utils/liveAgentActivity";
import { useLiveAgentActivityStore } from "../../store/liveAgentActivityStore";
import { useAppearanceStore } from "../../store/appearanceStore";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import { formatActivityTextDescriptor } from "../../utils/activity";

export function useClearLiveAgentActivityOnServerChange(serverId: string | undefined) {
  useLayoutEffect(() => {
    useLiveAgentActivityStore.getState().clear();
  }, [serverId]);
}

export default function LiveAgentActivityBar({
  variant = "sidebar",
}: {
  variant?: "sidebar" | "mobile";
}) {
  const latest = useLiveAgentActivityStore((state) => state.items[0] ?? null);
  const visible = useAppearanceStore((state) => state.showLiveAgentActivityBar);

  useEffect(() => {
    if (!latest) return;

    const remainingMs = LIVE_AGENT_ACTIVITY_VISIBLE_MS - (Date.now() - latest.createdAt);
    const timeout = window.setTimeout(() => {
      useLiveAgentActivityStore.getState().pruneExpired();
    }, Math.max(0, remainingMs) + 50);

    return () => window.clearTimeout(timeout);
  }, [latest]);

  if (!visible || !latest) return null;

  return <LiveAgentActivityBarPresentation latest={latest} variant={variant} />;
}

export function LiveAgentActivityBarPresentation({
  latest,
  variant = "sidebar",
}: {
  latest: LiveAgentActivityItem | null;
  variant?: "sidebar" | "mobile";
}) {
  const { formatMessage } = useIntl();
  if (!latest) return null;
  const text = latest.textDescriptor
    ? formatActivityTextDescriptor(formatMessage, latest.textDescriptor)
    : latest.text;

  const containerClassName = variant === "mobile"
    ? "border-t-2 border-black bg-white px-3 py-2"
    : "border-t-2 border-black bg-brutal-cream px-3 py-2";

  return (
    <div
      data-testid="live-agent-activity-bar"
      className={containerClassName}
      aria-live="polite"
    >
      <div className="flex min-h-8 items-center gap-2">
        <AvatarSlot
          context="compact-list"
          type="agent"
          agentAvatarUrl={latest.agentAvatarUrl}
        />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <StatusDot activity={latest.activity ?? "offline"} className="shrink-0" />
          <span className="min-w-0 truncate text-sm text-black/60 font-mono" title={text}>
            {text}
          </span>
        </div>
      </div>
    </div>
  );
}
