import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeDurableTextFile } from "./durableFile";
import type { ComputerApiEvent } from "./lib/events";
import { ComputerServiceError } from "./services/errors";

/*
 * macOS host lifecycle: who brings Computer back after login.
 *
 * - Nothing installs a login item for Computer. Raft Desktop starts the
 *   official install when it opens (its own login item); it records nothing
 *   here. An `owner: "app"` record is left by an older Raft Desktop that ran
 *   an embedded Computer; that Desktop removes it when it moves the machine to
 *   the official install.
 * - The CLI does NOT autostart at login. Earlier releases installed a CLI
 *   LaunchAgent (`build.raft.computer.login.<hash>`) whose plist baked in a
 *   binary path and proxy environment; keeping it correct across upgrades and
 *   reboots failed in the field, so it was removed (tygg, 2026-09-30). A
 *   CLI-hosted Computer comes back on the next CLI/app start or wake, like a
 *   crash.
 *
 * Every CLI converge only deletes a leftover CLI
 * LaunchAgent file for this home, best effort: none of this may affect start,
 * stop, upgrade, or Desktop's Launch at login. If it fails, it fails. They never call launchctl: on a machine
 * that booted through the old agent, the running service IS that launchd job,
 * and `launchctl bootout` would kill it. Deleting the file is enough: the job
 * had `RunAtLoad` and no `KeepAlive`, so nothing loads it again.
 *
 * The owner record (`computer/host-lifecycle-owner.json`) records the CLI's
 * enabled intent; an `owner: "app"` record tells Raft Desktop the machine
 * still has to move from its old embedded Computer to the official install.
 */

const HOST_LIFECYCLE_FORMAT_VERSION = 1 as const;

export type HostLifecycleOwner = "app" | "cli";

export interface HostLifecycleMarker {
  formatVersion: typeof HOST_LIFECYCLE_FORMAT_VERSION;
  owner: HostLifecycleOwner;
  enabled: boolean;
  dispatcherPath: string | null;
  label: string | null;
  definitionPath: string | null;
}

export interface MacosHostLifecycleDeps {
  platform?: NodeJS.Platform;
  userHome?: string;
  signal?: AbortSignal;
}

export interface HostLifecycleConvergenceResult {
  owner: HostLifecycleOwner;
  enabled: boolean;
  status: "converged" | "not-applicable";
  label: string | null;
  definitionPath: string | null;
  definition: string | null;
}

function loginCarrierHash(slockHome: string): string {
  return createHash("sha256")
    .update(path.resolve(slockHome))
    .digest("hex")
    .slice(0, 16);
}

/** Label and plist path of the retired CLI LaunchAgent for this home. */
export function retiredCliLoginCarrierPaths(
  slockHome: string,
  userHome: string = os.homedir(),
): { label: string; definitionPath: string } {
  const label = `build.raft.computer.login.${loginCarrierHash(slockHome)}`;
  return {
    label,
    definitionPath: path.join(path.resolve(userHome), "Library", "LaunchAgents", `${label}.plist`),
  };
}

function markerPath(slockHome: string): string {
  return path.join(
    path.resolve(slockHome),
    "computer",
    "host-lifecycle-owner.json",
  );
}

/** Files only the retired CLI LaunchAgent used. */
function retiredCarrierStatePaths(slockHome: string): string[] {
  const computerDir = path.join(path.resolve(slockHome), "computer");
  return [
    path.join(computerDir, "host-lifecycle-pending-replace.json"),
    path.join(computerDir, "proxy-env.json"),
  ];
}

function parseMarker(raw: string): HostLifecycleMarker | null {
  try {
    const value = JSON.parse(raw) as Partial<HostLifecycleMarker>;
    if (
      value.formatVersion !== HOST_LIFECYCLE_FORMAT_VERSION ||
      (value.owner !== "app" && value.owner !== "cli") ||
      typeof value.enabled !== "boolean" ||
      !(typeof value.dispatcherPath === "string" || value.dispatcherPath === null) ||
      !(typeof value.label === "string" || value.label === null) ||
      !(typeof value.definitionPath === "string" || value.definitionPath === null)
    ) {
      return null;
    }
    return value as HostLifecycleMarker;
  } catch {
    return null;
  }
}

export async function readHostLifecycleMarker(
  slockHome: string,
): Promise<HostLifecycleMarker | null> {
  try {
    const raw = await readFile(markerPath(slockHome), "utf8");
    const marker = parseMarker(raw);
    if (marker === null) {
      throw new ComputerServiceError(
        "HOST_LIFECYCLE_OWNER_UNREADABLE",
        "Raft Computer found an unreadable host-lifecycle owner record. Repair or remove it before changing startup behavior.",
      );
    }
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeMarker(
  slockHome: string,
  marker: HostLifecycleMarker,
): Promise<void> {
  const serialized = `${JSON.stringify(marker)}\n`;
  await writeDurableTextFile(markerPath(slockHome), serialized);
  const readback = await readHostLifecycleMarker(slockHome);
  if (JSON.stringify(readback) !== JSON.stringify(marker)) {
    throw new ComputerServiceError(
      "HOST_LIFECYCLE_OWNER_READBACK_FAILED",
      "Raft Computer could not verify the host-lifecycle owner record after writing it.",
    );
  }
}

export interface RetireCliLoginCarrierResult {
  removed: boolean;
  label: string | null;
  definitionPath: string | null;
  /** Why the cleanup did not finish; it is retried on the next start, stop,
   * or service boot. */
  error: string | null;
}

/**
 * Delete the retired CLI LaunchAgent definition for this home, plus the state
 * files only it used. File removal only; never launchctl (see the header).
 * The label is derived from this home, so a match is this home's own agent.
 * Never throws: a failed cleanup must not affect start, stop, upgrade, or
 * Desktop's Launch at login; it is reported in `error` and retried later.
 * Not macOS: nothing to do.
 */
export async function retireCliLoginCarrier(
  slockHome: string,
  deps: Pick<MacosHostLifecycleDeps, "platform" | "userHome"> = {},
): Promise<RetireCliLoginCarrierResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return { removed: false, label: null, definitionPath: null, error: null };
  const { label, definitionPath } = retiredCliLoginCarrierPaths(slockHome, deps.userHome);
  let removed = false;
  try {
    removed = await stat(definitionPath).then(() => true, () => false);
    await rm(definitionPath, { force: true });
    for (const file of retiredCarrierStatePaths(slockHome)) {
      await rm(file, { force: true });
    }
    return { removed, label, definitionPath, error: null };
  } catch (error) {
    return {
      removed: false,
      label,
      definitionPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The event start/stop emit when the best-effort host lifecycle failed. */
export function hostLifecycleSkipped(
  operation: "start" | "stop",
  error: unknown,
): Extract<ComputerApiEvent, { kind: "host_lifecycle.skipped" }> {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    kind: "host_lifecycle.skipped",
    operation,
    code: typeof code === "string" ? code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * CLI start/stop. Removes any leftover CLI LaunchAgent and records the CLI as
 * owner (Raft Desktop reads this to stay hands-off). Never installs anything,
 * so the result is always "not-applicable" for the CLI owner. An App-owned
 * record keeps its owner; only its `enabled` intent follows the CLI.
 * May throw on an unreadable or unwritable owner record; start/stop treat
 * that as best effort and continue.
 */
export async function convergeCliHostLifecycle(
  slockHome: string,
  desired: "enabled" | "disabled",
  deps: MacosHostLifecycleDeps = {},
): Promise<HostLifecycleConvergenceResult> {
  const platform = deps.platform ?? process.platform;
  const current = await readHostLifecycleMarker(slockHome);
  if (platform !== "darwin") {
    return {
      owner: current?.owner ?? "cli",
      enabled: desired === "enabled",
      status: "not-applicable",
      label: null,
      definitionPath: null,
      definition: null,
    };
  }
  await retireCliLoginCarrier(slockHome, { ...deps, platform });
  const owner: HostLifecycleOwner = current?.owner === "app" ? "app" : "cli";
  await writeMarker(slockHome, {
    formatVersion: HOST_LIFECYCLE_FORMAT_VERSION,
    owner,
    enabled: desired === "enabled",
    dispatcherPath: null,
    label: null,
    definitionPath: null,
  });
  return {
    owner,
    enabled: desired === "enabled",
    status: "not-applicable",
    label: null,
    definitionPath: null,
    definition: null,
  };
}
