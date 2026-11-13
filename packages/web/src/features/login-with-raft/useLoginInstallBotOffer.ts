import { useCallback, useState } from "react";
import type { AvailableServerClient } from "./loginClientSummary";

/**
 * f4 on Install and Continue: "Also add @handle to {server}", as the Settings ›
 * Apps install dialog has it. Offered (`bot`) when the lookup names the App's
 * bot; not offered,
 * the install sends no `bot`. Checked by default for each Server picked.
 * `conflictHandle`: the bot an install on this Server couldn't add (its
 * handle is taken), set with `setConflict`; another Server picked hides it.
 */
export function useLoginInstallBotOffer(entry: AvailableServerClient | null, canInstall: boolean) {
  const serverId = entry?.server.id ?? null;
  const bot = canInstall ? entry?.client.bot ?? null : null;
  const [choice, setChoice] = useState<{ serverId: string; checked: boolean } | null>(null);
  const checked = choice !== null && choice.serverId === serverId ? choice.checked : true;
  const onCheckedChange = useCallback((value: boolean) => {
    if (serverId) setChoice({ serverId, checked: value });
  }, [serverId]);
  const [conflict, setConflict] = useState<{ serverId: string; handle: string } | null>(null);
  const conflictHandle = conflict !== null && conflict.serverId === serverId ? conflict.handle : null;
  return { bot, checked, onCheckedChange, conflictHandle, setConflict };
}
