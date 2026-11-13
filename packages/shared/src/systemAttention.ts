import { z } from "zod";
import { lazySchema } from "./lazySchema";

import type { RuntimeAccountUsageProvider } from "./runtimeAccountUsage";

export const SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION = "server-system-attention-v1" as const;

export type SystemAttentionKind = "usage_limit_reached";

export interface UsageLimitAttentionNotification {
  id: string;
  kind: "usage_limit_reached";
  severity: "warning";
  state: "active";
  activatedAt: string;
  lastObservedAt: string;
  seenAt: string | null;
  machine: {
    id: string;
    name: string;
  };
  provider: RuntimeAccountUsageProvider;
  windowKey: string;
  resetsAt: string | null;
  affectedAgentIds: string[];
}

export interface ServerSystemAttentionResponse {
  contractVersion: typeof SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION;
  generatedAt: string;
  snapshotMode: "replace";
  unseenCount: number;
  notifications: UsageLimitAttentionNotification[];
}

export const systemAttentionReceiptInputSchema = lazySchema("systemAttentionReceiptInputSchema", () => z.strictObject({
  incidentId: z.string().uuid(),
}));

export type SystemAttentionReceiptInput = z.infer<typeof systemAttentionReceiptInputSchema>;
