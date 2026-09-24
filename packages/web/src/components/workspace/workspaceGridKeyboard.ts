export type WorkspaceTabNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End";

export interface WorkspaceTabsetRect {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function nextWorkspaceTabIndex(
  length: number,
  currentIndex: number,
  key: WorkspaceTabNavigationKey,
): number {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  const current = Math.max(0, Math.min(currentIndex, length - 1));
  return key === "ArrowLeft"
    ? (current - 1 + length) % length
    : (current + 1) % length;
}

export function nextWorkspaceMruTabId(
  mruTabIds: readonly string[],
  currentTabId: string | null,
  exists: (tabId: string) => boolean,
): string | null {
  const available = mruTabIds.filter(
    (tabId) => tabId !== currentTabId && exists(tabId),
  );
  return available[0] ?? null;
}

export function adjacentWorkspaceTabsetId(
  tabsets: readonly WorkspaceTabsetRect[],
  currentId: string,
  direction: "left" | "right",
): string | null {
  const current = tabsets.find((candidate) => candidate.id === currentId);
  if (!current) return null;
  const currentCenterX = (current.left + current.right) / 2;
  const currentCenterY = (current.top + current.bottom) / 2;

  const candidates = tabsets
    .filter((candidate) => {
      if (candidate.id === currentId) return false;
      const centerX = (candidate.left + candidate.right) / 2;
      if (
        direction === "left"
          ? centerX >= currentCenterX
          : centerX <= currentCenterX
      )
        return false;
      return (
        Math.min(current.bottom, candidate.bottom) -
          Math.max(current.top, candidate.top) >
        0
      );
    })
    .map((candidate) => {
      const centerX = (candidate.left + candidate.right) / 2;
      const centerY = (candidate.top + candidate.bottom) / 2;
      return {
        id: candidate.id,
        score:
          Math.abs(centerX - currentCenterX) +
          Math.abs(centerY - currentCenterY) * 2,
      };
    })
    .sort((a, b) => a.score - b.score);

  return candidates[0]?.id ?? null;
}
