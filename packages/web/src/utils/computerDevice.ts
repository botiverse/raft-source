import { isHostProvider } from "@botiverse/raft-shared";

/** The four device shapes a Computer is drawn as (Lucide laptop / monitor / server / cloud). */
export type ComputerDeviceShape = "laptop" | "monitor" | "server" | "cloud";

export interface ComputerDeviceInput {
  deviceClass?: string | null;
  hostProvider?: string | null;
}

/**
 * The shape for a Computer's icon. A recognised cloud provider
 * (HOST_PROVIDER_LABELS) wins, since a cloud VM also reports "vm" or
 * "server"; then laptop and server by device class. Everything else — Mac
 * mini / Studio / iMac, desktop, VM, container, unknown, an older server that
 * sends no class, and Windows (the Computer does not classify it) — is the
 * monitor every Computer showed before.
 */
export function computerDeviceShape(machine: ComputerDeviceInput): ComputerDeviceShape {
  if (isHostProvider(machine.hostProvider)) return "cloud";
  if (machine.deviceClass === "laptop") return "laptop";
  if (machine.deviceClass === "server") return "server";
  return "monitor";
}

// Proper names, the same in every locale.
const MACOS_NAME = "macOS";
const WINDOWS_NAME = "Windows";
const LINUX_NAME = "Linux";

/**
 * The platform a Computer reports (`os`: "darwin arm64", "win32 x64",
 * "linux x64") as people name it: "macOS arm64", "Windows x64", "Linux x64".
 * Anything else as reported. The one formatter wherever the platform shows.
 */
export function computerPlatformName(os: string | null | undefined): string | null {
  const reported = os?.trim() ?? "";
  if (!reported) return null;
  const [platform = "", ...rest] = reported.split(/\s+/u);
  const lower = platform.toLowerCase();
  const name = lower.startsWith("darwin") || lower === "macos" ? MACOS_NAME
    : lower.startsWith("win") ? WINDOWS_NAME
      : lower.startsWith("linux") ? LINUX_NAME
        : null;
  if (!name) return reported;
  return [name, ...rest].join(" ");
}

/**
 * The OS as one fact for a Computer's meta line: the reported release
 * ("Ubuntu 26.04", Linux only — it is read from os-release), else "macOS" /
 * "Windows" from the platform in `os` ("darwin arm64", "win32 x64"). Null for
 * anything else (Linux without a release, unknown) so the line shows no OS.
 */
export function computerOsName(machine: { os?: string | null; osRelease?: string | null }): string | null {
  const release = machine.osRelease?.trim();
  if (release) return release;
  const platform = machine.os?.trim().toLowerCase() ?? "";
  if (platform.startsWith("darwin")) return MACOS_NAME;
  if (platform.startsWith("win")) return WINDOWS_NAME;
  return null;
}
