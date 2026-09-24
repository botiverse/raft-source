import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type LegacyDaemonSupervisorKind = "pm2" | "systemd" | "launchd";

export interface LegacyDaemonSupervisorGuidance {
  kind: LegacyDaemonSupervisorKind;
  cleanupCommands: string[];
  detail: string;
}

export interface LegacyDaemonSupervisorProbe {
  pid: number;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execFile(file: string, args: string[]): string | undefined;
  readFile(file: string): string | undefined;
}

function execFileText(file: string, args: string[]): string | undefined {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function readFileText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function defaultProbe(pid: number): LegacyDaemonSupervisorProbe {
  return {
    pid,
    platform: process.platform,
    env: process.env,
    execFile: execFileText,
    readFile: readFileText,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parentPid(
  probe: LegacyDaemonSupervisorProbe,
  pid: number,
): number | undefined {
  const stdout = probe.execFile("ps", ["-o", "ppid=", "-p", String(pid)]);
  const parsed = Number.parseInt(stdout?.trim() ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function processCommand(
  probe: LegacyDaemonSupervisorProbe,
  pid: number,
): string {
  return (
    probe
      .execFile("ps", ["-o", "command=", "-p", String(pid)])
      ?.trim()
      .toLowerCase() ?? ""
  );
}

function relatedProcessIds(probe: LegacyDaemonSupervisorProbe): number[] {
  const ids = [probe.pid];
  let current = probe.pid;
  for (let depth = 0; depth < 12; depth += 1) {
    const parent = parentPid(probe, current);
    if (!parent || ids.includes(parent)) break;
    ids.push(parent);
    if (parent === 1) break;
    current = parent;
  }
  return ids;
}

function detectPm2(
  probe: LegacyDaemonSupervisorProbe,
  relatedPids: number[],
): LegacyDaemonSupervisorGuidance | undefined {
  const hasPm2Ancestor = relatedPids
    .slice(1)
    .some((pid) => processCommand(probe, pid).includes("pm2"));
  const hasPm2Environment = Boolean(probe.env.PM2_HOME || probe.env.pm_id);
  if (!hasPm2Ancestor && !hasPm2Environment) return undefined;

  const pm2Json = probe.execFile("pm2", ["jlist"]);
  if (pm2Json) {
    try {
      const entries = JSON.parse(pm2Json) as Array<{
        name?: unknown;
        pid?: unknown;
      }>;
      const entry = entries.find(
        (candidate) =>
          typeof candidate.pid === "number" &&
          relatedPids.includes(candidate.pid),
      );
      if (entry) {
        const name =
          typeof entry.name === "string" && entry.name.length > 0
            ? entry.name
            : String(entry.pid);
        return {
          kind: "pm2",
          detail: `PM2 app ${JSON.stringify(name)} is supervising this legacy daemon.`,
          cleanupCommands: [`pm2 delete ${shellQuote(name)}`, "pm2 save"],
        };
      }
    } catch {
      // PM2 is optional; malformed output falls through to ancestor detection.
    }
  }

  return {
    kind: "pm2",
    detail:
      "PM2 is supervising this legacy daemon, but its app name could not be resolved.",
    cleanupCommands: ["pm2 delete <legacy-daemon-app-name>", "pm2 save"],
  };
}

function systemdUnitFromCgroup(
  cgroup: string | undefined,
): { unit: string; user: boolean } | undefined {
  if (!cgroup) return undefined;
  for (const line of cgroup.split("\n")) {
    const pathPart = line.slice(line.lastIndexOf(":") + 1);
    let unit: string | undefined;
    for (const segment of pathPart.split("/")) {
      if (
        segment.endsWith(".service") &&
        segment.length > ".service".length &&
        !/^user@\d+\.service$/.test(segment)
      ) {
        unit = segment;
      }
    }
    if (unit) return { unit, user: pathPart.includes("/user.slice/") };
  }
  return undefined;
}

function detectSystemd(
  probe: LegacyDaemonSupervisorProbe,
): LegacyDaemonSupervisorGuidance | undefined {
  if (probe.platform !== "linux") return undefined;
  const cgroupUnit = systemdUnitFromCgroup(
    probe.readFile(`/proc/${probe.pid}/cgroup`),
  );
  const hasSystemdEvidence =
    cgroupUnit !== undefined || probe.env.INVOCATION_ID !== undefined;
  if (!hasSystemdEvidence) return undefined;

  if (cgroupUnit) {
    const prefix = cgroupUnit.user ? "systemctl --user" : "sudo systemctl";
    return {
      kind: "systemd",
      detail: `systemd unit ${JSON.stringify(cgroupUnit.unit)} is supervising this legacy daemon.`,
      cleanupCommands: [
        `${prefix} disable --now ${shellQuote(cgroupUnit.unit)}`,
      ],
    };
  }
  return {
    kind: "systemd",
    detail:
      "systemd is supervising this legacy daemon, but its unit name could not be resolved.",
    cleanupCommands: [
      "systemctl --user disable --now <legacy-daemon-unit>.service",
    ],
  };
}

function detectLaunchd(
  probe: LegacyDaemonSupervisorProbe,
): LegacyDaemonSupervisorGuidance | undefined {
  if (probe.platform !== "darwin") return undefined;
  const label = probe.env.LAUNCH_JOBKEY_LABEL || probe.env.XPC_SERVICE_NAME;
  if (!label || label === "0") return undefined;
  return {
    kind: "launchd",
    detail: `launchd job ${JSON.stringify(label)} is supervising this legacy daemon.`,
    cleanupCommands: [
      `launchctl bootout gui/$(id -u)/${shellQuote(label)}`,
      `rm -f ~/Library/LaunchAgents/${shellQuote(`${label}.plist`)}`,
    ],
  };
}

export function detectLegacyDaemonSupervisor(
  pid = process.pid,
): LegacyDaemonSupervisorGuidance | undefined {
  return detectLegacyDaemonSupervisorWithProbe(defaultProbe(pid));
}

/** Injectable probe seam for deterministic tests; production callers should pass a pid above. */
export function detectLegacyDaemonSupervisorWithProbe(
  probe: LegacyDaemonSupervisorProbe,
): LegacyDaemonSupervisorGuidance | undefined {
  const relatedPids = relatedProcessIds(probe);
  return (
    detectPm2(probe, relatedPids) ??
    detectSystemd(probe) ??
    detectLaunchd(probe)
  );
}

export const legacyDaemonSupervisorFallbackCommands = [
  "PM2: pm2 delete <legacy-daemon-app-name> && pm2 save",
  "systemd: systemctl --user disable --now <legacy-daemon-unit>.service",
  "launchd: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<legacy-daemon-label>.plist && rm -f ~/Library/LaunchAgents/<legacy-daemon-label>.plist",
] as const;
