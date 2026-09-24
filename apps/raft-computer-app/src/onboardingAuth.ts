import { ensureUsableUserSession } from "@botiverse/raft-computer/lib";

export async function hasValidUserSession(slockHome: string): Promise<boolean> {
  return (await ensureUsableUserSession(slockHome)).status === "usable";
}
