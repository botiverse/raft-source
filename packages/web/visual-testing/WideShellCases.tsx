import { useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import MainLayout from "../src/components/layout/MainLayout";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// Wide-layout parity cases (mobile #proj-mobile:#195): the real MainLayout in a 1280x800
// window by touch (the manifest's `viewport.pointer: "coarse"`, captured at 2x), beside the
// Android wide lane (compose_wide_shell_visual on a 2560x1600 @ 320dpi display). The stores
// are the shared primed navigation stores (channels, the Activity rows of
// activityResultsFixture.json, the tasks of tasksFixture.json). The harness serves no task,
// thread or message loads yet, so a task or thread opened from the URL would only show its
// loading state (a task opens as a loading dialog over Activity): the React side of
// activity-task, channel-thread and tasks-task renders the list column with nothing open, and
// the channel's messages show their loading rows. Serving those loads is the follow-up.

const slug = fixtureData.server.slug;

const WIDE_SHELL_ROUTES = {
  "screens.wide.activity-task": { path: `/s/${slug}/activity` },
  "screens.wide.channel": { path: `/s/${slug}/channel/channel-home` },
  "screens.wide.channel-thread": { path: `/s/${slug}/channel/channel-home` },
  "screens.wide.settings": { path: `/s/${slug}/settings/appearance` },
  "screens.wide.tasks-task": { path: `/s/${slug}/tasks` },
} as const satisfies Record<string, { path: string; params?: Record<string, string> }>;

type WideShellCaseId = keyof typeof WIDE_SHELL_ROUTES;

export const WIDE_SHELL_CASE_IDS = Object.keys(WIDE_SHELL_ROUTES) as WideShellCaseId[];

export function isWideShellCase(caseId: string): caseId is WideShellCaseId {
  return Object.prototype.hasOwnProperty.call(WIDE_SHELL_ROUTES, caseId);
}

export function wideShellCaseRoute(caseId: WideShellCaseId): { path: string; params?: Record<string, string> } {
  return WIDE_SHELL_ROUTES[caseId];
}

export function WideShellCase({ caseId, primeShell }: { caseId: WideShellCaseId; primeShell: () => void }) {
  useMemo(() => primeShell(), [primeShell]);
  if (window.location.pathname !== WIDE_SHELL_ROUTES[caseId].path) return null;
  return (
    <main className="h-dvh bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex h-full w-full flex-col overflow-hidden">
        <Routes>
          <Route path="/s/:serverSlug/*" element={<MainLayout />} />
        </Routes>
      </div>
    </main>
  );
}
