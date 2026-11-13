/**
 * `raft agent logout`: the profile's `sk_agent_*` key revokes itself on the
 * server (only that credential; the agent's other keys stay active), then the
 * profile's credential.json is removed. The file goes only once the server
 * revoked the key (200) or no longer accepts it (401); on any other answer the
 * file is kept and the error names the next step, so a profile never loses
 * the only copy of a key that may still be active. The key is never printed.
 *
 * The profile is the one every other command uses: root `--profile <slug>` or
 * RAFT_PROFILE, resolved and checked by loadAgentContext (a managed runtime
 * refuses a profile selector, so a daemon-held key is never touched here).
 */

import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { Command } from "commander";

import { selfRevokeAgentKey } from "../../agentLogin/selfRevoke";
import { AgentBootstrapError, resolveProfileDir, type AgentContext } from "../../auth/env";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import {
  describeLogoutRevokeFailure,
  formatLogoutNotLoggedIn,
  formatLogoutReport,
  logoutCommandLine,
  type LoginProfilePaths,
} from "./_format";

export const agentLogoutCommand = defineCommand(
  {
    name: "logout",
    description: "Revoke this profile's agent key on the server, then remove the profile's saved credential.",
    helpAfter: `
Profile:
  Logs out the profile other commands use, chosen with --profile or RAFT_PROFILE:
    ${logoutCommandLine("<slug>")}
  Only this profile's key is revoked; the agent's other keys stay active.
  The credential file is removed once the server has revoked the key or no
  longer accepts it. Otherwise the file is kept and the error says what to do.
`,
  },
  async (ctx) => {
    const profileSlug = ctx.env.RAFT_PROFILE ?? ctx.env.SLOCK_PROFILE;
    if (!profileSlug) {
      throw cliError(
        "LOGOUT_REQUIRES_PROFILE",
        "No profile is selected. `raft agent logout` logs out a profile saved by `raft agent login`.",
        { suggestedNextAction: `Run \`${logoutCommandLine("<slug>")}\` with the profile's slug.` },
      );
    }
    let profileDir: string;
    try {
      profileDir = resolveProfileDir(profileSlug, ctx.env);
    } catch (err) {
      if (err instanceof AgentBootstrapError) throw cliError(err.code, err.message, { cause: err });
      throw err;
    }
    const paths: LoginProfilePaths = { profileSlug, profileDir, credentialPath: path.join(profileDir, "credential.json") };

    // Same resolution and checks as every profile command (alias conflict,
    // managed-runtime refusal, malformed file); only a missing file is fine.
    let agent: AgentContext;
    try {
      agent = ctx.loadAgentContext();
    } catch (err) {
      if (err instanceof CliError && err.code === "PROFILE_FILE_UNREADABLE" && !(await fileExists(paths.credentialPath))) {
        writeText(ctx.io, formatLogoutNotLoggedIn(paths));
        return;
      }
      throw err;
    }
    const credentialId = await readCredentialId(paths.credentialPath);
    const outcome = await selfRevokeAgentKey(ctx, {
      serverUrl: agent.serverUrl,
      agentId: agent.agentId,
      serverId: agent.serverId,
      apiKey: agent.token,
    });
    if (outcome === "revoked" || outcome === "already_inactive") {
      await rm(paths.credentialPath, { force: true });
      writeText(ctx.io, formatLogoutReport(outcome, credentialId, { server: agent.serverUrl, agent: agent.agentId }, paths));
      return;
    }
    const failure = describeLogoutRevokeFailure(outcome, credentialId, paths);
    throw cliError(failure.code, failure.message, { suggestedNextAction: failure.suggestedNextAction });
  },
);

export function registerAgentLogoutCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, agentLogoutCommand, runtimeOptions);
}

async function readCredentialId(credentialPath: string): Promise<string | null> {
  try {
    const { credentialId } = JSON.parse(await readFile(credentialPath, "utf-8")) as { credentialId?: unknown };
    return typeof credentialId === "string" && credentialId ? credentialId : null;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
