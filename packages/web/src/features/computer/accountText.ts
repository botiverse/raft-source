import type { RuntimeAuthAccount } from "@botiverse/raft-shared";

export function accountText(account: RuntimeAuthAccount | undefined): string | null {
  const parts = [account?.maskedLabel, account?.planLabel].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
