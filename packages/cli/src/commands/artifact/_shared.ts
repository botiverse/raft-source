// Shared by `raft artifact …`: the operations live in
// @botiverse/raft-shared (agentOps/artifacts.ts, the same ones the SDK runs);
// this file turns their failures into the CLI's error envelope and parses the
// arguments every subcommand takes.

import type { RaftFailure } from "@botiverse/raft-shared";
import { AGENT_API_ARTIFACT_ERROR_CODES, AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE, AGENT_API_RATE_LIMITED_CODE, opError } from "@botiverse/raft-shared/src/agentCliSurface";

import { rateLimitedCliError } from "../../core/apiFailure";
import { CliError, cliError, type CliErrorCode } from "../../core/errors";

/** The Artifacts codes the CLI shows as they are (CliErrorCode lists each). */
const ARTIFACT_CLI_CODES = new Set<string>(AGENT_API_ARTIFACT_ERROR_CODES);
/** A request refused before sending carries this next step unless the operation wrote its own. */
const GENERIC_INVALID_REQUEST_NEXT = opError("INVALID_REQUEST").nextAction;

/**
 * An operation's failure as a CliError: the Artifacts code when there is one,
 * its sentence and next step. `again` is the command as run (commandLineOf),
 * for a write the Server refused over the agent's rate limit: run it again
 * after the wait. `rateLimitedLeftBehind`: what such a refusal left behind,
 * when the command knows (a push refused mid-upload kept the files sent).
 */
export function artifactCliError(failure: RaftFailure, again?: string | null, rateLimitedLeftBehind?: string): CliError {
  const { error } = failure;
  if (error.serverCode === AGENT_API_RATE_LIMITED_CODE && error.retryAfterSeconds !== undefined) {
    return rateLimitedCliError({ message: error.message, retryAfterSeconds: error.retryAfterSeconds }, again, rateLimitedLeftBehind);
  }
  // This CLI is older than the Server accepts for Artifacts: its sentence says how to upgrade.
  if (error.serverCode === AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE) {
    return new CliError({ code: "CLIENT_UPGRADE_REQUIRED", message: error.message, suggestedNextAction: error.nextAction });
  }
  if (error.serverCode && ARTIFACT_CLI_CODES.has(error.serverCode)) {
    return new CliError({ code: error.serverCode as CliErrorCode, message: error.message, suggestedNextAction: error.nextAction });
  }
  if (error.code === "INVALID_REQUEST") {
    // Keep a next step the operation wrote (a review's "Fix comment 2, then …"); drop the generic one.
    const own = error.nextAction && error.nextAction !== GENERIC_INVALID_REQUEST_NEXT ? { suggestedNextAction: error.nextAction } : {};
    return new CliError({ code: "INVALID_ARG", message: error.message, ...own });
  }
  const status = error.status ?? 0;
  // A code this CLI doesn't list (a newer Server): the Server's own sentence
  // (the op keeps it) and its code as the Code line, as in `action prepare`,
  // so the refusal reads without a CLI release. Without a step from the
  // Server, the step names this CLI's way to the latest version.
  if (error.serverCode && status < 500) {
    const generic = error.code === "HTTP_ERROR" ? opError("HTTP_ERROR") : null;
    const message = generic && error.message === generic.message
      ? `The Raft Server refused the request (${error.serverCode}) and sent no explanation.`
      : error.message;
    const suggestedNextAction = generic && error.nextAction === generic.nextAction
      ? "Change what the error says, then run the same command again. If it doesn't say what to change, this Raft CLI may be older than the Raft Server: ask the owner of this computer to update its Raft Computer to the latest version."
      : error.nextAction;
    return cliError(error.serverCode, message, { suggestedNextAction, retryable: error.retryable });
  }
  const code: CliErrorCode = status >= 500 ? "SERVER_5XX" : "ARTIFACT_FAILED";
  return new CliError({ code, message: error.message, suggestedNextAction: error.nextAction, retryable: error.retryable });
}

/** The artifact from the positional argument or `--artifact` (one of them). */
export function artifactArgument(positional: string | undefined, flag: string | undefined): string {
  const fromPositional = positional?.trim();
  const fromFlag = flag?.trim();
  if (fromPositional && fromFlag && fromPositional !== fromFlag) {
    throw new CliError({ code: "INVALID_ARG", message: "pass the artifact either as the first argument or with --artifact, not both" });
  }
  const artifact = fromPositional || fromFlag;
  if (!artifact) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "which artifact? Pass its id, link or exact title",
      suggestedNextAction: "List the ones you can see: raft artifact list",
    });
  }
  return artifact;
}

/** `--rev 9` or `--rev v9`. (Not `--version`: the root program owns that flag.) */
export function parseVersion(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/^v/i, "");
  if (!/^[1-9]\d{0,8}$/.test(trimmed)) {
    throw new CliError({ code: "INVALID_ARG", message: `--rev must be a version number like 9 or v9 (got "${raw}")` });
  }
  return Number(trimmed);
}

/**
 * Commander calls an action with (positionals…, opts, command): `count`
 * positionals (undefined when not given), then the options, then the Command
 * itself. Tests call handlers with (positionals…, opts) alone.
 */
export function splitArgs<O extends object>(args: readonly unknown[], count: number): { positionals: (string | undefined)[]; opts: Partial<O> } {
  const positionals = args.slice(0, count).map((a) => (typeof a === "string" ? a : undefined));
  const candidate = args[count];
  const opts = candidate && typeof candidate === "object" ? candidate as Partial<O> : {};
  return { positionals, opts };
}

/** Commander keeps arguments past the declared ones on the Command: refuse them rather than drop them silently. */
export function refuseExtraArguments(command: unknown, declared: number, hint: string): void {
  const given = (command as { args?: unknown[] } | undefined)?.args;
  if (Array.isArray(given) && given.length > declared) {
    throw new CliError({ code: "INVALID_ARG", message: `Unexpected argument${given.length - declared === 1 ? "" : "s"}: ${given.slice(declared).join(" ")}`, suggestedNextAction: hint });
  }
}
