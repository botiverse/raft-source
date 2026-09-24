/**
 * Ordinary login accepts an existing sk_agent_* through a hidden prompt or
 * stdin, verifies its identity, and atomically saves a mode-0600 profile.
 * It does not request device authorization or mint another credential.
 * Explicit `login start` / `login wait` retain the legacy browser flow.
 * `login status` verifies an existing profile. Subsequent commands select
 * it with `raft --profile <slug>` or RAFT_PROFILE. Tokens are never printed.
 */

import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import type { Command } from "commander";
import { fetch as undiciFetch } from "undici";

import {
  authorizeDeviceCode,
  DeviceCodeLoginError,
  describeDeviceCodeLoginError,
  pollDeviceToken,
  type DeviceAuthorization,
} from "../../agentLogin/deviceAuthClient.js";
import { resolveProfileDir } from "../../auth/env.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { NL, writeDiagnostic, writeText } from "../../core/renderer.js";
import {
  formatAlreadyLoggedIn,
  formatAgentTokenPrompt,
  formatAuthorizedLoginReport,
  formatCredentialRemintNotice,
  formatLoginStateMissing,
  formatLoginStatus,
  formatStartHandoff,
  startCommandLine,
  waitCommandLine,
  type LoginProfilePaths as ProfilePaths,
} from "./_format.js";

// Re-export for existing test imports; canonical home is agent/_format.ts.
export { formatAuthorizedLoginReport } from "./_format.js";

interface AgentCredentialResponse {
  credentialId: string;
  apiKey: string;
  scopes: string[];
  agentId: string;
  agentName: string;
  serverId: string;
}

interface MintErrorDetail {
  message: string;
  suggestedNextAction?: string;
}



interface BaseLoginOptions {
  server: string;
  agent: string;
  profileSlug?: string;
  profileDir?: string;
}

// Client-side safety ceiling for `login wait` polling. The server enforces
// the real expiry (returns `expired_token` once the device_code dies); this
// only bounds how long `wait` blocks if the server never resolves.
const WAIT_MAX_POLL_MS = 15 * 60 * 1000;

const SERVER_OPTION = {
  flags: "--server <url>",
  description: "Raft server base URL, e.g. https://app.raft.build",
} as const;
const AGENT_OPTION = {
  flags: "--agent <agentId>",
  description: "Agent id to log in as",
} as const;
const CLIENT_NAME_OPTION = {
  flags: "--client-name <label>",
  description: "Human-readable label shown on the web approval page",
} as const;
const PROFILE_SLUG_OPTION = {
  flags: "--profile-slug <slug>",
  description:
    "Slug to save the new profile under (defaults to the agent id). Distinct from root `raft --profile`, which selects an existing profile to use.",
} as const;
const PROFILE_DIR_OPTION = {
  flags: "--profile-dir <path>",
  description:
    "Override the profile directory root (default resolution uses the managed Raft home when present, otherwise the local profile store)",
} as const;
const DEVICE_CODE_OPTION = {
  flags: "--device-code <code>",
  description: "The device_code returned by `raft agent login start`",
} as const;

/**
 * Commander (without positional-options mode) lets the PARENT `login`
 * command consume any flag it also declares — even when the flag is written
 * after the subcommand: `raft agent login start --server x` binds `--server`
 * to `login`, and `start`'s own options object arrives empty, failing
 * validation with a misleading "--server is required" (task #61, field
 * repro by xxchan on @slock-ai/cli 0.0.4). `optsWithGlobals()` merges the
 * full parent chain with local values taking precedence, so the subcommand
 * sees the flag wherever the user wrote it. Same root-shadow class as the
 * `--profile` contract pinned in login.test.ts — one level down.
 */
function mergeParentLoginOpts<T extends object>(options: T, command?: Command): T {
  if (command && typeof command.optsWithGlobals === "function") {
    return { ...command.optsWithGlobals(), ...options } as T;
  }
  return options;
}

// ---------------------------------------------------------------------------
// `raft agent login` — direct existing-token login
// ---------------------------------------------------------------------------

export const agentLoginCommand = defineCommand(
  {
    name: "login",
    description: "Log in with an existing agent token (hidden prompt or stdin). No browser approval required.",
    options: [
      SERVER_OPTION,
      AGENT_OPTION,
      CLIENT_NAME_OPTION,
      PROFILE_SLUG_OPTION,
      PROFILE_DIR_OPTION,
    ],
  },
  async (ctx, options: BaseLoginOptions & { clientName?: string }) => {
    validateServerAgent(options);
    const paths = resolveProfilePaths(options);

    // Idempotency: re-running login on an existing profile verifies the
    // credential against the server rather than failing blindly (SHA-V0-006C).
    const idempotent = await handleExistingCredential(ctx, options, paths);
    if (idempotent === "handled") return;

    const apiKey = await readAgentToken(ctx);
    let response;
    try {
      response = await undiciFetch(`${options.server.replace(/\/+$/, "")}/internal/agent-api/`, {
        headers: { authorization: `Bearer ${apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw cliError("CREDENTIAL_CHECK_FAILED", "Could not verify the token with this server. The profile was not changed.");
    }
    if (!response.ok) {
      throw cliError(
        response.status === 401 || response.status === 403 ? "INVALID_AGENT_TOKEN" : "CREDENTIAL_CHECK_FAILED",
        "The server did not accept the token. The profile was not changed.",
      );
    }
    const identity = await safeJson(response) as Partial<AgentCredentialResponse> | null;
    if (!identity || typeof identity.agentId !== "string" || typeof identity.agentName !== "string"
      || typeof identity.serverId !== "string" || !identity.serverId
      || typeof identity.credentialId !== "string" || !identity.credentialId
      || !Array.isArray(identity.scopes) || !identity.scopes.every((scope) => typeof scope === "string")) {
      throw cliError("CREDENTIAL_CHECK_FAILED", "The server returned an invalid identity response. The profile was not changed.");
    }
    if (identity.agentId !== options.agent) {
      throw cliError("AGENT_IDENTITY_MISMATCH", "This token belongs to a different agent. The profile was not changed.");
    }
    await persistCredential(ctx, options, { ...identity, apiKey } as AgentCredentialResponse, paths);
  },
);

/** Never accept a bearer in argv or echo it, including readline's TTY redraws. */
async function readAgentToken(ctx: CommandContext): Promise<string> {
  const input = ctx.io.stdin;
  if (!input) throw cliError("AGENT_TOKEN_REQUIRED", "Provide an agent token through stdin or the hidden terminal prompt.");
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY);
  if (terminal) writeDiagnostic(ctx.io, formatAgentTokenPrompt());
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input, output: muted, terminal });
  const token = await new Promise<string>((resolve, reject) => {
    reader.once("line", (line) => { resolve(line.trim()); reader.close(); });
    reader.once("close", () => resolve(""));
    reader.once("SIGINT", () => { reader.close(); });
    input.once("error", onError);
    function onError() { reject(cliError("AGENT_TOKEN_REQUIRED", "Could not read an agent token.")); reader.close(); }
    reader.once("close", () => input.removeListener("error", onError));
  });
  if (terminal) writeDiagnostic(ctx.io, NL);
  if (!/^sk_agent_[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) {
    throw cliError("INVALID_AGENT_TOKEN", "Enter a valid agent token from the External Agent setup page.");
  }
  return token;
}

// ---------------------------------------------------------------------------
// `raft agent login start` — nonblocking handoff
// ---------------------------------------------------------------------------

export const agentLoginStartCommand = defineCommand(
  {
    name: "start",
    description:
      "Begin device-code login and print the browser handoff, then exit (does not wait for approval).",
    options: [SERVER_OPTION, AGENT_OPTION, CLIENT_NAME_OPTION, PROFILE_SLUG_OPTION, PROFILE_DIR_OPTION],
  },
  async (ctx, rawOptions: BaseLoginOptions & { clientName?: string }, command?: Command) => {
    const options = mergeParentLoginOpts(rawOptions, command);
    validateServerAgent(options);
    const paths = resolveProfilePaths(options);

    let authorization: DeviceAuthorization;
    try {
      authorization = await authorizeDeviceCode({
        serverUrl: options.server,
        ...(options.clientName ? { clientName: options.clientName } : {}),
      });
    } catch (err) {
      throw asCliError(err);
    }

    writeText(ctx.io, formatStartHandoff(authorization, options, paths));
  },
);

// ---------------------------------------------------------------------------
// `raft agent login wait` — resume polling + mint
// ---------------------------------------------------------------------------

export const agentLoginWaitCommand = defineCommand(
  {
    name: "wait",
    description:
      "Wait for the user to approve a `login start` request, then mint and save the credential.",
    options: [SERVER_OPTION, AGENT_OPTION, DEVICE_CODE_OPTION, PROFILE_SLUG_OPTION, PROFILE_DIR_OPTION],
  },
  async (ctx, rawOptions: BaseLoginOptions & { deviceCode: string }, command?: Command) => {
    const options = mergeParentLoginOpts(rawOptions, command);
    validateServerAgent(options);
    if (!options.deviceCode?.trim()) {
      throw cliError("INVALID_ARG", "--device-code is required (the value printed by `raft agent login start`).");
    }
    const paths = resolveProfilePaths(options);

    let userSession: { accessToken: string; refreshToken: string; userId: string };
    try {
      userSession = await pollDeviceToken({
        serverUrl: options.server,
        deviceCode: options.deviceCode,
        pollIntervalMs: 5000,
        deadlineMs: Date.now() + WAIT_MAX_POLL_MS,
      });
    } catch (err) {
      throw asCliError(err);
    }

    await mintAndPersist(ctx, options, userSession.accessToken, paths);
  },
);

// ---------------------------------------------------------------------------
// `raft agent login status` — classify the existing profile credential
// ---------------------------------------------------------------------------

export const agentLoginStatusCommand = defineCommand(
  {
    name: "status",
    description: "Report whether the local profile credential is usable, expired, or needs re-login.",
    options: [SERVER_OPTION, AGENT_OPTION, PROFILE_SLUG_OPTION, PROFILE_DIR_OPTION],
  },
  async (ctx, rawOptions: BaseLoginOptions, command?: Command) => {
    const options = mergeParentLoginOpts(rawOptions, command);
    validateServerAgent(options);
    const paths = resolveProfilePaths(options);

    if (!(await profileFileExists(paths.credentialPath))) {
      writeText(ctx.io, formatLoginStateMissing(options, paths));
      return;
    }

    const outcome = await tryIdempotentLogin(paths.credentialPath, options);
    writeText(ctx.io, formatLoginStatus(outcome, options, paths));
  },
);

export function registerAgentLoginCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, agentLoginCommand, runtimeOptions);
  const loginCmd = parent.commands.find((c) => c.name() === "login");
  if (!loginCmd) {
    throw new Error("internal: `login` command was not registered before attaching subcommands");
  }
  registerCliCommand(loginCmd, agentLoginStartCommand, runtimeOptions);
  registerCliCommand(loginCmd, agentLoginWaitCommand, runtimeOptions);
  registerCliCommand(loginCmd, agentLoginStatusCommand, runtimeOptions);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function validateServerAgent(options: { server: string; agent: string }): void {
  if (!options.server?.trim()) {
    throw cliError("INVALID_ARG", "--server is required");
  }
  if (!options.agent?.trim()) {
    throw cliError("INVALID_AGENT_ID", "--agent must not be empty.");
  }
  // Catches the most common operator confusion (passing a handle / channel
  // name / URL where the server expects an agent id) before any browser step.
  const invalidShape = describeInvalidAgentIdShape(options.agent);
  if (invalidShape) {
    throw cliError("INVALID_AGENT_ID", invalidShape, {
      suggestedNextAction: `Run \`raft agent list --server ${options.server}\` to see valid agent ids, then rerun login with --agent <id>.`,
    });
  }
}

function resolveProfilePaths(options: BaseLoginOptions): ProfilePaths {
  // Share the same resolver auth/env.ts uses so a login write at path X is
  // always read back at path X. Honors SLOCK_HOME isolation.
  const profileSlug = options.profileSlug ?? options.agent;
  const profileDir = options.profileDir ?? resolveProfileDir(profileSlug);
  const credentialPath = path.join(profileDir, "credential.json");
  return { profileSlug, profileDir, credentialPath };
}

/**
 * Idempotency gate shared by the one-shot path. Returns "handled" when the
 * caller should stop (already logged in, or a fatal mismatch/unverified was
 * thrown); returns "continue" when a replacement token is needed.
 */
async function handleExistingCredential(
  ctx: CommandContext,
  options: { server: string; agent: string; profileSlug?: string; profileDir?: string },
  paths: ProfilePaths,
): Promise<"handled" | "continue"> {
  if (!(await profileFileExists(paths.credentialPath))) {
    return "continue";
  }
  const outcome = await tryIdempotentLogin(paths.credentialPath, options);
  if (outcome === "already_logged_in") {
    writeText(ctx.io, formatAlreadyLoggedIn(paths.profileSlug));
    return "handled";
  }
  if (outcome === "mismatch") {
    throw cliError(
      "PROFILE_ALREADY_EXISTS",
      `Profile '${paths.profileSlug}' is already bound to a different agent or server at ${paths.credentialPath}.`,
      {
        suggestedNextAction: `Use a different \`--profile-slug <slug>\` to save another agent's token.`,
      },
    );
  }
  if (outcome === "unverified") {
    throw cliError(
      "CREDENTIAL_CHECK_FAILED",
      `Could not verify the existing credential for profile '${paths.profileSlug}' because the server is unreachable.`,
      {
        suggestedNextAction: `The existing credential may still be valid. Retry when the server is reachable.`,
      },
    );
  }
  // "expired" or "invalid" → accept an explicitly supplied replacement.
  writeDiagnostic(ctx.io, formatCredentialRemintNotice(paths.profileSlug));
  return "continue";
}

/**
 * Legacy `login wait`: mint using the approved user session, then save.
 */
async function mintAndPersist(
  ctx: CommandContext,
  options: { server: string; agent: string },
  accessToken: string,
  paths: ProfilePaths,
): Promise<void> {
  // No X-Server-Id header — the route derives server context from the agent
  // row (CLI resource-explicit invariant, see #proj-runtime:3d515727).
  const mintRes = await undiciFetch(
    `${options.server.replace(/\/+$/, "")}/api/agents/${encodeURIComponent(options.agent)}/credentials`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    },
  );
  if (!mintRes.ok) {
    const body = (await safeJson(mintRes)) as { code?: string; error?: string } | null;
    const code = body?.code ?? `mint_failed_${mintRes.status}`;
    const detail = describeMintError(code, options.server);
    throw cliError(
      code,
      detail?.message ?? body?.error ?? `Failed to mint agent credential (status ${mintRes.status}).`,
      detail?.suggestedNextAction ? { suggestedNextAction: detail.suggestedNextAction } : undefined,
    );
  }
  const minted = (await mintRes.json()) as AgentCredentialResponse;
  if (!minted.apiKey || !minted.agentId || !minted.serverId) {
    throw cliError("mint_response_invalid", "Server mint response was missing apiKey / agentId / serverId.");
  }

  await persistCredential(ctx, options, minted, paths);
}

async function persistCredential(ctx: CommandContext, options: { server: string }, minted: AgentCredentialResponse, paths: ProfilePaths): Promise<void> {
  await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(path.join(paths.profileDir, ".credential-"));
  try {
    await writeFile(
      path.join(tempDir, "credential.json"),
      JSON.stringify({
        schemaVersion: 1,
        serverUrl: options.server,
        agentId: minted.agentId,
        agentName: minted.agentName,
        serverId: minted.serverId,
        credentialId: minted.credentialId,
        scopes: minted.scopes,
        apiKey: minted.apiKey,
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(path.join(tempDir, "credential.json"), paths.credentialPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  // Authorized report — never print the apiKey. Point the agent at the
  // running-reference guide (SHA-V0-006C / 007). The report is read by two
  // audiences (one-shot login = human at a terminal; login wait = usually an
  // agent session), so the Next lines address both explicitly (xxchan,
  // task #63) — both keep the grep-stable `Next` prefix.
  writeText(ctx.io, formatAuthorizedLoginReport({
    agentName: minted.agentName,
    server: options.server,
    credentialPath: paths.credentialPath,
    profileSlug: paths.profileSlug,
  }));
}

function asCliError(err: unknown): Error {
  if (err instanceof DeviceCodeLoginError) {
    return cliError(err.code, err.message, { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function safeJson(res: { json: () => Promise<unknown> }): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Run only when a credential file already exists. Reads the local profile,
 * checks identity match, and validates the credential against the server.
 *
 * Returns:
 * - "already_logged_in" — identity matches + server confirms credential is valid.
 * - "mismatch"          — identity mismatch (different agent/server); slug keeps its identity.
 * - "expired"           — identity matches but credential is revoked/expired on the server.
 * - "unverified"        — could not reach the server to decide (network / 5xx / unparsable 200).
 * - "invalid"           — credential file is malformed or missing key fields.
 */
async function tryIdempotentLogin(
  credentialPath: string,
  options: { server: string; agent: string },
): Promise<"already_logged_in" | "mismatch" | "expired" | "unverified" | "invalid"> {
  let credential: { agentId?: unknown; serverUrl?: unknown; serverId?: unknown; apiKey?: unknown };
  try {
    const raw = await readFile(credentialPath, "utf-8");
    credential = JSON.parse(raw);
  } catch {
    return "invalid";
  }

  const localAgentId = typeof credential.agentId === "string" ? credential.agentId : "";
  const localApiKey = typeof credential.apiKey === "string" ? credential.apiKey : "";
  const localServerUrl = typeof credential.serverUrl === "string" ? credential.serverUrl : "";
  const localServerId = typeof credential.serverId === "string" ? credential.serverId : "";
  const targetServer = options.server.replace(/\/+$/, "");

  // Identity mismatch: slug keeps its existing identity, don't silently switch.
  if (localAgentId && localAgentId !== options.agent) {
    return "mismatch";
  }
  if (localServerUrl && localServerUrl.replace(/\/+$/, "") !== targetServer) {
    return "mismatch";
  }

  // Missing key fields: can't validate, treat as invalid.
  if (!localAgentId || !localApiKey || !localServerUrl) {
    return "invalid";
  }

  // Validate this exact credential against the server. Use the agent-api
  // whoami endpoint so the server derives the bound agent/credential from
  // the bearer token — proves this specific apiKey is still valid, not
  // just that the agent has some active credential (Ray, msg=8d5e77b7).
  try {
    const whoamiRes = await undiciFetch(`${targetServer}/internal/agent-api/`, {
      headers: { authorization: `Bearer ${localApiKey}` },
    });
    if (whoamiRes.ok) {
      const body = (await safeJson(whoamiRes)) as { agentId?: string; serverId?: string } | null;
      if (!body) {
        // 200 but body unparseable → server-side issue, retryable.
        return "unverified";
      }
      if (body.agentId === localAgentId && (body.serverId === localServerId || !localServerId)) {
        return "already_logged_in";
      }
      // 200 but identity mismatch — the apiKey resolves to a different
      // identity than the local file claims. Treat as conflict, not expired.
      return "mismatch";
    }
    // 401 / 403 → credential is explicitly invalid/revoked/expired.
    if (whoamiRes.status === 401 || whoamiRes.status === 403) {
      return "expired";
    }
    // 5xx / 404 / other non-2xx → server-side issue, not a credential
    // validity signal. Don't re-mint: a transient whoami failure must not
    // mint a new key for a still-valid profile (Ray's blocker).
    return "unverified";
  } catch {
    // Network unreachable (DNS / connect / timeout) — same reasoning:
    // don't treat a network blip as credential expiry.
    return "unverified";
  }
}

async function profileFileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Catch obviously-wrong shapes for `--agent`. The server's agent ids are
 * opaque to the CLI, so we don't validate the format — we only reject
 * inputs that look like they belong to a different kind of identifier.
 * Returns a human-readable description of the problem when the shape is
 * obviously wrong, or `null` if the input is plausibly an agent id.
 */
export function describeInvalidAgentIdShape(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "--agent must not be empty.";
  }
  if (trimmed.startsWith("@")) {
    return "--agent expects an agent id (an opaque server-issued identifier), not an @handle.";
  }
  if (trimmed.startsWith("#")) {
    return "--agent expects an agent id, not a #channel name.";
  }
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("/")) {
    return "--agent expects an agent id, not a URL or path.";
  }
  return null;
}

export function describeMintError(code: string, serverUrl: string): MintErrorDetail | undefined {
  switch (code) {
    case "device_login_disabled":
      return { message: describeDeviceCodeLoginError(code) ?? code };
    case "agent_missing":
      return {
        message:
          "Agent id is not known on this server, or the user you approved with isn't a member of the agent's server.",
        suggestedNextAction: `Run \`raft agent list --server ${serverUrl}\` to see manageable agents, then rerun login with --agent <id>.`,
      };
    case "insufficient_role":
      return {
        message:
          "The user you approved with has neither `issueAgentCredentials` on the agent's server nor human-creator authority for this agent, so they can't mint agent credentials.",
        suggestedNextAction:
          "Approve with the human user who created this agent, or ask a server owner or admin for access that includes `issueAgentCredentials`, then rerun login.",
      };
    case "scopes_invalid":
    case "scopes_empty":
    case "name_invalid":
      return {
        message: "Invalid request body for the agent credential mint. Re-run with default flags.",
      };
  }
  return undefined;
}
