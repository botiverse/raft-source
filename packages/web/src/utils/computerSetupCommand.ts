export const STAGING_COMPUTER_SERVER_URL = "https://api-aws-staging.botiverse.dev";
export const DEFAULT_COMPUTER_SERVER_URL = "https://api.raft.build";
export const LEGACY_DEFAULT_COMPUTER_SERVER_URL = "https://api.slock.ai";

// The Computer ships as a self-contained SEA binary installed by the native
// shell script (`install.sh` on macOS/Linux, `install.ps1` on Windows), not
// npm — no Node/npm required. Every environment uses the same production entry
// scripts; the installer resolves the Computer release through Hands. Prod
// installs the default `main` channel; staging passes `--channel alpha` (the
// channel staging builds publish to). A version pin (RAFT_COMPUTER_VERSION) is
// forwarded as `--version`, which the installer rejects together with
// `--channel`, so a pinned command carries no channel. The installed binary is
// `raft-computer`.
export const COMPUTER_CDN_BASE_PROD = "https://cdn.raft.build/computer";

/** Hands channel staging deployments install from. */
export const STAGING_COMPUTER_CHANNEL = "alpha";

/** The public guide to installing and connecting Raft Computer (the same
 *  commands the Add Computer dialog shows). */
export const COMPUTER_INSTALL_DOCS_URL = "https://docs.raft.build/features/server/computers/#connecting-a-computer";

export type ComputerCommandPlatform = "mac-linux" | "windows";

function normalizeComputerVersionPin(version?: string | null): string | null {
  const normalized = version?.trim() ?? "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized
    : null;
}

// Installer arguments implied by the environment; none once a version is
// pinned (the pin wins, and the installer rejects --version with --channel).
function computerInstallChannelArgs(deploymentEnv: string | undefined, versionPin: string | null): string[] {
  return deploymentEnv === "staging" && !versionPin ? ["--channel", STAGING_COMPUTER_CHANNEL] : [];
}

function computerInstallShellCommand(
  deploymentEnv: string | undefined,
  version: string | null | undefined,
  extraArgs: string[] = [],
): string {
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = versionPin ? `RAFT_COMPUTER_VERSION=${versionPin} ` : "";
  const args = [...computerInstallChannelArgs(deploymentEnv, versionPin), ...extraArgs];
  return `curl -fsSL ${COMPUTER_CDN_BASE_PROD}/install.sh | ${installEnv}sh${args.length > 0 ? ` -s -- ${args.join(" ")}` : ""}`;
}

export function computerInstallCommand(
  deploymentEnv?: string,
  version?: string | null,
): string {
  return computerInstallShellCommand(deploymentEnv, version);
}

export function windowsComputerInstallCommand(
  deploymentEnv?: string,
  version?: string | null,
): string {
  const versionPin = normalizeComputerVersionPin(version);
  const installEnv = versionPin ? `$env:RAFT_COMPUTER_VERSION = "${versionPin}"; ` : "";
  const args = computerInstallChannelArgs(deploymentEnv, versionPin);
  // `irm … | iex` cannot pass arguments; the scriptblock form can.
  return args.length > 0
    ? `${installEnv}& ([scriptblock]::Create((irm ${COMPUTER_CDN_BASE_PROD}/install.ps1))) ${args.join(" ")}`
    : `${installEnv}irm ${COMPUTER_CDN_BASE_PROD}/install.ps1 | iex`;
}

export interface ComputerSetupCommandOptions {
  // Identity-carried adoption (task #239 PR-D/PR-E): when the calling
  // surface knows WHICH machine row this computer is (machine detail
  // page), the command carries `--machine <id>` and `raft-computer setup`
  // adopts that row directly — no fingerprint matching, no local
  // evidence, works after key rotation. The id is an identifier, not a
  // secret.
  machineId?: string | null;
  platform?: ComputerCommandPlatform;
  // Optional deterministic installer target. Manual fresh-install recovery
  // uses the currently published Computer artifact instead of relying on a
  // CDN edge's potentially stale latest manifest.
  version?: string | null;
}

export interface ComputerCommands {
  install: string;
  setup: string;
  // mac/Linux production only: install, then run setup with the installed
  // binary, in one paste (`… | sh -s -- --setup /slug`). The entry script
  // never depends on the new PATH entry. Null where install and setup stay
  // separate steps (Windows, isolated test deployments).
  installAndSetup: string | null;
  status: string;
  doctor: string;
  // Upgrade in the terminal; the installer prints its result there.
  upgrade: string;
  // Restart the whole Computer service and every attached server runner.
  restartService: string;
  // Restart while scoping lifecycle readback to one server.
  restart: string;
  stop: string;
  start: string;
}

// Non-production deployments (staging / slockdev) are internal test surfaces.
// A tester frequently runs the connect command on a machine that already runs
// a real prod Computer; without isolation the command would install over
// ~/.local/bin/raft-computer and write state into ~/.slock, clobbering their
// prod Computer (binary + channel + state). For these envs every command
// carries the same per-server home/bin, while remaining a separate copy step:
// install only installs, setup only runs the installed binary, and terminal
// actions address that same isolated Computer. Production stays default — real
// users legitimately want a single Computer at the default location.
const ISOLATED_DEPLOYMENT_ENVS = new Set(["staging", "slockdev"]);

export function getComputerCommands(
  serverSlug: string | undefined | null,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
  serverUrl?: string,
  options: ComputerSetupCommandOptions = {},
): ComputerCommands | null {
  const slug = serverSlug?.trim().replace(/^\/+/, "");
  if (!slug) return null;

  const platform = options.platform ?? "mac-linux";

  const commandServerUrl = deploymentEnv === "production"
    ? isDefaultComputerServerUrl(serverUrl) ? null : serverUrl
    : deploymentEnv === "staging"
    ? STAGING_COMPUTER_SERVER_URL
    : deploymentEnv === "slockdev"
      ? serverUrl
      : null;
  const serverUrlArg = commandServerUrl ? ` --server-url ${commandServerUrl}` : "";
  const machineArg = options.machineId ? ` --machine ${options.machineId}` : "";
  const setupArgs = `${serverUrlArg}${machineArg}`;
  if (deploymentEnv && ISOLATED_DEPLOYMENT_ENVS.has(deploymentEnv)) {
    // `slug` is the canonical setup slug (same one used in `setup /${slug}`),
    // so the isolated home matches across web-generated command, #105 harness,
    // and manual QA. Every independent command carries the same env and invokes
    // the isolated binary by full path because it is intentionally not installed
    // on the tester's default PATH. `paths.ts` reads
    // `RAFT_HOME || SLOCK_HOME`, so RAFT_HOME alone carries the state root.
    if (platform === "windows") {
      const home = `$env:USERPROFILE\\.raft-computer-${slug}`;
      const environment = `$env:RAFT_HOME = "${home}"; $env:RAFT_COMPUTER_INSTALL_DIR = "$env:RAFT_HOME\\bin";`;
      const binary = `& "$env:RAFT_COMPUTER_INSTALL_DIR\\raft-computer.exe"`;
      return {
        install: `${environment} ${windowsComputerInstallCommand(deploymentEnv, options.version)}`,
        setup: `${environment} ${binary} setup /${slug}${setupArgs}`,
        installAndSetup: null,
        status: `${environment} ${binary} status`,
        doctor: `${environment} ${binary} doctor`,
        upgrade: `${environment} ${binary} upgrade`,
        restartService: `${environment} ${binary} restart`,
        restart: `${environment} ${binary} restart /${slug}`,
        stop: `${environment} ${binary} stop`,
        start: `${environment} ${binary} start`,
      };
    }

    const home = `$HOME/.raft-computer-${slug}`;
    const environment = `RAFT_HOME="${home}" RAFT_COMPUTER_INSTALL_DIR="${home}/bin"`;
    const binary = `"${home}/bin/raft-computer"`;
    return {
      install: `${environment} sh -c '${computerInstallCommand(deploymentEnv, options.version)}'`,
      setup: `${environment} ${binary} setup /${slug}${setupArgs}`,
      installAndSetup: null,
      status: `${environment} ${binary} status`,
      doctor: `${environment} ${binary} doctor`,
      upgrade: `${environment} ${binary} upgrade`,
      restartService: `${environment} ${binary} restart`,
      restart: `${environment} ${binary} restart /${slug}`,
      stop: `${environment} ${binary} stop`,
      start: `${environment} ${binary} start`,
    };
  }

  return {
    install: platform === "windows"
      ? windowsComputerInstallCommand(deploymentEnv, options.version)
      : computerInstallCommand(deploymentEnv, options.version),
    setup: `raft-computer setup /${slug}${setupArgs}`,
    installAndSetup: platform === "windows"
      ? null
      : computerInstallShellCommand(deploymentEnv, options.version, [`--setup /${slug}${setupArgs}`]),
    status: "raft-computer status",
    doctor: "raft-computer doctor",
    upgrade: "raft-computer upgrade",
    restartService: "raft-computer restart",
    restart: `raft-computer restart /${slug}`,
    stop: "raft-computer stop",
    start: "raft-computer start",
  };
}

export function getComputerSetupCommand(
  serverSlug: string | undefined | null,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
  serverUrl?: string,
  options: ComputerSetupCommandOptions = {},
): string | null {
  return getComputerCommands(serverSlug, deploymentEnv, serverUrl, options)?.setup ?? null;
}

function isDefaultComputerServerUrl(serverUrl: string | undefined): boolean {
  const normalized = serverUrl?.trim().replace(/\/+$/, "");
  return normalized === DEFAULT_COMPUTER_SERVER_URL || normalized === LEGACY_DEFAULT_COMPUTER_SERVER_URL;
}
