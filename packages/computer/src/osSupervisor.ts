import { createHash } from "node:crypto";
import path from "node:path";

import { buildSystemdDiscoveryPath } from "./systemdDiscoveryPath.js";

export type OsSupervisorKind = "launchd-user" | "systemd-user" | "windows-task";
export type SupervisorDefinitionOwnership =
  | "absent"
  | "exact"
  | "repairable"
  | "foreign";

export interface BuildOsSupervisorSpecInput {
  platform: NodeJS.Platform;
  slockHome: string;
  binaryPath: string;
  userHome: string;
  runtimeSearchPath?: string;
  uid: number | null;
  windowsUserId?: string;
  xdgConfigHome?: string;
}

export interface OsSupervisorSpec {
  kind: OsSupervisorKind;
  id: string;
  slockHome: string;
  binaryPath: string;
  definitionPath: string | null;
  definition: string;
  ownerToken: string;
  command: string;
  args: string[];
}

export type OsSupervisorAction = "stop" | "status";

const HISTORICAL_LAUNCHD_LABEL_RE =
  /^build\.raft\.computer\.([0-9a-f]{16})$/;

export function describeOsSupervisorKind(kind: OsSupervisorKind): string {
  if (kind === "launchd-user") return "macOS per-user launchd agent";
  if (kind === "systemd-user") return "Linux per-user systemd unit";
  return "Windows per-user scheduled task (not an SCM service)";
}

export interface SupervisorCommand {
  command: string;
  args: string[];
  /** Missing/unloaded jobs are expected while converging idempotently. */
  allowFailure?: boolean;
}

const CONTRACT_VERSION = "v1";

function normalizeForPlatform(
  value: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    return path.win32.resolve(value).replace(/[\\/]+$/, "");
  }
  return path.resolve(value);
}

function supervisorHash(slockHome: string, platform: NodeJS.Platform): string {
  const normalized = normalizeForPlatform(slockHome, platform);
  return createHash("sha256")
    .update(
      `${platform}\0${platform === "win32" ? normalized.toLowerCase() : normalized}`,
    )
    .digest("hex")
    .slice(0, 16);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Prove that one historical LaunchAgent definition belongs to this Computer
 * home. The label family is deliberately anchored: substring matching `raft`
 * also catches unrelated applications such as Drafts.
 *
 * Historical labels encoded the home hash in both the launchd label and the
 * owner token. The executable path may legitimately differ after an install
 * move, so ownership is instead bound to the closed `__service` argv shape,
 * the exact normalized home, and the matching v1 owner token.
 */
export function isOwnedHistoricalLaunchdDefinition(
  slockHome: string,
  label: string,
  definition: string,
): boolean {
  const match = HISTORICAL_LAUNCHD_LABEL_RE.exec(label);
  if (!match) return false;
  const hash = match[1]!;
  const labelNeedle = `<string>${xmlEscape(label)}</string>`;
  const ownerNeedle = `<string>${xmlEscape(`raft-computer-os-supervisor-v1-${hash}`)}</string>`;
  const args = definition.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  if (!args) return false;
  const expectedArgs = [
    "__service",
    "--slock-home",
    normalizeForPlatform(slockHome, "darwin"),
    "--os-supervised",
    "launchd-user",
  ].map((value) => `<string>${xmlEscape(value)}</string>`);
  let cursor = 0;
  for (const needle of expectedArgs) {
    const next = args.indexOf(needle, cursor);
    if (next < 0) return false;
    cursor = next + needle.length;
  }
  return definition.includes(labelNeedle) && definition.includes(ownerNeedle);
}

function systemdQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(
      "OS_SUPERVISOR_INVALID_PATH: systemd paths cannot contain control characters",
    );
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Quote one argv token using the CommandLineToArgvW inverse rules. */
export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    backslashes = 0;
    result += char;
  }
  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

function commonArgs(slockHome: string, kind: OsSupervisorKind): string[] {
  return ["__service", "--slock-home", slockHome, "--os-supervised", kind];
}

function buildSystemdDefinition(
  binaryPath: string,
  args: string[],
  ownerToken: string,
  userHome: string,
  runtimeSearchPath: string | undefined,
): string {
  return [
    "[Unit]",
    `Description=Raft Computer per-user service (${ownerToken})`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=${systemdQuote(`PATH=${buildSystemdDiscoveryPath(userHome, runtimeSearchPath)}`)}`,
    `ExecStart=${[binaryPath, ...args].map(systemdQuote).join(" ")}`,
    "Restart=always",
    "RestartSec=2",
    "KillMode=control-group",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function buildLaunchdDefinition(
  id: string,
  binaryPath: string,
  args: string[],
  ownerToken: string,
  serviceLogPath: string,
  userHome: string,
): string {
  const argv = [binaryPath, ...args]
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${xmlEscape(id)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    argv,
    "    </array>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "      <key>RAFT_COMPUTER_SUPERVISOR_OWNER</key>",
    `      <string>${ownerToken}</string>`,
    "      <key>PATH</key>",
    `      <string>${xmlEscape(buildLaunchdDiscoveryPath(userHome))}</string>`,
    "    </dict>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "    <key>ProcessType</key>",
    "    <string>Background</string>",
    "    <key>StandardOutPath</key>",
    `    <string>${xmlEscape(serviceLogPath)}</string>`,
    "    <key>StandardErrorPath</key>",
    `    <string>${xmlEscape(serviceLogPath)}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * Stable executable discovery roots for a background LaunchAgent.
 *
 * launchd does not start a login shell, so it cannot be expected to inherit
 * user shell rc PATH mutations. Keep this list explicit: sourcing shell rc in
 * a service context would execute arbitrary interactive-shell code, while
 * inheriting the installer process PATH would make the persisted definition
 * host/process dependent. Non-standard directories remain an explicit future
 * configuration surface rather than an ambient inheritance rule.
 */
export function buildLaunchdDiscoveryPath(userHome: string): string {
  return [
    path.join(path.resolve(userHome), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(":");
}

function buildWindowsTaskDefinition(
  binaryPath: string,
  args: string[],
  ownerToken: string,
  windowsUserId: string,
): string {
  const argumentLine = args.map(quoteWindowsArgument).join(" ");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>Raft Computer per-user supervisor (${ownerToken})</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${xmlEscape(windowsUserId)}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(windowsUserId)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Enabled>true</Enabled>",
    "    <RestartOnFailure>",
    "      <Interval>PT2S</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(binaryPath)}</Command>`,
    `      <Arguments>${xmlEscape(argumentLine)}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

export function buildOsSupervisorSpec(
  input: BuildOsSupervisorSpecInput,
): OsSupervisorSpec {
  const slockHome = normalizeForPlatform(input.slockHome, input.platform);
  const binaryPath = normalizeForPlatform(input.binaryPath, input.platform);
  const hash = supervisorHash(slockHome, input.platform);
  const ownerToken = `raft-computer-os-supervisor-${CONTRACT_VERSION}-${hash}`;

  if (input.platform === "linux") {
    const kind: OsSupervisorKind = "systemd-user";
    const id = `raft-computer-${hash}.service`;
    const args = commonArgs(slockHome, kind);
    const configRoot = input.xdgConfigHome
      ? path.resolve(input.xdgConfigHome)
      : path.join(path.resolve(input.userHome), ".config");
    return {
      kind,
      id,
      slockHome,
      binaryPath,
      definitionPath: path.join(configRoot, "systemd", "user", id),
      definition: buildSystemdDefinition(
        binaryPath,
        args,
        ownerToken,
        input.userHome,
        input.runtimeSearchPath,
      ),
      ownerToken,
      command: binaryPath,
      args,
    };
  }

  if (input.platform === "darwin") {
    if (
      input.uid === null ||
      !Number.isSafeInteger(input.uid) ||
      input.uid < 0
    ) {
      throw new Error(
        "OS_SUPERVISOR_UID_REQUIRED: launchd user jobs require a numeric uid",
      );
    }
    const kind: OsSupervisorKind = "launchd-user";
    const id = `build.raft.computer.${hash}`;
    const args = commonArgs(slockHome, kind);
    return {
      kind,
      id,
      slockHome,
      binaryPath,
      definitionPath: path.join(
        path.resolve(input.userHome),
        "Library",
        "LaunchAgents",
        `${id}.plist`,
      ),
      definition: buildLaunchdDefinition(
        id,
        binaryPath,
        args,
        ownerToken,
        path.join(slockHome, "computer", "run", "service.log"),
        input.userHome,
      ),
      ownerToken,
      command: binaryPath,
      args,
    };
  }

  if (input.platform === "win32") {
    if (!input.windowsUserId?.trim()) {
      throw new Error(
        "OS_SUPERVISOR_WINDOWS_USER_REQUIRED: scheduled tasks require the current user SID",
      );
    }
    const kind: OsSupervisorKind = "windows-task";
    const id = `\\Raft-Computer-${hash}`;
    const args = commonArgs(slockHome, kind);
    return {
      kind,
      id,
      slockHome,
      binaryPath,
      definitionPath: null,
      definition: buildWindowsTaskDefinition(
        binaryPath,
        args,
        ownerToken,
        input.windowsUserId.trim(),
      ),
      ownerToken,
      command: binaryPath,
      args,
    };
  }

  throw new Error(`OS_SUPERVISOR_UNSUPPORTED_PLATFORM: ${input.platform}`);
}

/**
 * Classify actual manager bytes. A same-home v1 definition is repairable when
 * only its binary path/manager formatting differs; anything without the exact
 * unforgeable-by-accident owner token and service argv is foreign/fail-closed.
 */
export function classifySupervisorDefinition(
  expected: OsSupervisorSpec,
  actual: string | null,
): SupervisorDefinitionOwnership {
  if (actual === null) return "absent";
  if (actual === expected.definition) return "exact";
  if (!actual.includes(expected.ownerToken)) return "foreign";

  // Task Scheduler rewrites imported XML (notably whitespace, declaration
  // formatting, and the top-level Enabled value after `/Change /DISABLE`).
  // Byte equality would therefore misclassify our own disabled task as
  // repairable and make the public `start` command impossible. Treat the
  // immutable execution/restart/login fields as the Windows exactness oracle;
  // enabled/running are separate manager state read through Schedule.Service.
  if (expected.kind === "windows-task") {
    const requiredElementValues = [
      "Command",
      "Arguments",
      "UserId",
      "LogonType",
      "RunLevel",
      "MultipleInstancesPolicy",
      "StartWhenAvailable",
      "ExecutionTimeLimit",
      "Interval",
      "Count",
    ];
    const elementValues = (xml: string, tag: string): string[] => {
      return Array.from(
        xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "gi")),
        (match) => match[1]?.trim() ?? "",
      );
    };
    const exactFields = requiredElementValues.every((tag) => {
      const wanted = elementValues(expected.definition, tag);
      const observed = elementValues(actual, tag);
      return (
        wanted.length > 0 && JSON.stringify(observed) === JSON.stringify(wanted)
      );
    });
    const enabledLogonTrigger =
      /<LogonTrigger\b[^>]*>[\s\S]*?<Enabled>\s*true\s*<\/Enabled>[\s\S]*?<\/LogonTrigger>/i.test(
        actual,
      );
    if (
      exactFields &&
      enabledLogonTrigger &&
      /<RestartOnFailure\b/i.test(actual)
    ) {
      return "exact";
    }
  }

  const homeNeedle =
    expected.kind === "launchd-user"
      ? `<string>${xmlEscape(expected.slockHome)}</string>`
      : expected.kind === "windows-task"
        ? xmlEscape(quoteWindowsArgument(expected.slockHome))
        : systemdQuote(expected.slockHome);
  if (
    !actual.includes("__service") ||
    !actual.includes("--slock-home") ||
    !actual.includes(homeNeedle)
  ) {
    return "foreign";
  }
  return "repairable";
}

export function buildSupervisorCommandPlan(
  spec: OsSupervisorSpec,
  action: OsSupervisorAction,
  opts: { uid: number | null },
): SupervisorCommand[] {
  if (spec.kind === "systemd-user") {
    if (action === "stop") {
      return [
        { command: "systemctl", args: ["--user", "disable", "--now", spec.id] },
      ];
    }
    return [
      {
        command: "systemctl",
        args: [
          "--user",
          "show",
          spec.id,
          "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID",
        ],
      },
    ];
  }

  if (spec.kind === "launchd-user") {
    if (opts.uid === null || !Number.isSafeInteger(opts.uid) || opts.uid < 0) {
      throw new Error(
        "OS_SUPERVISOR_UID_REQUIRED: launchd user jobs require a numeric uid",
      );
    }
    const domain = `gui/${opts.uid}`;
    const service = `${domain}/${spec.id}`;
    if (action === "stop") {
      return [
        { command: "launchctl", args: ["disable", service] },
        {
          command: "launchctl",
          args: ["bootout", service],
          allowFailure: true,
        },
      ];
    }
    return [{ command: "launchctl", args: ["print", service] }];
  }

  if (action === "stop") {
    return [
      {
        command: "schtasks.exe",
        args: ["/Change", "/TN", spec.id, "/DISABLE"],
      },
      {
        command: "schtasks.exe",
        args: ["/End", "/TN", spec.id],
        allowFailure: true,
      },
    ];
  }
  return [
    {
      command: "schtasks.exe",
      // `/HRESULT` on EVERY exact existence query, not just the direct one in
      // readRetirementDefinition: this plan is the second, independent path that
      // decides whether the task is gone, and fixing only one would leave an
      // identically broken oracle behind.
      args: ["/Query", "/TN", spec.id, "/XML", "/HRESULT"],
    },
    {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$s=New-Object -ComObject 'Schedule.Service';$s.Connect();[Console]::Out.Write([int]$s.GetFolder('\\').GetTask($args[0]).State)",
        spec.id.slice(1),
      ],
    },
  ];
}
