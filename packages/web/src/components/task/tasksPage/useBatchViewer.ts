import { useMemo } from "react";

import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useAuthStore } from "../../../store/authStore";
import type { BatchViewer } from "./tasksBatch";

/** Who is acting, for the batch actions' permissions (tasksBatch.canApplyBatchAction). */
export function useBatchViewer(): BatchViewer {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const { role, capabilities } = useServerPermissions();
  return useMemo<BatchViewer>(() => ({
    userId,
    // A Guest assigns in its own channel without the capability (the server's rule).
    canAssign: capabilities.assignTasks || role === "guest",
    canDeleteAny: capabilities.deleteAnyTask,
  }), [capabilities.assignTasks, capabilities.deleteAnyTask, role, userId]);
}
