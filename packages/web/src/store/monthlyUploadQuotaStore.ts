import { create } from "zustand";
import { registerServerReset } from "./serverResetRegistry";
import { useServerStore } from "./serverStore";
import type { MonthlyUploadQuota } from "../utils/monthlyUploadQuota";

/**
 * The last monthly upload quota the server reported for a server.
 *
 * An upload entry (the composer's attach buttons, a drop, a paste, Save as
 * Artifact) opens the upgrade dialog instead when the month's quota is used
 * up, and it has to decide at once: a file picker opens only inside the click
 * that asked for it, so there is no time to ask the server. This is that
 * answer, kept fresh by every capability fetch (each selection makes one), by
 * each refusal, and by the composer when it mounts. A stale "used up" costs at
 * most one dialog: the selection itself is always checked against a fresh
 * answer, and a new month or a plan change voids it (`monthlyUploadUsedUp`).
 */
interface MonthlyUploadQuotaState {
  serverId: string | null;
  /** Null where none applies (Pro), or before the server has said. */
  quota: MonthlyUploadQuota | null;
}

export const useMonthlyUploadQuotaStore = create<MonthlyUploadQuotaState>(() => ({ serverId: null, quota: null }));

registerServerReset(() => {
  useMonthlyUploadQuotaStore.setState({ serverId: null, quota: null });
});

export function noteMonthlyUploadQuota(serverId: string, quota: MonthlyUploadQuota | null): void {
  useMonthlyUploadQuotaStore.setState({ serverId, quota });
}

/** Less than this left is nothing worth picking a file for. */
export const MONTHLY_UPLOAD_USED_UP_BELOW_BYTES = 1024 * 1024;

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The current server's quota when its month is used up, else null: a Free
 * server, this UTC month, under 1 MB left.
 */
export function monthlyUploadUsedUp(now = new Date()): MonthlyUploadQuota | null {
  const { serverId, quota } = useMonthlyUploadQuotaStore.getState();
  const server = useServerStore.getState();
  if (!quota || serverId !== server.current?.id) return null;
  const plan = server.billing?.plan || server.current?.plan || "free";
  const appsumo = plan === "pro" && (server.billing?.source === "appsumo" || quota.source === "appsumo");
  if (plan !== "free" && !appsumo) return null;
  if (plan === "free" && quota.source === "appsumo") return null;
  if (quota.month !== currentUtcMonth(now)) return null;
  return quota.remainingBytes < MONTHLY_UPLOAD_USED_UP_BELOW_BYTES ? quota : null;
}
