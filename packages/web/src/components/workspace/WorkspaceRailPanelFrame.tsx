import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type WorkspaceRailPanelMode = "activity" | "search" | "tasks" | "saved";

const TOOLBAR_SELECTOR: Partial<Record<WorkspaceRailPanelMode, string>> = {
  activity: '[data-testid="inbox-toolbar"]',
  search: ".shrink-0.border-b-2.border-black.bg-white.px-4.py-3",
  tasks: ".shrink-0.border-b-2.border-black.bg-white.px-4.py-3",
};

export default function WorkspaceRailPanelFrame({
  mode,
  borderClass,
  children,
}: {
  mode: WorkspaceRailPanelMode;
  borderClass: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [showOverflowCue, setShowOverflowCue] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    const selector = TOOLBAR_SELECTOR[mode];
    if (!root || !selector) return;

    let toolbar: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const updateCue = () => {
      setShowOverflowCue(Boolean(
        toolbar && toolbar.scrollLeft + toolbar.clientWidth < toolbar.scrollWidth - 2,
      ));
    };
    const connectToolbar = () => {
      const nextToolbar = root.querySelector<HTMLElement>(selector);
      if (!nextToolbar) return;
      if (nextToolbar === toolbar) {
        updateCue();
        return;
      }
      toolbar?.removeEventListener("scroll", updateCue);
      resizeObserver?.disconnect();
      toolbar = nextToolbar;
      toolbar.classList.add("workspace-grid-panel-toolbar");
      toolbar.addEventListener("scroll", updateCue, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(updateCue);
        resizeObserver.observe(toolbar);
      }
      updateCue();
    };

    connectToolbar();
    const mutationObserver = new MutationObserver(connectToolbar);
    mutationObserver.observe(root, { childList: true, subtree: true });
    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      toolbar?.removeEventListener("scroll", updateCue);
    };
  }, [mode]);

  return (
    <div
      ref={rootRef}
      className={`workspace-grid-chrome-density workspace-grid-chrome-${mode} relative flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden overflow-y-hidden ${borderClass}`}
      data-testid={`workspace-${mode}-panel-frame`}
    >
      <div className="workspace-grid-panel-content flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden overflow-y-hidden">
        {children}
      </div>
      {showOverflowCue && (
        <div
          aria-hidden="true"
          className="workspace-grid-toolbar-overflow-cue pointer-events-none absolute right-0 top-12 z-10 h-10 w-6"
          data-testid={`workspace-${mode}-toolbar-overflow-cue`}
        />
      )}
    </div>
  );
}
