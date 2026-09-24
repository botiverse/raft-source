import { readFile } from "node:fs/promises";

import { kRunnerHoldPath } from "./kPaths.js";

/** HostAdapter state only: true means the service must not spawn runners yet. */
export async function readKRunnerHold(slockHome: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(kRunnerHoldPath(slockHome), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  try {
    const parsed = JSON.parse(raw) as { formatVersion?: unknown; held?: unknown };
    return parsed.formatVersion === 1 && parsed.held === true;
  } catch {
    return true;
  }
}
