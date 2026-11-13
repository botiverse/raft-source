// Cursor on OAR (#oar-raft:#10), behind the server flag
// `agent_runtime_oar_cursor` (default off).
//
// OAR 0.101 runs the Cursor SDK (`@cursor/sdk`, a daemon dependency) in a
// Node child per session (`execution: "subprocess"`, oarLoader.ts), started
// from an empty environment (`envBase: "clean"`). OAR refuses
// `systemPrompt`, `appendSystemPrompt` and `launchArgs` for it, so the launch
// carries `cwd`, `env`, `model`, `resume` and `mcpServers`:
//
// - Standing prompt: no native channel. The OAR host puts it ahead of a fresh
//   session's first input (the cursor driver sets no
//   `supportsNativeStandingPrompt`), as the legacy Cursor driver does.
// - Environment (`cursorChildEnv`): the child, and the tool shells the SDK
//   starts, get only what the session's `env` gives them: a few of the
//   daemon's variables a shell and Node need (HOME, TMPDIR, the locale, the
//   user, proxies), `SHELL=/bin/sh` so the SDK's `$SHELL -lc` reads no bash
//   or zsh startup files, and the launch's own variables from Raft's
//   CLI transport: PATH with the agent's `raft` wrapper dir in front, the
//   agent's identity, and the agent's configured env vars. Daemon-only
//   variables (the Computer's key file pointer, profile selectors, telemetry
//   settings) never reach it.
// - Cursor API key: `CURSOR_API_KEY` (the agent's env vars first, else the
//   daemon's) goes in the session's `env`, and OAR takes it out of the
//   child's environment and hands it to the SDK as `apiKey` over IPC (OAR
//   #741): tool shells and `/proc/<pid>/environ` do not see it.
// - Managed MCP: `SessionOptions.mcpServers`, HTTP with the token as a bearer
//   header (oarManagedMcp.ts), sent on create and again on resume. Never the
//   workspace `.cursor/mcp.json` the legacy driver writes with the token in
//   the URL.
// - Resume: only a Cursor SDK agent id (`agent-<uuid>`). A Cursor CLI session
//   is dropped before the launch (`runtime_host_changed`, oarAgentHost.ts) and
//   never reaches here.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthStatus } from "@botiverse/oar";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields } from "@botiverse/raft-shared";
import { prepareCliTransport } from "../drivers/cliTransport";
import type { SpawnContext } from "../drivers/types";
import type { ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import { ambientProcessEnv } from "../processEnvPatch";
import { isCursorSdkSessionId } from "../runtimeSpec";
import type { OarLaunch } from "./oarLaunch";
import { managedMcpSessionOptions, prepareOarManagedMcp } from "./oarManagedMcp";

/**
 * The Cursor SDK model for an agent's configured model. The Cursor CLI's
 * "let Cursor pick" ids (`default`, `auto`) are the SDK catalog's `default`
 * entry, which OAR opens when no model is given (and on a resume, the model
 * the agent's latest run used). Any other id passes as is; one the SDK does
 * not list fails the open, which hands the start back to the legacy driver.
 */
export function cursorSdkModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  return /^(default|auto)$/i.test(trimmed) ? null : trimmed;
}

/**
 * The daemon variables a Cursor child keeps under `envBase: "clean"`: what
 * Node, a POSIX shell and the SDK's network calls need (OAR's own check
 * opened a session with HOME, PATH, TMPDIR, LANG, LC_ALL, USER, LOGNAME and
 * SHELL), proxies and an extra CA bundle, and `CURSOR_API_KEY`, which OAR
 * moves out of the environment into the SDK's `apiKey`. The agent's own
 * env vars and Raft's launch variables go over these.
 */
export const CURSOR_CHILD_INHERITED_ENV = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "CURSOR_API_KEY",
] as const;

/**
 * A Cursor child's whole environment (OAR `envBase: "clean"`): from `base`
 * (the daemon's environment with the launch's over it) only
 * `CURSOR_CHILD_INHERITED_ENV`, then `SHELL=/bin/sh` (the SDK's shell tool
 * runs `$SHELL -lc`: a POSIX login shell reads only /etc/profile and
 * ~/.profile, not the user's bash or zsh startup files), then `own`, the variables the launch sets itself
 * (`prepareCliTransport` `launchEnv`: the agent's env vars, its identity and
 * PATH with the `raft` wrapper dir in front), which win.
 */
export function cursorChildEnv(base: NodeJS.ProcessEnv, own: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CURSOR_CHILD_INHERITED_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  env.SHELL = "/bin/sh";
  for (const [name, value] of Object.entries(own)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The environment of a Cursor sign-in read (OAR's `authStatus`, a one-shot
 * child under the same clean base) for an agent: the daemon's variables a
 * child keeps, with the agent's env vars over them, so its `CURSOR_API_KEY`
 * and HOME are the ones its session would get.
 */
export function cursorAuthEnv(envVars: Readonly<Record<string, string>> | null | undefined, daemonEnv: NodeJS.ProcessEnv = ambientProcessEnv()): Record<string, string> {
  return cursorChildEnv({ ...daemonEnv, ...(envVars ?? {}) }, envVars ?? {});
}

/**
 * The Cursor SDK's sign-in for a start: its stored login
 * (`Cursor.auth.status`), or `CURSOR_API_KEY` in the read's environment
 * (`cursorAuthEnv`; OAR answers `unknown` with it configured, unvalidated):
 * `signed_in`. A definite `logged_out`: `signed_out`. Anything else (a failed or late read)
 * is `unknown`, which never alone moves an agent off its SDK session
 * (oarAgentHost.ts `cursorSignIn`).
 */
export function cursorSdkSignIn(status: AuthStatus): "signed_in" | "signed_out" | "unknown" {
  if (status.kind === "logged_in") return "signed_in";
  if (status.kind === "logged_out") return "signed_out";
  return (status.configured ?? []).some((label) => label.includes("CURSOR_API_KEY")) ? "signed_in" : "unknown";
}

/**
 * Where the Cursor SDK keeps its login (`FileCredentialStore`; OAR's Cursor
 * docs: `~/.cursor/sdk/auth.json`, what `Cursor.auth.status()` reads).
 */
export function cursorSdkAuthFile(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".cursor", "sdk", "auth.json");
}

/**
 * Whether the SDK could have a sign-in at all, read without loading it (its
 * bundle and native companion): `CURSOR_API_KEY` set, or its auth file
 * present. Neither: signed out, and the SDK is never imported for the check.
 */
export function cursorSdkCredentialPresent(input: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (file: string) => boolean;
} = {}): boolean {
  if ((input.env ?? process.env).CURSOR_API_KEY !== undefined) return true;
  return (input.exists ?? existsSync)(cursorSdkAuthFile(input.homeDir));
}

/** A prepared Raft launch as an OAR Cursor launch, on the child environment given (`cursorChildEnv`). */
export function cursorOarLaunch(
  ctx: SpawnContext,
  input: { env: Record<string, string>; managedMcp?: ManagedMcpRuntimeEndpoint | null },
): OarLaunch {
  const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const model = cursorSdkModel(launchFields.model);
  const sessionId = ctx.config.sessionId?.trim();
  // A Cursor CLI id never reaches the SDK (dropped before the launch); kept out here too.
  const resume = sessionId && isCursorSdkSessionId(sessionId) ? sessionId : null;
  return {
    runtimeId: "cursor",
    // The SDK beside the daemon, run in OAR's child (oarLoader.ts cursorSdkModule).
    installation: { kind: "available", via: "bundled" },
    options: {
      cwd: ctx.workingDirectory,
      // The child's whole environment (envBase "clean"); OAR moves CURSOR_API_KEY to the SDK's apiKey.
      env: input.env,
      ...(model ? { model } : {}),
      ...(resume ? { resume } : {}),
      // Given on every open: the SDK keeps none for an agent across a resume.
      ...managedMcpSessionOptions(input.managedMcp),
    },
    // The SDK's run takes mid-run input (`run.steer`); with no run OAR answers
    // `no_active_turn` and the host holds the delivery for the turn end.
    busyDelivery: "now",
  };
}

export async function prepareCursorOarLaunch(ctx: SpawnContext): Promise<OarLaunch> {
  // The credential proxy, the wrappers and the launch environment.
  const { spawnEnv, launchEnv } = await prepareCliTransport(ctx);
  return cursorOarLaunch(ctx, { env: cursorChildEnv(spawnEnv, launchEnv), managedMcp: await prepareOarManagedMcp(ctx) });
}
