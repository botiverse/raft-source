import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentDate } from "@botiverse/raft-shared";
import { COMPUTER_VERSION } from "./version.js";
import { serverRunnerVersionPath, serviceVersionPath } from "./paths.js";
import { SHELL_ENV_STATE_ENV_VAR } from "./shellEnvCapture.js";
import {
  readProcessVersionEvidence,
  writeProcessVersionEvidence,
  type ProcessVersionEvidence,
} from "./versionEvidence.js";

export interface ServiceVersionEvidence {
  version: string | null;
  installRoot: string;
  pid: number;
  writtenAt: string;
}

async function resolveServiceIdentity(): Promise<{ installRoot: string; version: string | null }> {
  const here = fileURLToPath(import.meta.url);
  const installRoot = dirname(dirname(here));
  let version: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(join(installRoot, "package.json"), "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) version = parsed.version;
  } catch {
    // Dev-mode and SEA have no install-root package.json.
  }
  return { installRoot, version: version ?? (COMPUTER_VERSION || null) };
}

async function writeEvidence(
  path: string,
  roleDescription: string,
  parentPid?: number,
): Promise<void> {
  try {
    const identity = await resolveServiceIdentity();
    const payload: ProcessVersionEvidence = {
      version: COMPUTER_VERSION,
      installRoot: identity.installRoot,
      pid: process.pid,
      writtenAt: currentDate().toISOString(),
      ...(parentPid !== undefined ? { parentPid } : {}),
      ...(process.env[SHELL_ENV_STATE_ENV_VAR]
        ? { shellEnvironment: process.env[SHELL_ENV_STATE_ENV_VAR] }
        : {}),
    };
    await writeProcessVersionEvidence(path, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Service: failed to write ${roleDescription} version evidence: ${message}. Continuing.\n`);
  }
}

export function writeServiceVersionEvidence(slockHome: string): Promise<void> {
  return writeEvidence(serviceVersionPath(slockHome), "service", process.ppid);
}

export function writeRunnerVersionEvidence(slockHome: string, serverId: string): Promise<void> {
  return writeEvidence(serverRunnerVersionPath(slockHome, serverId), `runner for ${serverId}`);
}

export async function readServiceVersionEvidence(
  slockHome: string,
): Promise<ServiceVersionEvidence | null> {
  return readProcessVersionEvidence(serviceVersionPath(slockHome));
}
