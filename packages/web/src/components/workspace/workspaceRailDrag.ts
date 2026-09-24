export const WORKSPACE_RAIL_DRAG_ACTIVATION_PX = 4;
export const WORKSPACE_RAIL_RIGHT_EDGE_PREVIEW_PX = 24;

export function shouldActivateWorkspaceRailDrag(
  startX: number,
  startY: number,
  pointerX: number,
  pointerY: number,
) {
  return Math.hypot(pointerX - startX, pointerY - startY) >= WORKSPACE_RAIL_DRAG_ACTIVATION_PX;
}

export function isWorkspaceRailRightEdge(pointerX: number, viewportWidth: number) {
  return pointerX >= viewportWidth - WORKSPACE_RAIL_RIGHT_EDGE_PREVIEW_PX;
}
