import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isShellEnvOutcome } from "./shellEnvCapture.js";

export interface ProcessVersionEvidence {
  version: string | null;
  installRoot: string;
  pid: number;
  writtenAt: string;
  /** Parent observed when the evidence was written; observability only. */
  parentPid?: number;
  /**
   * Terminal-equivalent shell env import outcome for supervised service
   * boots: "inherited" or "unavailable:<code>" (task #326 ②surface). Codes
   * only — never environment values.
   */
  shellEnvironment?: string;
}

export async function writeProcessVersionEvidence(
  path: string,
  evidence: ProcessVersionEvidence,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function readProcessVersionEvidence(
  path: string,
): Promise<ProcessVersionEvidence | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ProcessVersionEvidence>;
    if (
      typeof parsed.installRoot !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.writtenAt !== "string" ||
      (parsed.parentPid !== undefined && typeof parsed.parentPid !== "number") ||
      (parsed.shellEnvironment !== undefined && typeof parsed.shellEnvironment !== "string") ||
      (parsed.version !== null && typeof parsed.version !== "string")
    ) {
      return null;
    }
    return {
      version: parsed.version ?? null,
      installRoot: parsed.installRoot,
      pid: parsed.pid,
      writtenAt: parsed.writtenAt,
      ...(parsed.parentPid !== undefined ? { parentPid: parsed.parentPid } : {}),
      // Closed-set enforcement (B3): only "inherited" or "unavailable:<one of
      // the seven capture failure codes>" may surface; any other string —
      // hand-edited, corrupted, or future drift — is dropped, so the rendered
      // status line structurally cannot carry values or control characters.
      ...(parsed.shellEnvironment !== undefined && isShellEnvOutcome(parsed.shellEnvironment)
        ? { shellEnvironment: parsed.shellEnvironment }
        : {}),
    };
  } catch {
    return null;
  }
}
